use std::{
    collections::{HashMap, HashSet, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::Arc,
};

use anyhow::{Context, Result, bail, ensure};
use fontdb::{Database, Family, ID, Query, Source as FontSource, Stretch, Style, Weight};
use harfrust::{Buffer, ShapeOptions, ShaperFont, shape};
use swash::{
    FontRef,
    scale::{Render, ScaleContext, Source, StrikeWith, image::Content},
    zeno::Format,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

mod emoji_presentation;

use emoji_presentation::has_default_emoji_presentation;

#[cfg(feature = "fixture")]
mod fixture;

#[cfg(feature = "fixture")]
pub use fixture::{
    NormalizedFontFace, NormalizedGlyphDefinition, NormalizedGlyphInstance, NormalizedShapedRow,
    NormalizedShapedRowDigest, ShapingFixture, ShapingFixtureCase, phase2_fixture_cases,
};

pub const FONT_SIZE_PX: f32 = 13.0;
pub const RASTER_SCALE: f32 = 2.0;
pub const CELL_WIDTH_PX: f32 = 7.83;
pub const LINE_HEIGHT_PX: f32 = 19.0;
pub const BASELINE_PX: f32 = 14.0;

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(
    feature = "fixture",
    derive(serde::Deserialize, serde::Serialize),
    serde(rename_all = "camelCase")
)]
pub struct TextMetrics {
    pub font_size_px: f32,
    pub cell_width_px: f32,
    pub line_height_px: f32,
    pub baseline_px: f32,
}

impl Default for TextMetrics {
    fn default() -> Self {
        Self {
            font_size_px: FONT_SIZE_PX,
            cell_width_px: CELL_WIDTH_PX,
            line_height_px: LINE_HEIGHT_PX,
            baseline_px: BASELINE_PX,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FontMode {
    Bundled,
    System,
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum FontPresentation {
    #[default]
    Text,
    Emoji,
    Any,
}

impl FontPresentation {
    fn accepts(self, requested: Self) -> bool {
        self == Self::Any || requested == Self::Any || self == requested
    }
}

#[derive(Clone)]
pub struct FontResource {
    name: String,
    bytes: Arc<Vec<u8>>,
    face_index: usize,
    presentation: FontPresentation,
}

impl FontResource {
    pub fn new(name: impl Into<String>, bytes: Vec<u8>) -> Self {
        Self {
            name: name.into(),
            bytes: Arc::new(bytes),
            face_index: 0,
            presentation: FontPresentation::Text,
        }
    }

    pub fn with_face_index(mut self, face_index: usize) -> Self {
        self.face_index = face_index;
        self
    }

    pub fn with_presentation(mut self, presentation: FontPresentation) -> Self {
        self.presentation = presentation;
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn bytes(&self) -> &[u8] {
        self.bytes.as_slice()
    }

    pub fn presentation(&self) -> FontPresentation {
        self.presentation
    }
}

#[derive(Clone)]
pub struct FontResources {
    pub regular: FontResource,
    pub bold: Option<FontResource>,
    pub italic: Option<FontResource>,
    pub bold_italic: Option<FontResource>,
    pub fallbacks: Vec<FontResource>,
}

impl FontResources {
    pub fn new(regular: FontResource) -> Self {
        Self {
            regular,
            bold: None,
            italic: None,
            bold_italic: None,
            fallbacks: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct FontStyle {
    pub bold: bool,
    pub italic: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct StyleSpan {
    pub byte_start: usize,
    pub byte_end: usize,
    pub style: FontStyle,
}

/// A terminal host's authoritative text cluster and grid placement.
/// Keep these boundaries when rendering a local or mirrored terminal: the
/// host's Unicode version and grapheme mode may differ from this shaper's.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TerminalCellSpan {
    pub byte_start: usize,
    pub byte_end: usize,
    pub column: u16,
    pub span: u16,
    pub style: FontStyle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum GlyphFormat {
    Alpha8 = 0,
    Rgba8Premultiplied = 1,
}

#[derive(Clone, Debug)]
pub struct GlyphDefinition {
    pub id: u32,
    pub width: u16,
    pub height: u16,
    pub bearing_x: i16,
    pub bearing_y: i16,
    pub format: GlyphFormat,
    pub pixels: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug)]
pub struct GlyphInstance {
    pub glyph_id: u32,
    pub style_id: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub cell_start: u16,
    pub cell_span: u16,
}

#[derive(Clone, Debug, Default)]
pub struct ShapedRow {
    pub glyphs: Vec<GlyphInstance>,
    pub definitions: Vec<GlyphDefinition>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct GlyphKey {
    face_id: u32,
    glyph_index: u32,
    pixel_size_26_6: u32,
    render_flags: u16,
}

struct LoadedFace {
    id: u32,
    index: u32,
    data: Arc<dyn AsRef<[u8]> + Send + Sync>,
    /// The face as harfrust reads it, parsed once per loaded face and shared by every run.
    /// `None` when read-fonts rejects the bytes; see [`shape_glyphs`].
    shaping: Option<harfrust::Font>,
}

/// One shaped glyph, positioned in 26.6 pixels.
struct ShapedGlyph {
    glyph_id: u32,
    cluster: u32,
    x_advance: i32,
    x_offset: i32,
    y_offset: i32,
}

#[derive(Clone, Copy)]
struct FallbackFace {
    id: ID,
    presentation: FontPresentation,
}

#[derive(Clone)]
struct Grapheme<'a> {
    text: &'a str,
    byte_start: usize,
    cell_start: u16,
    cell_span: u16,
    face: ID,
    style: FontStyle,
    presentation: FontPresentation,
}

struct CachedShapedRow {
    text: String,
    spans: Vec<StyleSpan>,
    cells: Option<Vec<TerminalCellSpan>>,
    shaped: ShapedRow,
}

pub struct TextEngine {
    database: Database,
    primary_family: String,
    styled_faces: HashMap<FontStyle, ID>,
    face_presentations: HashMap<ID, FontPresentation>,
    fallback_order: Option<Vec<FallbackFace>>,
    fallback_faces: HashMap<(String, FontPresentation), Option<ID>>,
    loaded_faces: HashMap<ID, LoadedFace>,
    next_face_id: u32,
    glyph_ids: HashMap<GlyphKey, u32>,
    glyphs: HashMap<u32, GlyphDefinition>,
    next_glyph_id: u32,
    shaped_rows: HashMap<u64, Vec<CachedShapedRow>>,
    shaped_row_count: usize,
    shaped_row_candidates: HashSet<u64>,
    scale_context: ScaleContext,
    metrics: TextMetrics,
    raster_scale: f32,
    mode: FontMode,
}

const MAX_CACHED_GLYPHS: usize = 65_536;
const MAX_CACHED_SHAPED_ROWS: usize = 128;
const MAX_SHAPED_ROW_CANDIDATES: usize = 1_024;

impl TextEngine {
    pub fn discover() -> Result<Self> {
        let requested = std::env::var("GHOSTTEA_FONT_FAMILY")
            .or_else(|_| std::env::var("ELECTRON_GHOSTTY_FONT_FAMILY"))
            .ok();
        Self::discover_with_family(requested.as_deref())
    }

    pub fn discover_with_family(requested: Option<&str>) -> Result<Self> {
        let mut database = Database::new();
        database.load_system_fonts();
        let mut preferred = Vec::new();
        if let Some(family) = requested {
            preferred.push(Family::Name(family));
        }
        preferred.extend([
            Family::Name("JetBrains Mono"),
            Family::Name("Fira Code"),
            Family::Name("Cascadia Code"),
            Family::Name("SF Mono"),
            Family::Name("Menlo"),
            Family::Name("Monaco"),
            Family::Name("Cascadia Mono"),
            Family::Name("DejaVu Sans Mono"),
            Family::Monospace,
        ]);
        let primary = database
            .query(&Query {
                families: &preferred,
                ..Query::default()
            })
            .or_else(|| {
                database
                    .faces()
                    .find(|face| face.monospaced)
                    .map(|face| face.id)
            })
            .context("no system monospace font was discovered")?;
        let primary_family = database
            .face(primary)
            .and_then(|face| face.families.first())
            .map(|family| family.0.clone())
            .context("primary font has no family name")?;

        let mut styled_faces = HashMap::new();
        for style in [
            FontStyle::default(),
            FontStyle {
                bold: true,
                italic: false,
            },
            FontStyle {
                bold: false,
                italic: true,
            },
            FontStyle {
                bold: true,
                italic: true,
            },
        ] {
            let families = [Family::Name(primary_family.as_str())];
            let face = database
                .query(&Query {
                    families: &families,
                    weight: if style.bold {
                        Weight::BOLD
                    } else {
                        Weight::NORMAL
                    },
                    stretch: Stretch::Normal,
                    style: if style.italic {
                        Style::Italic
                    } else {
                        Style::Normal
                    },
                })
                .unwrap_or(primary);
            styled_faces.insert(style, face);
        }
        let face_presentations = styled_faces
            .values()
            .copied()
            .map(|face| (face, FontPresentation::Text))
            .collect();

        Ok(Self {
            database,
            primary_family,
            styled_faces,
            face_presentations,
            fallback_order: None,
            fallback_faces: HashMap::new(),
            loaded_faces: HashMap::new(),
            next_face_id: 1,
            glyph_ids: HashMap::new(),
            glyphs: HashMap::new(),
            next_glyph_id: 1,
            shaped_rows: HashMap::new(),
            shaped_row_count: 0,
            shaped_row_candidates: HashSet::new(),
            scale_context: ScaleContext::new(),
            metrics: TextMetrics::default(),
            raster_scale: RASTER_SCALE,
            mode: FontMode::System,
        })
    }

    pub fn from_fonts(
        fonts: FontResources,
        metrics: TextMetrics,
        raster_scale: f32,
    ) -> Result<Self> {
        validate_configuration(metrics, raster_scale)?;
        let mut database = Database::new();
        let regular = load_font_resource(&mut database, &fonts.regular)?;
        let mut face_presentations = HashMap::from([(regular, fonts.regular.presentation())]);
        let bold = fonts
            .bold
            .as_ref()
            .map(|font| load_font_resource(&mut database, font))
            .transpose()?
            .unwrap_or(regular);
        let italic = fonts
            .italic
            .as_ref()
            .map(|font| load_font_resource(&mut database, font))
            .transpose()?
            .unwrap_or(regular);
        let bold_italic = fonts
            .bold_italic
            .as_ref()
            .map(|font| load_font_resource(&mut database, font))
            .transpose()?
            .unwrap_or_else(|| if bold != regular { bold } else { italic });
        if let Some(font) = &fonts.bold {
            face_presentations.insert(bold, font.presentation());
        }
        if let Some(font) = &fonts.italic {
            face_presentations.insert(italic, font.presentation());
        }
        if let Some(font) = &fonts.bold_italic {
            face_presentations.insert(bold_italic, font.presentation());
        }
        let fallback_order = fonts
            .fallbacks
            .iter()
            .map(|font| {
                let id = load_font_resource(&mut database, font)?;
                face_presentations.insert(id, font.presentation());
                Ok(FallbackFace {
                    id,
                    presentation: font.presentation(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let primary_family = database
            .face(regular)
            .and_then(|face| face.families.first())
            .map(|family| family.0.clone())
            .with_context(|| {
                format!(
                    "bundled primary font {} has no family name",
                    fonts.regular.name()
                )
            })?;
        let styled_faces = HashMap::from([
            (FontStyle::default(), regular),
            (
                FontStyle {
                    bold: true,
                    italic: false,
                },
                bold,
            ),
            (
                FontStyle {
                    bold: false,
                    italic: true,
                },
                italic,
            ),
            (
                FontStyle {
                    bold: true,
                    italic: true,
                },
                bold_italic,
            ),
        ]);

        Ok(Self {
            database,
            primary_family,
            styled_faces,
            face_presentations,
            fallback_order: Some(fallback_order),
            fallback_faces: HashMap::new(),
            loaded_faces: HashMap::new(),
            next_face_id: 1,
            glyph_ids: HashMap::new(),
            glyphs: HashMap::new(),
            next_glyph_id: 1,
            shaped_rows: HashMap::new(),
            shaped_row_count: 0,
            shaped_row_candidates: HashSet::new(),
            scale_context: ScaleContext::new(),
            metrics,
            raster_scale,
            mode: FontMode::Bundled,
        })
    }

    pub fn primary_family(&self) -> &str {
        &self.primary_family
    }

    pub fn metrics(&self) -> TextMetrics {
        self.metrics
    }

    pub fn raster_scale(&self) -> f32 {
        self.raster_scale
    }

    pub fn font_mode(&self) -> FontMode {
        self.mode
    }

    pub fn shape_row(&mut self, text: &str, style: FontStyle) -> Result<ShapedRow> {
        self.shape_styled_row(
            text,
            &[StyleSpan {
                byte_start: 0,
                byte_end: text.len(),
                style,
            }],
        )
    }

    pub fn shape_styled_row(&mut self, text: &str, spans: &[StyleSpan]) -> Result<ShapedRow> {
        self.shape_row_layout(text, spans, None)
    }

    /// Shapes using the terminal's cell boundaries, widths and columns.
    /// Empty cell metadata retains the text-only API's layout for legacy
    /// logical rows. Nonempty metadata must cover the complete UTF-8 text.
    pub fn shape_terminal_row(
        &mut self,
        text: &str,
        cells: &[TerminalCellSpan],
    ) -> Result<ShapedRow> {
        self.shape_row_layout(text, &[], (!cells.is_empty()).then_some(cells))
    }

    fn shape_row_layout(
        &mut self,
        text: &str,
        spans: &[StyleSpan],
        cells: Option<&[TerminalCellSpan]>,
    ) -> Result<ShapedRow> {
        let cache_key = shaped_row_hash(text, spans, cells);
        if let Some(shaped) = self
            .shaped_rows
            .get(&cache_key)
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.text == text && row.spans == spans && row.cells.as_deref() == cells
                })
            })
            .map(|row| row.shaped.clone())
        {
            return Ok(shaped);
        }
        let graphemes = match cells {
            Some(cells) => self.resolve_terminal_cells(text, cells)?,
            None => self.resolve_graphemes(text, spans)?,
        };
        let mut output = ShapedRow::default();
        let mut used_definitions = HashSet::new();
        let mut run_start = 0;
        while run_start < graphemes.len() {
            let face = graphemes[run_start].face;
            let mut run_end = run_start + 1;
            let style = graphemes[run_start].style;
            let presentation = graphemes[run_start].presentation;
            while run_end < graphemes.len()
                && graphemes[run_end].face == face
                && graphemes[run_end].style == style
                // Emoji need independent visual fitting while their grid
                // advance still comes from the host. Keep normal text runs
                // together so ordinary cross-cell ligatures are unchanged.
                && (cells.is_none()
                    || graphemes[run_end].presentation == presentation)
                && graphemes[run_end].cell_start
                    == graphemes[run_end - 1]
                        .cell_start
                        .saturating_add(graphemes[run_end - 1].cell_span)
            {
                run_end += 1;
            }
            self.shape_run(
                text,
                &graphemes[run_start..run_end],
                face,
                style,
                cells.is_some() && presentation == FontPresentation::Emoji,
                &mut output.glyphs,
                &mut used_definitions,
            )?;
            run_start = run_end;
        }
        let mut ids: Vec<_> = used_definitions.into_iter().collect();
        ids.sort_unstable();
        output.definitions = ids
            .into_iter()
            .filter_map(|id| self.glyphs.get(&id).cloned())
            .collect();
        if self.shaped_row_candidates.remove(&cache_key) {
            if self.shaped_row_count >= MAX_CACHED_SHAPED_ROWS {
                self.shaped_rows.clear();
                self.shaped_row_count = 0;
            }
            self.shaped_rows
                .entry(cache_key)
                .or_default()
                .push(CachedShapedRow {
                    text: text.to_owned(),
                    spans: spans.to_vec(),
                    cells: cells.map(<[_]>::to_vec),
                    shaped: output.clone(),
                });
            self.shaped_row_count += 1;
        } else {
            if self.shaped_row_candidates.len() >= MAX_SHAPED_ROW_CANDIDATES {
                self.shaped_row_candidates.clear();
            }
            self.shaped_row_candidates.insert(cache_key);
        }
        Ok(output)
    }

    fn resolve_terminal_cells<'a>(
        &mut self,
        text: &'a str,
        cells: &[TerminalCellSpan],
    ) -> Result<Vec<Grapheme<'a>>> {
        let mut byte_end = 0;
        let mut column_end = 0;
        let mut output = Vec::with_capacity(cells.len());
        for cell in cells {
            ensure!(
                cell.byte_start == byte_end && cell.byte_end > cell.byte_start,
                "terminal cells must cover the row without gaps or overlaps"
            );
            ensure!(
                cell.span > 0 && cell.column >= column_end,
                "terminal cells must have positive, non-overlapping grid spans"
            );
            let cluster = text
                .get(cell.byte_start..cell.byte_end)
                .context("terminal cell is not a valid UTF-8 range")?;
            column_end = cell
                .column
                .checked_add(cell.span)
                .context("terminal cell exceeds the grid")?;
            byte_end = cell.byte_end;
            let primary = *self
                .styled_faces
                .get(&cell.style)
                .context("missing styled primary face")?;
            let presentation = cluster_presentation(cluster);
            let face = if self.face_supports(primary, cluster)?
                && self.face_matches(primary, presentation)
            {
                primary
            } else {
                self.fallback_for(cluster, presentation).unwrap_or(primary)
            };
            output.push(Grapheme {
                text: cluster,
                byte_start: cell.byte_start,
                cell_start: cell.column,
                cell_span: cell.span,
                face,
                style: cell.style,
                presentation,
            });
        }
        ensure!(
            byte_end == text.len(),
            "terminal cells do not cover the complete row"
        );
        Ok(output)
    }

    fn resolve_graphemes<'a>(
        &mut self,
        text: &'a str,
        spans: &[StyleSpan],
    ) -> Result<Vec<Grapheme<'a>>> {
        let mut cell = 0_u16;
        let mut output = Vec::new();
        for (byte_start, cluster) in text.grapheme_indices(true) {
            let style = spans
                .iter()
                .find(|span| byte_start >= span.byte_start && byte_start < span.byte_end)
                .map(|span| span.style)
                .unwrap_or_default();
            let primary = *self
                .styled_faces
                .get(&style)
                .context("missing styled primary face")?;
            let span = UnicodeWidthStr::width(cluster).clamp(1, 2) as u16;
            let presentation = cluster_presentation(cluster);
            let face = if self.face_supports(primary, cluster)?
                && self.face_matches(primary, presentation)
            {
                primary
            } else {
                self.fallback_for(cluster, presentation).unwrap_or(primary)
            };
            output.push(Grapheme {
                text: cluster,
                byte_start,
                cell_start: cell,
                cell_span: span,
                face,
                style,
                presentation,
            });
            cell = cell.saturating_add(span);
        }
        Ok(output)
    }

    fn fallback_for(&mut self, cluster: &str, presentation: FontPresentation) -> Option<ID> {
        cluster
            .chars()
            .find(|character| !is_ignorable(*character))?;
        // Cache misses too, keyed by the entire cluster: a missing combining
        // sequence must not poison a supported base character (or vice versa).
        let cache_key = (cluster.to_owned(), presentation);
        if let Some(face) = self.fallback_faces.get(&cache_key) {
            return *face;
        }
        let faces = self.fallback_order.clone().unwrap_or_else(|| {
            self.database
                .faces()
                .map(|face| FallbackFace {
                    id: face.id,
                    presentation: self.inferred_presentation(face.id),
                })
                .collect()
        });
        let found = faces
            .iter()
            .copied()
            .find(|face| {
                face.presentation.accepts(presentation)
                    && self.face_supports(face.id, cluster).unwrap_or(false)
            })
            .or_else(|| {
                faces
                    .iter()
                    .copied()
                    .find(|face| self.face_supports(face.id, cluster).unwrap_or(false))
            })
            .map(|face| face.id);
        if self.fallback_faces.len() >= 4_096 {
            self.fallback_faces.clear();
        }
        self.fallback_faces.insert(cache_key, found);
        found
    }

    fn face_matches(&self, face: ID, presentation: FontPresentation) -> bool {
        self.inferred_presentation(face).accepts(presentation)
    }

    fn inferred_presentation(&self, face: ID) -> FontPresentation {
        self.face_presentations
            .get(&face)
            .copied()
            .unwrap_or_else(|| {
                let color_emoji = self.database.face(face).is_some_and(|face| {
                    face.post_script_name.contains("ColorEmoji")
                        || face.post_script_name.contains("Color Emoji")
                        || face
                            .families
                            .iter()
                            .any(|family| family.0.contains("Color Emoji"))
                });
                if color_emoji {
                    FontPresentation::Emoji
                } else {
                    FontPresentation::Text
                }
            })
    }

    fn face_supports(&self, face: ID, cluster: &str) -> Result<bool> {
        self.database
            .with_face_data(face, |data, index| {
                FontRef::from_index(data, index as usize).is_some_and(|font| {
                    cluster
                        .chars()
                        .filter(|character| !is_ignorable(*character))
                        .all(|character| font.charmap().map(character) != 0)
                })
            })
            .context("failed to access system font data")
    }

    #[allow(clippy::too_many_arguments)]
    fn shape_run(
        &mut self,
        full_text: &str,
        graphemes: &[Grapheme<'_>],
        face_id: ID,
        style: FontStyle,
        grid_emoji: bool,
        output: &mut Vec<GlyphInstance>,
        used_definitions: &mut HashSet<u32>,
    ) -> Result<()> {
        let metrics = self.metrics;
        let raster_scale = self.raster_scale;
        let first = graphemes.first().context("empty shaping run")?;
        let last = graphemes.last().context("empty shaping run")?;
        let byte_end = last.byte_start + last.text.len();
        let run_text = &full_text[first.byte_start..byte_end];
        let loaded = self.load_face(face_id)?;
        let shaped = shape_glyphs(
            loaded.shaping.as_ref(),
            run_text,
            graphemes
                .iter()
                .map(|grapheme| (grapheme.byte_start - first.byte_start) as u32),
            (metrics.font_size_px * 64.0).round() as i32,
        )?;
        let natural_width = shaped.iter().map(|glyph| glyph.x_advance).sum::<i32>() as f32 / 64.0;
        let target_cells = graphemes
            .iter()
            .map(|grapheme| grapheme.cell_span as u32)
            .sum::<u32>() as f32;
        let target_width = target_cells * metrics.cell_width_px;
        let run_scale_x = if natural_width.abs() > f32::EPSILON {
            target_width / natural_width
        } else {
            1.0
        };
        let mut pen_x = first.cell_start as f32 * metrics.cell_width_px;
        let mut emoji_positions = HashMap::<u32, (f32, f32)>::new();
        if grid_emoji {
            for glyph in &shaped {
                emoji_positions.entry(glyph.cluster).or_default().0 +=
                    glyph.x_advance as f32 / 64.0;
            }
        }

        let mut cluster_starts: Vec<u32> = shaped.iter().map(|glyph| glyph.cluster).collect();
        cluster_starts.sort_unstable();
        cluster_starts.dedup();
        for glyph in &shaped {
            let cluster = glyph.cluster as usize;
            let grapheme_index = graphemes
                .iter()
                .rposition(|grapheme| grapheme.byte_start - first.byte_start <= cluster)
                .unwrap_or(0);
            let cluster_cell_start = graphemes[grapheme_index].cell_start;
            let next_cluster = cluster_starts
                .iter()
                .copied()
                .find(|candidate| *candidate > glyph.cluster)
                .map(|value| value as usize);
            let cluster_end_cell = next_cluster
                .and_then(|byte| {
                    graphemes
                        .iter()
                        .find(|grapheme| grapheme.byte_start - first.byte_start >= byte)
                })
                .map(|grapheme| grapheme.cell_start)
                .unwrap_or_else(|| last.cell_start.saturating_add(last.cell_span));
            let cluster_span = cluster_end_cell.saturating_sub(cluster_cell_start).max(1);
            let (glyph_x, scale_x) = if grid_emoji {
                // Legacy width mode may reserve four (or more) columns for
                // one ZWJ emoji. Preserve its combined artwork at at most two
                // columns, then anchor the next cluster at ITS host column.
                // Breaking the ZWJ into separate shaping runs would change
                // the symbol; scaling the whole run would stretch it.
                let (advance, offset) = emoji_positions.get_mut(&glyph.cluster).unwrap();
                let scale = if advance.abs() > f32::EPSILON {
                    f32::from(cluster_span.min(2)) * metrics.cell_width_px / *advance
                } else {
                    1.0
                };
                let x = f32::from(cluster_cell_start) * metrics.cell_width_px + *offset * scale;
                *offset += glyph.x_advance as f32 / 64.0;
                (x, scale)
            } else {
                (pen_x, run_scale_x)
            };
            if let Some((glyph_id, definition)) = self.rasterize(&loaded, glyph.glyph_id, style)? {
                let x = glyph_x
                    + glyph.x_offset as f32 / 64.0 * scale_x
                    + definition.bearing_x as f32 / raster_scale * scale_x;
                let y = metrics.baseline_px
                    - glyph.y_offset as f32 / 64.0
                    - definition.bearing_y as f32 / raster_scale;
                output.push(GlyphInstance {
                    glyph_id,
                    style_id: style_id(style),
                    x,
                    y,
                    width: definition.width as f32 / raster_scale * scale_x,
                    height: definition.height as f32 / raster_scale,
                    cell_start: cluster_cell_start,
                    cell_span: cluster_span,
                });
                used_definitions.insert(glyph_id);
            }
            pen_x += glyph.x_advance as f32 / 64.0 * run_scale_x;
        }
        Ok(())
    }

    fn load_face(&mut self, id: ID) -> Result<Arc<LoadedFace>> {
        if !self.loaded_faces.contains_key(&id) {
            // System font files are treated as immutable for the ghosttead lifetime.
            let (data, index) = unsafe { self.database.make_shared_face_data(id) }
                .context("failed to memory-map system font")?;
            let face = LoadedFace {
                id: self.next_face_id,
                index,
                shaping: harfrust::Font::new(Arc::clone(&data), index),
                data,
            };
            self.next_face_id = self
                .next_face_id
                .checked_add(1)
                .context("font ID overflow")?;
            self.loaded_faces.insert(id, face);
        }
        let face = self
            .loaded_faces
            .get(&id)
            .context("loaded font disappeared")?;
        Ok(Arc::new(LoadedFace {
            id: face.id,
            index: face.index,
            data: Arc::clone(&face.data),
            shaping: face.shaping.clone(),
        }))
    }

    fn rasterize(
        &mut self,
        face: &LoadedFace,
        glyph_index: u32,
        style: FontStyle,
    ) -> Result<Option<(u32, GlyphDefinition)>> {
        let flags = u16::from(style.bold) | (u16::from(style.italic) << 1);
        let key = GlyphKey {
            face_id: face.id,
            glyph_index,
            pixel_size_26_6: (self.metrics.font_size_px * self.raster_scale * 64.0).round() as u32,
            render_flags: flags,
        };
        if let Some(id) = self.glyph_ids.get(&key).copied() {
            return Ok(self
                .glyphs
                .get(&id)
                .cloned()
                .map(|definition| (id, definition)));
        }
        if self.glyph_ids.len() >= MAX_CACHED_GLYPHS {
            self.glyph_ids.clear();
            self.glyphs.clear();
            self.shaped_rows.clear();
            self.shaped_row_count = 0;
            self.shaped_row_candidates.clear();
        }
        if glyph_index > u16::MAX as u32 {
            bail!("glyph index exceeds OpenType range");
        }
        let font = FontRef::from_index(face.data.as_ref().as_ref(), face.index as usize)
            .context("invalid raster font")?;
        let mut scaler = self
            .scale_context
            .builder(font)
            .size(self.metrics.font_size_px * self.raster_scale)
            .hint(true)
            .build();
        let image = Render::new(&[
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ])
        .format(Format::Alpha)
        .render(&mut scaler, glyph_index as u16);
        let Some(image) = image else { return Ok(None) };
        if image.placement.width == 0 || image.placement.height == 0 {
            return Ok(None);
        }
        let format = match image.content {
            Content::Mask => GlyphFormat::Alpha8,
            Content::SubpixelMask | Content::Color => GlyphFormat::Rgba8Premultiplied,
        };
        let id = self.next_glyph_id;
        self.next_glyph_id = self
            .next_glyph_id
            .checked_add(1)
            .context("glyph ID overflow")?;
        let definition = GlyphDefinition {
            id,
            width: image
                .placement
                .width
                .try_into()
                .context("glyph is too wide")?,
            height: image
                .placement
                .height
                .try_into()
                .context("glyph is too tall")?,
            bearing_x: image
                .placement
                .left
                .try_into()
                .context("glyph X bearing overflow")?,
            bearing_y: image
                .placement
                .top
                .try_into()
                .context("glyph Y bearing overflow")?,
            format,
            pixels: image.data.into(),
        };
        self.glyph_ids.insert(key, id);
        self.glyphs.insert(id, definition.clone());
        Ok(Some((id, definition)))
    }
}

/// Shapes one run with harfrust at `scale_26_6`.
///
/// A face read-fonts cannot read shapes the way HarfBuzz shaped an unreadable face: `.notdef`
/// at half an em, here one per grapheme, which the caller fits to the run's cells like any
/// other run.
fn shape_glyphs(
    font: Option<&harfrust::Font>,
    text: &str,
    grapheme_starts: impl Iterator<Item = u32>,
    scale_26_6: i32,
) -> Result<Vec<ShapedGlyph>> {
    let Some(font) = font else {
        return Ok(grapheme_starts
            .map(|cluster| ShapedGlyph {
                glyph_id: 0,
                cluster,
                x_advance: scale_26_6 / 2,
                x_offset: 0,
                y_offset: 0,
            })
            .collect());
    };
    let shaper = ShaperFont::new(font).with_scale(scale_26_6);
    let mut buffer = Buffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    shape(&shaper, &mut buffer, ShapeOptions::new()).context("shape a text run")?;
    Ok(buffer
        .glyph_infos()
        .iter()
        .zip(buffer.glyph_positions())
        .map(|(info, position)| ShapedGlyph {
            glyph_id: info.glyph_id,
            cluster: info.cluster,
            x_advance: position.x_advance,
            x_offset: position.x_offset,
            y_offset: position.y_offset,
        })
        .collect())
}

fn validate_configuration(metrics: TextMetrics, raster_scale: f32) -> Result<()> {
    for (name, value) in [
        ("font size", metrics.font_size_px),
        ("cell width", metrics.cell_width_px),
        ("line height", metrics.line_height_px),
        ("baseline", metrics.baseline_px),
        ("raster scale", raster_scale),
    ] {
        if !value.is_finite() || value <= 0.0 {
            bail!("text {name} must be finite and positive");
        }
    }
    if metrics.baseline_px > metrics.line_height_px {
        bail!("text baseline must not exceed line height");
    }
    Ok(())
}

fn load_font_resource(database: &mut Database, resource: &FontResource) -> Result<ID> {
    if resource.bytes.is_empty() {
        bail!("font resource {} is empty", resource.name());
    }
    let source: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::clone(&resource.bytes) as _;
    let ids = database.load_font_source(FontSource::Binary(source));
    ids.get(resource.face_index).copied().with_context(|| {
        format!(
            "font resource {} has no face at index {}",
            resource.name(),
            resource.face_index
        )
    })
}

fn is_ignorable(character: char) -> bool {
    character == '\u{200d}'
        || character == '\u{fe0e}'
        || character == '\u{fe0f}'
        || character.is_control()
}

fn cluster_presentation(cluster: &str) -> FontPresentation {
    for character in cluster.chars() {
        match character {
            '\u{fe0e}' => return FontPresentation::Text,
            '\u{fe0f}' => return FontPresentation::Emoji,
            _ => {}
        }
    }
    cluster
        .chars()
        .find(|character| !is_ignorable(*character))
        .filter(|character| has_default_emoji_presentation(*character))
        .map_or(FontPresentation::Text, |_| FontPresentation::Emoji)
}

fn style_id(style: FontStyle) -> u32 {
    u32::from(style.bold) | (u32::from(style.italic) << 1)
}

fn shaped_row_hash(text: &str, spans: &[StyleSpan], cells: Option<&[TerminalCellSpan]>) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    spans.hash(&mut hasher);
    cells.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_monospace_resource() -> FontResource {
        let mut database = Database::new();
        database.load_system_fonts();
        let face = database
            .query(&Query {
                families: &[Family::Monospace],
                ..Query::default()
            })
            .or_else(|| {
                database
                    .faces()
                    .find(|face| face.monospaced)
                    .map(|face| face.id)
            })
            .expect("test host must provide a monospace font");
        let (bytes, index) = database
            .with_face_data(face, |bytes, index| (bytes.to_vec(), index))
            .expect("test system font must be readable");
        FontResource::new("test-monospace", bytes).with_face_index(index as usize)
    }

    pub(super) fn presentation_test_engine() -> TextEngine {
        let mut fonts = FontResources::new(FontResource::new(
            "JetBrainsMonoNerdFont-Regular.ttf",
            include_bytes!(
                "../../../../../apple/GhostteaKit/Sources/GhostteaFontProof/Resources/Fonts/JetBrainsMonoNerdFont-Regular.ttf"
            )
            .to_vec(),
        ));
        fonts.fallbacks = vec![
            FontResource::new(
                "NotoColorEmoji.ttf",
                include_bytes!(
                    "../../../../../apple/GhostteaKit/Sources/GhostteaFontProof/Resources/Fonts/NotoColorEmoji.ttf"
                )
                .to_vec(),
            )
            .with_presentation(FontPresentation::Emoji),
            FontResource::new(
                "STIXTwoMath-Regular.otf",
                include_bytes!("../../../../font-resources/STIXTwoMath-Regular.otf").to_vec(),
            )
            .with_presentation(FontPresentation::Text),
            FontResource::new(
                "NotoSansSymbols2-Regular.ttf",
                include_bytes!("../../../../font-resources/NotoSansSymbols2-Regular.ttf").to_vec(),
            )
            .with_presentation(FontPresentation::Text),
            FontResource::new(
                "NotoEmoji-Regular.ttf",
                include_bytes!(
                    "../../../../../apple/GhostteaKit/Sources/GhostteaFontProof/Resources/Fonts/NotoEmoji-Regular.ttf"
                )
                .to_vec(),
            )
            .with_presentation(FontPresentation::Text),
        ];
        TextEngine::from_fonts(fonts, TextMetrics::default(), RASTER_SCALE).unwrap()
    }

    #[test]
    fn remembers_missing_fallbacks_without_poisoning_other_clusters() {
        let mut engine = TextEngine::discover().unwrap();
        let missing = "\u{10ffff}";
        assert_eq!(engine.fallback_for(missing, FontPresentation::Text), None);
        assert_eq!(
            engine
                .fallback_faces
                .get(&(missing.into(), FontPresentation::Text)),
            Some(&None)
        );
        assert_eq!(engine.fallback_for(missing, FontPresentation::Text), None);
        assert!(engine.fallback_for("a", FontPresentation::Text).is_some());
    }

    #[test]
    fn terminal_layout_preserves_missing_glyph_width_and_separates_cached_host_layouts() {
        let mut engine = presentation_test_engine();
        let text = "\u{1f6d9}X";
        // Unicode 17 and 18 hosts disagree about the new character's width.
        // Neither bundled emoji font has artwork yet; the next cell still
        // belongs at the position sent by that host, including on cache hits.
        assert_eq!(
            engine.fallback_for("\u{1f6d9}", FontPresentation::Emoji),
            None
        );
        for width in [1, 2, 1, 2, 2, 1] {
            let cells = [
                TerminalCellSpan {
                    byte_start: 0,
                    byte_end: 4,
                    column: 0,
                    span: width,
                    style: FontStyle::default(),
                },
                TerminalCellSpan {
                    byte_start: 4,
                    byte_end: 5,
                    column: width,
                    span: 1,
                    style: FontStyle::default(),
                },
            ];
            let shaped = engine.shape_terminal_row(text, &cells).unwrap();
            assert!(
                shaped
                    .glyphs
                    .iter()
                    .any(|glyph| glyph.cell_start == width && glyph.cell_span == 1)
            );
            assert!(
                shaped
                    .glyphs
                    .iter()
                    .any(|glyph| glyph.cell_start == 0 && glyph.cell_span == width)
            );
        }
    }

    #[test]
    fn terminal_layout_keeps_grid_gaps_and_rejects_invalid_utf8_ranges() {
        let mut engine = presentation_test_engine();
        let mut cells = [
            TerminalCellSpan {
                byte_start: 0,
                byte_end: 1,
                column: 0,
                span: 1,
                style: FontStyle::default(),
            },
            TerminalCellSpan {
                byte_start: 1,
                byte_end: 2,
                column: 5,
                span: 1,
                style: FontStyle::default(),
            },
        ];
        let shaped = engine.shape_terminal_row("XX", &cells).unwrap();
        assert_eq!(
            shaped
                .glyphs
                .iter()
                .map(|g| g.cell_start)
                .collect::<Vec<_>>(),
            [0, 5]
        );
        assert!(shaped.glyphs[1].x >= 5.0 * engine.metrics().cell_width_px);
        assert!(engine.shape_terminal_row("é", &cells).is_err());
        cells[1].column = 0;
        assert!(engine.shape_terminal_row("XX", &cells).is_err());
        cells[1].column = 1;
        cells[1].span = 0;
        assert!(engine.shape_terminal_row("XX", &cells).is_err());
    }

    #[test]
    fn resolves_unicode_and_explicit_presentation_selectors() {
        assert_eq!(cluster_presentation("\u{23f8}"), FontPresentation::Text);
        assert_eq!(
            cluster_presentation("\u{23f8}\u{fe0e}"),
            FontPresentation::Text
        );
        assert_eq!(
            cluster_presentation("\u{23f8}\u{fe0f}"),
            FontPresentation::Emoji
        );
        assert_eq!(cluster_presentation("\u{1f600}"), FontPresentation::Emoji);
        assert_eq!(cluster_presentation("\u{26a0}"), FontPresentation::Text);
    }

    #[test]
    fn renders_text_default_symbols_as_alpha_and_real_emoji_as_color() {
        let mut engine = presentation_test_engine();
        let pause = engine.shape_row("\u{23f8}", FontStyle::default()).unwrap();
        assert!(!pause.definitions.is_empty());
        assert!(
            pause
                .definitions
                .iter()
                .all(|definition| definition.format == GlyphFormat::Alpha8)
        );

        let emoji_pause = engine
            .shape_row("\u{23f8}\u{fe0f}", FontStyle::default())
            .unwrap();
        assert!(
            emoji_pause
                .definitions
                .iter()
                .any(|definition| definition.format == GlyphFormat::Rgba8Premultiplied)
        );

        let grin = engine.shape_row("\u{1f600}", FontStyle::default()).unwrap();
        assert!(
            grin.definitions
                .iter()
                .any(|definition| definition.format == GlyphFormat::Rgba8Premultiplied)
        );

        for symbol in ["✻", "⚠"] {
            let row = engine.shape_row(symbol, FontStyle::default()).unwrap();
            assert!(
                !row.definitions.is_empty(),
                "{symbol} must resolve through text fallback"
            );
            assert!(
                row.definitions
                    .iter()
                    .all(|definition| definition.format == GlyphFormat::Alpha8),
                "{symbol} must not silently become an emoji"
            );
        }
    }

    #[test]
    fn resolves_missing_symbols_by_ordered_font_coverage() {
        let mut engine = presentation_test_engine();
        let graphemes = engine
            .resolve_graphemes("⏸✻⚠←·", &[])
            .expect("symbol cascade must resolve");
        let postscript_names = graphemes
            .iter()
            .map(|grapheme| {
                engine
                    .database
                    .face(grapheme.face)
                    .expect("resolved face metadata")
                    .post_script_name
                    .as_str()
            })
            .collect::<Vec<_>>();

        assert_eq!(postscript_names[0], "STIXTwoMath-Regular");
        assert_eq!(postscript_names[1], "NotoSansSymbols2-Regular");
        assert_eq!(postscript_names[3], "JetBrainsMonoNF-Regular");
        assert_eq!(postscript_names[4], "JetBrainsMonoNF-Regular");
    }

    #[test]
    fn loads_font_bytes_with_explicit_metrics_and_raster_scale() {
        let metrics = TextMetrics {
            font_size_px: 14.0,
            cell_width_px: 8.25,
            line_height_px: 20.0,
            baseline_px: 15.0,
        };
        let mut engine = TextEngine::from_fonts(
            FontResources::new(system_monospace_resource()),
            metrics,
            3.0,
        )
        .unwrap();

        assert_eq!(engine.font_mode(), FontMode::Bundled);
        assert_eq!(engine.metrics(), metrics);
        assert_eq!(engine.raster_scale(), 3.0);
        let row = engine.shape_row("explicit", FontStyle::default()).unwrap();
        assert!(!row.glyphs.is_empty());
        assert!(row.definitions.iter().all(|glyph| !glyph.pixels.is_empty()));
    }

    #[test]
    fn rejects_invalid_font_resources_and_metrics() {
        assert!(
            TextEngine::from_fonts(
                FontResources::new(FontResource::new("empty", Vec::new())),
                TextMetrics::default(),
                RASTER_SCALE,
            )
            .is_err()
        );
        assert!(
            TextEngine::from_fonts(
                FontResources::new(system_monospace_resource()),
                TextMetrics {
                    cell_width_px: 0.0,
                    ..TextMetrics::default()
                },
                RASTER_SCALE,
            )
            .is_err()
        );
    }

    #[cfg(feature = "fixture")]
    #[test]
    fn normalized_fixture_is_repeatable_for_the_same_font_bytes() {
        let font = system_monospace_resource();
        let cases = [ShapingFixtureCase {
            name: "mixed".into(),
            text: "ffi e\u{301} 0123".into(),
            bold: false,
            italic: false,
        }];
        let mut first = TextEngine::from_fonts(
            FontResources::new(font.clone()),
            TextMetrics::default(),
            RASTER_SCALE,
        )
        .unwrap();
        let mut second = TextEngine::from_fonts(
            FontResources::new(font),
            TextMetrics::default(),
            RASTER_SCALE,
        )
        .unwrap();

        let first = first.shaping_fixture(&cases).unwrap();
        let second = second.shaping_fixture(&cases).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.font_mode, "bundled");
        assert_eq!(first.faces.len(), 1);
    }

    #[test]
    fn an_unreadable_face_shapes_one_notdef_per_grapheme() {
        let glyphs = shape_glyphs(None, "e\u{301} 界", [0, 3, 4].into_iter(), 832).unwrap();
        assert_eq!(
            glyphs
                .iter()
                .map(|glyph| (glyph.glyph_id, glyph.cluster, glyph.x_advance))
                .collect::<Vec<_>>(),
            [(0, 0, 416), (0, 3, 416), (0, 4, 416)]
        );
    }

    #[test]
    fn shapes_ligatures_combining_marks_and_wide_text_without_cell_drift() {
        let mut engine = TextEngine::discover().unwrap();
        let row = engine
            .shape_row("ffi e\u{301} 界", FontStyle::default())
            .unwrap();
        assert!(!row.glyphs.is_empty());
        assert!(
            row.glyphs
                .iter()
                .all(|glyph| glyph.x.is_finite() && glyph.y.is_finite())
        );
        assert!(row.glyphs.iter().any(|glyph| glyph.cell_span >= 2));
        assert!(row.definitions.iter().all(|glyph| !glyph.pixels.is_empty()));
    }

    #[test]
    fn resolves_bold_and_italic_profiles() {
        let mut engine = TextEngine::discover().unwrap();
        for style in [
            FontStyle {
                bold: true,
                italic: false,
            },
            FontStyle {
                bold: false,
                italic: true,
            },
            FontStyle {
                bold: true,
                italic: true,
            },
        ] {
            let row = engine.shape_row("agent => ready", style).unwrap();
            assert!(!row.glyphs.is_empty());
            assert!(
                row.glyphs
                    .iter()
                    .all(|glyph| glyph.style_id == style_id(style))
            );
        }
    }

    #[test]
    fn applies_style_spans_without_breaking_cell_positions() {
        let mut engine = TextEngine::discover().unwrap();
        let row = engine
            .shape_styled_row(
                "normal bold italic",
                &[
                    StyleSpan {
                        byte_start: 0,
                        byte_end: 7,
                        style: FontStyle::default(),
                    },
                    StyleSpan {
                        byte_start: 7,
                        byte_end: 12,
                        style: FontStyle {
                            bold: true,
                            italic: false,
                        },
                    },
                    StyleSpan {
                        byte_start: 12,
                        byte_end: 19,
                        style: FontStyle {
                            bold: false,
                            italic: true,
                        },
                    },
                ],
            )
            .unwrap();
        assert!(row.glyphs.iter().any(|glyph| glyph.style_id == 1));
        assert!(row.glyphs.iter().any(|glyph| glyph.style_id == 2));
        assert!(
            row.glyphs
                .windows(2)
                .all(|pair| pair[0].x <= pair[1].x + CELL_WIDTH_PX)
        );
    }

    #[test]
    fn repeated_rows_share_a_bounded_shape_cache() {
        let mut engine = TextEngine::discover().unwrap();
        let spans = [StyleSpan {
            byte_start: 0,
            byte_end: 6,
            style: FontStyle::default(),
        }];
        engine.shape_styled_row("cached", &spans).unwrap();
        assert_eq!(engine.shaped_row_count, 0);

        engine.shape_styled_row("cached", &spans).unwrap();
        assert_eq!(engine.shaped_row_count, 1);

        engine.shape_styled_row("cached", &spans).unwrap();
        assert_eq!(engine.shaped_row_count, 1);

        engine.shape_row("different", FontStyle::default()).unwrap();
        assert_eq!(engine.shaped_row_count, 1);
    }
}

#[cfg(test)]
mod terminal_emoji_boundaries {
    use super::*;

    #[test]
    fn emoji_joining_respects_host_cell_boundaries_without_stretching() {
        let mut engine = super::tests::presentation_test_engine();
        let text = "👩\u{200d}💻X";
        let style = FontStyle::default();
        // Legacy width accounting keeps the two emoji in separate cells.
        let split = [
            TerminalCellSpan {
                byte_start: 0,
                byte_end: 7,
                column: 0,
                span: 2,
                style,
            },
            TerminalCellSpan {
                byte_start: 7,
                byte_end: 11,
                column: 2,
                span: 2,
                style,
            },
            TerminalCellSpan {
                byte_start: 11,
                byte_end: 12,
                column: 4,
                span: 1,
                style,
            },
        ];
        let row = engine.shape_terminal_row(text, &split).unwrap();
        assert!(
            row.glyphs
                .iter()
                .all(|glyph| glyph.width <= 2.0 * engine.metrics().cell_width_px + 1.0),
            "a joined emoji must not stretch across distinct terminal cells: {:?}",
            row.glyphs
        );
        assert!(
            row.glyphs
                .iter()
                .any(|glyph| glyph.cell_start == 4 && glyph.cell_span == 1)
        );
        assert_eq!(
            row.glyphs.len(),
            2,
            "the ZWJ must remain one combined emoji plus X"
        );
        let split_emoji = row.glyphs[0];
        // Mode 2027 hosts give the entire ZWJ sequence one two-column cell.
        let joined = [
            TerminalCellSpan {
                byte_start: 0,
                byte_end: 11,
                column: 0,
                span: 2,
                style,
            },
            TerminalCellSpan {
                byte_start: 11,
                byte_end: 12,
                column: 2,
                span: 1,
                style,
            },
        ];
        let row = engine.shape_terminal_row(text, &joined).unwrap();
        assert!(
            row.glyphs
                .iter()
                .any(|glyph| glyph.cell_start == 0 && glyph.cell_span == 2)
        );
        assert!(
            row.glyphs
                .iter()
                .any(|glyph| glyph.cell_start == 2 && glyph.cell_span == 1)
        );
        assert_eq!(row.glyphs[0].glyph_id, split_emoji.glyph_id);
        assert_eq!(row.glyphs[0].width, split_emoji.width);
        assert_eq!(row.glyphs[0].height, split_emoji.height);
        let adjacent = engine
            .shape_terminal_row(
                "👩‍💻😀X",
                &[
                    TerminalCellSpan {
                        byte_start: 0,
                        byte_end: 7,
                        column: 0,
                        span: 2,
                        style,
                    },
                    TerminalCellSpan {
                        byte_start: 7,
                        byte_end: 11,
                        column: 2,
                        span: 2,
                        style,
                    },
                    TerminalCellSpan {
                        byte_start: 11,
                        byte_end: 15,
                        column: 4,
                        span: 2,
                        style,
                    },
                    TerminalCellSpan {
                        byte_start: 15,
                        byte_end: 16,
                        column: 6,
                        span: 1,
                        style,
                    },
                ],
            )
            .unwrap();
        let second_emoji = adjacent
            .glyphs
            .iter()
            .find(|glyph| glyph.cell_start == 4)
            .unwrap();
        assert!((second_emoji.x - 4.0 * engine.metrics().cell_width_px).abs() < 1.0);
        assert!(
            adjacent
                .glyphs
                .iter()
                .any(|glyph| glyph.cell_start == 6 && glyph.cell_span == 1)
        );
    }
}
