use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ghosttea_text::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan, TextEngine};
use ghosttea_vt::{GhosttyTerminalCore, TerminalSnapshot, TrackedTerminalSelection};

use crate::{
    AccessibilityRow, ClipboardRequest, FrameCursor, LogicalCell, LogicalCellStyle, LogicalCursor,
    LogicalRow, LogicalScrollbar, LogicalTerminalSnapshot, TerminalEffect, TerminalMetadata,
    TerminalUpdate, TextSnapshot, encode_text_snapshot,
};

const MAX_SENT_GLYPHS_PER_CATALOG: usize = 65_536;

#[derive(Clone)]
pub struct TerminalRuntime {
    text_engine: Arc<Mutex<TextEngine>>,
}

impl TerminalRuntime {
    pub fn new(text_engine: TextEngine) -> Self {
        Self {
            text_engine: Arc::new(Mutex::new(text_engine)),
        }
    }

    pub fn from_shared_text_engine(text_engine: Arc<Mutex<TextEngine>>) -> Self {
        Self { text_engine }
    }

    pub fn discover() -> Result<Self> {
        Ok(Self::new(TextEngine::discover()?))
    }

    pub(crate) fn text_engine(&self) -> &Arc<Mutex<TextEngine>> {
        &self.text_engine
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextEnginePerformanceSnapshot {
    pub sequence: u64,
    pub acquisition_count: u64,
    pub wait_nanoseconds: u64,
    pub hold_nanoseconds: u64,
}

impl TextEnginePerformanceSnapshot {
    pub(crate) fn record(&mut self, wait: Duration, hold: Duration) {
        self.sequence = self.sequence.saturating_add(1);
        self.acquisition_count = 1;
        self.wait_nanoseconds = duration_nanoseconds(wait);
        self.hold_nanoseconds = duration_nanoseconds(hold);
    }

    pub(crate) fn record_no_acquisition(&mut self) {
        self.sequence = self.sequence.saturating_add(1);
        self.acquisition_count = 0;
        self.wait_nanoseconds = 0;
        self.hold_nanoseconds = 0;
    }
}

fn duration_nanoseconds(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderRequest {
    None,
    Damage,
    Full,
}

#[derive(Clone, Copy, Debug)]
pub struct TerminalModelOptions {
    pub session_handle: u64,
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub scrollback_bytes: usize,
}

#[derive(Clone, PartialEq, Eq)]
struct RowShapeKey {
    text: String,
    spans: Vec<(usize, usize, FontStyle)>,
}

#[derive(Clone)]
struct CachedRow {
    key: RowShapeKey,
    shaped: ShapedRow,
}

struct RenderCache {
    rows: Vec<Option<CachedRow>>,
    sent_glyphs: HashSet<u32>,
    force_full: bool,
    reset_catalog: bool,
}

impl RenderCache {
    fn new() -> Self {
        Self {
            rows: Vec::new(),
            sent_glyphs: HashSet::new(),
            force_full: true,
            reset_catalog: true,
        }
    }
}

pub struct TerminalModel {
    runtime: Arc<TerminalRuntime>,
    terminal: GhosttyTerminalCore,
    view_selections: HashMap<String, TrackedTerminalSelection>,
    render_cache: RenderCache,
    metadata: TerminalMetadata,
    session_handle: u64,
    session_epoch: u64,
    layout_epoch: u64,
    terminal_revision: u64,
    frame_sequence: u64,
    latest_logical: Option<LogicalTerminalSnapshot>,
    text_engine_performance: TextEnginePerformanceSnapshot,
}

impl TerminalModel {
    pub fn new(runtime: Arc<TerminalRuntime>, options: TerminalModelOptions) -> Result<Self> {
        Ok(Self {
            runtime,
            terminal: GhosttyTerminalCore::new(
                options.cols,
                options.rows,
                options.scrollback_bytes,
            )?,
            view_selections: HashMap::new(),
            render_cache: RenderCache::new(),
            metadata: TerminalMetadata {
                cols: options.cols,
                rows: options.rows,
                title: None,
                cwd: None,
            },
            session_handle: options.session_handle,
            session_epoch: options.session_epoch,
            layout_epoch: options.layout_epoch,
            terminal_revision: 0,
            frame_sequence: 0,
            latest_logical: None,
            text_engine_performance: TextEnginePerformanceSnapshot::default(),
        })
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }

    pub fn latest_logical(&self) -> Option<LogicalTerminalSnapshot> {
        self.latest_logical.clone()
    }

    pub fn selection(&self) -> Option<ghosttea_vt::TerminalSelection> {
        self.terminal.selection()
    }

    pub fn text_engine_performance(&self) -> TextEnginePerformanceSnapshot {
        self.text_engine_performance
    }

    pub fn feed(&mut self, bytes: &[u8], render: RenderRequest) -> Result<TerminalUpdate> {
        self.terminal.feed(bytes);
        self.snapshot_update(render)
    }

    pub fn refresh(&mut self, render: RenderRequest) -> Result<TerminalUpdate> {
        if render == RenderRequest::Full {
            self.render_cache.force_full = true;
            self.render_cache.reset_catalog = true;
        }
        self.snapshot_update(render)
    }

    pub fn resize(
        &mut self,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
        render: RenderRequest,
    ) -> Result<TerminalUpdate> {
        let previous_cols = self.metadata.cols;
        let previous_rows = self.metadata.rows;
        let previous_layout_epoch = self.layout_epoch;
        self.terminal.resize(cols, rows)?;
        self.layout_epoch = layout_epoch;
        match self.snapshot_update(render) {
            Ok(update) => Ok(update),
            Err(error) => {
                let _ = self.terminal.resize(previous_cols, previous_rows);
                self.layout_epoch = previous_layout_epoch;
                Err(error)
            }
        }
    }

    pub fn set_colors(
        &mut self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
        render: RenderRequest,
    ) -> Result<TerminalUpdate> {
        self.terminal.set_colors(foreground, background, cursor)?;
        self.snapshot_update(render)
    }

    pub fn set_appearance(
        &mut self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
        palette: &[(u8, [u8; 3])],
        render: RenderRequest,
    ) -> Result<TerminalUpdate> {
        self.terminal.set_colors(foreground, background, cursor)?;
        self.terminal.set_palette(palette)?;
        self.snapshot_update(render)
    }

    pub fn selection_text(
        &mut self,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<String> {
        self.validate_selection_rows(start, end, select_all)?;
        Ok(self.terminal.selection_text(start, end, select_all)?)
    }

    /// Create a selection owned by one attached view. Unlike
    /// [`TerminalModel::selection_text`], this does not install a terminal-wide
    /// default selection, so another viewer cannot inherit its highlight.
    pub fn selection_text_for(
        &mut self,
        view_id: &str,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<String> {
        self.validate_selection_rows(start, end, select_all)?;
        let selection = self.terminal.track_selection(start, end, select_all)?;
        let text = self.terminal.format_tracked_selection(&selection)?;
        self.view_selections.insert(view_id.to_owned(), selection);
        Ok(text)
    }

    pub fn selection_for(&self, view_id: &str) -> Option<ghosttea_vt::TerminalSelection> {
        self.view_selections
            .get(view_id)
            .and_then(|selection| self.terminal.tracked_selection_points(selection))
    }

    pub fn view_selections(&self) -> Vec<(String, Option<ghosttea_vt::TerminalSelection>)> {
        self.view_selections
            .iter()
            .map(|(view_id, selection)| {
                (
                    view_id.clone(),
                    self.terminal.tracked_selection_points(selection),
                )
            })
            .collect()
    }

    pub fn remove_view_selection(&mut self, view_id: &str) {
        self.view_selections.remove(view_id);
    }

    fn validate_selection_rows(
        &self,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<()> {
        if !select_all {
            let row_count = self.terminal.selection_row_count()?;
            anyhow::ensure!(
                u64::from(start.1) < row_count && u64::from(end.1) < row_count,
                "selection row is outside the retained terminal grid"
            );
        }
        Ok(())
    }

    pub fn accessibility_rows(
        &self,
        start_row: u16,
        row_count: u16,
    ) -> Result<Vec<AccessibilityRow>> {
        let snapshot = self
            .latest_logical
            .as_ref()
            .context("terminal has no logical snapshot; request a rendered refresh first")?;
        let start = usize::from(start_row).min(snapshot.rows.len());
        let end = start
            .saturating_add(usize::from(row_count))
            .min(snapshot.rows.len());
        Ok(snapshot.rows[start..end]
            .iter()
            .enumerate()
            .map(|(offset, row)| AccessibilityRow {
                row: u16::try_from(start + offset).expect("logical row index fits u16"),
                text: row.text.clone(),
            })
            .collect())
    }

    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>> {
        Ok(self.terminal.encode_paste(text)?)
    }

    pub fn encode_key(
        &mut self,
        code: &str,
        text: &str,
        unshifted_codepoint: u32,
        mods: u16,
        action: u8,
    ) -> Result<Vec<u8>> {
        Ok(self
            .terminal
            .encode_key(code, text, unshifted_codepoint, mods, action)?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode_mouse(
        &mut self,
        action: u8,
        button: u8,
        mods: u16,
        x: f32,
        y: f32,
        screen_width: u32,
        screen_height: u32,
        cell_width: u32,
        cell_height: u32,
        padding_left: u32,
        padding_top: u32,
    ) -> Result<Vec<u8>> {
        Ok(self.terminal.encode_mouse(
            action,
            button,
            mods,
            x,
            y,
            screen_width,
            screen_height,
            cell_width,
            cell_height,
            padding_left,
            padding_top,
        )?)
    }

    pub fn encode_focus(&mut self, focused: bool) -> Result<Vec<u8>> {
        Ok(self.terminal.encode_focus(focused)?)
    }

    pub fn alternate_scroll(&self) -> bool {
        self.terminal.alternate_scroll()
    }

    pub fn scroll(&mut self, rows: isize, render: RenderRequest) -> Result<TerminalUpdate> {
        self.terminal.scroll(rows);
        self.snapshot_update(render)
    }

    pub fn scroll_to(&mut self, row: usize, render: RenderRequest) -> Result<TerminalUpdate> {
        self.terminal.scroll_to(row);
        self.snapshot_update(render)
    }

    pub fn compress_scrollback_full(&mut self) -> Result<bool> {
        Ok(self.terminal.compress_scrollback_full()?)
    }

    fn snapshot_update(&mut self, render: RenderRequest) -> Result<TerminalUpdate> {
        let snapshot = self.terminal.snapshot()?;
        self.effects_for_snapshot(snapshot, render)
    }

    fn effects_for_snapshot(
        &mut self,
        snapshot: TerminalSnapshot,
        render: RenderRequest,
    ) -> Result<TerminalUpdate> {
        let mut update = TerminalUpdate::new();
        if !snapshot.pty_response.is_empty() {
            update.push(TerminalEffect::WriteToTransport(
                snapshot.pty_response.clone(),
            ));
        }

        let metadata = TerminalMetadata {
            cols: snapshot.cols,
            rows: snapshot.rows.len() as u16,
            title: snapshot.title.clone(),
            cwd: snapshot.cwd.clone(),
        };
        if metadata != self.metadata {
            self.metadata = metadata.clone();
            update.push(TerminalEffect::MetadataChanged(metadata));
        }
        if snapshot.bell {
            update.push(TerminalEffect::Bell);
        }
        if let Some(bytes) = snapshot.clipboard.clone() {
            update.push(TerminalEffect::ClipboardRequest(ClipboardRequest::Write(
                bytes,
            )));
        }
        if render == RenderRequest::None {
            return Ok(update);
        }

        self.frame_sequence = self.frame_sequence.saturating_add(1);
        self.terminal_revision = self.terminal_revision.saturating_add(1);
        let logical = logical_snapshot(
            &snapshot,
            self.session_epoch,
            self.layout_epoch,
            self.terminal_revision,
        );
        self.latest_logical = Some(logical.clone());
        update.push(TerminalEffect::LogicalSnapshotReady(logical));
        let frame = self.encode_frame(&snapshot, render)?;
        update.push(TerminalEffect::FrameReady(frame));
        Ok(update)
    }

    fn encode_frame(
        &mut self,
        snapshot: &TerminalSnapshot,
        render: RenderRequest,
    ) -> Result<Vec<u8>> {
        if render == RenderRequest::Full {
            self.render_cache.force_full = true;
            self.render_cache.reset_catalog = true;
        } else if self.render_cache.sent_glyphs.len() >= MAX_SENT_GLYPHS_PER_CATALOG {
            // A catalog reset is rare and deliberately becomes a self-contained
            // full frame. This caps both native sent-ID bookkeeping and the
            // renderer's historical CPU glyph catalog without adding work to
            // ordinary frames.
            self.render_cache.force_full = true;
            self.render_cache.reset_catalog = true;
        }
        let cursor = FrameCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        };
        let (shaped_rows, updated_rows, full_snapshot, catalog_reset, new_definitions, wait, hold) = {
            let cache = &mut self.render_cache;
            let row_count = snapshot.rows.len();
            let cache_resized = cache.rows.len() != row_count;
            if cache_resized {
                cache.rows.resize_with(row_count, || None);
            }
            let full_snapshot = snapshot.damage.full
                || cache.force_full
                || cache_resized
                || render == RenderRequest::Full;
            let mut updated: BTreeSet<u16> = if full_snapshot {
                (0..row_count.min(u16::MAX as usize))
                    .map(|row| row as u16)
                    .collect()
            } else {
                snapshot
                    .damage
                    .dirty_rows
                    .iter()
                    .copied()
                    .filter(|row| (*row as usize) < row_count)
                    .collect()
            };
            for (row, cached) in cache.rows.iter().enumerate() {
                if cached.is_none() {
                    updated.insert(row as u16);
                }
            }
            let catalog_reset = cache.reset_catalog;
            if catalog_reset {
                cache.sent_glyphs.clear();
                cache.reset_catalog = false;
            }

            let wait_started = Instant::now();
            let mut engine = self.runtime.text_engine.lock().unwrap();
            let wait = wait_started.elapsed();
            let hold_started = Instant::now();
            for row_index in updated.iter().copied() {
                let row = &snapshot.rows[row_index as usize];
                let cells = &snapshot.cells[row_index as usize];
                let mut byte_offset = 0;
                let span_tuples: Vec<_> = cells
                    .iter()
                    .filter_map(|cell| {
                        if byte_offset >= row.len() {
                            return None;
                        }
                        let byte_start = byte_offset;
                        byte_offset = (byte_offset + cell.text.len()).min(row.len());
                        Some((
                            byte_start,
                            byte_offset,
                            FontStyle {
                                bold: cell.style.bold,
                                italic: cell.style.italic,
                            },
                        ))
                    })
                    .collect();
                let key = RowShapeKey {
                    text: row.clone(),
                    spans: span_tuples.clone(),
                };
                if cache.rows[row_index as usize]
                    .as_ref()
                    .is_some_and(|cached| cached.key == key)
                {
                    continue;
                }
                let spans: Vec<_> = span_tuples
                    .into_iter()
                    .map(|(byte_start, byte_end, style)| StyleSpan {
                        byte_start,
                        byte_end,
                        style,
                    })
                    .collect();
                let shaped = engine
                    .shape_styled_row(row, &spans)
                    .with_context(|| format!("shape terminal row {row_index}"))?;
                cache.rows[row_index as usize] = Some(CachedRow { key, shaped });
            }
            drop(engine);
            let hold = hold_started.elapsed();
            cache.force_full = false;
            let shaped_rows: Vec<_> = cache
                .rows
                .iter()
                .map(|row| {
                    row.as_ref()
                        .map(|cached| cached.shaped.clone())
                        .unwrap_or_default()
                })
                .collect();
            let mut new_definitions = BTreeMap::<u32, GlyphDefinition>::new();
            for row_index in &updated {
                for definition in &shaped_rows[*row_index as usize].definitions {
                    if cache.sent_glyphs.insert(definition.id) {
                        new_definitions.insert(definition.id, definition.clone());
                    }
                }
            }
            (
                shaped_rows,
                updated.into_iter().collect::<Vec<_>>(),
                full_snapshot,
                catalog_reset,
                new_definitions.into_values().collect::<Vec<_>>(),
                wait,
                hold,
            )
        };
        self.text_engine_performance.record(wait, hold);

        encode_text_snapshot(TextSnapshot {
            session_handle: self.session_handle,
            session_epoch: self.session_epoch,
            layout_epoch: self.layout_epoch,
            sequence: self.frame_sequence,
            revision: self.terminal_revision,
            cols: snapshot.cols,
            rows: &snapshot.rows,
            shaped_rows: &shaped_rows,
            cells: &snapshot.cells,
            updated_rows: &updated_rows,
            full_snapshot,
            catalog_reset,
            mouse_tracking: snapshot.mouse_tracking,
            scrollbar: &snapshot.scrollbar,
            selection: snapshot.selection.as_ref(),
            new_glyph_definitions: &new_definitions,
            clipboard: snapshot.clipboard.as_deref(),
            cursor: &cursor,
            links: Some(&crate::links::terminal_links(
                &snapshot.cells,
                &snapshot.row_metadata,
                &snapshot.hyperlinks,
            )),
        })
    }
}

fn logical_snapshot(
    snapshot: &TerminalSnapshot,
    session_epoch: u64,
    layout_epoch: u64,
    terminal_revision: u64,
) -> LogicalTerminalSnapshot {
    LogicalTerminalSnapshot {
        session_epoch,
        layout_epoch,
        terminal_revision,
        cols: snapshot.cols,
        rows: snapshot
            .rows
            .iter()
            .cloned()
            .zip(snapshot.cells.iter())
            .map(|(text, cells)| LogicalRow {
                text,
                cells: cells
                    .iter()
                    .map(|cell| LogicalCell {
                        column: cell.column,
                        span: cell.span,
                        text: cell.text.clone(),
                        style: LogicalCellStyle {
                            bold: cell.style.bold,
                            italic: cell.style.italic,
                            faint: cell.style.faint,
                            inverse: cell.style.inverse,
                            invisible: cell.style.invisible,
                            strikethrough: cell.style.strikethrough,
                            underline: cell.style.underline,
                            foreground: cell.style.foreground,
                            background: cell.style.background,
                            foreground_default: cell.foreground_default,
                            foreground_palette: cell.foreground_palette,
                            background_default: cell.background_default,
                            background_palette: cell.background_palette,
                        },
                    })
                    .collect(),
            })
            .collect(),
        cursor: LogicalCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        },
        mouse_tracking: snapshot.mouse_tracking,
        scrollbar: LogicalScrollbar {
            total: snapshot.scrollbar.total,
            offset: snapshot.scrollbar.offset,
            len: snapshot.scrollbar.len,
        },
        title: snapshot.title.clone(),
        cwd: snapshot.cwd.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_reply_precedes_semantic_and_render_effects() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: 4,
                session_epoch: 1,
                layout_epoch: 1,
                cols: 20,
                rows: 4,
                scrollback_bytes: 4096,
            },
        )
        .unwrap();
        model
            .set_colors([1, 2, 3], [4, 5, 6], [7, 8, 9], RenderRequest::None)
            .unwrap();
        let update = model
            .feed(
                b"\x1b]2;ordered\x1b\\\x07\x1b]10;?\x1b\\",
                RenderRequest::Full,
            )
            .unwrap();
        assert!(matches!(
            update.as_slice().first(),
            Some(TerminalEffect::WriteToTransport(_))
        ));
        assert!(
            update
                .as_slice()
                .iter()
                .any(|effect| matches!(effect, TerminalEffect::Bell))
        );
        assert!(matches!(
            update.as_slice().last(),
            Some(TerminalEffect::FrameReady(_))
        ));
    }

    #[test]
    fn full_refresh_after_headless_output_produces_complete_state() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: 4,
                session_epoch: 1,
                layout_epoch: 1,
                cols: 20,
                rows: 4,
                scrollback_bytes: 4096,
            },
        )
        .unwrap();
        let headless = model.feed(b"before-attach", RenderRequest::None).unwrap();
        assert!(
            !headless
                .as_slice()
                .iter()
                .any(|effect| matches!(effect, TerminalEffect::FrameReady(_)))
        );

        let attached = model.refresh(RenderRequest::Full).unwrap();
        assert!(attached.as_slice().iter().any(|effect| {
            matches!(
                effect,
                TerminalEffect::LogicalSnapshotReady(snapshot)
                    if snapshot.rows[0].text == "before-attach"
            )
        }));
        assert!(matches!(
            attached.as_slice().last(),
            Some(TerminalEffect::FrameReady(_))
        ));
        let performance = model.text_engine_performance();
        assert_eq!(performance.sequence, 1);
        assert_eq!(performance.acquisition_count, 1);
        assert!(performance.hold_nanoseconds > 0);
    }

    #[test]
    fn rejects_selection_rows_outside_retained_grid_before_formatting() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: 4,
                session_epoch: 1,
                layout_epoch: 1,
                cols: 20,
                rows: 4,
                scrollback_bytes: 4096,
            },
        )
        .unwrap();
        model.feed(b"one\r\ntwo", RenderRequest::None).unwrap();

        let error = model
            .selection_text((0, u32::MAX), (u16::MAX, u32::MAX), false)
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("outside the retained terminal grid")
        );
        assert!(model.selection_text((0, 0), (0, 0), true).is_ok());
    }

    #[test]
    fn keeps_tracked_selection_state_owned_by_each_view() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: 5,
                session_epoch: 1,
                layout_epoch: 1,
                cols: 12,
                rows: 3,
                scrollback_bytes: 4096,
            },
        )
        .unwrap();
        model
            .feed(b"\x1b[?1049hfirst\r\nsecond\r\nthird", RenderRequest::None)
            .unwrap();

        assert_eq!(
            model
                .selection_text_for("view-a", (0, 1), (5, 1), false)
                .unwrap(),
            "second"
        );
        assert_eq!(
            model
                .selection_text_for("view-b", (0, 2), (4, 2), false)
                .unwrap(),
            "third"
        );
        assert_eq!(model.selection(), None);

        model.feed(b"\x1b[1S", RenderRequest::None).unwrap();
        assert_eq!(model.selection_for("view-a").unwrap().anchor.row, 0);
        assert_eq!(model.selection_for("view-b").unwrap().anchor.row, 1);

        model.remove_view_selection("view-a");
        assert_eq!(model.selection_for("view-a"), None);
        assert_eq!(model.selection_for("view-b").unwrap().anchor.row, 1);
    }
}
