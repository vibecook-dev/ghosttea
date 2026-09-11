//! Viewer-local link targets, resolved against terminal cells before shaping.
use ghosttea_vt::{TerminalCell, TerminalHyperlinkRun, TerminalRowMetadata};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkSpan {
    pub row: u16,
    pub start_column: u16,
    pub end_column: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalLink {
    pub uri: String,
    pub explicit: bool,
    pub spans: Vec<LinkSpan>,
}

/// Keep destinations bounded; the desktop opener independently validates schemes.
const MAX_URI_BYTES: usize = 8192;

pub fn terminal_links(
    rows: &[Vec<TerminalCell>],
    metadata: &[TerminalRowMetadata],
    hyperlinks: &[TerminalHyperlinkRun],
) -> Vec<TerminalLink> {
    let mut links: Vec<TerminalLink> = Vec::new();
    for run in hyperlinks {
        if run.row as usize >= rows.len() || run.uri.len() > MAX_URI_BYTES {
            continue;
        }
        let Ok(uri) = std::str::from_utf8(&run.uri) else {
            continue;
        };
        if uri.is_empty() || uri.chars().any(char::is_control) {
            continue;
        }
        let span = LinkSpan {
            row: run.row as u16,
            start_column: run.start_column,
            end_column: run.end_column,
        };
        let previous = links.last_mut().filter(|previous| previous.uri == uri);
        if let Some(previous) = previous
            && let Some(last) = previous.spans.last_mut()
            && ((last.row == span.row && last.end_column == span.start_column)
                || (last.row + 1 == span.row
                    && span.start_column == 0
                    && metadata.get(last.row as usize).is_some_and(|m| m.wrap)))
        {
            if last.row == span.row {
                last.end_column = span.end_column;
            } else {
                previous.spans.push(span);
            }
        } else {
            links.push(TerminalLink {
                uri: uri.to_owned(),
                explicit: true,
                spans: vec![span],
            });
        }
    }

    // A byte-to-cell map handles wide characters, combining marks and wrapped URLs.
    let mut text = String::new();
    let mut positions: Vec<(usize, usize, LinkSpan)> = Vec::new();
    for (row, cells) in rows.iter().enumerate() {
        let mut column = 0;
        for cell in cells {
            if cell.column > column {
                text.push_str(&" ".repeat((cell.column - column) as usize));
            }
            let start = text.len();
            if cell.style.invisible {
                text.push_str(&" ".repeat(cell.text.len()));
            } else {
                text.push_str(&cell.text);
            }
            positions.push((
                start,
                text.len(),
                LinkSpan {
                    row: row as u16,
                    start_column: cell.column,
                    end_column: cell.column.saturating_add(cell.span),
                },
            ));
            column = cell.column.saturating_add(cell.span);
        }
        if !metadata.get(row).is_some_and(|m| m.wrap) || row + 1 == rows.len() {
            for (start, end) in url_ranges(&text) {
                let spans = positions
                    .iter()
                    .filter(|(a, b, _)| *a < end && *b > start)
                    .map(|(_, _, span)| span.clone())
                    .collect::<Vec<_>>();
                // OSC 8 destinations take precedence over URL-looking labels.
                if spans.iter().any(|span| {
                    links.iter().filter(|link| link.explicit).any(|link| {
                        link.spans.iter().any(|other| {
                            span.row == other.row
                                && span.start_column < other.end_column
                                && span.end_column > other.start_column
                        })
                    })
                }) {
                    continue;
                }
                let mut compact: Vec<LinkSpan> = Vec::new();
                for span in spans {
                    if let Some(last) = compact.last_mut()
                        && last.row == span.row
                        && last.end_column == span.start_column
                    {
                        last.end_column = span.end_column;
                    } else {
                        compact.push(span);
                    }
                }
                if !compact.is_empty() {
                    links.push(TerminalLink {
                        uri: text[start..end].to_owned(),
                        explicit: false,
                        spans: compact,
                    });
                }
            }
            text.clear();
            positions.clear();
        }
    }
    links
}

fn url_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let lowercase = text.to_ascii_lowercase();
    let mut offset = 0;
    while offset < text.len() {
        let remaining = &lowercase[offset..];
        let prefix = ["https://", "http://", "mailto:", "ftp://", "ftps://"]
            .into_iter()
            .filter_map(|scheme| remaining.find(scheme).map(|i| (i, scheme.len())))
            .min_by_key(|(i, _)| *i);
        let Some((index, prefix_len)) = prefix else {
            break;
        };
        let start = offset + index;
        let tail = &text[start..];
        let mut len = tail
            .find(|c: char| {
                c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '\'' | '`')
            })
            .unwrap_or(tail.len());
        loop {
            let candidate = &tail[..len];
            let Some(last) = candidate.chars().last() else {
                break;
            };
            let trim = matches!(last, '.' | ',' | ';' | ':' | '!' | '?')
                || [('(', ')'), ('[', ']'), ('{', '}')]
                    .into_iter()
                    .any(|(open, close)| {
                        last == close
                            && candidate.matches(close).count() > candidate.matches(open).count()
                    });
            if !trim {
                break;
            }
            len -= last.len_utf8();
        }
        if len > prefix_len && len <= MAX_URI_BYTES {
            ranges.push((start, start + len));
        }
        offset = start + len.max(prefix_len);
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn punctuation_balancing_and_multiple_urls() {
        let text = "See (https://example.com/a_(b)), https://localhost:3000/a?b=1&c=2.";
        let links: Vec<_> = url_ranges(text)
            .into_iter()
            .map(|(a, b)| &text[a..b])
            .collect();
        assert_eq!(
            links,
            [
                "https://example.com/a_(b)",
                "https://localhost:3000/a?b=1&c=2"
            ]
        );
    }
    fn snapshot_links(cols: u16, input: &[u8]) -> Vec<TerminalLink> {
        let mut core = ghosttea_vt::GhosttyTerminalCore::new(cols, 6, 1024 * 1024).unwrap();
        core.feed(input);
        let snapshot = core.snapshot().unwrap();
        terminal_links(
            &snapshot.cells,
            &snapshot.row_metadata,
            &snapshot.hyperlinks,
        )
    }

    #[test]
    fn wide_and_combining_characters_preserve_cell_ranges() {
        let links = snapshot_links(80, "界e\u{301} https://example.com.".as_bytes());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].uri, "https://example.com");
        assert_eq!(
            links[0].spans,
            [LinkSpan {
                row: 0,
                start_column: 4,
                end_column: 23
            }]
        );
    }

    #[test]
    fn soft_wrapped_urls_have_one_target_and_multiple_spans() {
        let links = snapshot_links(16, b"https://example.com/path");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].uri, "https://example.com/path");
        assert_eq!(links[0].spans.len(), 2);
        assert_eq!(
            links[0].spans[1],
            LinkSpan {
                row: 1,
                start_column: 0,
                end_column: 8
            }
        );
    }

    #[test]
    fn hard_newlines_do_not_join_urls() {
        let links = snapshot_links(80, b"https://example.com\r\n/path");
        assert_eq!(links[0].uri, "https://example.com");
    }

    #[test]
    fn osc8_destination_overrides_url_label_and_survives_wrap() {
        let links = snapshot_links(
            16,
            b"\x1b]8;;https://actual.example/\x1b\\https://label.example/\x1b]8;;\x1b\\",
        );
        assert_eq!(links.len(), 1);
        assert!(links[0].explicit);
        assert_eq!(links[0].uri, "https://actual.example/");
        assert_eq!(links[0].spans.len(), 2);
    }

    #[test]
    fn erased_links_do_not_survive_an_incremental_snapshot() {
        let mut core = ghosttea_vt::GhosttyTerminalCore::new(80, 6, 1024 * 1024).unwrap();
        core.feed(b"https://example.com");
        let snapshot = core.snapshot().unwrap();
        assert_eq!(
            terminal_links(
                &snapshot.cells,
                &snapshot.row_metadata,
                &snapshot.hyperlinks
            )
            .len(),
            1
        );
        core.feed(b"\r\x1b[2K");
        let snapshot = core.snapshot().unwrap();
        assert!(
            terminal_links(
                &snapshot.cells,
                &snapshot.row_metadata,
                &snapshot.hyperlinks
            )
            .is_empty()
        );
    }

    #[test]
    fn scrollback_and_resize_recompute_viewport_spans() {
        let mut core = ghosttea_vt::GhosttyTerminalCore::new(80, 3, 1024 * 1024).unwrap();
        core.feed(b"https://example.com/path\r\none\r\ntwo\r\nthree\r\n");
        let snapshot = core.snapshot().unwrap();
        assert!(
            terminal_links(
                &snapshot.cells,
                &snapshot.row_metadata,
                &snapshot.hyperlinks
            )
            .is_empty()
        );
        core.scroll_to(0);
        let snapshot = core.snapshot().unwrap();
        let links = terminal_links(
            &snapshot.cells,
            &snapshot.row_metadata,
            &snapshot.hyperlinks,
        );
        assert_eq!(links[0].spans[0].row, 0);
        assert_eq!(links[0].uri, "https://example.com/path");
        core.resize(12, 6).unwrap();
        core.scroll_to(0);
        let snapshot = core.snapshot().unwrap();
        let links = terminal_links(
            &snapshot.cells,
            &snapshot.row_metadata,
            &snapshot.hyperlinks,
        );
        assert_eq!(links[0].uri, "https://example.com/path");
        assert_eq!(links[0].spans.len(), 2);
    }

    #[test]
    fn scheme_matching_is_case_insensitive() {
        let text = "HTTPS://example.com/Path";
        assert_eq!(url_ranges(text), [(0, text.len())]);
    }
}
