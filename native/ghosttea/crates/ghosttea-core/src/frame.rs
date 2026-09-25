use crate::links::TerminalLink;
use anyhow::{Result, bail};
use ghosttea_text::{GlyphDefinition, GlyphFormat, GlyphInstance, ShapedRow};
use ghosttea_vt::{CellStyle, TerminalCell, TerminalScrollbar, TerminalSelection};
use std::collections::{BTreeMap, HashMap};

pub const FRAME_MAGIC: u32 = 0x3146_5254;
pub const FRAME_HEADER_BYTES: usize = 64;
pub const SECTION_HEADER_BYTES: usize = 16;
pub const ACCESSIBILITY_TEXT: u16 = 10;
pub const CURSOR_STATE: u16 = 4;
pub const SCROLLBAR_STATE: u16 = 8;
pub const ROW_REPLACEMENTS: u16 = 3;
pub const STYLE_DEFINITIONS: u16 = 2;
pub const GLYPH_DEFINITIONS: u16 = 1;
pub const CLIPBOARD_WRITE: u16 = 11;
pub const SELECTION_SPANS: u16 = 5;
pub const LINK_TARGETS: u16 = 12;
pub const FULL_SNAPSHOT: u16 = 1;
pub const MOUSE_TRACKING: u16 = 1 << 1;
pub const CATALOG_RESET: u16 = 1 << 2;

pub struct FrameCursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}

fn put_u16(target: &mut [u8], offset: usize, value: u16) {
    target[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(target: &mut [u8], offset: usize, value: u32) {
    target[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(target: &mut [u8], offset: usize, value: u64) {
    target[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn encode_glyph_definitions(definitions: &[GlyphDefinition]) -> Result<(Vec<u8>, u32)> {
    let count: u32 = definitions.len().try_into()?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&count.to_le_bytes());
    for definition in definitions {
        let pixel_length: u32 = definition.pixels.len().try_into()?;
        bytes.extend_from_slice(&definition.id.to_le_bytes());
        bytes.extend_from_slice(&definition.width.to_le_bytes());
        bytes.extend_from_slice(&definition.height.to_le_bytes());
        bytes.extend_from_slice(&definition.bearing_x.to_le_bytes());
        bytes.extend_from_slice(&definition.bearing_y.to_le_bytes());
        bytes.push(match definition.format {
            GlyphFormat::Alpha8 => 0,
            GlyphFormat::Rgba8Premultiplied => 1,
        });
        bytes.extend_from_slice(&[0; 3]);
        bytes.extend_from_slice(&pixel_length.to_le_bytes());
        bytes.extend_from_slice(&definition.pixels);
    }
    Ok((bytes, count))
}

fn style_id(style: CellStyle) -> u32 {
    if style == CellStyle::default() {
        return 0;
    }
    let mut hash = 2_166_136_261_u32;
    let flags = [
        style.bold,
        style.italic,
        style.faint,
        style.inverse,
        style.invisible,
        style.strikethrough,
        style.underline,
    ];
    let foreground = style.foreground.unwrap_or([0; 3]);
    let background = style.background.unwrap_or([0; 3]);
    for byte in flags
        .into_iter()
        .map(u8::from)
        .chain([u8::from(style.foreground.is_some())])
        .chain(foreground)
        .chain([u8::from(style.background.is_some())])
        .chain(background)
    {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    if hash == 0 { 1 } else { hash }
}

fn encode_style_definitions(styles: impl ExactSizeIterator<Item = (u32, CellStyle)>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(4 + styles.len() * 16);
    bytes.extend_from_slice(&(styles.len() as u32).to_le_bytes());
    for (id, style) in styles {
        let flags = u16::from(style.bold)
            | (u16::from(style.italic) << 1)
            | (u16::from(style.faint) << 2)
            | (u16::from(style.inverse) << 3)
            | (u16::from(style.invisible) << 4)
            | (u16::from(style.strikethrough) << 5)
            | (u16::from(style.underline) << 6);
        let foreground = style.foreground.unwrap_or([0; 3]);
        let background = style.background.unwrap_or([0; 3]);
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.push(u8::from(style.foreground.is_some()));
        bytes.push(u8::from(style.background.is_some()));
        bytes.extend_from_slice(&foreground);
        bytes.extend_from_slice(&background);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
    }
    bytes
}

struct PreparedRowStyles {
    cell_ids: Vec<u32>,
    column_ids: Vec<u32>,
}

enum PreparedFrameStyles {
    Linear(BTreeMap<u32, CellStyle>),
    Indexed {
        definitions: HashMap<u32, CellStyle>,
        rows: Vec<PreparedRowStyles>,
    },
}

impl PreparedFrameStyles {
    fn len(&self) -> usize {
        match self {
            Self::Linear(styles) => styles.len(),
            Self::Indexed { definitions, .. } => definitions.len(),
        }
    }

    fn encode(&self) -> Vec<u8> {
        match self {
            Self::Linear(styles) => {
                encode_style_definitions(styles.iter().map(|(&id, &style)| (id, style)))
            }
            Self::Indexed { definitions, .. } => {
                let mut sorted = definitions
                    .iter()
                    .map(|(&id, &style)| (id, style))
                    .collect::<Vec<_>>();
                sorted.sort_unstable_by_key(|(id, _)| *id);
                encode_style_definitions(sorted.into_iter())
            }
        }
    }
}

/// The frame encoder only needs grid geometry and resolved style. Local VT
/// snapshots carry grapheme text and semantic color provenance as well, while
/// replicas can use a compact cell and avoid cloning data this path never reads.
pub(crate) trait FrameCell {
    fn column(&self) -> u16;
    fn span(&self) -> u16;
    fn style(&self) -> CellStyle;
}

impl FrameCell for TerminalCell {
    fn column(&self) -> u16 {
        self.column
    }

    fn span(&self) -> u16 {
        self.span
    }

    fn style(&self) -> CellStyle {
        self.style
    }
}

fn append_style_run<C: FrameCell>(runs: &mut Vec<(u32, u16, u16)>, cell: &C, id: u32) {
    if id == 0 {
        return;
    }
    if let Some((previous_id, start, span)) = runs.last_mut()
        && *previous_id == id
        && start.saturating_add(*span) == cell.column()
    {
        *span = span.saturating_add(cell.span());
        return;
    }
    runs.push((id, cell.column(), cell.span()));
}

fn prepare_row_styles<C: FrameCell>(
    cells: &[C],
    shaped: &ShapedRow,
    styles: &mut HashMap<u32, CellStyle>,
) -> PreparedRowStyles {
    let cell_ids = cells
        .iter()
        .map(|cell| {
            let style = cell.style();
            let id = style_id(style);
            styles.entry(id).or_insert(style);
            id
        })
        .collect::<Vec<_>>();
    let column_count = shaped
        .glyphs
        .iter()
        .map(|glyph| glyph.cell_start as usize + 1)
        .max()
        .unwrap_or(0);
    let mut column_ids = vec![0; column_count];
    // The old lookup selected the first matching cell. Fill in reverse so
    // earlier cells still win for malformed or overlapping input.
    for (cell, id) in cells.iter().zip(&cell_ids).rev() {
        let start = (cell.column() as usize).min(column_ids.len());
        let end = (cell.column().saturating_add(cell.span()) as usize).min(column_ids.len());
        column_ids[start..end].fill(*id);
    }
    PreparedRowStyles {
        cell_ids,
        column_ids,
    }
}

fn encode_glyph_instance(bytes: &mut Vec<u8>, glyph: &GlyphInstance, style_id: u32) {
    bytes.extend_from_slice(&glyph.glyph_id.to_le_bytes());
    bytes.extend_from_slice(&style_id.to_le_bytes());
    bytes.extend_from_slice(&glyph.x.to_le_bytes());
    bytes.extend_from_slice(&glyph.y.to_le_bytes());
    bytes.extend_from_slice(&glyph.width.to_le_bytes());
    bytes.extend_from_slice(&glyph.height.to_le_bytes());
    bytes.extend_from_slice(&glyph.cell_start.to_le_bytes());
    bytes.extend_from_slice(&glyph.cell_span.to_le_bytes());
}

pub struct TextSnapshot<'a> {
    pub session_handle: u64,
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub sequence: u64,
    pub revision: u64,
    pub cols: u16,
    pub rows: &'a [String],
    pub shaped_rows: &'a [ShapedRow],
    pub cells: &'a [Vec<TerminalCell>],
    pub updated_rows: &'a [u16],
    pub full_snapshot: bool,
    pub catalog_reset: bool,
    pub mouse_tracking: bool,
    pub scrollbar: &'a TerminalScrollbar,
    pub selection: Option<&'a TerminalSelection>,
    pub new_glyph_definitions: &'a [GlyphDefinition],
    pub clipboard: Option<&'a [u8]>,
    pub cursor: &'a FrameCursor,
    pub links: Option<&'a [TerminalLink]>,
}

pub(crate) struct FrameTextSnapshot<'a, C: FrameCell> {
    pub session_handle: u64,
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub sequence: u64,
    pub revision: u64,
    pub cols: u16,
    pub rows: &'a [String],
    pub shaped_rows: &'a [ShapedRow],
    pub cells: &'a [Vec<C>],
    pub updated_rows: &'a [u16],
    pub full_snapshot: bool,
    pub catalog_reset: bool,
    pub mouse_tracking: bool,
    pub scrollbar: &'a TerminalScrollbar,
    pub selection: Option<&'a TerminalSelection>,
    pub new_glyph_definitions: &'a [GlyphDefinition],
    pub clipboard: Option<&'a [u8]>,
    pub cursor: &'a FrameCursor,
    pub links: Option<&'a [TerminalLink]>,
}

pub fn encode_text_snapshot(snapshot: TextSnapshot<'_>) -> Result<Vec<u8>> {
    encode_frame_text_snapshot(FrameTextSnapshot {
        session_handle: snapshot.session_handle,
        session_epoch: snapshot.session_epoch,
        layout_epoch: snapshot.layout_epoch,
        sequence: snapshot.sequence,
        revision: snapshot.revision,
        cols: snapshot.cols,
        rows: snapshot.rows,
        shaped_rows: snapshot.shaped_rows,
        cells: snapshot.cells,
        updated_rows: snapshot.updated_rows,
        full_snapshot: snapshot.full_snapshot,
        catalog_reset: snapshot.catalog_reset,
        mouse_tracking: snapshot.mouse_tracking,
        scrollbar: snapshot.scrollbar,
        selection: snapshot.selection,
        new_glyph_definitions: snapshot.new_glyph_definitions,
        clipboard: snapshot.clipboard,
        cursor: snapshot.cursor,
        links: snapshot.links,
    })
}

pub(crate) fn encode_frame_text_snapshot<C: FrameCell>(
    snapshot: FrameTextSnapshot<'_, C>,
) -> Result<Vec<u8>> {
    let FrameTextSnapshot {
        session_handle,
        session_epoch,
        layout_epoch,
        sequence,
        revision,
        cols,
        rows,
        shaped_rows,
        cells,
        updated_rows,
        full_snapshot,
        catalog_reset,
        mouse_tracking,
        scrollbar,
        selection,
        new_glyph_definitions,
        clipboard,
        cursor,
        links,
    } = snapshot;
    if rows.len() > u16::MAX as usize {
        bail!("too many rows");
    }
    if rows.len() != shaped_rows.len() || rows.len() != cells.len() {
        bail!("text, shaped, and styled row counts differ");
    }
    let indexed_styles = updated_rows
        .iter()
        .any(|row| cells[*row as usize].len() >= 8);
    let prepared_styles = if indexed_styles {
        let mut definitions = HashMap::new();
        definitions.insert(0, CellStyle::default());
        let rows = updated_rows
            .iter()
            .map(|row| {
                let index = *row as usize;
                prepare_row_styles(&cells[index], &shaped_rows[index], &mut definitions)
            })
            .collect::<Vec<_>>();
        PreparedFrameStyles::Indexed { definitions, rows }
    } else {
        let mut definitions = BTreeMap::new();
        definitions.insert(0, CellStyle::default());
        for row in updated_rows {
            for cell in &cells[*row as usize] {
                let style = cell.style();
                definitions.entry(style_id(style)).or_insert(style);
            }
        }
        PreparedFrameStyles::Linear(definitions)
    };
    let (glyph_definitions, glyph_count) = encode_glyph_definitions(new_glyph_definitions)?;
    let style_definitions = prepared_styles.encode();
    let mut accessibility = Vec::new();
    accessibility.extend_from_slice(&(updated_rows.len() as u16).to_le_bytes());
    let mut replacements = Vec::new();
    replacements.extend_from_slice(&(updated_rows.len() as u16).to_le_bytes());
    for (updated_index, row) in updated_rows.iter().copied().enumerate() {
        let row_index = row as usize;
        let text = &rows[row_index];
        let shaped = &shaped_rows[row_index];
        let row_cells = &cells[row_index];
        let bytes = text.as_bytes();
        if bytes.len() > u32::MAX as usize {
            bail!("row is too large");
        }
        accessibility.extend_from_slice(&row.to_le_bytes());
        accessibility.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        accessibility.extend_from_slice(bytes);
        replacements.extend_from_slice(&row.to_le_bytes());
        replacements.extend_from_slice(&revision.to_le_bytes());
        replacements.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        replacements.extend_from_slice(&(shaped.glyphs.len() as u16).to_le_bytes());
        let mut runs: Vec<(u32, u16, u16)> = Vec::new();
        match &prepared_styles {
            PreparedFrameStyles::Linear(_) => {
                for cell in row_cells {
                    append_style_run(&mut runs, cell, style_id(cell.style()));
                }
            }
            PreparedFrameStyles::Indexed { rows, .. } => {
                for (cell, id) in row_cells.iter().zip(&rows[updated_index].cell_ids) {
                    append_style_run(&mut runs, cell, *id);
                }
            }
        }
        replacements.extend_from_slice(&(runs.len() as u16).to_le_bytes());
        replacements.extend_from_slice(bytes);
        match &prepared_styles {
            PreparedFrameStyles::Linear(_) => {
                for glyph in &shaped.glyphs {
                    let id = row_cells
                        .iter()
                        .find(|cell| {
                            glyph.cell_start >= cell.column()
                                && glyph.cell_start < cell.column().saturating_add(cell.span())
                        })
                        .map(|cell| style_id(cell.style()))
                        .unwrap_or(0);
                    encode_glyph_instance(&mut replacements, glyph, id);
                }
            }
            PreparedFrameStyles::Indexed { rows, .. } => {
                let column_ids = &rows[updated_index].column_ids;
                for glyph in &shaped.glyphs {
                    let id = column_ids
                        .get(glyph.cell_start as usize)
                        .copied()
                        .unwrap_or(0);
                    encode_glyph_instance(&mut replacements, glyph, id);
                }
            }
        }
        for (style_id, cell_start, cell_span) in runs {
            replacements.extend_from_slice(&style_id.to_le_bytes());
            replacements.extend_from_slice(&cell_start.to_le_bytes());
            replacements.extend_from_slice(&cell_span.to_le_bytes());
        }
    }

    let clipboard_payload = clipboard.map(|text| {
        let mut bytes = Vec::with_capacity(4 + text.len());
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text);
        bytes
    });
    let selection_payload = selection.map(|selection| {
        let mut bytes = Vec::with_capacity(12);
        bytes.extend_from_slice(&selection.anchor.column.to_le_bytes());
        bytes.extend_from_slice(&selection.anchor.row.to_le_bytes());
        bytes.extend_from_slice(&selection.focus.column.to_le_bytes());
        bytes.extend_from_slice(&selection.focus.row.to_le_bytes());
        bytes
    });
    // Selection is present even when empty so an incremental frame can clear a
    // previously retained selection without widening another section.
    let mut link_payload = Vec::new();
    if let Some(links) = links {
        link_payload.extend_from_slice(&u32::try_from(links.len())?.to_le_bytes());
        for link in links {
            link_payload.extend_from_slice(&u32::try_from(link.uri.len())?.to_le_bytes());
            link_payload.extend_from_slice(&u16::try_from(link.spans.len())?.to_le_bytes());
            link_payload.extend_from_slice(&u16::from(link.explicit).to_le_bytes());
            link_payload.extend_from_slice(link.uri.as_bytes());
            for span in &link.spans {
                link_payload.extend_from_slice(&span.row.to_le_bytes());
                link_payload.extend_from_slice(&span.start_column.to_le_bytes());
                link_payload.extend_from_slice(&span.end_column.to_le_bytes());
            }
        }
    }
    let section_count = 7 + usize::from(links.is_some()) + usize::from(clipboard_payload.is_some());
    let glyph_offset = FRAME_HEADER_BYTES + SECTION_HEADER_BYTES * section_count;
    let style_offset = glyph_offset + glyph_definitions.len();
    let replacement_offset = style_offset + style_definitions.len();
    let cursor_offset = replacement_offset + replacements.len();
    let accessibility_offset = cursor_offset + 8;
    let scrollbar_offset = accessibility_offset + accessibility.len();
    let mut packet = vec![0; glyph_offset];
    packet.extend_from_slice(&glyph_definitions);
    packet.extend_from_slice(&style_definitions);
    packet.extend_from_slice(&replacements);
    packet.extend_from_slice(&cursor.x.to_le_bytes());
    packet.extend_from_slice(&cursor.y.to_le_bytes());
    packet.push(u8::from(cursor.visible));
    packet.push(cursor.style);
    packet.push(u8::from(cursor.blinking));
    packet.push(0);
    packet.extend_from_slice(&accessibility);
    packet.extend_from_slice(&scrollbar.total.to_le_bytes());
    packet.extend_from_slice(&scrollbar.offset.to_le_bytes());
    packet.extend_from_slice(&scrollbar.len.to_le_bytes());
    let selection_offset = packet.len();
    if let Some(bytes) = &selection_payload {
        packet.extend_from_slice(bytes);
    }
    let clipboard_offset = packet.len();
    if let Some(bytes) = &clipboard_payload {
        packet.extend_from_slice(bytes);
    }

    let link_offset = packet.len();
    packet.extend_from_slice(&link_payload);

    put_u32(&mut packet, 0, FRAME_MAGIC);
    put_u16(&mut packet, 4, 1);
    put_u16(
        &mut packet,
        6,
        (if full_snapshot { FULL_SNAPSHOT } else { 0 })
            | (if mouse_tracking { MOUSE_TRACKING } else { 0 })
            | (if catalog_reset { CATALOG_RESET } else { 0 }),
    );
    put_u64(&mut packet, 8, session_handle);
    put_u64(&mut packet, 16, session_handle);
    put_u64(&mut packet, 24, session_epoch);
    put_u64(&mut packet, 32, layout_epoch);
    put_u64(&mut packet, 40, sequence);
    put_u64(&mut packet, 48, revision);
    put_u16(&mut packet, 56, cols);
    put_u16(&mut packet, 58, rows.len() as u16);
    put_u16(&mut packet, 60, section_count as u16);

    put_u16(&mut packet, 64, GLYPH_DEFINITIONS);
    put_u32(&mut packet, 68, glyph_offset as u32);
    put_u32(&mut packet, 72, glyph_definitions.len() as u32);
    put_u32(&mut packet, 76, glyph_count);
    put_u16(&mut packet, 80, STYLE_DEFINITIONS);
    put_u32(&mut packet, 84, style_offset as u32);
    put_u32(&mut packet, 88, style_definitions.len() as u32);
    put_u32(&mut packet, 92, prepared_styles.len() as u32);
    put_u16(&mut packet, 96, ROW_REPLACEMENTS);
    put_u16(
        &mut packet,
        98,
        if full_snapshot { FULL_SNAPSHOT } else { 0 },
    );
    put_u32(&mut packet, 100, replacement_offset as u32);
    put_u32(&mut packet, 104, replacements.len() as u32);
    put_u32(&mut packet, 108, updated_rows.len() as u32);
    put_u16(&mut packet, 112, CURSOR_STATE);
    put_u32(&mut packet, 116, cursor_offset as u32);
    put_u32(&mut packet, 120, 8);
    put_u32(&mut packet, 124, 1);
    put_u16(&mut packet, 128, ACCESSIBILITY_TEXT);
    put_u32(&mut packet, 132, accessibility_offset as u32);
    put_u32(&mut packet, 136, accessibility.len() as u32);
    put_u32(&mut packet, 140, updated_rows.len() as u32);
    put_u16(&mut packet, 144, SCROLLBAR_STATE);
    put_u32(&mut packet, 148, scrollbar_offset as u32);
    put_u32(&mut packet, 152, 24);
    put_u32(&mut packet, 156, 1);
    put_u16(&mut packet, 160, SELECTION_SPANS);
    put_u32(&mut packet, 164, selection_offset as u32);
    put_u32(
        &mut packet,
        168,
        selection_payload.as_ref().map_or(0, |bytes| bytes.len()) as u32,
    );
    put_u32(&mut packet, 172, u32::from(selection_payload.is_some()));
    if let Some(bytes) = &clipboard_payload {
        put_u16(&mut packet, 176, CLIPBOARD_WRITE);
        put_u32(&mut packet, 180, clipboard_offset as u32);
        put_u32(&mut packet, 184, bytes.len() as u32);
        put_u32(&mut packet, 188, 1);
    }
    if let Some(links) = links {
        let link_header = 176 + usize::from(clipboard_payload.is_some()) * SECTION_HEADER_BYTES;
        put_u16(&mut packet, link_header, LINK_TARGETS);
        put_u32(&mut packet, link_header + 4, link_offset as u32);
        put_u32(&mut packet, link_header + 8, link_payload.len() as u32);
        put_u32(&mut packet, link_header + 12, links.len() as u32);
    }
    Ok(packet)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph_at(column: u16) -> GlyphInstance {
        GlyphInstance {
            glyph_id: column as u32 + 1,
            style_id: 0,
            x: column as f32,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            cell_start: column,
            cell_span: 1,
        }
    }

    #[test]
    fn prepared_row_styles_match_first_overlapping_cell_lookup() {
        let styles = [
            CellStyle {
                bold: true,
                ..CellStyle::default()
            },
            CellStyle {
                italic: true,
                ..CellStyle::default()
            },
            CellStyle {
                underline: true,
                ..CellStyle::default()
            },
        ];
        let cells = vec![
            TerminalCell {
                column: 2,
                span: 3,
                text: "abc".into(),
                style: styles[0],
                ..TerminalCell::default()
            },
            TerminalCell {
                column: 0,
                span: 4,
                text: "defg".into(),
                style: styles[1],
                ..TerminalCell::default()
            },
            TerminalCell {
                column: 5,
                span: 1,
                text: "h".into(),
                style: styles[2],
                ..TerminalCell::default()
            },
        ];
        let cells = cells
            .into_iter()
            .chain((0..5).map(|column| TerminalCell {
                column: column + 7,
                span: 0,
                text: String::new(),
                style: CellStyle::default(),
                ..TerminalCell::default()
            }))
            .collect::<Vec<_>>();
        let shaped = ShapedRow {
            glyphs: (0..=6).map(glyph_at).collect(),
            definitions: Vec::new(),
        };
        let mut definitions = HashMap::new();
        definitions.insert(0, CellStyle::default());
        let prepared = prepare_row_styles(&cells, &shaped, &mut definitions);

        assert_eq!(
            prepared.cell_ids,
            cells
                .iter()
                .map(|cell| style_id(cell.style))
                .collect::<Vec<_>>()
        );
        for glyph in &shaped.glyphs {
            let expected = cells
                .iter()
                .find(|cell| {
                    glyph.cell_start >= cell.column
                        && glyph.cell_start < cell.column.saturating_add(cell.span)
                })
                .map(|cell| style_id(cell.style))
                .unwrap_or(0);
            assert_eq!(
                prepared
                    .column_ids
                    .get(glyph.cell_start as usize)
                    .copied()
                    .unwrap_or(0),
                expected,
                "column {}",
                glyph.cell_start
            );
        }
    }

    #[test]
    fn snapshot_has_expected_header() {
        let mut engine = ghosttea_text::TextEngine::discover().unwrap();
        let shaped = vec![
            engine
                .shape_row("hello", ghosttea_text::FontStyle::default())
                .unwrap(),
        ];
        let cells = vec![vec![TerminalCell {
            column: 0,
            span: 1,
            text: "h".into(),
            style: CellStyle::default(),
            ..TerminalCell::default()
        }]];
        let cursor = FrameCursor {
            x: 5,
            y: 0,
            visible: true,
            style: 1,
            blinking: true,
        };
        let selection = TerminalSelection {
            anchor: ghosttea_vt::TerminalSelectionPoint { column: 2, row: 7 },
            focus: ghosttea_vt::TerminalSelectionPoint { column: 9, row: 8 },
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 3,
            revision: 5,
            cols: 80,
            rows: &["hello".into()],
            shaped_rows: &shaped,
            cells: &cells,
            updated_rows: &[0],
            full_snapshot: true,
            catalog_reset: true,
            mouse_tracking: false,
            scrollbar: &TerminalScrollbar {
                total: 30,
                offset: 6,
                len: 24,
            },
            selection: Some(&selection),
            new_glyph_definitions: &shaped[0].definitions,
            clipboard: None,
            links: None,
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(&frame[0..4], &FRAME_MAGIC.to_le_bytes());
        assert_eq!(
            u16::from_le_bytes(frame[6..8].try_into().unwrap()) & CATALOG_RESET,
            CATALOG_RESET
        );
        assert_eq!(u64::from_le_bytes(frame[40..48].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(frame[60..62].try_into().unwrap()), 7);
        assert_eq!(
            u16::from_le_bytes(frame[64..66].try_into().unwrap()),
            GLYPH_DEFINITIONS
        );
        assert_eq!(
            u16::from_le_bytes(frame[96..98].try_into().unwrap()),
            ROW_REPLACEMENTS
        );
        assert_eq!(u32::from_le_bytes(frame[120..124].try_into().unwrap()), 8);
        let cursor_offset = u32::from_le_bytes(frame[116..120].try_into().unwrap()) as usize;
        assert_eq!(&frame[cursor_offset + 4..cursor_offset + 8], &[1, 1, 1, 0]);
        assert_eq!(
            u16::from_le_bytes(frame[144..146].try_into().unwrap()),
            SCROLLBAR_STATE
        );
        assert_eq!(
            u16::from_le_bytes(frame[160..162].try_into().unwrap()),
            SELECTION_SPANS
        );
        assert_eq!(u32::from_le_bytes(frame[168..172].try_into().unwrap()), 12);
        assert_eq!(u32::from_le_bytes(frame[172..176].try_into().unwrap()), 1);
        let selection_offset = u32::from_le_bytes(frame[164..168].try_into().unwrap()) as usize;
        assert_eq!(
            &frame[selection_offset..selection_offset + 12],
            &[2, 0, 7, 0, 0, 0, 9, 0, 8, 0, 0, 0]
        );
        let scrollbar_offset = u32::from_le_bytes(frame[148..152].try_into().unwrap()) as usize;
        assert_eq!(
            u64::from_le_bytes(
                frame[scrollbar_offset..scrollbar_offset + 8]
                    .try_into()
                    .unwrap()
            ),
            30
        );
        assert_eq!(
            u64::from_le_bytes(
                frame[scrollbar_offset + 8..scrollbar_offset + 16]
                    .try_into()
                    .unwrap()
            ),
            6
        );
        assert_eq!(
            u64::from_le_bytes(
                frame[scrollbar_offset + 16..scrollbar_offset + 24]
                    .try_into()
                    .unwrap()
            ),
            24
        );
    }

    #[test]
    fn incremental_frame_contains_only_updated_rows_and_no_repeated_glyphs() {
        let mut engine = ghosttea_text::TextEngine::discover().unwrap();
        let shaped = vec![
            engine
                .shape_row("stable", ghosttea_text::FontStyle::default())
                .unwrap(),
            engine
                .shape_row("changed", ghosttea_text::FontStyle::default())
                .unwrap(),
        ];
        let cells: Vec<Vec<TerminalCell>> = vec![Vec::new(), Vec::new()];
        let cursor = FrameCursor {
            x: 7,
            y: 1,
            visible: true,
            style: 1,
            blinking: true,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 4,
            revision: 6,
            cols: 80,
            rows: &["stable".into(), "changed".into()],
            shaped_rows: &shaped,
            cells: &cells,
            updated_rows: &[1],
            full_snapshot: false,
            catalog_reset: false,
            mouse_tracking: false,
            scrollbar: &TerminalScrollbar {
                total: 24,
                offset: 0,
                len: 24,
            },
            selection: None,
            new_glyph_definitions: &[],
            clipboard: None,
            links: None,
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(u16::from_le_bytes(frame[6..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(frame[76..80].try_into().unwrap()), 0);
        assert_eq!(u16::from_le_bytes(frame[98..100].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(frame[108..112].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(frame[168..172].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(frame[172..176].try_into().unwrap()), 0);
    }

    #[test]
    fn advertises_mouse_tracking_and_transports_clipboard_writes() {
        let shaped = vec![ShapedRow::default()];
        let cursor = FrameCursor {
            x: 0,
            y: 0,
            visible: false,
            style: 1,
            blinking: false,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 5,
            revision: 7,
            cols: 80,
            rows: &[String::new()],
            shaped_rows: &shaped,
            cells: &[Vec::<TerminalCell>::new()],
            updated_rows: &[0],
            full_snapshot: false,
            catalog_reset: false,
            mouse_tracking: true,
            scrollbar: &TerminalScrollbar {
                total: 48,
                offset: 24,
                len: 24,
            },
            selection: None,
            new_glyph_definitions: &[],
            clipboard: Some(b"copied"),
            links: None,
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(
            u16::from_le_bytes(frame[6..8].try_into().unwrap()) & MOUSE_TRACKING,
            MOUSE_TRACKING
        );
        assert_eq!(u16::from_le_bytes(frame[60..62].try_into().unwrap()), 8);
        assert_eq!(
            u16::from_le_bytes(frame[176..178].try_into().unwrap()),
            CLIPBOARD_WRITE
        );
        let offset = u32::from_le_bytes(frame[180..184].try_into().unwrap()) as usize;
        assert_eq!(&frame[offset + 4..], b"copied");
    }

    fn phase1_baseline_frame(
        input: &[u8],
        chunk_sizes: &[usize],
    ) -> (ghosttea_vt::TerminalSnapshot, Vec<u8>) {
        let mut terminal = ghosttea_vt::GhosttyTerminalCore::new(24, 5, 4096).unwrap();
        terminal
            .set_colors([1, 2, 3], [4, 5, 6], [7, 8, 9])
            .unwrap();
        let mut offset = 0;
        let mut chunk = 0;
        while offset < input.len() {
            let size = chunk_sizes[chunk % chunk_sizes.len()];
            let end = offset.saturating_add(size).min(input.len());
            terminal.feed(&input[offset..end]);
            offset = end;
            chunk += 1;
        }
        let snapshot = terminal.snapshot().unwrap();
        let shaped_rows = vec![ShapedRow::default(); snapshot.rows.len()];
        let updated_rows: Vec<u16> = (0..snapshot.rows.len() as u16).collect();
        let cursor = FrameCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 0x0102_0304_0506_0708,
            session_epoch: 11,
            layout_epoch: 12,
            sequence: 13,
            revision: 14,
            cols: snapshot.cols,
            rows: &snapshot.rows,
            shaped_rows: &shaped_rows,
            cells: &snapshot.cells,
            updated_rows: &updated_rows,
            full_snapshot: true,
            catalog_reset: true,
            mouse_tracking: snapshot.mouse_tracking,
            scrollbar: &snapshot.scrollbar,
            selection: snapshot.selection.as_ref(),
            new_glyph_definitions: &[],
            clipboard: snapshot.clipboard.as_deref(),
            links: None,
            cursor: &cursor,
        })
        .unwrap();
        (snapshot, frame)
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0, "fixture hex must contain byte pairs");
        (0..value.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&value[offset..offset + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn phase1_desktop_baseline_is_invariant_to_input_chunking() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/phase1/ansi-baseline.json"))
                .unwrap();
        let input = decode_hex(fixture["inputHex"].as_str().unwrap());
        let expected_frame = decode_hex(fixture["expectedFrameHex"].as_str().unwrap());
        let expected_reply = decode_hex(fixture["expectedReplyHex"].as_str().unwrap());
        let expected_rows: Vec<&str> = fixture["expectedRows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row.as_str().unwrap())
            .collect();
        let (whole_snapshot, whole_frame) = phase1_baseline_frame(&input, &[usize::MAX]);
        for chunk_sizes in [&[1][..], &[2, 5, 13][..], &[7, 3, 1, 19][..]] {
            let (snapshot, frame) = phase1_baseline_frame(&input, chunk_sizes);
            assert_eq!(snapshot.rows, whole_snapshot.rows);
            assert_eq!(snapshot.pty_response, whole_snapshot.pty_response);
            assert_eq!(frame, whole_frame);
        }
        assert_eq!(whole_snapshot.rows, expected_rows);
        assert_eq!(whole_snapshot.pty_response, expected_reply);
        assert_eq!(whole_frame, expected_frame);
        assert_eq!(
            whole_snapshot.title.as_deref(),
            fixture["expectedTitle"].as_str()
        );
        assert!(whole_snapshot.mouse_tracking);
        assert_eq!(
            whole_snapshot.clipboard.as_deref(),
            fixture["expectedClipboard"].as_str().map(str::as_bytes)
        );
    }
}
