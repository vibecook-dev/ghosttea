// Keep the native-linking crate in the dependency graph. Its build script is
// the single owner of locating and linking the Ghostty VT artifact.
use ghosttea_vt_sys as _;

use std::{ffi::c_void, fmt, ptr::NonNull};

const EFFECT_BELL: u32 = 1 << 0;
const EFFECT_CLIPBOARD: u32 = 1 << 3;

#[repr(C)]
struct RawTerminal {
    _private: [u8; 0],
}

#[repr(C)]
struct RawTrackedSelection {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Default)]
struct RawSnapshotMeta {
    cols: u16,
    rows: u16,
    cursor_x: u16,
    cursor_y: u16,
    cursor_visible: u8,
    cursor_style: u8,
    cursor_blinking: u8,
    full_dirty: u8,
    dirty_count: u16,
    effects: u32,
}

type RowCallback = unsafe extern "C" fn(*mut c_void, u32, *const u8, usize, bool, bool, bool, u8);

#[repr(C)]
struct RawCellStyle {
    flags: u8,
    fg_kind: u8,
    fg_palette: u8,
    fg_r: u8,
    fg_g: u8,
    fg_b: u8,
    bg_kind: u8,
    bg_palette: u8,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
}

#[repr(C)]
#[derive(Default)]
struct RawScrollbar {
    total: u64,
    offset: u64,
    len: u64,
}

#[repr(C)]
#[derive(Default)]
struct RawSelection {
    start_column: u16,
    start_row: u32,
    end_column: u16,
    end_row: u32,
}

type CellCallback =
    unsafe extern "C" fn(*mut c_void, u32, u16, u16, *const u8, usize, *const RawCellStyle);

type HyperlinkUriCallback = unsafe extern "C" fn(*mut c_void, u32, u16, u16, *const u8, usize);
type HyperlinkIdentityCallback =
    unsafe extern "C" fn(*mut c_void, u32, u16, u16, u8, *const u8, usize, u64);
type CursorHyperlinkCallback =
    unsafe extern "C" fn(*mut c_void, *const u8, usize, u8, *const u8, usize, u64);

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawStyleColor {
    kind: u8,
    palette: u8,
    r: u8,
    g: u8,
    b: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawTerminalStyle {
    flags: u16,
    underline: i32,
    foreground: RawStyleColor,
    background: RawStyleColor,
    underline_color: RawStyleColor,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct RawCharsetState {
    g0: u8,
    g1: u8,
    g2: u8,
    g3: u8,
    gl: u8,
    gr: u8,
    single_shift: u8,
}

#[repr(C)]
#[derive(Default)]
struct RawSavedCursor {
    x: u16,
    y: u16,
    style: RawTerminalStyle,
    protected_cell: bool,
    pending_wrap: bool,
    origin: bool,
    charset: RawCharsetState,
}

#[repr(C)]
#[derive(Default)]
struct RawScreenMeta {
    cols: u16,
    rows: u16,
    total_rows: u64,
    scrollback_rows: u64,
    cursor_x: u16,
    cursor_y: u16,
    cursor_visual_style: u8,
    cursor_style: RawTerminalStyle,
    cursor_protected: bool,
    cursor_pending_wrap: bool,
    charset: RawCharsetState,
    kitty_keyboard_flags: u8,
    viewport_offset: u64,
    cursor_semantic_content: u8,
    cursor_semantic_content_clear_eol: bool,
    hyperlink_implicit_id: u64,
    protected_mode: u8,
    kitty_keyboard_stack: [u8; 8],
    kitty_keyboard_index: u8,
    semantic_prompt_seen: bool,
    semantic_prompt_click: u8,
}

type ScreenCellCallback = unsafe extern "C" fn(
    *mut c_void,
    u32,
    u16,
    u16,
    *const u8,
    usize,
    *const RawTerminalStyle,
    bool,
    u8,
);

unsafe extern "C" {
    fn eg_terminal_new(cols: u16, rows: u16, max_scrollback: usize) -> *mut RawTerminal;
    fn eg_terminal_free(terminal: *mut RawTerminal);
    fn eg_terminal_write(terminal: *mut RawTerminal, data: *const u8, len: usize);
    fn eg_terminal_resize(terminal: *mut RawTerminal, cols: u16, rows: u16) -> i32;
    fn eg_terminal_set_colors(
        terminal: *mut RawTerminal,
        fg_r: u8,
        fg_g: u8,
        fg_b: u8,
        bg_r: u8,
        bg_g: u8,
        bg_b: u8,
        cursor_r: u8,
        cursor_g: u8,
        cursor_b: u8,
    ) -> i32;
    fn eg_terminal_set_palette(
        terminal: *mut RawTerminal,
        indices: *const u8,
        colors: *const u8,
        len: usize,
    ) -> i32;
    fn eg_default_palette(colors: *mut u8, len: usize) -> i32;
    fn eg_terminal_scroll(terminal: *mut RawTerminal, rows: isize);
    fn eg_terminal_scroll_to(terminal: *mut RawTerminal, row: usize);
    fn eg_terminal_compress_scrollback_full(terminal: *mut RawTerminal) -> i32;
    fn eg_terminal_scrollbar(terminal: *mut RawTerminal, scrollbar: *mut RawScrollbar) -> bool;
    fn eg_terminal_mouse_tracking(terminal: *mut RawTerminal) -> bool;
    fn eg_terminal_alternate_scroll(terminal: *mut RawTerminal) -> bool;
    fn eg_terminal_mode_get_raw(
        terminal: *mut RawTerminal,
        value: u16,
        ansi: bool,
        out_value: *mut bool,
    ) -> i32;
    fn eg_terminal_pending_wrap(terminal: *mut RawTerminal, out_value: *mut bool) -> i32;
    fn eg_terminal_track_selection(
        terminal: *mut RawTerminal,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    ) -> *mut RawTrackedSelection;
    fn eg_tracked_selection_free(selection: *mut RawTrackedSelection);
    fn eg_terminal_tracked_selection_points(
        terminal: *mut RawTerminal,
        selection: *const RawTrackedSelection,
        points: *mut RawSelection,
    ) -> bool;
    fn eg_terminal_tracked_selection_text(
        terminal: *mut RawTerminal,
        selection: *const RawTrackedSelection,
        out: *mut u8,
        cap: usize,
    ) -> usize;
    fn eg_terminal_snapshot(
        terminal: *mut RawTerminal,
        meta: *mut RawSnapshotMeta,
        row_fn: RowCallback,
        cell_fn: CellCallback,
        hyperlink_fn: HyperlinkUriCallback,
        userdata: *mut c_void,
    ) -> i32;
    fn eg_terminal_recovery_fragment(terminal: *mut RawTerminal, out: *mut u8, cap: usize)
    -> usize;
    fn eg_terminal_recovery_state(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_saved_cursor(
        terminal: *mut RawTerminal,
        screen: u8,
        out_cursor: *mut RawSavedCursor,
    ) -> i32;
    fn eg_terminal_screen_snapshot(
        terminal: *mut RawTerminal,
        screen: u8,
        meta: *mut RawScreenMeta,
        row_fn: RowCallback,
        cell_fn: ScreenCellCallback,
        hyperlink_fn: HyperlinkUriCallback,
        userdata: *mut c_void,
    ) -> i32;
    fn eg_terminal_screen_hyperlink_identities(
        terminal: *mut RawTerminal,
        screen: u8,
        identity_fn: HyperlinkIdentityCallback,
        userdata: *mut c_void,
    ) -> i32;
    fn eg_terminal_screen_cursor_hyperlink(
        terminal: *mut RawTerminal,
        screen: u8,
        hyperlink_fn: CursorHyperlinkCallback,
        userdata: *mut c_void,
    ) -> i32;
    fn eg_terminal_take_response(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_title(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_pwd(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_take_clipboard(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_encode_key(
        terminal: *mut RawTerminal,
        code: *const u8,
        code_len: usize,
        text: *const u8,
        text_len: usize,
        unshifted_codepoint: u32,
        mods: u16,
        action: u8,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_mouse(
        terminal: *mut RawTerminal,
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
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_focus(
        terminal: *mut RawTerminal,
        focused: bool,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_paste(
        terminal: *mut RawTerminal,
        data: *const u8,
        data_len: usize,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GhosttyError(i32);

impl fmt::Display for GhosttyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "libghostty-vt returned error {}", self.0)
    }
}

impl std::error::Error for GhosttyError {}

#[derive(Debug, Clone, Default)]
pub struct TerminalDamage {
    pub full: bool,
    pub dirty_rows: Vec<u16>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalScrollbar {
    pub total: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Default)]
pub struct CursorState {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct CellStyle {
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub underline: bool,
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum TerminalStyleColor {
    #[default]
    Default,
    Palette(u8),
    Rgb([u8; 3]),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct TerminalStyle {
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub blink: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub overline: bool,
    /// Ghostty's SGR underline value (none, single, double, curly, dotted,
    /// dashed). Kept numeric so new upstream variants remain representable.
    pub underline: i32,
    pub foreground: TerminalStyleColor,
    pub background: TerminalStyleColor,
    pub underline_color: TerminalStyleColor,
}

impl From<RawTerminalStyle> for TerminalStyle {
    fn from(raw: RawTerminalStyle) -> Self {
        fn color(raw: RawStyleColor) -> TerminalStyleColor {
            match raw.kind {
                1 => TerminalStyleColor::Palette(raw.palette),
                2 => TerminalStyleColor::Rgb([raw.r, raw.g, raw.b]),
                _ => TerminalStyleColor::Default,
            }
        }
        Self {
            bold: raw.flags & 1 != 0,
            italic: raw.flags & 2 != 0,
            faint: raw.flags & 4 != 0,
            blink: raw.flags & 8 != 0,
            inverse: raw.flags & 16 != 0,
            invisible: raw.flags & 32 != 0,
            strikethrough: raw.flags & 64 != 0,
            overline: raw.flags & 128 != 0,
            underline: raw.underline,
            foreground: color(raw.foreground),
            background: color(raw.background),
            underline_color: color(raw.underline_color),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalCharset {
    Utf8,
    Ascii,
    British,
    DecSpecial,
}

impl TerminalCharset {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Ascii,
            2 => Self::British,
            3 => Self::DecSpecial,
            _ => Self::Utf8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalCharsetSlot {
    G0,
    G1,
    G2,
    G3,
}

impl TerminalCharsetSlot {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::G1,
            2 => Self::G2,
            3 => Self::G3,
            _ => Self::G0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TerminalCharsetState {
    pub g0: TerminalCharset,
    pub g1: TerminalCharset,
    pub g2: TerminalCharset,
    pub g3: TerminalCharset,
    pub gl: TerminalCharsetSlot,
    pub gr: TerminalCharsetSlot,
    pub single_shift: Option<TerminalCharsetSlot>,
}

impl From<RawCharsetState> for TerminalCharsetState {
    fn from(raw: RawCharsetState) -> Self {
        Self {
            g0: TerminalCharset::from_raw(raw.g0),
            g1: TerminalCharset::from_raw(raw.g1),
            g2: TerminalCharset::from_raw(raw.g2),
            g3: TerminalCharset::from_raw(raw.g3),
            gl: TerminalCharsetSlot::from_raw(raw.gl),
            gr: TerminalCharsetSlot::from_raw(raw.gr),
            single_shift: (raw.single_shift != u8::MAX)
                .then(|| TerminalCharsetSlot::from_raw(raw.single_shift)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminalScreen {
    Primary,
    Alternate,
}

impl TerminalScreen {
    const fn raw(self) -> u8 {
        match self {
            Self::Primary => 0,
            Self::Alternate => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedCursor {
    pub x: u16,
    pub y: u16,
    pub style: TerminalStyle,
    pub protected: bool,
    pub pending_wrap: bool,
    pub origin: bool,
    pub charset: TerminalCharsetState,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TerminalRowSemanticPrompt {
    #[default]
    None,
    Prompt,
    PromptContinuation,
    Unknown(u8),
}

impl TerminalRowSemanticPrompt {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::None,
            1 => Self::Prompt,
            2 => Self::PromptContinuation,
            value => Self::Unknown(value),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalRowMetadata {
    pub wrap: bool,
    pub wrap_continuation: bool,
    pub semantic_prompt: TerminalRowSemanticPrompt,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TerminalHyperlinkIdentity {
    Explicit(Vec<u8>),
    Implicit(u64),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TerminalHyperlinkRun {
    pub row: u32,
    pub start_column: u16,
    /// Exclusive end column.
    pub end_column: u16,
    /// `None` on the URI-only G18/G20 surface. Call
    /// `screen_hyperlink_identities` to compose in G21 identity data.
    pub identity: Option<TerminalHyperlinkIdentity>,
    pub uri: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TerminalHyperlinkIdentityRun {
    pub row: u32,
    pub start_column: u16,
    /// Exclusive end column.
    pub end_column: u16,
    pub identity: TerminalHyperlinkIdentity,
}

#[derive(Debug, Clone, Default)]
pub struct TerminalCell {
    pub column: u16,
    pub span: u16,
    pub text: String,
    pub style: CellStyle,
    /// Semantic color source retained for replicated renderers. The resolved
    /// RGB remains in `style` as the protocol-minor-7 fallback.
    pub foreground_default: bool,
    pub foreground_palette: Option<u8>,
    pub background_default: bool,
    pub background_palette: Option<u8>,
}

pub type TerminalPalette = [[u8; 3]; 256];

/// Ghostty's canonical 256-color palette with sparse embedder overrides.
/// Keeping this in the VT boundary prevents Swift and the replica renderer
/// from growing subtly different xterm palette tables.
pub fn resolved_palette(entries: &[(u8, [u8; 3])]) -> TerminalPalette {
    let mut bytes = [0_u8; 256 * 3];
    let result = unsafe { eg_default_palette(bytes.as_mut_ptr(), bytes.len()) };
    debug_assert_eq!(result, 0, "Ghostty default palette lookup must succeed");
    let mut palette = [[0_u8; 3]; 256];
    for (index, color) in palette.iter_mut().enumerate() {
        let offset = index * 3;
        *color = [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
    }
    for &(index, color) in entries {
        palette[index as usize] = color;
    }
    palette
}

#[derive(Debug, Clone, Default)]
pub struct TerminalSnapshot {
    pub cols: u16,
    pub rows: Vec<String>,
    pub cells: Vec<Vec<TerminalCell>>,
    pub row_metadata: Vec<TerminalRowMetadata>,
    pub hyperlinks: Vec<TerminalHyperlinkRun>,
    pub cursor: CursorState,
    pub damage: TerminalDamage,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub bell: bool,
    pub mouse_tracking: bool,
    pub scrollbar: TerminalScrollbar,
    pub selection: Option<TerminalSelection>,
    pub clipboard: Option<Vec<u8>>,
    pub pty_response: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalSemanticContent {
    Output,
    Input,
    Prompt,
    Unknown(u8),
}

impl TerminalSemanticContent {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::Output,
            1 => Self::Input,
            2 => Self::Prompt,
            value => Self::Unknown(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalScreenCell {
    pub column: u16,
    pub span: u16,
    pub text: String,
    pub style: TerminalStyle,
    pub protected: bool,
    pub semantic_content: TerminalSemanticContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalScreenRow {
    pub text: String,
    pub cells: Vec<TerminalScreenCell>,
    pub metadata: TerminalRowMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalScreenState {
    pub cols: u16,
    pub rows: u16,
    pub total_rows: u64,
    pub scrollback_rows: u64,
    pub cursor_x: u16,
    pub cursor_y: u16,
    pub cursor_visual_style: u8,
    pub cursor_style: TerminalStyle,
    pub cursor_protected: bool,
    pub cursor_pending_wrap: bool,
    pub charset: TerminalCharsetState,
    /// Convenience copy of `kitty_keyboard.stack[kitty_keyboard.index]`.
    pub kitty_keyboard_flags: u8,
    pub viewport_offset: u64,
    pub cursor_semantic_content: TerminalSemanticContent,
    pub cursor_semantic_content_clear_eol: bool,
    pub hyperlink_implicit_id: u64,
    pub protected_mode: TerminalProtectedMode,
    pub kitty_keyboard: TerminalKittyKeyboardState,
    pub semantic_prompt: TerminalSemanticPromptState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalProtectedMode {
    Off,
    Iso,
    Dec,
    Unknown(u8),
}

impl TerminalProtectedMode {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::Off,
            1 => Self::Iso,
            2 => Self::Dec,
            value => Self::Unknown(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalKittyKeyboardState {
    pub stack: [u8; 8],
    pub index: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalSemanticPromptClick {
    None,
    ClickEventsAbsolute,
    ClickEventsRelative,
    Line,
    Multiple,
    ConservativeVertical,
    SmartVertical,
    Unknown(u8),
}

impl TerminalSemanticPromptClick {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::None,
            1 => Self::ClickEventsAbsolute,
            2 => Self::ClickEventsRelative,
            3 => Self::Line,
            4 => Self::Multiple,
            5 => Self::ConservativeVertical,
            6 => Self::SmartVertical,
            value => Self::Unknown(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSemanticPromptState {
    pub seen: bool,
    pub click: TerminalSemanticPromptClick,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCursorHyperlink {
    pub uri: Vec<u8>,
    pub identity: TerminalHyperlinkIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalScreenSnapshot {
    pub state: TerminalScreenState,
    pub rows: Vec<TerminalScreenRow>,
    pub hyperlinks: Vec<TerminalHyperlinkRun>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSelectionPoint {
    pub column: u16,
    pub row: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSelection {
    pub anchor: TerminalSelectionPoint,
    pub focus: TerminalSelectionPoint,
}

/// A pair of Ghostty-owned grid pins that follows the selected cells as the
/// terminal scrolls, reflows, or redraws an alternate screen.
pub struct TrackedTerminalSelection {
    raw: NonNull<RawTrackedSelection>,
    owner: NonNull<RawTerminal>,
}

// Selection pins are only accessed while their owning terminal actor is
// serialized. The opaque handles never receive concurrent calls.
unsafe impl Send for TrackedTerminalSelection {}

impl fmt::Debug for TrackedTerminalSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TrackedTerminalSelection")
            .finish_non_exhaustive()
    }
}

impl Drop for TrackedTerminalSelection {
    fn drop(&mut self) {
        unsafe { eg_tracked_selection_free(self.raw.as_ptr()) };
    }
}

pub struct GhosttyTerminalCore {
    raw: NonNull<RawTerminal>,
    default_selection: Option<TrackedTerminalSelection>,
    cached_rows: Vec<String>,
    cached_cells: Vec<Vec<TerminalCell>>,
    cached_row_metadata: Vec<TerminalRowMetadata>,
    cached_hyperlinks: Vec<Vec<TerminalHyperlinkRun>>,
}

// libghostty-vt access is serialized by the owning session actor. The opaque
// handle never escapes this wrapper or receives concurrent calls.
unsafe impl Send for GhosttyTerminalCore {}

impl GhosttyTerminalCore {
    pub fn new(cols: u16, rows: u16, max_scrollback: usize) -> Result<Self, GhosttyError> {
        let raw = NonNull::new(unsafe { eg_terminal_new(cols, rows, max_scrollback) })
            .ok_or(GhosttyError(-1))?;
        Ok(Self {
            raw,
            default_selection: None,
            cached_rows: Vec::new(),
            cached_cells: Vec::new(),
            cached_row_metadata: Vec::new(),
            cached_hyperlinks: Vec::new(),
        })
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        unsafe { eg_terminal_write(self.raw.as_ptr(), bytes.as_ptr(), bytes.len()) };
    }

    /// Read a packed ANSI/DEC terminal mode. `None` means the mode is not
    /// recognized (and is also returned for values above Ghostty's 15-bit
    /// packed-mode range, which are rejected rather than masked).
    pub fn mode_get(&self, value: u16, ansi: bool) -> Option<bool> {
        if value > 0x7fff {
            return None;
        }
        let mut enabled = false;
        (unsafe { eg_terminal_mode_get_raw(self.raw.as_ptr(), value, ansi, &mut enabled) } == 0)
            .then_some(enabled)
    }

    pub fn pending_wrap(&self) -> Result<bool, GhosttyError> {
        let mut pending = false;
        check(unsafe { eg_terminal_pending_wrap(self.raw.as_ptr(), &mut pending) })?;
        Ok(pending)
    }

    /// Opaque whole-screen VT fragment: content plus every state class the
    /// public Ghostty formatter can emit.
    pub fn recovery_fragment(&self) -> Result<Vec<u8>, GhosttyError> {
        self.recovery_bytes(eg_terminal_recovery_fragment)
    }

    /// VT state emission with formatter content disabled. Pending-wrap is not
    /// representable by a control sequence and must be restored separately.
    pub fn recovery_state(&self) -> Result<Vec<u8>, GhosttyError> {
        self.recovery_bytes(eg_terminal_recovery_state)
    }

    fn recovery_bytes(
        &self,
        formatter: unsafe extern "C" fn(*mut RawTerminal, *mut u8, usize) -> usize,
    ) -> Result<Vec<u8>, GhosttyError> {
        let required = unsafe { formatter(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        if required == usize::MAX {
            return Err(GhosttyError(-1));
        }
        let mut bytes = vec![0_u8; required];
        let written = unsafe { formatter(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len()) };
        if written == usize::MAX || written > bytes.len() {
            return Err(GhosttyError(-1));
        }
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn saved_cursor(
        &self,
        screen: TerminalScreen,
    ) -> Result<Option<SavedCursor>, GhosttyError> {
        let mut raw = RawSavedCursor::default();
        match unsafe { eg_terminal_saved_cursor(self.raw.as_ptr(), screen.raw(), &mut raw) } {
            0 => Ok(None),
            1 => Ok(Some(SavedCursor {
                x: raw.x,
                y: raw.y,
                style: raw.style.into(),
                protected: raw.protected_cell,
                pending_wrap: raw.pending_wrap,
                origin: raw.origin,
                charset: raw.charset.into(),
            })),
            status => Err(GhosttyError(status)),
        }
    }

    /// Snapshot either screen without activating it. This intentionally reads
    /// a stable semantic surface; it never switches screens or writes VT.
    pub fn screen_snapshot(
        &self,
        screen: TerminalScreen,
    ) -> Result<Option<TerminalScreenSnapshot>, GhosttyError> {
        struct Rows {
            rows: Vec<TerminalScreenRow>,
            hyperlinks: Vec<Vec<TerminalHyperlinkRun>>,
        }

        fn empty_row() -> TerminalScreenRow {
            TerminalScreenRow {
                text: String::new(),
                cells: Vec::new(),
                metadata: TerminalRowMetadata::default(),
            }
        }

        unsafe extern "C" fn collect_row(
            userdata: *mut c_void,
            row: u32,
            text: *const u8,
            len: usize,
            _dirty: bool,
            wrap: bool,
            wrap_continuation: bool,
            semantic_prompt: u8,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.rows.resize_with(row as usize + 1, empty_row);
            rows.hyperlinks.resize_with(row as usize + 1, Vec::new);
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            rows.rows[row as usize].text = String::from_utf8_lossy(bytes).into_owned();
            rows.rows[row as usize].metadata = TerminalRowMetadata {
                wrap,
                wrap_continuation,
                semantic_prompt: TerminalRowSemanticPrompt::from_raw(semantic_prompt),
            };
        }

        unsafe extern "C" fn collect_cell(
            userdata: *mut c_void,
            row: u32,
            column: u16,
            span: u16,
            text: *const u8,
            len: usize,
            style: *const RawTerminalStyle,
            protected: bool,
            semantic_content: u8,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.rows.resize_with(row as usize + 1, empty_row);
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            rows.rows[row as usize].cells.push(TerminalScreenCell {
                column,
                span,
                text: String::from_utf8_lossy(bytes).into_owned(),
                style: unsafe { *style }.into(),
                protected,
                semantic_content: TerminalSemanticContent::from_raw(semantic_content),
            });
        }

        unsafe extern "C" fn collect_hyperlink(
            userdata: *mut c_void,
            row: u32,
            column: u16,
            span: u16,
            uri: *const u8,
            uri_len: usize,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.hyperlinks.resize_with(row as usize + 1, Vec::new);
            let uri = if uri_len == 0 {
                Vec::new()
            } else {
                unsafe { std::slice::from_raw_parts(uri, uri_len) }.to_vec()
            };
            rows.hyperlinks[row as usize].push(TerminalHyperlinkRun {
                row,
                start_column: column,
                end_column: column.saturating_add(span),
                identity: None,
                uri,
            });
        }

        let mut meta = RawScreenMeta::default();
        let mut rows = Rows {
            rows: Vec::new(),
            hyperlinks: Vec::new(),
        };
        match unsafe {
            eg_terminal_screen_snapshot(
                self.raw.as_ptr(),
                screen.raw(),
                &mut meta,
                collect_row,
                collect_cell,
                collect_hyperlink,
                (&mut rows as *mut Rows).cast(),
            )
        } {
            0 => Ok(None),
            1 => {
                let row_count = usize::try_from(meta.total_rows).map_err(|_| GhosttyError(-1))?;
                rows.rows.resize_with(row_count, empty_row);
                rows.hyperlinks.resize_with(row_count, Vec::new);
                Ok(Some(TerminalScreenSnapshot {
                    state: TerminalScreenState {
                        cols: meta.cols,
                        rows: meta.rows,
                        total_rows: meta.total_rows,
                        scrollback_rows: meta.scrollback_rows,
                        cursor_x: meta.cursor_x,
                        cursor_y: meta.cursor_y,
                        cursor_visual_style: meta.cursor_visual_style,
                        cursor_style: meta.cursor_style.into(),
                        cursor_protected: meta.cursor_protected,
                        cursor_pending_wrap: meta.cursor_pending_wrap,
                        charset: meta.charset.into(),
                        kitty_keyboard_flags: meta.kitty_keyboard_flags,
                        viewport_offset: meta.viewport_offset,
                        cursor_semantic_content: TerminalSemanticContent::from_raw(
                            meta.cursor_semantic_content,
                        ),
                        cursor_semantic_content_clear_eol: meta.cursor_semantic_content_clear_eol,
                        hyperlink_implicit_id: meta.hyperlink_implicit_id,
                        protected_mode: TerminalProtectedMode::from_raw(meta.protected_mode),
                        kitty_keyboard: TerminalKittyKeyboardState {
                            stack: meta.kitty_keyboard_stack,
                            index: meta.kitty_keyboard_index,
                        },
                        semantic_prompt: TerminalSemanticPromptState {
                            seen: meta.semantic_prompt_seen,
                            click: TerminalSemanticPromptClick::from_raw(
                                meta.semantic_prompt_click,
                            ),
                        },
                    },
                    rows: rows.rows,
                    hyperlinks: rows.hyperlinks.into_iter().flatten().collect(),
                }))
            }
            status => Err(GhosttyError(status)),
        }
    }

    /// Read G21 semantic identity separately from the G18/G20 URI surface.
    /// Runs are emitted in the same row/column order as `screen_snapshot`.
    pub fn screen_hyperlink_identities(
        &self,
        screen: TerminalScreen,
    ) -> Result<Option<Vec<TerminalHyperlinkIdentityRun>>, GhosttyError> {
        unsafe extern "C" fn collect(
            userdata: *mut c_void,
            row: u32,
            column: u16,
            span: u16,
            identity_kind: u8,
            explicit_id: *const u8,
            explicit_id_len: usize,
            implicit_token: u64,
        ) {
            let output = unsafe { &mut *userdata.cast::<Vec<TerminalHyperlinkIdentityRun>>() };
            let identity = if identity_kind == 1 {
                TerminalHyperlinkIdentity::Explicit(if explicit_id_len == 0 {
                    Vec::new()
                } else {
                    unsafe { std::slice::from_raw_parts(explicit_id, explicit_id_len) }.to_vec()
                })
            } else {
                TerminalHyperlinkIdentity::Implicit(implicit_token)
            };
            output.push(TerminalHyperlinkIdentityRun {
                row,
                start_column: column,
                end_column: column.saturating_add(span),
                identity,
            });
        }

        let mut output = Vec::new();
        match unsafe {
            eg_terminal_screen_hyperlink_identities(
                self.raw.as_ptr(),
                screen.raw(),
                collect,
                (&mut output as *mut Vec<TerminalHyperlinkIdentityRun>).cast(),
            )
        } {
            0 => Ok(None),
            1 => Ok(Some(output)),
            status => Err(GhosttyError(status)),
        }
    }

    /// Compose G20 rows/URIs with G21 identity and compact adjacent cells only
    /// after the full semantic (identity, URI) equality pair is known.
    pub fn screen_snapshot_with_hyperlink_identities(
        &self,
        screen: TerminalScreen,
    ) -> Result<Option<TerminalScreenSnapshot>, GhosttyError> {
        let Some(mut snapshot) = self.screen_snapshot(screen)? else {
            return Ok(None);
        };
        let identities = self
            .screen_hyperlink_identities(screen)?
            .ok_or(GhosttyError(-1))?;
        if snapshot.hyperlinks.len() != identities.len() {
            return Err(GhosttyError(-1));
        }
        for (link, identity) in snapshot.hyperlinks.iter_mut().zip(identities) {
            if (link.row, link.start_column, link.end_column)
                != (identity.row, identity.start_column, identity.end_column)
            {
                return Err(GhosttyError(-1));
            }
            link.identity = Some(identity.identity);
        }
        let mut compact: Vec<TerminalHyperlinkRun> = Vec::with_capacity(snapshot.hyperlinks.len());
        for link in snapshot.hyperlinks.drain(..) {
            if let Some(previous) = compact.last_mut()
                && previous.row == link.row
                && previous.end_column == link.start_column
                && previous.identity == link.identity
                && previous.uri == link.uri
            {
                previous.end_column = link.end_column;
            } else {
                compact.push(link);
            }
        }
        snapshot.hyperlinks = compact;
        Ok(Some(snapshot))
    }

    pub fn screen_cursor_hyperlink(
        &self,
        screen: TerminalScreen,
    ) -> Result<Option<TerminalCursorHyperlink>, GhosttyError> {
        unsafe extern "C" fn collect(
            userdata: *mut c_void,
            uri: *const u8,
            uri_len: usize,
            identity_kind: u8,
            explicit_id: *const u8,
            explicit_id_len: usize,
            implicit_token: u64,
        ) {
            let output = unsafe { &mut *userdata.cast::<Option<TerminalCursorHyperlink>>() };
            let uri = if uri_len == 0 {
                Vec::new()
            } else {
                unsafe { std::slice::from_raw_parts(uri, uri_len) }.to_vec()
            };
            let identity = if identity_kind == 1 {
                TerminalHyperlinkIdentity::Explicit(if explicit_id_len == 0 {
                    Vec::new()
                } else {
                    unsafe { std::slice::from_raw_parts(explicit_id, explicit_id_len) }.to_vec()
                })
            } else {
                TerminalHyperlinkIdentity::Implicit(implicit_token)
            };
            *output = Some(TerminalCursorHyperlink { uri, identity });
        }

        let mut output = None;
        match unsafe {
            eg_terminal_screen_cursor_hyperlink(
                self.raw.as_ptr(),
                screen.raw(),
                collect,
                (&mut output as *mut Option<TerminalCursorHyperlink>).cast(),
            )
        } {
            0 => Ok(None),
            1 => output.map(Some).ok_or(GhosttyError(-1)),
            status => Err(GhosttyError(status)),
        }
    }

    pub fn selection_text(
        &mut self,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<String, GhosttyError> {
        let selection = self.track_selection(start, end, select_all)?;
        let text = self.format_tracked_selection(&selection)?;
        self.default_selection = Some(selection);
        Ok(text)
    }

    pub fn track_selection(
        &mut self,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<TrackedTerminalSelection, GhosttyError> {
        let raw = NonNull::new(unsafe {
            eg_terminal_track_selection(
                self.raw.as_ptr(),
                start.0,
                start.1,
                end.0,
                end.1,
                select_all,
            )
        })
        .ok_or(GhosttyError(-1))?;
        Ok(TrackedTerminalSelection {
            raw,
            owner: self.raw,
        })
    }

    pub fn tracked_selection_points(
        &self,
        selection: &TrackedTerminalSelection,
    ) -> Option<TerminalSelection> {
        if selection.owner != self.raw {
            return None;
        }
        let mut points = RawSelection::default();
        unsafe {
            eg_terminal_tracked_selection_points(
                self.raw.as_ptr(),
                selection.raw.as_ptr(),
                &mut points,
            )
        }
        .then_some(TerminalSelection {
            anchor: TerminalSelectionPoint {
                column: points.start_column,
                row: points.start_row,
            },
            focus: TerminalSelectionPoint {
                column: points.end_column,
                row: points.end_row,
            },
        })
    }

    pub fn format_tracked_selection(
        &self,
        selection: &TrackedTerminalSelection,
    ) -> Result<String, GhosttyError> {
        if selection.owner != self.raw {
            return Err(GhosttyError(-1));
        }
        let required = unsafe {
            eg_terminal_tracked_selection_text(
                self.raw.as_ptr(),
                selection.raw.as_ptr(),
                std::ptr::null_mut(),
                0,
            )
        };
        if required == usize::MAX {
            return Err(GhosttyError(-1));
        }
        let mut output = vec![0_u8; required];
        let written = unsafe {
            eg_terminal_tracked_selection_text(
                self.raw.as_ptr(),
                selection.raw.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
            )
        };
        if written == usize::MAX || written > output.len() {
            return Err(GhosttyError(-1));
        }
        output.truncate(written);
        String::from_utf8(output).map_err(|_| GhosttyError(-1))
    }

    pub fn selection_row_count(&self) -> Result<u64, GhosttyError> {
        let mut scrollbar = RawScrollbar::default();
        if unsafe { eg_terminal_scrollbar(self.raw.as_ptr(), &mut scrollbar) } {
            Ok(scrollbar.total)
        } else {
            Err(GhosttyError(-1))
        }
    }

    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>, GhosttyError> {
        let bytes = text.as_bytes();
        let mut output = vec![0_u8; bytes.len().saturating_add(16)];
        let mut written = 0;
        check(unsafe {
            eg_terminal_encode_paste(
                self.raw.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        })?;
        output.truncate(written);
        Ok(output)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), GhosttyError> {
        check(unsafe { eg_terminal_resize(self.raw.as_ptr(), cols, rows) })
    }

    pub fn set_colors(
        &mut self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    ) -> Result<(), GhosttyError> {
        check(unsafe {
            eg_terminal_set_colors(
                self.raw.as_ptr(),
                foreground[0],
                foreground[1],
                foreground[2],
                background[0],
                background[1],
                background[2],
                cursor[0],
                cursor[1],
                cursor[2],
            )
        })
    }

    pub fn set_palette(&mut self, entries: &[(u8, [u8; 3])]) -> Result<(), GhosttyError> {
        let indices = entries.iter().map(|(index, _)| *index).collect::<Vec<_>>();
        let colors = entries
            .iter()
            .flat_map(|(_, color)| color.iter().copied())
            .collect::<Vec<_>>();
        check(unsafe {
            eg_terminal_set_palette(
                self.raw.as_ptr(),
                indices.as_ptr(),
                colors.as_ptr(),
                entries.len(),
            )
        })
    }

    pub fn scroll(&mut self, rows: isize) {
        unsafe { eg_terminal_scroll(self.raw.as_ptr(), rows) };
    }

    pub fn scroll_to(&mut self, row: usize) {
        unsafe { eg_terminal_scroll_to(self.raw.as_ptr(), row) };
    }

    pub fn compress_scrollback_full(&mut self) -> Result<bool, GhosttyError> {
        match unsafe { eg_terminal_compress_scrollback_full(self.raw.as_ptr()) } {
            0 => Ok(false),
            1 => Ok(true),
            status => Err(GhosttyError(status)),
        }
    }

    pub fn alternate_scroll(&self) -> bool {
        unsafe { eg_terminal_alternate_scroll(self.raw.as_ptr()) }
    }

    pub fn selection(&self) -> Option<TerminalSelection> {
        self.default_selection
            .as_ref()
            .and_then(|selection| self.tracked_selection_points(selection))
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
    ) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 128];
        let mut written = 0;
        let mut result = unsafe {
            eg_terminal_encode_mouse(
                self.raw.as_ptr(),
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
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        };
        if result == -3 {
            bytes.resize(written, 0);
            result = unsafe {
                eg_terminal_encode_mouse(
                    self.raw.as_ptr(),
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
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                )
            };
        }
        check(result)?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn encode_focus(&mut self, focused: bool) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 8];
        let mut written = 0;
        check(unsafe {
            eg_terminal_encode_focus(
                self.raw.as_ptr(),
                focused,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        })?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn encode_key(
        &mut self,
        code: &str,
        text: &str,
        unshifted_codepoint: u32,
        mods: u16,
        action: u8,
    ) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 128];
        let mut written = 0;
        let mut result = unsafe {
            eg_terminal_encode_key(
                self.raw.as_ptr(),
                code.as_ptr(),
                code.len(),
                text.as_ptr(),
                text.len(),
                unshifted_codepoint,
                mods,
                action,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        };
        if result == -3 {
            bytes.resize(written, 0);
            result = unsafe {
                eg_terminal_encode_key(
                    self.raw.as_ptr(),
                    code.as_ptr(),
                    code.len(),
                    text.as_ptr(),
                    text.len(),
                    unshifted_codepoint,
                    mods,
                    action,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                )
            };
        }
        check(result)?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn snapshot(&mut self) -> Result<TerminalSnapshot, GhosttyError> {
        struct Rows {
            text: Vec<String>,
            cells: Vec<Vec<TerminalCell>>,
            metadata: Vec<TerminalRowMetadata>,
            hyperlinks: Vec<Vec<TerminalHyperlinkRun>>,
            present: Vec<bool>,
            dirty: Vec<u16>,
        }
        unsafe extern "C" fn collect_row(
            userdata: *mut c_void,
            row: u32,
            text: *const u8,
            len: usize,
            dirty: bool,
            wrap: bool,
            wrap_continuation: bool,
            semantic_prompt: u8,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            rows.text.resize_with(row as usize + 1, String::new);
            rows.metadata
                .resize_with(row as usize + 1, TerminalRowMetadata::default);
            rows.hyperlinks.resize_with(row as usize + 1, Vec::new);
            rows.present.resize(row as usize + 1, false);
            rows.text[row as usize] = String::from_utf8_lossy(bytes).into_owned();
            rows.metadata[row as usize] = TerminalRowMetadata {
                wrap,
                wrap_continuation,
                semantic_prompt: TerminalRowSemanticPrompt::from_raw(semantic_prompt),
            };
            rows.present[row as usize] = dirty;
            if dirty {
                rows.dirty.push(row as u16);
            }
        }
        unsafe extern "C" fn collect_cell(
            userdata: *mut c_void,
            row: u32,
            column: u16,
            span: u16,
            text: *const u8,
            len: usize,
            raw_style: *const RawCellStyle,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.cells.resize_with(row as usize + 1, Vec::new);
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            let raw = unsafe { &*raw_style };
            rows.cells[row as usize].push(TerminalCell {
                column,
                span,
                text: String::from_utf8_lossy(bytes).into_owned(),
                style: CellStyle {
                    bold: raw.flags & 1 != 0,
                    italic: raw.flags & 2 != 0,
                    faint: raw.flags & 4 != 0,
                    inverse: raw.flags & 8 != 0,
                    invisible: raw.flags & 16 != 0,
                    strikethrough: raw.flags & 32 != 0,
                    underline: raw.flags & 64 != 0,
                    foreground: (raw.fg_kind != 0).then_some([raw.fg_r, raw.fg_g, raw.fg_b]),
                    background: (raw.bg_kind != 0).then_some([raw.bg_r, raw.bg_g, raw.bg_b]),
                },
                foreground_default: raw.fg_kind == 0,
                foreground_palette: (raw.fg_kind == 2).then_some(raw.fg_palette),
                background_default: raw.bg_kind == 0,
                background_palette: (raw.bg_kind == 2).then_some(raw.bg_palette),
            });
        }
        unsafe extern "C" fn collect_hyperlink(
            userdata: *mut c_void,
            row: u32,
            column: u16,
            span: u16,
            uri: *const u8,
            uri_len: usize,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.hyperlinks.resize_with(row as usize + 1, Vec::new);
            let uri = if uri_len == 0 {
                Vec::new()
            } else {
                unsafe { std::slice::from_raw_parts(uri, uri_len) }.to_vec()
            };
            rows.hyperlinks[row as usize].push(TerminalHyperlinkRun {
                row,
                start_column: column,
                end_column: column.saturating_add(span),
                identity: None,
                uri,
            });
        }

        let mut meta = RawSnapshotMeta::default();
        let mut rows = Rows {
            text: Vec::new(),
            cells: Vec::new(),
            metadata: Vec::new(),
            hyperlinks: Vec::new(),
            present: Vec::new(),
            dirty: Vec::new(),
        };
        check(unsafe {
            eg_terminal_snapshot(
                self.raw.as_ptr(),
                &mut meta,
                collect_row,
                collect_cell,
                collect_hyperlink,
                (&mut rows as *mut Rows).cast(),
            )
        })?;
        rows.text.resize_with(meta.rows as usize, String::new);
        rows.cells.resize_with(meta.rows as usize, Vec::new);
        rows.metadata
            .resize_with(meta.rows as usize, TerminalRowMetadata::default);
        rows.hyperlinks.resize_with(meta.rows as usize, Vec::new);
        rows.present.resize(meta.rows as usize, false);
        for (row_index, (text, cells)) in rows.text.iter().zip(&mut rows.cells).enumerate() {
            if meta.full_dirty == 0 && !rows.present[row_index] {
                continue;
            }
            let mut bytes = 0;
            cells.retain(|cell| {
                let keep = bytes < text.len() || cell.style != CellStyle::default();
                bytes += cell.text.len();
                keep
            });
        }
        self.cached_rows
            .resize_with(meta.rows as usize, String::new);
        self.cached_cells.resize_with(meta.rows as usize, Vec::new);
        self.cached_row_metadata
            .resize_with(meta.rows as usize, TerminalRowMetadata::default);
        self.cached_hyperlinks
            .resize_with(meta.rows as usize, Vec::new);
        for row_index in 0..meta.rows as usize {
            self.cached_row_metadata[row_index] = rows.metadata[row_index].clone();
            if meta.full_dirty != 0 || rows.present[row_index] {
                self.cached_rows[row_index] = std::mem::take(&mut rows.text[row_index]);
                self.cached_cells[row_index] = std::mem::take(&mut rows.cells[row_index]);
                self.cached_hyperlinks[row_index] = std::mem::take(&mut rows.hyperlinks[row_index]);
            }
        }
        let mut scrollbar = RawScrollbar::default();
        let has_scrollbar = unsafe { eg_terminal_scrollbar(self.raw.as_ptr(), &mut scrollbar) };
        Ok(TerminalSnapshot {
            cols: meta.cols,
            rows: self.cached_rows.clone(),
            cells: self.cached_cells.clone(),
            row_metadata: self.cached_row_metadata.clone(),
            hyperlinks: self.cached_hyperlinks.iter().flatten().cloned().collect(),
            cursor: CursorState {
                x: meta.cursor_x,
                y: meta.cursor_y,
                visible: meta.cursor_visible != 0,
                style: meta.cursor_style,
                blinking: meta.cursor_blinking != 0,
            },
            damage: TerminalDamage {
                full: meta.full_dirty != 0,
                dirty_rows: rows.dirty,
            },
            title: self.read_string(eg_terminal_title),
            cwd: self.read_string(eg_terminal_pwd),
            bell: meta.effects & EFFECT_BELL != 0,
            mouse_tracking: unsafe { eg_terminal_mouse_tracking(self.raw.as_ptr()) },
            scrollbar: if has_scrollbar {
                TerminalScrollbar {
                    total: scrollbar.total,
                    offset: scrollbar.offset,
                    len: scrollbar.len,
                }
            } else {
                TerminalScrollbar {
                    total: meta.rows.into(),
                    offset: 0,
                    len: meta.rows.into(),
                }
            },
            selection: self.selection(),
            clipboard: (meta.effects & EFFECT_CLIPBOARD != 0).then(|| self.take_clipboard()),
            pty_response: self.take_pty_response(),
        })
    }

    fn read_string(
        &self,
        getter: unsafe extern "C" fn(*mut RawTerminal, *mut u8, usize) -> usize,
    ) -> Option<String> {
        let required = unsafe { getter(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        if required == 0 {
            return None;
        }
        let mut bytes = vec![0_u8; required];
        unsafe { getter(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len()) };
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn take_pty_response(&self) -> Vec<u8> {
        let required =
            unsafe { eg_terminal_take_response(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        let mut bytes = vec![0_u8; required];
        if required != 0 {
            unsafe {
                eg_terminal_take_response(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len())
            };
        }
        bytes
    }

    fn take_clipboard(&self) -> Vec<u8> {
        let required =
            unsafe { eg_terminal_take_clipboard(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        let mut bytes = vec![0_u8; required];
        if required != 0 {
            unsafe {
                eg_terminal_take_clipboard(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len())
            };
        }
        bytes
    }
}

impl Drop for GhosttyTerminalCore {
    fn drop(&mut self) {
        unsafe { eg_terminal_free(self.raw.as_ptr()) };
    }
}

fn check(result: i32) -> Result<(), GhosttyError> {
    if result == 0 {
        Ok(())
    } else {
        Err(GhosttyError(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_sweep_round_trips_through_real_csi_handling() {
        fn capture(terminal: &GhosttyTerminalCore) -> Vec<(u16, bool, bool)> {
            let mut result = Vec::new();
            for ansi in [true, false] {
                for value in 0_u16..=0x7fff {
                    if let Some(enabled) = terminal.mode_get(value, ansi) {
                        result.push((value, ansi, enabled));
                    }
                }
            }
            result
        }

        let mut source = GhosttyTerminalCore::new(80, 4, 100).unwrap();
        source.feed(b"\x1b[?40h\x1b[?3h\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?2004h\x1b[4h");
        let captured = capture(&source);
        assert!(!captured.is_empty());
        assert!(captured.contains(&(3, false, true)));
        assert!(captured.contains(&(40, false, true)));

        let mut replacement = GhosttyTerminalCore::new(80, 4, 100).unwrap();
        // Real CSI semantics make mode 40 a prerequisite for mode 3. Restore
        // prerequisites first, then the rest of the discovered mode space.
        for &(value, ansi, enabled) in captured
            .iter()
            .filter(|&&(value, ansi, _)| value == 40 && !ansi)
            .chain(
                captured
                    .iter()
                    .filter(|&&(value, ansi, _)| value != 40 || ansi),
            )
        {
            let prefix = if ansi { "" } else { "?" };
            let suffix = if enabled { 'h' } else { 'l' };
            replacement.feed(format!("\x1b[{prefix}{value}{suffix}").as_bytes());
        }
        let restored = capture(&replacement);
        assert_eq!(restored, captured);
        assert_eq!(source.mode_get(0x8000, false), None);
        assert_eq!(source.mode_get(u16::MAX, true), None);
    }

    #[test]
    fn exposes_pending_wrap_and_row_wrap_flags() {
        let mut terminal = GhosttyTerminalCore::new(4, 3, 100).unwrap();
        terminal.feed(b"abcd");
        assert!(terminal.pending_wrap().unwrap());
        terminal.feed(b"e");
        assert!(!terminal.pending_wrap().unwrap());
        let snapshot = terminal.snapshot().unwrap();
        assert!(snapshot.row_metadata[0].wrap);
        assert!(snapshot.row_metadata[1].wrap_continuation);
    }

    #[test]
    fn scrollback_caps_produce_different_retention_depths() {
        let mut disabled = GhosttyTerminalCore::new(8, 2, 0).unwrap();
        let mut retained = GhosttyTerminalCore::new(8, 2, 1_000_000).unwrap();
        for line in 0..100 {
            let bytes = format!("{line:07}\r\n");
            disabled.feed(bytes.as_bytes());
            retained.feed(bytes.as_bytes());
        }

        let disabled = disabled.snapshot().unwrap().scrollbar;
        let retained = retained.snapshot().unwrap().scrollbar;
        assert_eq!(disabled.total, disabled.len);
        assert!(retained.total > retained.len);
        assert!(retained.total > disabled.total);
    }

    #[test]
    fn formatter_exposes_whole_screen_and_content_free_recovery() {
        let mut source = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        source.feed(b"hello \x1b[31mred\x1b[?2004h\x1b[1\"q\x1b(0\x1b[2;5H\x1b*0\x1bN");
        let source_state = source
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap()
            .state;

        let fragment = source.recovery_fragment().unwrap();
        let mut whole = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        whole.feed(&fragment);
        assert_eq!(
            whole.snapshot().unwrap().rows,
            source.snapshot().unwrap().rows
        );
        assert_eq!(whole.mode_get(2004, false), Some(true));
        let whole_state = whole
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap()
            .state;
        assert_eq!(whole_state.cursor_x, source_state.cursor_x);
        assert_eq!(whole_state.cursor_y, source_state.cursor_y);
        assert_eq!(whole_state.cursor_style, source_state.cursor_style);
        assert_eq!(whole_state.cursor_protected, source_state.cursor_protected);
        assert_eq!(whole_state.charset, source_state.charset);

        let state = source.recovery_state().unwrap();
        let mut state_only = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        state_only.feed(&state);
        assert!(
            state_only
                .snapshot()
                .unwrap()
                .rows
                .iter()
                .all(String::is_empty)
        );
        assert_eq!(state_only.mode_get(2004, false), Some(true));
        let state_only_state = state_only
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap()
            .state;
        assert_eq!(state_only_state.cursor_x, source_state.cursor_x);
        assert_eq!(state_only_state.cursor_y, source_state.cursor_y);
        assert_eq!(state_only_state.cursor_style, source_state.cursor_style);
        assert_eq!(
            state_only_state.cursor_protected,
            source_state.cursor_protected
        );
        assert_eq!(state_only_state.charset, source_state.charset);
    }

    #[test]
    fn recovery_state_orders_deccolm_after_mode_40() {
        let mut source = GhosttyTerminalCore::new(80, 3, 100).unwrap();
        source.feed(b"\x1b[?40h\x1b[?3h");
        assert_eq!(source.mode_get(40, false), Some(true));
        assert_eq!(source.mode_get(3, false), Some(true));

        let state = source.recovery_state().unwrap();
        let mut replacement = GhosttyTerminalCore::new(80, 3, 100).unwrap();
        replacement.feed(&state);
        assert_eq!(replacement.mode_get(40, false), Some(true));
        assert_eq!(replacement.mode_get(3, false), Some(true));
        assert_eq!(
            replacement
                .screen_snapshot(TerminalScreen::Primary)
                .unwrap()
                .unwrap()
                .state
                .cols,
            132,
        );
    }

    #[test]
    fn saved_cursor_is_complete_and_kept_per_screen() {
        let mut terminal = GhosttyTerminalCore::new(4, 3, 100).unwrap();
        terminal.feed(b"\x1b[?6h\x1b[31m\x1b[1\"q\x1b(0abcd\x1b*0\x1bN\x1b7");
        let primary = terminal
            .saved_cursor(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert_eq!((primary.x, primary.y), (3, 0));
        assert!(primary.protected);
        assert!(primary.pending_wrap);
        assert!(primary.origin);
        assert_eq!(primary.style.foreground, TerminalStyleColor::Palette(1));
        assert_eq!(primary.charset.g0, TerminalCharset::DecSpecial);
        assert_eq!(primary.charset.g2, TerminalCharset::DecSpecial);
        assert_eq!(primary.charset.single_shift, Some(TerminalCharsetSlot::G2));

        terminal.feed(b"\x1b[?1047h\x1b[?6l\x1b[32m\x1b[1\"q\x1b[2;4HX\x1b+0\x1bO\x1b7");
        let alternate = terminal
            .saved_cursor(TerminalScreen::Alternate)
            .unwrap()
            .unwrap();
        assert_eq!((alternate.x, alternate.y), (3, 1));
        assert_eq!(alternate.style.foreground, TerminalStyleColor::Palette(2));
        assert!(alternate.protected);
        assert!(alternate.pending_wrap);
        assert!(!alternate.origin);
        assert_eq!(alternate.charset.g3, TerminalCharset::DecSpecial);
        assert_eq!(
            alternate.charset.single_shift,
            Some(TerminalCharsetSlot::G3)
        );
        assert_eq!(
            terminal
                .saved_cursor(TerminalScreen::Primary)
                .unwrap()
                .unwrap(),
            primary
        );
    }

    #[test]
    fn screen_selector_reads_primary_while_alternate_is_active() {
        let mut terminal = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        terminal.feed(b"primary\r\nretained\x1b[?1049h\x1b[Halt");
        assert_eq!(terminal.mode_get(1049, false), Some(true));
        let primary = terminal
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        let alternate = terminal
            .screen_snapshot(TerminalScreen::Alternate)
            .unwrap()
            .unwrap();
        let saved_primary = terminal
            .saved_cursor(TerminalScreen::Primary)
            .unwrap()
            .expect("mode 1049 must save the primary cursor");
        assert!(
            primary
                .rows
                .iter()
                .any(|row| row.text.starts_with("primary"))
        );
        assert!(
            primary
                .rows
                .iter()
                .any(|row| row.text.starts_with("retained"))
        );
        assert!(
            alternate.rows.iter().any(|row| row.text.starts_with("alt")),
            "alternate rows: {:?}",
            alternate.rows,
        );
        assert_eq!(terminal.mode_get(1049, false), Some(true));

        // Rebuild a distinct terminal from G20's selected rows/state plus
        // G19's primary saved slot. This is the real recovery oracle: exiting
        // 1049 on the source itself would only retest Ghostty's existing path.
        let mut replacement = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        for (row, value) in primary.rows.iter().enumerate() {
            if !value.text.is_empty() {
                replacement.feed(format!("\x1b[{};1H{}", row + 1, value.text).as_bytes());
            }
        }
        replacement.feed(
            format!(
                "\x1b[{};{}H\x1b[?1049h",
                saved_primary.y + 1,
                saved_primary.x + 1
            )
            .as_bytes(),
        );
        for (row, value) in alternate.rows.iter().enumerate() {
            if !value.text.is_empty() {
                replacement.feed(format!("\x1b[{};1H{}", row + 1, value.text).as_bytes());
            }
        }
        assert_eq!(replacement.mode_get(1049, false), Some(true));

        terminal.feed(b"\x1b[?1049l");
        replacement.feed(b"\x1b[?1049l");
        let source_restored = terminal
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        let replacement_restored = replacement
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert_eq!(terminal.mode_get(1049, false), Some(false));
        assert_eq!(replacement.mode_get(1049, false), Some(false));
        assert_eq!(
            (
                replacement_restored.state.cursor_x,
                replacement_restored.state.cursor_y,
            ),
            (saved_primary.x, saved_primary.y)
        );
        assert_eq!(
            replacement_restored.rows, source_restored.rows,
            "replacement primary plane diverged after 1049 exit",
        );
    }

    #[test]
    fn screen_selector_preserves_inactive_attributes_and_wrap_metadata() {
        let mut terminal = GhosttyTerminalCore::new(4, 3, 100).unwrap();
        terminal.feed(b"\x1b[31m\x1b[1\"qabcde\x1b[?1047h");

        let primary = terminal
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert!(primary.rows[0].metadata.wrap);
        assert!(primary.rows[1].metadata.wrap_continuation);
        assert_eq!(
            primary.rows[0].cells[0].style.foreground,
            TerminalStyleColor::Palette(1)
        );
        assert!(primary.rows[0].cells[0].protected);
        assert_eq!(primary.rows[0].cells[0].text, "a");
        assert_eq!((primary.state.cursor_x, primary.state.cursor_y), (1, 1));
        assert!(!primary.state.cursor_pending_wrap);
        assert_eq!(terminal.mode_get(1047, false), Some(true));
    }

    #[test]
    fn screen_state_carries_behavioral_stacks_semantics_and_viewport() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 1_000_000).unwrap();
        for line in 0..10 {
            terminal.feed(format!("line-{line}\r\n").as_bytes());
        }
        terminal.feed(
            b"\x1b[>1u\x1b[>2u\x1b[1\"q\x1b]133;A;click_events=1\x07\x1b]8;;https://example.test/open\x1b\\",
        );
        terminal.scroll(-2);

        let snapshot = terminal
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.state.kitty_keyboard.index, 2);
        assert_eq!(snapshot.state.kitty_keyboard.stack[1], 1);
        assert_eq!(snapshot.state.kitty_keyboard.stack[2], 2);
        assert_eq!(snapshot.state.kitty_keyboard_flags, 2);
        assert_eq!(snapshot.state.protected_mode, TerminalProtectedMode::Dec);
        assert_eq!(
            snapshot.state.cursor_semantic_content,
            TerminalSemanticContent::Prompt
        );
        assert!(snapshot.state.semantic_prompt.seen);
        assert_eq!(
            snapshot.state.semantic_prompt.click,
            TerminalSemanticPromptClick::ClickEventsAbsolute
        );
        assert!(
            snapshot.state.viewport_offset + u64::from(snapshot.state.rows)
                < snapshot.state.total_rows
        );

        let cursor_link = terminal
            .screen_cursor_hyperlink(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert_eq!(cursor_link.uri, b"https://example.test/open");
        assert!(matches!(
            cursor_link.identity,
            TerminalHyperlinkIdentity::Implicit(_)
        ));
    }

    #[test]
    fn screen_snapshot_represents_default_blank_scrollback_sparsely() {
        let mut terminal = GhosttyTerminalCore::new(80, 4, 4_000_000).unwrap();
        for _ in 0..2_000 {
            terminal.feed(b"\r\n");
        }
        let snapshot = terminal
            .screen_snapshot(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        assert!(snapshot.rows.len() > 1_000);
        assert!(snapshot.rows.iter().all(|row| row.text.is_empty()));
        assert_eq!(
            snapshot
                .rows
                .iter()
                .map(|row| row.cells.len())
                .sum::<usize>(),
            0,
            "default cells must remain implicit rather than allocating one String per column",
        );
    }

    #[test]
    fn hyperlink_runs_preserve_explicit_and_implicit_semantic_identity() {
        let mut terminal = GhosttyTerminalCore::new(8, 4, 100).unwrap();
        terminal.feed(
            b"\x1b]8;id=group-1;https://example.test/a\x1b\\explicit\x1b]8;;\x1b\\\r\n\x1b]8;;https://example.test/b\x1b\\implicit-link\x1b]8;;\x1b\\",
        );
        let snapshot = terminal
            .screen_snapshot_with_hyperlink_identities(TerminalScreen::Primary)
            .unwrap()
            .unwrap();
        let explicit = snapshot
            .hyperlinks
            .iter()
            .find(|link| link.uri == b"https://example.test/a")
            .unwrap();
        assert_eq!(
            explicit.identity,
            Some(TerminalHyperlinkIdentity::Explicit(b"group-1".to_vec()))
        );
        let implicit = snapshot
            .hyperlinks
            .iter()
            .filter(|link| link.uri == b"https://example.test/b")
            .collect::<Vec<_>>();
        assert!(implicit.len() >= 2);
        assert!(
            implicit
                .windows(2)
                .all(|pair| pair[0].identity == pair[1].identity)
        );
        assert!(matches!(
            implicit[0].identity,
            Some(TerminalHyperlinkIdentity::Implicit(_))
        ));
    }

    #[test]
    fn parses_unicode_styles_and_effects() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"hello \x1b[31mworld\x1b[0m\r\nwide: \xE7\x95\x8C\x07");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "hello world");
        assert!(snapshot.rows[1].starts_with("wide: \u{754c}"));
        assert!(snapshot.bell);
        assert!(snapshot.damage.full || !snapshot.damage.dirty_rows.is_empty());
        assert_eq!(snapshot.cells[0][6].style.foreground, Some([204, 102, 102]));
        assert_eq!(snapshot.cells[0][6].foreground_palette, Some(1));
        assert!(!snapshot.cells[0][6].foreground_default);
    }

    #[test]
    fn applies_sparse_palette_overrides_to_ansi_cells() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        terminal.feed(b"\x1b[31mred\x1b[34mblue");
        terminal
            .set_palette(&[(1, [0x12, 0x34, 0x56]), (4, [0xab, 0xcd, 0xef])])
            .unwrap();
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(
            snapshot.cells[0][0].style.foreground,
            Some([0x12, 0x34, 0x56])
        );
        assert_eq!(
            snapshot.cells[0][3].style.foreground,
            Some([0xab, 0xcd, 0xef])
        );
        assert_eq!(snapshot.cells[0][0].foreground_palette, Some(1));
        assert_eq!(snapshot.cells[0][3].foreground_palette, Some(4));
    }

    #[test]
    fn answers_color_scheme_queries_from_the_default_background() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        terminal.feed(b"\x1b[?996n");
        assert_eq!(terminal.take_pty_response(), b"\x1b[?997;1n");

        terminal
            .set_colors([0x4c, 0x4f, 0x69], [0xef, 0xf1, 0xf5], [0xdc, 0x8a, 0x78])
            .unwrap();
        terminal.feed(b"\x1b[?996n");
        assert_eq!(terminal.take_pty_response(), b"\x1b[?997;2n");
    }

    #[test]
    fn reports_scheme_flips_only_to_programs_that_enabled_mode_2031() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        let light = ([0x4c, 0x4f, 0x69], [0xef, 0xf1, 0xf5], [0xdc, 0x8a, 0x78]);
        let dark = ([0xcd, 0xd6, 0xf4], [0x1e, 0x1e, 0x2e], [0xf5, 0xe0, 0xdc]);

        terminal.set_colors(light.0, light.1, light.2).unwrap();
        assert!(terminal.take_pty_response().is_empty());

        terminal.feed(b"\x1b[?2031h");
        terminal.set_colors(dark.0, dark.1, dark.2).unwrap();
        assert_eq!(terminal.take_pty_response(), b"\x1b[?997;1n");

        // Another dark theme is not a scheme change.
        terminal
            .set_colors([0xff, 0xff, 0xff], [0x28, 0x2c, 0x34], [0xff, 0xff, 0xff])
            .unwrap();
        assert!(terminal.take_pty_response().is_empty());

        terminal.set_colors(light.0, light.1, light.2).unwrap();
        assert_eq!(terminal.take_pty_response(), b"\x1b[?997;2n");
    }

    #[test]
    fn distinguishes_defaults_palette_truecolor_and_osc_overrides() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        terminal
            .set_colors([1, 2, 3], [4, 5, 6], [7, 8, 9])
            .unwrap();
        terminal.feed(b"d\x1b[31mp\x1b[38;2;10;20;30mt");
        let snapshot = terminal.snapshot().unwrap();
        assert!(snapshot.cells[0][0].foreground_default);
        assert_eq!(snapshot.cells[0][0].style.foreground, None);
        assert_eq!(snapshot.cells[0][1].foreground_palette, Some(1));
        assert_eq!(snapshot.cells[0][2].foreground_palette, None);
        assert_eq!(snapshot.cells[0][2].style.foreground, Some([10, 20, 30]));

        terminal.feed(b"\x1b]4;1;rgb:aa/bb/cc\x1b\\");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.cells[0][1].foreground_palette, None);
        assert_eq!(
            snapshot.cells[0][1].style.foreground,
            Some([0xaa, 0xbb, 0xcc])
        );

        terminal.feed(b"\x1b]10;rgb:11/22/33\x1b\\\x1b[0m x");
        let snapshot = terminal.snapshot().unwrap();
        let default_cell = snapshot.cells[0].last().unwrap();
        assert!(!default_cell.foreground_default);
        assert_eq!(default_cell.style.foreground, Some([0x11, 0x22, 0x33]));
    }

    #[test]
    fn encodes_mode_aware_safe_paste() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert_eq!(
            terminal.encode_paste("first\nsecond").unwrap(),
            b"first\rsecond"
        );
        terminal.feed(b"\x1b[?2004h");
        let encoded = terminal.encode_paste("first\nsecond\x1b[201~tail").unwrap();
        assert!(encoded.starts_with(b"\x1b[200~"));
        assert!(encoded.ends_with(b"\x1b[201~"));
        assert_eq!(
            encoded
                .windows(6)
                .filter(|window| *window == b"\x1b[201~")
                .count(),
            1
        );
    }

    #[test]
    fn preserves_font_style_flags_per_cell() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        terminal.feed(b"a\x1b[1mb\x1b[3mc\x1b[0md");
        let snapshot = terminal.snapshot().unwrap();
        assert!(!snapshot.cells[0][0].style.bold);
        assert!(snapshot.cells[0][1].style.bold);
        assert!(snapshot.cells[0][2].style.bold && snapshot.cells[0][2].style.italic);
        assert!(!snapshot.cells[0][3].style.bold && !snapshot.cells[0][3].style.italic);
    }

    #[test]
    fn preserves_styled_blank_cells_after_trimmed_text() {
        let mut terminal = GhosttyTerminalCore::new(8, 2, 100).unwrap();
        terminal.feed(b"\x1b[44m   \x1b[0m");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "");
        assert!(
            snapshot.cells[0]
                .iter()
                .take(3)
                .all(|cell| cell.style.background.is_some())
        );
    }

    #[test]
    fn preserves_background_when_erasing_the_rest_of_a_row() {
        let mut terminal = GhosttyTerminalCore::new(8, 2, 100).unwrap();
        terminal.feed(b"\x1b[44m> go\x1b[K\x1b[0m");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "> go");
        assert_eq!(snapshot.cells[0].len(), 8);
        assert!(
            snapshot.cells[0]
                .iter()
                .all(|cell| cell.style.background.is_some())
        );
    }

    #[test]
    fn captures_title_and_device_response() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b]2;agent shell\x1b\\\x1b[5n");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.title.as_deref(), Some("agent shell"));
        assert!(!snapshot.pty_response.is_empty());
    }

    #[test]
    fn answers_dynamic_color_queries_from_the_configured_theme() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal
            .set_colors([1, 2, 3], [4, 5, 6], [7, 8, 9])
            .unwrap();
        terminal.feed(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\");
        let response = terminal.snapshot().unwrap().pty_response;
        assert!(
            response.windows(8).any(|value| value == b"]10;rgb:"),
            "missing foreground response: {response:?}"
        );
        assert!(
            response.windows(8).any(|value| value == b"]11;rgb:"),
            "missing background response: {response:?}"
        );
        assert!(
            response.windows(8).any(|value| value == b"]12;rgb:"),
            "missing cursor response: {response:?}"
        );
    }

    #[test]
    fn encodes_keys_from_terminal_modes() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert_eq!(
            terminal.encode_key("ArrowUp", "", 0, 0, 1).unwrap(),
            b"\x1b[A"
        );
        terminal.feed(b"\x1b[?1h");
        assert_eq!(
            terminal.encode_key("ArrowUp", "", 0, 0, 1).unwrap(),
            b"\x1bOA"
        );
        assert_eq!(
            terminal
                .encode_key("KeyC", "c", 'c'.into(), 1 << 1, 1)
                .unwrap(),
            b"\x03"
        );
    }

    #[test]
    fn suppresses_release_events_without_kitty_event_reporting() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        let press = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 1).unwrap();
        let release = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 0).unwrap();
        assert_eq!(press, b"w");
        assert!(release.is_empty());
    }

    #[test]
    fn reports_printable_releases_without_repeating_text_in_kitty_mode() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b[>7u");
        let press = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 1).unwrap();
        let release = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 0).unwrap();
        assert_eq!(press, b"w");
        assert_eq!(release, b"\x1b[119;1:3u");
    }

    const MODS_SHIFT: u16 = 1 << 0;
    const MODS_CTRL: u16 = 1 << 1;

    /// A shifted key sends the text the layout produced, not the unshifted key
    /// plus a shift modifier.
    ///
    /// Ghostty emits text verbatim only when the modifiers left after removing
    /// the ones the layout consumed are empty, so a shifted keypress that
    /// reports nothing consumed looks like a modified keypress instead. Under
    /// the Kitty protocol that made `shift+/` encode as `CSI 47;2u` — keycode
    /// `/` plus shift — so clients that enable progressive enhancement and
    /// cannot map a keycode back through the layout inserted `/` for `?`.
    /// Clients that never enable it were unaffected, which is why this survived
    /// in a plain shell.
    #[test]
    fn shifted_keys_encode_their_translated_text() {
        for flags in ["", "\x1b[>1u", "\x1b[>5u", "\x1b[>7u"] {
            let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
            terminal.feed(flags.as_bytes());
            let encoded = terminal
                .encode_key("Slash", "?", '/'.into(), MODS_SHIFT, 1)
                .unwrap();
            assert_eq!(
                encoded,
                b"?",
                "shift+slash under kitty flags {flags:?}: {:?}",
                String::from_utf8_lossy(&encoded)
            );
            assert_eq!(
                terminal
                    .encode_key("KeyW", "W", 'w'.into(), MODS_SHIFT, 1)
                    .unwrap(),
                b"W"
            );
            assert_eq!(
                terminal.encode_key("Slash", "/", '/'.into(), 0, 1).unwrap(),
                b"/"
            );
        }
    }

    /// `report_all` requires every key to be an escape sequence, so the shifted
    /// text cannot be sent verbatim. The shifted codepoint has to survive as the
    /// alternate key (`47:63`) and, once associated text is negotiated, as the
    /// trailing text field — otherwise the client is back to guessing.
    #[test]
    fn reporting_all_keys_still_carries_the_shifted_codepoint() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b[>31u");
        assert_eq!(
            terminal
                .encode_key("Slash", "?", '/'.into(), MODS_SHIFT, 1)
                .unwrap(),
            b"\x1b[47:63;2;63u"
        );
    }

    /// Consuming shift must not hide modifiers the application still needs: the
    /// text fast path is gated on *unconsumed* mods, and the reported bitmask
    /// keeps every mod that was actually held.
    #[test]
    fn consuming_shift_preserves_other_modifiers() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b[>1u");
        assert_eq!(
            terminal
                .encode_key("Slash", "?", '/'.into(), MODS_SHIFT | MODS_CTRL, 1)
                .unwrap(),
            b"\x1b[47;6u"
        );
    }

    /// Asking for the default cursor gets the same cursor as never asking.
    ///
    /// A blinking cursor is this terminal's default, but libghostty resolves
    /// `CSI 0 q` and a terminal reset against a separate DEFAULT_CURSOR_BLINK
    /// option that is false unless set. Declaring the default only as a mode
    /// left `CSI 0 q` — which is what a crossterm-style "restore the user's
    /// cursor" emits — turning blinking off for the rest of the session.
    #[test]
    fn resetting_to_the_default_cursor_keeps_it_blinking() {
        for sequence in ["", "\x1b[0 q", "\x1b[1 q", "\x1b[!p", "\x1bc", "\x1b[?12h"] {
            let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
            terminal.feed(sequence.as_bytes());
            assert!(
                terminal.snapshot().unwrap().cursor.blinking,
                "cursor stopped blinking after {sequence:?}"
            );
        }
    }

    /// The flip side: a program that explicitly asks for a steady cursor gets
    /// one, so the default above cannot be implemented by forcing blink on.
    #[test]
    fn honors_an_explicit_request_for_a_steady_cursor() {
        for (sequence, style) in [("\x1b[2 q", 1_u8), ("\x1b[4 q", 2), ("\x1b[6 q", 0)] {
            let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
            terminal.feed(sequence.as_bytes());
            let cursor = terminal.snapshot().unwrap().cursor;
            assert!(!cursor.blinking, "cursor still blinking after {sequence:?}");
            assert_eq!(cursor.style, style, "unexpected style for {sequence:?}");
        }
        let mut disabled = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        disabled.feed(b"\x1b[?12l");
        assert!(!disabled.snapshot().unwrap().cursor.blinking);
    }

    /// Scrolling the cursor out of the viewport hides it rather than parking it
    /// in the top-left corner.
    ///
    /// Ghostty answers "are the terminal modes showing a cursor" and "is the
    /// cursor inside the rows being rendered" separately, and documents the
    /// viewport position as undefined when the latter is false. Forwarding
    /// mode-visible alongside the zeroed position drew a cursor at (0, 0) for as
    /// long as the user stayed scrolled up. Only clients that show the real
    /// cursor could see it, which is why it looked specific to one program.
    #[test]
    fn hides_the_cursor_once_it_scrolls_out_of_the_viewport() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        for line in 0..10 {
            terminal.feed(format!("line-{line}\r\n").as_bytes());
        }
        terminal.feed(b"prompt> ");

        let bottom = terminal.snapshot().unwrap();
        assert_eq!((bottom.cursor.x, bottom.cursor.y), (8, 2));
        assert!(bottom.cursor.visible);

        terminal.scroll(-2);
        let scrolled = terminal.snapshot().unwrap();
        assert!(
            !scrolled.cursor.visible,
            "cursor reported visible at ({}, {}) while scrolled off screen",
            scrolled.cursor.x, scrolled.cursor.y
        );

        // Returning to the bottom restores it, so this hides rather than latches.
        terminal.scroll(2);
        let restored = terminal.snapshot().unwrap();
        assert_eq!((restored.cursor.x, restored.cursor.y), (8, 2));
        assert!(restored.cursor.visible);
    }

    #[test]
    fn encodes_mouse_only_when_application_tracking_is_active() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert!(!terminal.snapshot().unwrap().mouse_tracking);
        assert!(
            terminal
                .encode_mouse(0, 1, 0, 16.0, 22.0, 188, 100, 8, 19, 14, 12)
                .unwrap()
                .is_empty()
        );
        terminal.feed(b"\x1b[?1000h\x1b[?1006h");
        assert!(terminal.snapshot().unwrap().mouse_tracking);
        let encoded = terminal
            .encode_mouse(0, 1, 0, 16.0, 22.0, 668, 404, 8, 19, 14, 12)
            .unwrap();
        assert_eq!(
            encoded, b"\x1b[<0;1;1M",
            "unexpected mouse sequence: {encoded:?}"
        );
    }

    #[test]
    fn captures_osc52_clipboard_writes() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(
            terminal.snapshot().unwrap().clipboard.as_deref(),
            Some(b"hello".as_slice())
        );
    }

    #[test]
    fn scrolls_the_primary_screen_viewport() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        terminal.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let bottom = terminal.snapshot().unwrap();
        assert!(bottom.scrollbar.total > bottom.scrollbar.len);
        assert_eq!(
            bottom.scrollbar.offset + bottom.scrollbar.len,
            bottom.scrollbar.total
        );
        terminal.scroll(-2);
        let history = terminal.snapshot().unwrap();
        assert_ne!(history.rows, bottom.rows);
        assert!(history.scrollbar.offset < bottom.scrollbar.offset);
        assert!(
            history
                .rows
                .iter()
                .any(|row| row.starts_with("one") || row.starts_with("two"))
        );
        terminal.scroll_to(bottom.scrollbar.offset as usize);
        let restored = terminal.snapshot().unwrap();
        assert_eq!(restored.rows, bottom.rows);
        assert_eq!(restored.scrollbar, bottom.scrollbar);
    }

    /// Ghostty performs strict page reclamation only on 64-bit Linux and
    /// Darwin (`src/terminal/mem.zig`). Elsewhere full compression reports
    /// unsupported and leaves scrollback memory resident.
    const SCROLLBACK_RECLAIM_SUPPORTED: bool = cfg!(all(
        target_pointer_width = "64",
        any(target_os = "linux", target_vendor = "apple")
    ));

    #[test]
    fn full_scrollback_compression_preserves_logical_content() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 1_000_000).unwrap();
        for line in 0..2_000 {
            terminal.feed(format!("line-{line:04}\r\n").as_bytes());
        }
        let before = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        let before_scrollbar = terminal.snapshot().unwrap().scrollbar;

        // Logical content must survive either outcome; only reclamation is
        // platform-dependent.
        assert_eq!(
            terminal.compress_scrollback_full().unwrap(),
            SCROLLBACK_RECLAIM_SUPPORTED
        );

        let after = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        let after_scrollbar = terminal.snapshot().unwrap().scrollbar;
        assert_eq!(after, before);
        assert_eq!(after_scrollbar, before_scrollbar);
    }

    #[test]
    fn formats_screen_absolute_and_select_all_ranges() {
        let mut terminal = GhosttyTerminalCore::new(12, 2, 100).unwrap();
        terminal.feed(b"first\r\nsecond\r\nthird");
        let scrollbar = terminal.snapshot().unwrap().scrollbar;
        assert_eq!(terminal.selection_row_count().unwrap(), scrollbar.total);
        assert_eq!(
            terminal.selection_text((0, 1), (5, 1), false).unwrap(),
            "second"
        );
        let all = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        assert!(all.contains("first"));
        assert!(all.contains("third"));
        assert!(scrollbar.total >= 3);
    }

    #[test]
    fn selection_points_follow_cells_scrolled_inside_alternate_screen() {
        let mut terminal = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        terminal.feed(b"\x1b[?1049hfirst\r\nsecond\r\nthird");
        assert_eq!(
            terminal.selection_text((0, 1), (5, 1), false).unwrap(),
            "second"
        );
        assert_eq!(terminal.selection().unwrap().anchor.row, 1);

        // Claude Code and other TUIs scroll their alternate-screen grid. A
        // numeric row would remain 1 and silently begin selecting "third";
        // Ghostty's tracked grid pin follows "second" to row 0 instead.
        terminal.feed(b"\x1b[1S");
        let selection = terminal.selection().unwrap();
        assert_eq!(selection.anchor.row, 0);
        assert_eq!(selection.focus.row, 0);

        // A pin still belongs to the alternate screen after the TUI exits;
        // it must not highlight the same numeric row on the primary screen.
        terminal.feed(b"\x1b[?1049l");
        assert_eq!(terminal.selection(), None);
    }

    #[test]
    fn independently_tracked_selections_follow_their_own_cells() {
        let mut terminal = GhosttyTerminalCore::new(12, 3, 100).unwrap();
        terminal.feed(b"\x1b[?1049hfirst\r\nsecond\r\nthird");
        let second = terminal.track_selection((0, 1), (5, 1), false).unwrap();
        let third = terminal.track_selection((0, 2), (4, 2), false).unwrap();
        assert_eq!(
            terminal.format_tracked_selection(&second).unwrap(),
            "second"
        );
        assert_eq!(terminal.format_tracked_selection(&third).unwrap(), "third");

        // Installing a separate default selection must not replace either
        // caller-owned pair of pins.
        assert_eq!(
            terminal.selection_text((0, 0), (4, 0), false).unwrap(),
            "first"
        );
        terminal.feed(b"\x1b[1S");

        assert_eq!(
            terminal
                .tracked_selection_points(&second)
                .unwrap()
                .anchor
                .row,
            0
        );
        assert_eq!(
            terminal
                .tracked_selection_points(&third)
                .unwrap()
                .anchor
                .row,
            1
        );
        assert_eq!(
            terminal.format_tracked_selection(&second).unwrap(),
            "second"
        );
        assert_eq!(terminal.format_tracked_selection(&third).unwrap(), "third");
    }

    #[test]
    fn identifies_alternate_screen_scroll_key_mode() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(!terminal.alternate_scroll());
        terminal.feed(b"\x1b[?1049h\x1b[?1007h");
        assert!(terminal.alternate_scroll());
        terminal.feed(b"\x1b[?1007l");
        assert!(!terminal.alternate_scroll());
    }

    #[test]
    fn exposes_requested_cursor_style_and_blinking() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(terminal.snapshot().unwrap().cursor.blinking);
        terminal.feed(b"\x1b[5 q");
        let bar = terminal.snapshot().unwrap().cursor;
        assert_eq!(bar.style, 0);
        assert!(bar.blinking);
        terminal.feed(b"\x1b[4 q");
        let underline = terminal.snapshot().unwrap().cursor;
        assert_eq!(underline.style, 2);
        assert!(!underline.blinking);
    }

    #[test]
    fn encodes_focus_only_when_application_reporting_is_active() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(terminal.encode_focus(true).unwrap().is_empty());
        terminal.feed(b"\x1b[?1004h");
        assert_eq!(terminal.encode_focus(true).unwrap(), b"\x1b[I");
        assert_eq!(terminal.encode_focus(false).unwrap(), b"\x1b[O");
    }

    #[test]
    fn restores_primary_screen_after_alternate_screen() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"primary");
        terminal.feed(b"\x1b[?1049h\x1b[2J\x1b[Halternate");
        assert!(terminal.snapshot().unwrap().rows[0].starts_with("alternate"));
        terminal.feed(b"\x1b[?1049l");
        assert!(terminal.snapshot().unwrap().rows[0].starts_with("primary"));
    }

    #[test]
    fn reflows_wrapped_unicode_on_resize() {
        let mut terminal = GhosttyTerminalCore::new(6, 4, 100).unwrap();
        terminal.feed("ab界cdef".as_bytes());
        terminal.resize(12, 4).unwrap();
        let joined = terminal.snapshot().unwrap().rows.join("");
        assert!(
            joined.starts_with("ab界cdef"),
            "unexpected reflow output: {joined:?}"
        );
    }

    #[test]
    fn remains_stable_under_arbitrary_input_chunks() {
        let mut terminal = GhosttyTerminalCore::new(40, 8, 100).unwrap();
        let mut state = 0x5eed_u32;
        for chunk_index in 0..256 {
            let mut bytes = [0_u8; 64];
            for byte in &mut bytes {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (state >> 24) as u8;
            }
            terminal.feed(&bytes);
            if chunk_index % 16 == 0 {
                terminal.snapshot().unwrap();
            }
        }
        terminal.snapshot().unwrap();
    }
}
