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
    terminal_links_with_context(rows, metadata, hyperlinks, LinkContext::default())
}

pub fn terminal_links_with_context(
    rows: &[Vec<TerminalCell>],
    metadata: &[TerminalRowMetadata],
    hyperlinks: &[TerminalHyperlinkRun],
    context: LinkContext<'_>,
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
            for (start, end, uri) in automatic_links(&text, context) {
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
                        uri,
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

/// Filesystem context belongs to the terminal process, not the renderer window.
#[derive(Clone, Copy, Debug, Default)]
pub struct LinkContext<'a> {
    pub cwd: Option<&'a str>,
    pub home: Option<&'a str>,
}

fn automatic_links(text: &str, context: LinkContext<'_>) -> Vec<(usize, usize, String)> {
    let mut matches = url_ranges(text)
        .into_iter()
        .map(|(start, end)| (start, end, text[start..end].to_owned()))
        .collect::<Vec<_>>();
    let mut offset = 0;
    while offset < text.len() {
        let first = text[offset..].chars().next().unwrap();
        let quoted = matches!(first, '\'' | '"' | '`');
        let start = offset + if quoted { first.len_utf8() } else { 0 };
        let mut end = if quoted {
            text[start..]
                .find(first)
                .map(|i| start + i)
                .unwrap_or(start)
        } else {
            text[start..]
                .find(|c: char| !path_character(c))
                .map_or(text.len(), |i| start + i)
        };
        if end == start {
            offset += first.len_utf8();
            continue;
        }
        if !quoted && looks_like_path(&text[start..end]) && !text[start..end].ends_with(':') {
            // Like Ghostty's default matcher, allow single spaces within a
            // rooted directory path. Dotted paths only extend into another
            // path-like segment, so "src/main.rs more text" ends at the file.
            let mut file_like = text[start..end]
                .trim_start_matches(['.', '/', '~'])
                .contains('.');
            while text[end..].starts_with(' ') {
                let next_start = end + 1;
                let next_end = text[next_start..]
                    .find(|c: char| !path_character(c))
                    .map_or(text.len(), |i| next_start + i);
                let next = &text[next_start..next_end];
                if next.is_empty()
                    || next.starts_with('/')
                    || next.starts_with("~/")
                    || next.starts_with("./")
                    || next.starts_with("../")
                    || next.starts_with('$')
                    || next.contains(':')
                    || (file_like && !next.contains(['/', '.']))
                {
                    break;
                }
                end = next_end;
                file_like |= next.contains('.');
            }
        }
        offset = end + if quoted { first.len_utf8() } else { 0 };
        let candidate = text[start..end].trim_end_matches([',', '.', ':']);
        if !looks_like_path(candidate) {
            continue;
        }
        let end = start + candidate.len();
        // A URL's path component must never become a separate file link.
        if matches.iter().any(|(a, b, _)| start < *b && end > *a) {
            continue;
        }
        if let Some(uri) = path_uri(candidate, context)
            && uri.len() <= MAX_URI_BYTES
        {
            matches.push((start, end, uri));
        }
    }
    matches.sort_by_key(|(start, _, _)| *start);
    matches
}

fn path_character(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(
            c,
            '_' | '-'
                | '.'
                | '~'
                | ':'
                | '/'
                | '\\'
                | '#'
                | '@'
                | '!'
                | '$'
                | '&'
                | '+'
                | ';'
                | '='
                | '%'
        )
}

fn looks_like_path(value: &str) -> bool {
    if value.is_empty() || value.contains("://") || value.starts_with("//") {
        return false;
    }
    if value.starts_with('/')
        || value.starts_with("~/")
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with("$HOME/")
        || value.starts_with("$PWD/")
    {
        return value.len() > 1;
    }
    if cfg!(windows)
        && value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .get(2)
            .is_some_and(|c| *c == b'/' || *c == b'\\')
    {
        return true;
    }
    let Some((directory, rest)) = value.split_once('/') else {
        return false;
    };
    !directory.is_empty()
        && directory
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !rest.is_empty()
        && (directory.contains('.') || rest.contains('.'))
}

fn context_directory(value: &str) -> Option<std::path::PathBuf> {
    let Some(uri) = value.strip_prefix("file://") else {
        return Some(value.into());
    };
    // libghostty-vt retains OSC 7 as a file URI, including its hostname.
    let path = &uri[uri.find('/')?..];
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            (high * 16 + low) as u8
        } else {
            byte
        });
    }
    let decoded = String::from_utf8(decoded).ok()?;
    if decoded.chars().any(char::is_control) {
        return None;
    }
    #[cfg(windows)]
    let decoded = if decoded.as_bytes().get(2) == Some(&b':') {
        decoded[1..].to_owned()
    } else {
        decoded
    };
    Some(decoded.into())
}

fn path_uri(value: &str, context: LinkContext<'_>) -> Option<String> {
    use std::path::{Component, Path, PathBuf};
    // Source references commonly append :line[:column] or #Lline. These are
    // part of the highlighted text, but not part of the filesystem name.
    let mut path = value;
    for _ in 0..2 {
        if let Some((prefix, suffix)) = path.rsplit_once(':')
            && !suffix.is_empty()
            && suffix.bytes().all(|c| c.is_ascii_digit())
        {
            path = prefix;
        }
    }
    if let Some((prefix, suffix)) = path.rsplit_once("#L")
        && !suffix.is_empty()
        && suffix.bytes().all(|c| c.is_ascii_digit())
    {
        path = prefix;
    }
    let resolved = if let Some(relative) = path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("$HOME/"))
    {
        Path::new(context.home?).join(relative)
    } else if let Some(relative) = path.strip_prefix("$PWD/") {
        context_directory(context.cwd?)?.join(relative)
    } else if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        context_directory(context.cwd?)?.join(path)
    };
    if !resolved.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in resolved.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let path = normalized.to_str()?;
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    let mut uri = String::from("file://");
    if !path.starts_with('/') {
        uri.push('/');
    }
    const HEX: &[u8] = b"0123456789ABCDEF";
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'.' | b'_' | b'~') {
            uri.push(byte as char);
        } else {
            uri.push('%');
            uri.push(HEX[(byte >> 4) as usize] as char);
            uri.push(HEX[(byte & 15) as usize] as char);
        }
    }
    Some(uri)
}

fn url_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let lowercase = text.to_ascii_lowercase();
    let mut offset = 0;
    while offset < text.len() {
        let remaining = &lowercase[offset..];
        let prefix = [
            "https://", "http://", "mailto:", "ftp://", "ftps://", "file://",
        ]
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
    #[cfg(unix)]
    fn plain_paths_resolve_against_the_terminal_context() {
        let context = LinkContext {
            cwd: Some("/work/project"),
            home: Some("/home/user"),
        };
        for (text, label, uri) in [
            (
                "gpt-6 xhigh · ~/Projects/project100/puppeteer · title",
                "~/Projects/project100/puppeteer",
                "file:///home/user/Projects/project100/puppeteer",
            ),
            (
                "modified: src/main.rs:42:10",
                "src/main.rs:42:10",
                "file:///work/project/src/main.rs",
            ),
            (
                "see ../shared/lib.rs#L42",
                "../shared/lib.rs#L42",
                "file:///work/shared/lib.rs",
            ),
            (
                "directory /tmp/example",
                "/tmp/example",
                "file:///tmp/example",
            ),
            (
                "open \"~/my project/notes.md\"",
                "~/my project/notes.md",
                "file:///home/user/my%20project/notes.md",
            ),
            (
                "open '$HOME/my project/notes.md'",
                "$HOME/my project/notes.md",
                "file:///home/user/my%20project/notes.md",
            ),
            (
                "loaded .config/app/settings.json",
                ".config/app/settings.json",
                "file:///work/project/.config/app/settings.json",
            ),
            (
                "$PWD/src/界.rs",
                "$PWD/src/界.rs",
                "file:///work/project/src/%E7%95%8C.rs",
            ),
        ] {
            let links = automatic_links(text, context);
            assert_eq!(links.len(), 1, "{text}");
            let (start, end, destination) = &links[0];
            assert_eq!(&text[*start..*end], label);
            assert_eq!(destination, uri);
        }
        for text in [
            "input/output",
            "// comment",
            "//foo",
            "foo~/bar.txt",
            "$10/bar.txt",
        ] {
            assert!(automatic_links(text, context).is_empty(), "{text}");
        }
        let links = automatic_links("https://example.com/path.rs /tmp/file.rs", context);
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].2, "https://example.com/path.rs");
        assert_eq!(links[1].2, "file:///tmp/file.rs");
        assert!(automatic_links("~/src/main.rs ./src/main.rs", LinkContext::default()).is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn unquoted_paths_with_spaces_stop_at_terminal_separators() {
        let context = LinkContext {
            cwd: Some("/work"),
            home: Some("/home/user"),
        };
        for (text, expected) in [
            ("gpt-6 · ~/My Projects/repo · Ready", "~/My Projects/repo"),
            (
                "/tmp/test folder/file.txt more text",
                "/tmp/test folder/file.txt",
            ),
            ("./Downloads: Operation not permitted", "./Downloads"),
            ("src/main.rs more text", "src/main.rs"),
            ("/tmp/foo /tmp/bar", "/tmp/foo"),
            ("/tmp/foo  other", "/tmp/foo"),
            ("foo.local/share", "foo.local/share"),
        ] {
            let links = automatic_links(text, context);
            assert!(!links.is_empty(), "{text}");
            assert_eq!(&text[links[0].0..links[0].1], expected);
        }
    }

    #[test]
    #[cfg(unix)]
    fn path_underlines_use_cells_and_osc8_retains_precedence() {
        let mut core = ghosttea_vt::GhosttyTerminalCore::new(20, 6, 4096).unwrap();
        core.feed("界 ~/Projects/project100/puppeteer\r\n".as_bytes());
        core.feed(b"\x1b]8;;https://example.com\x1b\\src/main.rs\x1b]8;;\x1b\\");
        let snapshot = core.snapshot().unwrap();
        let links = terminal_links_with_context(
            &snapshot.cells,
            &snapshot.row_metadata,
            &snapshot.hyperlinks,
            LinkContext {
                cwd: Some("/work"),
                home: Some("/home/user"),
            },
        );
        assert_eq!(links.len(), 2);
        let path = links.iter().find(|link| !link.explicit).unwrap();
        assert_eq!(path.uri, "file:///home/user/Projects/project100/puppeteer");
        assert_eq!(path.spans.len(), 2);
        assert_eq!(path.spans[0].start_column, 3);
        assert_eq!(path.spans[1].start_column, 0);
        assert_eq!(
            links.iter().find(|link| link.explicit).unwrap().uri,
            "https://example.com"
        );
    }

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
