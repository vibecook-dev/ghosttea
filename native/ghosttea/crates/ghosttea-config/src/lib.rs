//! Ghostty-compatible configuration loading with explicit compatibility
//! reporting.
//!
//! Ghosttea accepts Ghostty's `key = value` syntax and source layering, then
//! projects the values it can currently honor into platform-neutral terminal,
//! renderer, and workspace settings. Recognized-but-unimplemented keys are
//! retained as capabilities and reported as diagnostics instead of being
//! silently accepted.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const GHOSTTY_CONFIG_COMPAT_VERSION: &str = "1.3.1";
pub const GHOSTTY_CONFIG_COMPAT_COMMIT: &str = "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28";
// Retain the original public names as source-compatible aliases. These refer
// to the independently pinned config release, not the Ghostty VT build.
pub const GHOSTTY_COMPAT_VERSION: &str = GHOSTTY_CONFIG_COMPAT_VERSION;
pub const GHOSTTY_COMPAT_COMMIT: &str = GHOSTTY_CONFIG_COMPAT_COMMIT;
pub const DEFAULT_SCROLLBACK_BYTES: u64 = 10_000_000;
pub const GHOSTTEA_BETTER_CRT_SHADER: &str = "ghosttea:better-crt";
pub const GHOSTTEA_CRT_SHADER: &str = "ghosttea:crt";
pub const GHOSTTEA_VHS_SHADER: &str = "ghosttea:vhs";
pub const GHOSTTEA_SPARKS_SHADER: &str = "ghosttea:sparks-from-fire";
pub const CONFIG_DOCUMENT_SCHEMA_VERSION: u32 = 1;
/// Keeps a raw document plus worst-case JSON escaping below the 1 MiB control
/// packet quota. Ghostty configuration should reference large assets by path.
pub const MAX_CONFIG_DOCUMENT_BYTES: usize = 64 * 1024;
/// Bound every inherited/include source independently. This also rejects
/// devices and pipes before reading so configuration validation cannot become
/// an unbounded filesystem read.
const MAX_CONFIG_SOURCE_BYTES: usize = 64 * 1024;
const MAX_CONFIG_TOTAL_SOURCE_BYTES: usize = 512 * 1024;
const MAX_CONFIG_INCLUDE_FILES: usize = 128;

const DEFAULT_BACKGROUND: [u8; 3] = [0x28, 0x2c, 0x34];
const DEFAULT_FOREGROUND: [u8; 3] = [0xff, 0xff, 0xff];
const DEFAULT_FONT_SIZE_MACOS: f32 = 13.0;
const DEFAULT_FONT_SIZE_OTHER: f32 = 12.0;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const KNOWN_KEYS_TEXT: &str = include_str!("known-keys.txt");
const X11_COLORS_TEXT: &str = include_str!("x11-rgb.txt");

#[derive(Clone, Debug)]
pub struct ConfigLoadOptions {
    /// Load Ghostty's standard XDG and macOS files before the overlay.
    pub load_default_files: bool,
    /// A Ghosttea-owned final overlay. This is also the file opened by the UI.
    pub explicit_path: Option<PathBuf>,
    /// Test/embedding override. `None` resolves from `HOME` when loading.
    pub home_dir: Option<PathBuf>,
    /// Test/embedding override. `None` resolves from `XDG_CONFIG_HOME`.
    pub xdg_config_home: Option<PathBuf>,
    /// Test/embedding override for Ghostty's Windows `LOCALAPPDATA` fallback.
    pub local_app_data: Option<PathBuf>,
    /// Treat the host as macOS when adding Application Support paths.
    pub macos: bool,
    /// Treat the host as Windows when resolving XDG and home fallbacks.
    pub windows: bool,
}

impl Default for ConfigLoadOptions {
    fn default() -> Self {
        Self {
            load_default_files: true,
            explicit_path: None,
            home_dir: None,
            xdg_config_home: None,
            local_app_data: None,
            macos: cfg!(target_os = "macos"),
            windows: cfg!(target_os = "windows"),
        }
    }
}

impl ConfigLoadOptions {
    pub fn explicit(path: impl Into<PathBuf>) -> Self {
        Self {
            load_default_files: false,
            explicit_path: Some(path.into()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub schema_version: u32,
    pub revision: String,
    pub compatibility: ConfigCompatibility,
    pub sources: Vec<ConfigSource>,
    pub diagnostics: Vec<ConfigDiagnostic>,
    pub configured_keys: Vec<ConfiguredKey>,
    pub terminal: TerminalConfig,
    pub renderer: RendererConfig,
    pub workspace: WorkspaceConfig,
}

impl ConfigSnapshot {
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }

    /// Return the presentation settings that are safe and meaningful to send
    /// to a remote terminal view.
    ///
    /// This deliberately excludes source and diagnostic paths, workspace
    /// keybindings, scrollback policy, and custom shader paths. Those values
    /// are either host-private or owned by a different runtime boundary.
    pub fn terminal_presentation(&self) -> TerminalPresentationConfig {
        let mut presentation = TerminalPresentationConfig {
            schema_version: self.schema_version,
            revision: String::new(),
            foreground: self.renderer.foreground,
            background: self.renderer.background,
            cursor: self.renderer.cursor,
            cursor_text: self.renderer.cursor_text,
            selection_background: self.renderer.selection_background,
            selection_foreground: self.renderer.selection_foreground,
            palette: self.renderer.palette.clone(),
            background_opacity: self.renderer.background_opacity,
            background_opacity_cells: self.renderer.background_opacity_cells,
            font_size: self.renderer.font_size,
            font_families: self.renderer.font_families.clone(),
            padding_x: self.renderer.padding_x,
            padding_y: self.renderer.padding_y,
            post_process: self.renderer.post_process,
            shader_effects: self.renderer.shader_effects.clone(),
            custom_shader_animation: self.renderer.custom_shader_animation,
            custom_shader_count: u32::try_from(self.renderer.custom_shader_paths.len())
                .unwrap_or(u32::MAX),
        };
        presentation.revision = stable_json_revision(&presentation);
        presentation
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCompatibility {
    pub ghostty_version: String,
    pub ghostty_commit: String,
    pub known_key_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub path: String,
    pub kind: ConfigSourceKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigSourceKind {
    GhosttyDefault,
    Included,
    GhostteaOverlay,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredKey {
    pub key: String,
    pub support: ConfigSupport,
    pub occurrences: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigSupport {
    Applied,
    Parsed,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    pub scrollback_bytes: u64,
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    /// Sparse overrides for Ghostty's default 256-color palette.
    #[serde(default)]
    pub palette: Vec<PaletteConfigEntry>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaletteConfigEntry {
    pub index: u8,
    pub color: [u8; 3],
}

fn default_link_url() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererConfig {
    #[serde(default = "default_link_url")]
    pub link_url: bool,
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    #[serde(default = "default_cursor_text")]
    pub cursor_text: [u8; 3],
    pub selection_background: [u8; 3],
    pub selection_foreground: [u8; 3],
    #[serde(default)]
    pub palette: Vec<PaletteConfigEntry>,
    #[serde(default = "default_background_opacity")]
    pub background_opacity: f32,
    #[serde(default)]
    pub background_opacity_cells: bool,
    pub font_size: f32,
    pub font_families: Vec<String>,
    pub padding_x: [f32; 2],
    pub padding_y: [f32; 2],
    pub post_process: RendererPostProcess,
    /// Ordered, distributable WGSL effects selected from Ghosttea's registry.
    #[serde(default)]
    pub shader_effects: Vec<String>,
    #[serde(default)]
    pub custom_shader_animation: bool,
    pub custom_shader_paths: Vec<String>,
}

/// A redacted, renderer-owned projection for remote terminal views.
///
/// The session host is authoritative for this projection. View-local input
/// bindings and retention policy are intentionally not part of it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPresentationConfig {
    pub schema_version: u32,
    pub revision: String,
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    pub cursor_text: [u8; 3],
    pub selection_background: [u8; 3],
    pub selection_foreground: [u8; 3],
    #[serde(default)]
    pub palette: Vec<PaletteConfigEntry>,
    #[serde(default = "default_background_opacity")]
    pub background_opacity: f32,
    #[serde(default)]
    pub background_opacity_cells: bool,
    pub font_size: f32,
    pub font_families: Vec<String>,
    pub padding_x: [f32; 2],
    pub padding_y: [f32; 2],
    pub post_process: RendererPostProcess,
    /// Ordered, distributable effects selected from Ghosttea's built-in registry.
    #[serde(default)]
    pub shader_effects: Vec<String>,
    #[serde(default)]
    pub custom_shader_animation: bool,
    /// Number of host-local shader paths omitted from this projection.
    pub custom_shader_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPresentationConfigWire {
    schema_version: u32,
    revision: String,
    foreground: [u8; 3],
    background: [u8; 3],
    cursor: [u8; 3],
    #[serde(default)]
    cursor_text: Option<[u8; 3]>,
    selection_background: [u8; 3],
    selection_foreground: [u8; 3],
    #[serde(default)]
    palette: Vec<PaletteConfigEntry>,
    #[serde(default = "default_background_opacity")]
    background_opacity: f32,
    #[serde(default)]
    background_opacity_cells: bool,
    font_size: f32,
    font_families: Vec<String>,
    padding_x: [f32; 2],
    padding_y: [f32; 2],
    post_process: RendererPostProcess,
    #[serde(default)]
    shader_effects: Vec<String>,
    #[serde(default)]
    custom_shader_animation: bool,
    custom_shader_count: u32,
}

impl<'de> Deserialize<'de> for TerminalPresentationConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = TerminalPresentationConfigWire::deserialize(deserializer)?;
        Ok(Self {
            schema_version: wire.schema_version,
            revision: wire.revision,
            foreground: wire.foreground,
            background: wire.background,
            cursor: wire.cursor,
            cursor_text: wire.cursor_text.unwrap_or(wire.background),
            selection_background: wire.selection_background,
            selection_foreground: wire.selection_foreground,
            palette: wire.palette,
            background_opacity: wire.background_opacity,
            background_opacity_cells: wire.background_opacity_cells,
            font_size: wire.font_size,
            font_families: wire.font_families,
            padding_x: wire.padding_x,
            padding_y: wire.padding_y,
            post_process: wire.post_process,
            shader_effects: wire.shader_effects,
            custom_shader_animation: wire.custom_shader_animation,
            custom_shader_count: wire.custom_shader_count,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RendererPostProcess {
    #[default]
    None,
    BetterCrt,
}

const fn default_background_opacity() -> f32 {
    1.0
}

const fn default_cursor_text() -> [u8; 3] {
    DEFAULT_BACKGROUND
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    /// Ordered Ghostty keybind mutations.
    pub keybindings: Vec<KeybindingConfig>,
    /// True when `keybind = clear` removed the default binding set before
    /// later mutations. A subsequent blank `keybind =` restores defaults.
    pub clear_keybindings: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingConfig {
    pub trigger: String,
    pub action: String,
}

/// The exact app-owned Ghostty-syntax overlay.
///
/// `contents` is never reconstructed from [`ConfigSnapshot`], so comments,
/// ordering, unknown options, includes, and line endings round-trip unchanged.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub schema_version: u32,
    pub revision: String,
    pub path: String,
    pub exists: bool,
    pub contents: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocumentValidation {
    /// Revision the candidate would have as an existing document.
    pub document_revision: String,
    pub config: ConfigSnapshot,
}

#[derive(Debug)]
pub enum ConfigDocumentError {
    Unavailable,
    UnsafeOverlay {
        path: PathBuf,
    },
    TooLarge {
        actual: usize,
        limit: usize,
    },
    UnsupportedFileType {
        path: PathBuf,
    },
    InvalidUtf8 {
        path: PathBuf,
        source: std::string::FromUtf8Error,
    },
    NonUtf8Path {
        path: PathBuf,
    },
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    Conflict {
        current: ConfigDocument,
    },
}

impl std::fmt::Display for ConfigDocumentError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => formatter
                .write_str("configuration document is unavailable without an explicit overlay"),
            Self::UnsafeOverlay { path } => write!(
                formatter,
                "refusing to edit imported Ghostty configuration {}",
                path.display()
            ),
            Self::TooLarge { actual, limit } => write!(
                formatter,
                "configuration document is {actual} bytes; maximum is {limit} bytes"
            ),
            Self::UnsupportedFileType { path } => write!(
                formatter,
                "configuration document must be a regular file: {}",
                path.display()
            ),
            Self::InvalidUtf8 { path, .. } => write!(
                formatter,
                "configuration document is not valid UTF-8: {}",
                path.display()
            ),
            Self::NonUtf8Path { path } => write!(
                formatter,
                "configuration document path is not valid UTF-8: {}",
                path.display()
            ),
            Self::Io {
                operation,
                path,
                source,
            } => write!(
                formatter,
                "failed to {operation} configuration document {}: {source}",
                path.display()
            ),
            Self::Conflict { .. } => {
                formatter.write_str("configuration document changed since it was read")
            }
        }
    }
}

impl std::error::Error for ConfigDocumentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidUtf8 { source, .. } => Some(source),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct ConfigDocumentUpdate {
    pub document: ConfigDocument,
    pub config: Arc<ConfigSnapshot>,
    pub effective_changed: bool,
}

impl Default for ConfigSnapshot {
    fn default() -> Self {
        let renderer = RendererConfig {
            link_url: true,
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
            cursor: DEFAULT_FOREGROUND,
            cursor_text: DEFAULT_BACKGROUND,
            selection_background: DEFAULT_FOREGROUND,
            selection_foreground: DEFAULT_BACKGROUND,
            palette: Vec::new(),
            background_opacity: 1.0,
            background_opacity_cells: false,
            font_size: platform_default_font_size(),
            font_families: Vec::new(),
            padding_x: [2.0, 2.0],
            padding_y: [2.0, 2.0],
            post_process: RendererPostProcess::None,
            shader_effects: Vec::new(),
            custom_shader_animation: false,
            custom_shader_paths: Vec::new(),
        };
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            revision: String::new(),
            compatibility: ConfigCompatibility {
                ghostty_version: GHOSTTY_COMPAT_VERSION.to_owned(),
                ghostty_commit: GHOSTTY_COMPAT_COMMIT.to_owned(),
                known_key_count: known_keys().len(),
            },
            sources: Vec::new(),
            diagnostics: Vec::new(),
            configured_keys: Vec::new(),
            terminal: TerminalConfig {
                scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
                foreground: renderer.foreground,
                background: renderer.background,
                cursor: renderer.cursor,
                palette: renderer.palette.clone(),
            },
            renderer,
            workspace: WorkspaceConfig::default(),
        }
    }
}

/// A reloadable snapshot holder shared by the daemon's client connections.
#[derive(Clone)]
pub struct ConfigManager {
    options: ConfigLoadOptions,
    snapshot: Arc<RwLock<Arc<ConfigSnapshot>>>,
    document_lock: Arc<Mutex<()>>,
}

impl ConfigManager {
    pub fn load(options: ConfigLoadOptions) -> Self {
        let snapshot = Arc::new(load_config(&options));
        Self {
            options,
            snapshot: Arc::new(RwLock::new(snapshot)),
            document_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn snapshot(&self) -> Arc<ConfigSnapshot> {
        Arc::clone(&self.snapshot.read().unwrap())
    }

    /// Reload all sources. Returns the new snapshot and whether its effective
    /// content or diagnostics changed.
    pub fn reload(&self) -> (Arc<ConfigSnapshot>, bool) {
        let _guard = self
            .document_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reload_locked()
    }

    fn reload_locked(&self) -> (Arc<ConfigSnapshot>, bool) {
        let next = Arc::new(load_config(&self.options));
        let mut current = self.snapshot.write().unwrap();
        let changed = current.revision != next.revision;
        *current = Arc::clone(&next);
        (next, changed)
    }

    /// Read the exact app-owned overlay. Imported Ghostty files and includes
    /// are intentionally outside this editing capability.
    pub fn document(&self) -> Result<ConfigDocument, ConfigDocumentError> {
        let _guard = self
            .document_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.editable_overlay_path()?;
        read_config_document(&path)
    }

    /// Project a candidate overlay through the same loader without writing it.
    pub fn validate_document(
        &self,
        contents: &str,
    ) -> Result<ConfigDocumentValidation, ConfigDocumentError> {
        validate_document_size(contents)?;
        let _guard = self
            .document_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.editable_overlay_path()?;
        Ok(ConfigDocumentValidation {
            document_revision: config_document_revision(true, contents.as_bytes()),
            config: load_config_with_override(&self.options, Some((&path, contents))),
        })
    }

    /// Optimistically replace the app overlay after checking its exact raw
    /// revision, using an atomic same-directory filesystem replacement.
    pub fn replace_document(
        &self,
        expected_revision: &str,
        contents: &str,
    ) -> Result<ConfigDocumentUpdate, ConfigDocumentError> {
        validate_document_size(contents)?;
        let _guard = self
            .document_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = self.editable_overlay_path()?;
        let current = read_config_document(&path)?;
        if current.revision != expected_revision {
            return Err(ConfigDocumentError::Conflict { current });
        }

        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|source| ConfigDocumentError::Io {
            operation: "create the parent directory for",
            path: parent.to_owned(),
            source,
        })?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".ghosttea-config-")
            .tempfile_in(parent)
            .map_err(|source| ConfigDocumentError::Io {
                operation: "create a temporary file for",
                path: path.clone(),
                source,
            })?;
        temporary
            .write_all(contents.as_bytes())
            .and_then(|()| temporary.as_file_mut().sync_all())
            .map_err(|source| ConfigDocumentError::Io {
                operation: "write",
                path: path.clone(),
                source,
            })?;

        // Recheck after the potentially slow write and flush. This cannot
        // compel unrelated editors to honor our lock, but it prevents an edit
        // observed before the atomic replacement from being clobbered.
        let latest = read_config_document(&path)?;
        if latest.revision != expected_revision {
            return Err(ConfigDocumentError::Conflict { current: latest });
        }
        temporary
            .persist(&path)
            .map_err(|error| ConfigDocumentError::Io {
                operation: "replace",
                path: path.clone(),
                source: error.error,
            })?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }

        let document = read_config_document(&path)?;
        let (config, effective_changed) = self.reload_locked();
        Ok(ConfigDocumentUpdate {
            document,
            config,
            effective_changed,
        })
    }

    fn editable_overlay_path(&self) -> Result<PathBuf, ConfigDocumentError> {
        let configured = self
            .options
            .explicit_path
            .as_ref()
            .ok_or(ConfigDocumentError::Unavailable)?;
        let path = absolute_lexical_path(configured);
        let identity = normalize_identity(&path);
        if standard_config_paths(&self.options).iter().any(|standard| {
            paths_share_identity(
                &normalize_identity(standard),
                &identity,
                self.options.windows || self.options.macos,
            )
        }) {
            return Err(ConfigDocumentError::UnsafeOverlay { path });
        }
        Ok(path)
    }
}

#[derive(Clone, Debug)]
struct Setting {
    key: String,
    value: String,
    source: String,
    line: usize,
    bare: bool,
}

#[derive(Default)]
struct LoadState {
    settings: Vec<Setting>,
    sources: Vec<ConfigSource>,
    diagnostics: Vec<ConfigDiagnostic>,
    configured: BTreeMap<String, usize>,
    loaded_includes: HashSet<PathBuf>,
    loaded_source_bytes: usize,
    home_dir: Option<PathBuf>,
    default_font_size: f32,
}

pub fn load_config(options: &ConfigLoadOptions) -> ConfigSnapshot {
    load_config_with_override(options, None)
}

fn load_config_with_override(
    options: &ConfigLoadOptions,
    document_override: Option<(&Path, &str)>,
) -> ConfigSnapshot {
    let document_override = document_override.map(|(path, contents)| ConfigTextOverride {
        identity: normalize_identity(path),
        contents,
    });
    let mut state = LoadState {
        home_dir: resolved_home(options),
        default_font_size: if options.macos {
            DEFAULT_FONT_SIZE_MACOS
        } else {
            DEFAULT_FONT_SIZE_OTHER
        },
        ..LoadState::default()
    };
    let mut includes = VecDeque::new();
    for (path, kind, optional) in root_sources(options) {
        // Resolve every include discovered in Ghostty's own files before the
        // app-owned overlay, keeping the overlay a true final layer.
        if kind == ConfigSourceKind::GhostteaOverlay {
            drain_includes(&mut includes, document_override.as_ref(), &mut state);
        }
        load_file(
            &path,
            kind,
            optional,
            &mut includes,
            document_override.as_ref(),
            &mut state,
        );
    }
    drain_includes(&mut includes, document_override.as_ref(), &mut state);
    project(state)
}

pub fn standard_config_paths(options: &ConfigLoadOptions) -> Vec<PathBuf> {
    if !options.load_default_files {
        return Vec::new();
    }
    let home = resolved_home(options);
    let xdg = options
        .xdg_config_home
        .clone()
        .or_else(|| {
            env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            if options.windows {
                options.local_app_data.clone().or_else(|| {
                    env::var_os("LOCALAPPDATA")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
            } else {
                None
            }
        })
        .or_else(|| home.as_ref().map(|path| path.join(".config")));
    let mut paths = Vec::new();
    if let Some(xdg) = xdg {
        // Ghostty 1.3.1 loads the legacy name first so `config.ghostty`
        // wins when both files exist.
        paths.push(xdg.join("ghostty/config"));
        paths.push(xdg.join("ghostty/config.ghostty"));
    }
    if options.macos
        && let Some(home) = home
    {
        let directory = home.join("Library/Application Support/com.mitchellh.ghostty");
        paths.push(directory.join("config"));
        paths.push(directory.join("config.ghostty"));
    }
    paths
}

fn resolved_home(options: &ConfigLoadOptions) -> Option<PathBuf> {
    options.home_dir.clone().or_else(|| {
        if options.windows {
            env_path("USERPROFILE")
                .or_else(windows_home_from_drive_and_path)
                .or_else(|| env_path("HOME"))
        } else {
            env_path("HOME")
        }
    })
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn windows_home_from_drive_and_path() -> Option<PathBuf> {
    let drive = env::var_os("HOMEDRIVE").filter(|value| !value.is_empty())?;
    let path = env::var_os("HOMEPATH").filter(|value| !value.is_empty())?;
    let mut joined = drive;
    joined.push(path);
    Some(PathBuf::from(joined))
}

fn root_sources(options: &ConfigLoadOptions) -> Vec<(PathBuf, ConfigSourceKind, bool)> {
    let mut sources = standard_config_paths(options)
        .into_iter()
        .map(|path| (path, ConfigSourceKind::GhosttyDefault, true))
        .collect::<Vec<_>>();
    if let Some(path) = options.explicit_path.as_ref()
        && !sources.iter().any(|(candidate, _, _)| {
            paths_share_identity(
                &normalize_identity(candidate),
                &normalize_identity(path),
                options.windows || options.macos,
            )
        })
    {
        sources.push((
            path.clone(),
            ConfigSourceKind::GhostteaOverlay,
            // A not-yet-created application overlay is a valid empty config.
            true,
        ));
    }
    sources
}

#[derive(Clone)]
struct ConfigTextOverride<'a> {
    identity: PathBuf,
    contents: &'a str,
}

fn drain_includes(
    includes: &mut VecDeque<(PathBuf, bool)>,
    document_override: Option<&ConfigTextOverride<'_>>,
    state: &mut LoadState,
) {
    while let Some((path, optional)) = includes.pop_front() {
        load_file(
            &path,
            ConfigSourceKind::Included,
            optional,
            includes,
            document_override,
            state,
        );
    }
}

fn load_file(
    path: &Path,
    kind: ConfigSourceKind,
    optional: bool,
    includes: &mut VecDeque<(PathBuf, bool)>,
    document_override: Option<&ConfigTextOverride<'_>>,
    state: &mut LoadState,
) {
    let identity = normalize_identity(path);
    if kind == ConfigSourceKind::Included {
        // Ghostty de-duplicates entries in its recursive include queue. Root
        // files are not pre-seeded, so a root referenced by config-file is
        // loaded once more before a subsequent reference is diagnosed.
        if state.loaded_includes.contains(&identity) {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Warning,
                "include-cycle",
                format!("configuration include cycle ignored at {}", path.display()),
                Some(path),
                None,
                Some("config-file"),
            ));
            return;
        }
        if state.loaded_includes.len() >= MAX_CONFIG_INCLUDE_FILES {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Error,
                "source-limit-exceeded",
                format!("configuration includes are limited to {MAX_CONFIG_INCLUDE_FILES} files"),
                Some(path),
                None,
                Some("config-file"),
            ));
            includes.clear();
            return;
        }
        state.loaded_includes.insert(identity.clone());
    }
    let text = match document_override
        .filter(|document| document.identity == identity)
        .map(|document| Cow::Borrowed(document.contents))
    {
        Some(text) => {
            if state.loaded_source_bytes.saturating_add(text.len()) > MAX_CONFIG_TOTAL_SOURCE_BYTES
            {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "source-limit-exceeded",
                    format!(
                        "configuration sources exceed the {MAX_CONFIG_TOTAL_SOURCE_BYTES}-byte total limit"
                    ),
                    Some(path),
                    None,
                    None,
                ));
                return;
            }
            state.loaded_source_bytes += text.len();
            text
        }
        None => match read_config_source(
            path,
            MAX_CONFIG_TOTAL_SOURCE_BYTES.saturating_sub(state.loaded_source_bytes),
        ) {
            Ok((text, bytes)) => {
                state.loaded_source_bytes += bytes;
                Cow::Owned(text)
            }
            Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "source-read-failed",
                    format!("failed to read configuration {}: {error}", path.display()),
                    Some(path),
                    None,
                    None,
                ));
                return;
            }
        },
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    state.sources.push(ConfigSource {
        path: path.to_string_lossy().into_owned(),
        kind,
    });

    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (raw_key, raw_value, bare) = match raw.split_once('=') {
            Some((key, value)) => (key, value, false),
            None => (raw, "", true),
        };
        let key = raw_key.trim();
        if key.is_empty() {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Warning,
                "empty-key",
                "configuration key must not be empty".to_owned(),
                Some(path),
                Some(line),
                None,
            ));
            continue;
        }
        *state.configured.entry(key.to_owned()).or_default() += 1;
        let (value, quoted) = parse_value(raw_value.trim());
        if key == "config-file" {
            if bare {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "invalid-value",
                    "`config-file` requires a value".to_owned(),
                    Some(path),
                    Some(line),
                    Some(key),
                ));
                continue;
            }
            if value.is_empty() {
                if !quoted {
                    includes.clear();
                }
                continue;
            }
            let (include_value, include_optional) = if quoted {
                (value.as_str(), false)
            } else {
                value
                    .strip_prefix('?')
                    .map_or((value.as_str(), false), |value| {
                        (strip_surrounding_quotes(value), true)
                    })
            };
            if include_value.is_empty() {
                continue;
            }
            let Some(include_path) = resolve_include_path(include_value, path, line, state) else {
                continue;
            };
            includes.push_back((include_path, include_optional));
            continue;
        }
        state.settings.push(Setting {
            key: key.to_owned(),
            value,
            source: path.to_string_lossy().into_owned(),
            line,
            bare,
        });
    }
}

fn read_config_source(path: &Path, remaining_total_bytes: usize) -> io::Result<(String, usize)> {
    let mut file = match open_config_source(path) {
        Ok(file) => file,
        Err(open_error) => {
            // Windows rejects opening a directory before we can inspect the
            // resulting handle. Normalize that platform-specific error to the
            // same diagnostic produced after a successful open on Unix.
            match fs::metadata(path) {
                Ok(metadata) if !metadata.is_file() => return Err(non_regular_source_error()),
                _ => return Err(open_error),
            }
        }
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(non_regular_source_error());
    }

    let limit = MAX_CONFIG_SOURCE_BYTES.min(remaining_total_bytes);
    if metadata.len() > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "configuration source is {} bytes; maximum remaining is {limit} bytes",
                metadata.len()
            ),
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("configuration source exceeded the {limit}-byte limit while it was being read"),
        ));
    }
    let length = bytes.len();
    String::from_utf8(bytes)
        .map(|contents| (contents, length))
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "configuration source is not valid UTF-8",
            )
        })
}

fn non_regular_source_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "configuration source must be a regular file",
    )
}

fn open_config_source(path: &Path) -> io::Result<fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        // Opening a FIFO read-only can block before its descriptor can be
        // inspected. O_NONBLOCK is harmless for regular files and lets the
        // descriptor metadata check below reject special files safely.
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
    }

    #[cfg(not(unix))]
    {
        fs::File::open(path)
    }
}

fn parse_value(value: &str) -> (String, bool) {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        (value[1..value.len() - 1].to_owned(), true)
    } else {
        (value.to_owned(), false)
    }
}

fn strip_surrounding_quotes(value: &str) -> &str {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn resolve_include_path(
    value: &str,
    source: &Path,
    line: usize,
    state: &mut LoadState,
) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Some(path);
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return match state.home_dir.as_ref() {
            Some(home) => Some(home.join(relative)),
            None => {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "path-expansion-failed",
                    format!("cannot expand config-file `{value}` without a home directory"),
                    Some(source),
                    Some(line),
                    Some("config-file"),
                ));
                None
            }
        };
    }
    Some(source.parent().unwrap_or_else(|| Path::new(".")).join(path))
}

fn normalize_identity(path: &Path) -> PathBuf {
    let path = absolute_lexical_path(path);
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    let mut ancestor = path.as_path();
    let mut suffix = Vec::new();
    while let Some(name) = ancestor.file_name() {
        suffix.push(name.to_owned());
        let Some(parent) = ancestor.parent() else {
            break;
        };
        ancestor = parent;
        if let Ok(mut canonical) = ancestor.canonicalize() {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
    }
    path
}

fn absolute_lexical_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            std::path::Component::RootDir => {
                normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR));
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if normalized.file_name().is_some() {
                    normalized.pop();
                }
            }
            std::path::Component::Normal(component) => normalized.push(component),
        }
    }
    normalized
}

fn paths_share_identity(left: &Path, right: &Path, case_insensitive: bool) -> bool {
    left == right
        || (case_insensitive
            && left
                .to_string_lossy()
                .eq_ignore_ascii_case(&right.to_string_lossy()))
}

fn validate_document_size(contents: &str) -> Result<(), ConfigDocumentError> {
    let actual = contents.len();
    if actual > MAX_CONFIG_DOCUMENT_BYTES {
        return Err(ConfigDocumentError::TooLarge {
            actual,
            limit: MAX_CONFIG_DOCUMENT_BYTES,
        });
    }
    Ok(())
}

fn read_config_document(path: &Path) -> Result<ConfigDocument, ConfigDocumentError> {
    let document_path = path
        .to_str()
        .ok_or_else(|| ConfigDocumentError::NonUtf8Path {
            path: path.to_owned(),
        })?
        .to_owned();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(ConfigDocumentError::Io {
                operation: "inspect",
                path: path.to_owned(),
                source,
            });
        }
    };
    if metadata
        .as_ref()
        .is_some_and(|metadata| !metadata.file_type().is_file())
    {
        return Err(ConfigDocumentError::UnsupportedFileType {
            path: path.to_owned(),
        });
    }
    let (exists, contents) = if metadata.is_some() {
        let bytes = fs::read(path).map_err(|source| ConfigDocumentError::Io {
            operation: "read",
            path: path.to_owned(),
            source,
        })?;
        if bytes.len() > MAX_CONFIG_DOCUMENT_BYTES {
            return Err(ConfigDocumentError::TooLarge {
                actual: bytes.len(),
                limit: MAX_CONFIG_DOCUMENT_BYTES,
            });
        }
        let contents =
            String::from_utf8(bytes).map_err(|source| ConfigDocumentError::InvalidUtf8 {
                path: path.to_owned(),
                source,
            })?;
        (true, contents)
    } else {
        (false, String::new())
    };
    Ok(ConfigDocument {
        schema_version: CONFIG_DOCUMENT_SCHEMA_VERSION,
        revision: config_document_revision(exists, contents.as_bytes()),
        path: document_path,
        exists,
        contents,
    })
}

fn config_document_revision(exists: bool, contents: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"ghosttea-config-document-v1\0");
    hash.update([u8::from(exists)]);
    hash.update(contents);
    format!("{:x}", hash.finalize())
}

fn project(mut state: LoadState) -> ConfigSnapshot {
    let known = known_keys();
    let mut snapshot = ConfigSnapshot {
        sources: state.sources,
        ..ConfigSnapshot::default()
    };
    snapshot.renderer.font_size = state.default_font_size;
    let mut scalars = Vec::<Setting>::new();
    let mut font_families = Vec::<Setting>::new();
    let mut custom_shaders = Vec::<Setting>::new();
    let mut keybindings = Vec::<Setting>::new();
    let mut clear_keybindings = false;

    for setting in state.settings {
        if !known.contains(setting.key.as_str()) {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "unknown-key",
                format!("unknown Ghostty configuration key `{}`", setting.key),
                &setting,
            ));
            continue;
        }
        if setting.bare && support_for_key(&setting.key) != ConfigSupport::Unsupported {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                format!("`{}` requires a value", setting.key),
                &setting,
            ));
            continue;
        }
        match setting.key.as_str() {
            "font-family" => {
                if setting.value.is_empty() {
                    font_families.clear();
                } else {
                    font_families.push(setting);
                }
            }
            "custom-shader" => {
                if setting.value.is_empty() {
                    custom_shaders.clear();
                } else {
                    custom_shaders.push(setting);
                }
            }
            "keybind" => {
                if setting.value.is_empty() {
                    keybindings.clear();
                    clear_keybindings = false;
                } else if setting.value == "clear" {
                    keybindings.clear();
                    clear_keybindings = true;
                } else {
                    keybindings.push(setting);
                }
            }
            _ => {
                scalars.push(setting);
            }
        }
    }

    let mut parsed_only_keys = BTreeSet::new();
    apply_color(
        &scalars,
        "background",
        &mut snapshot.renderer.background,
        DEFAULT_BACKGROUND,
        &mut state.diagnostics,
    );
    apply_color(
        &scalars,
        "foreground",
        &mut snapshot.renderer.foreground,
        DEFAULT_FOREGROUND,
        &mut state.diagnostics,
    );
    snapshot.renderer.cursor = snapshot.renderer.foreground;
    if apply_terminal_color(
        &scalars,
        "cursor-color",
        &mut snapshot.renderer.cursor,
        snapshot.renderer.foreground,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("cursor-color");
    }
    snapshot.renderer.cursor_text = snapshot.renderer.background;
    if apply_terminal_color(
        &scalars,
        "cursor-text",
        &mut snapshot.renderer.cursor_text,
        snapshot.renderer.background,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("cursor-text");
    }
    snapshot.renderer.selection_background = snapshot.renderer.foreground;
    snapshot.renderer.selection_foreground = snapshot.renderer.background;
    if apply_terminal_color(
        &scalars,
        "selection-background",
        &mut snapshot.renderer.selection_background,
        snapshot.renderer.foreground,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("selection-background");
    }
    if apply_terminal_color(
        &scalars,
        "selection-foreground",
        &mut snapshot.renderer.selection_foreground,
        snapshot.renderer.background,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("selection-foreground");
    }
    apply_palette(
        &scalars,
        &mut snapshot.renderer.palette,
        &mut state.diagnostics,
    );
    for setting in scalars
        .iter()
        .filter(|setting| setting.key == "background-opacity")
    {
        if setting.value.is_empty() {
            snapshot.renderer.background_opacity = 1.0;
            continue;
        }
        match setting.value.parse::<f32>() {
            Ok(value) if value.is_finite() && (0.0..=1.0).contains(&value) => {
                snapshot.renderer.background_opacity = value;
            }
            _ => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`background-opacity` must be a number from 0 through 1".to_owned(),
                setting,
            )),
        }
    }
    for setting in scalars
        .iter()
        .filter(|setting| setting.key == "background-opacity-cells")
    {
        if setting.value.is_empty() {
            snapshot.renderer.background_opacity_cells = false;
            continue;
        }
        match parse_bool(&setting.value) {
            Some(value) => snapshot.renderer.background_opacity_cells = value,
            None => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`background-opacity-cells` must be `true` or `false`".to_owned(),
                setting,
            )),
        }
    }
    for setting in scalars.iter().filter(|setting| setting.key == "link-url") {
        if setting.value.is_empty() {
            snapshot.renderer.link_url = true;
            continue;
        }
        match parse_bool(&setting.value) {
            Some(value) => snapshot.renderer.link_url = value,
            None => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`link-url` must be `true` or `false`".to_owned(),
                setting,
            )),
        }
    }
    for setting in scalars
        .iter()
        .filter(|setting| setting.key == "scrollback-limit")
    {
        if setting.value.is_empty() {
            snapshot.terminal.scrollback_bytes = DEFAULT_SCROLLBACK_BYTES;
            continue;
        }
        match setting.value.parse::<u64>() {
            Ok(value) if value <= MAX_JSON_SAFE_INTEGER => {
                snapshot.terminal.scrollback_bytes = value;
            }
            _ => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                format!(
                    "`scrollback-limit` must be a non-negative byte count no greater than {MAX_JSON_SAFE_INTEGER}"
                ),
                setting,
            )),
        }
    }
    for setting in scalars.iter().filter(|setting| setting.key == "font-size") {
        if setting.value.is_empty() {
            snapshot.renderer.font_size = state.default_font_size;
            continue;
        }
        match setting.value.parse::<f32>() {
            Ok(value) if value.is_finite() && value > 0.0 => {
                snapshot.renderer.font_size = value;
            }
            _ => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`font-size` must be a positive number".to_owned(),
                setting,
            )),
        }
    }
    apply_padding(
        &scalars,
        "window-padding-x",
        &mut snapshot.renderer.padding_x,
        [2.0, 2.0],
        &mut state.diagnostics,
    );
    apply_padding(
        &scalars,
        "window-padding-y",
        &mut snapshot.renderer.padding_y,
        [2.0, 2.0],
        &mut state.diagnostics,
    );
    snapshot.renderer.font_families = font_families
        .iter()
        .map(|setting| setting.value.clone())
        .collect();

    for setting in custom_shaders {
        if let Some(shader_id) = builtin_shader_id(&setting.value) {
            if shader_id == GHOSTTEA_BETTER_CRT_SHADER {
                snapshot.renderer.post_process = RendererPostProcess::BetterCrt;
            }
            snapshot.renderer.shader_effects.push(shader_id.to_owned());
        } else {
            snapshot
                .renderer
                .custom_shader_paths
                .push(setting.value.clone());
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "unsupported-custom-shader",
                format!(
                    "custom shader `{}` was imported but cannot run in Ghosttea's WGSL renderer",
                    setting.value
                ),
                &setting,
            ));
        }
    }
    for setting in scalars
        .iter()
        .filter(|setting| setting.key == "custom-shader-animation")
    {
        if setting.value.is_empty() {
            snapshot.renderer.custom_shader_animation = false;
            continue;
        }
        match parse_bool(&setting.value) {
            Some(value) => snapshot.renderer.custom_shader_animation = value,
            None => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`custom-shader-animation` must be `true` or `false`".to_owned(),
                setting,
            )),
        }
    }

    snapshot.workspace.clear_keybindings = clear_keybindings;
    for setting in keybindings {
        let Some((trigger, action)) = split_keybinding(&setting.value) else {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` must use `trigger=action`".to_owned(),
                &setting,
            ));
            continue;
        };
        if trigger.trim().is_empty() {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` trigger must not be empty".to_owned(),
                &setting,
            ));
            continue;
        }
        if action.trim().is_empty() {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` action must not be empty".to_owned(),
                &setting,
            ));
            continue;
        }
        snapshot.workspace.keybindings.push(KeybindingConfig {
            trigger: trigger.trim().to_owned(),
            action: action.trim().to_owned(),
        });
    }

    snapshot.terminal.foreground = snapshot.renderer.foreground;
    snapshot.terminal.background = snapshot.renderer.background;
    snapshot.terminal.cursor = snapshot.renderer.cursor;
    snapshot.terminal.palette = snapshot.renderer.palette.clone();

    let mut unsupported_reported = BTreeSet::new();
    snapshot.configured_keys = state
        .configured
        .into_iter()
        .map(|(key, occurrences)| {
            let support = if parsed_only_keys.contains(key.as_str()) {
                ConfigSupport::Parsed
            } else {
                support_for_key(&key)
            };
            if known.contains(key.as_str())
                && support == ConfigSupport::Unsupported
                && unsupported_reported.insert(key.clone())
            {
                state.diagnostics.push(ConfigDiagnostic {
                    severity: DiagnosticSeverity::Info,
                    code: "recognized-not-applied".to_owned(),
                    message: format!(
                        "Ghostty key `{key}` is recognized by the compatibility schema but is not applied yet"
                    ),
                    source: None,
                    line: None,
                    key: Some(key.clone()),
                });
            }
            ConfiguredKey {
                key,
                support,
                occurrences,
            }
        })
        .collect();
    snapshot.diagnostics = state.diagnostics;
    snapshot.revision = snapshot_revision(&snapshot);
    snapshot
}

fn split_keybinding(value: &str) -> Option<(&str, &str)> {
    for (index, _) in value.match_indices('=') {
        let trigger = &value[..index];
        if valid_keybinding_trigger(trigger) {
            return Some((trigger, &value[index + 1..]));
        }
    }
    None
}

fn valid_keybinding_trigger(value: &str) -> bool {
    let mut value = value.trim();
    for prefix in ["all:", "global:", "unconsumed:", "performable:"] {
        while let Some(rest) = value.strip_prefix(prefix) {
            value = rest;
        }
    }
    loop {
        let previous = value;
        for modifier in [
            "super+", "cmd+", "command+", "ctrl+", "control+", "shift+", "alt+", "opt+", "option+",
        ] {
            if let Some(rest) = value.strip_prefix(modifier) {
                value = rest;
                break;
            }
        }
        if value == previous {
            break;
        }
    }
    !value.is_empty()
}

fn apply_color(
    scalars: &[Setting],
    key: &str,
    output: &mut [u8; 3],
    reset: [u8; 3],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) {
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            continue;
        }
        match parse_color(&setting.value) {
            Some(value) => *output = value,
            None => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-color",
                format!("`{key}` must be a valid Ghostty color"),
                setting,
            )),
        }
    }
}

fn apply_palette(
    scalars: &[Setting],
    output: &mut Vec<PaletteConfigEntry>,
    diagnostics: &mut Vec<ConfigDiagnostic>,
) {
    let mut palette = BTreeMap::<u8, [u8; 3]>::new();
    for setting in scalars.iter().filter(|setting| setting.key == "palette") {
        if setting.value.is_empty() {
            palette.clear();
            continue;
        }
        let parsed = setting.value.split_once('=').and_then(|(index, color)| {
            Some((index.trim().parse::<u8>().ok()?, parse_color(color.trim())?))
        });
        match parsed {
            Some((index, color)) => {
                palette.insert(index, color);
            }
            None => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-palette",
                "`palette` must use `index=color` with an index from 0 through 255".to_owned(),
                setting,
            )),
        }
    }
    *output = palette
        .into_iter()
        .map(|(index, color)| PaletteConfigEntry { index, color })
        .collect();
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn builtin_shader_id(value: &str) -> Option<&'static str> {
    match value.trim() {
        GHOSTTEA_BETTER_CRT_SHADER => Some(GHOSTTEA_BETTER_CRT_SHADER),
        GHOSTTEA_CRT_SHADER => Some(GHOSTTEA_CRT_SHADER),
        GHOSTTEA_VHS_SHADER => Some(GHOSTTEA_VHS_SHADER),
        GHOSTTEA_SPARKS_SHADER => Some(GHOSTTEA_SPARKS_SHADER),
        _ => None,
    }
}

/// Apply a Ghostty `TerminalColor` to the fixed-color runtime projection.
///
/// Cell color references are valid Ghostty syntax, but their value is chosen
/// per rendered cell. Keep the last representable fixed value and report that
/// the dynamic value was parsed rather than pretending it is globally fixed.
/// Returns true when the effective final value is a dynamic reference.
fn apply_terminal_color(
    scalars: &[Setting],
    key: &str,
    output: &mut [u8; 3],
    reset: [u8; 3],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) -> bool {
    let mut dynamic = false;
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            dynamic = false;
            continue;
        }
        if matches!(
            setting.value.as_str(),
            "cell-foreground" | "cell-background"
        ) {
            dynamic = true;
            diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "dynamic-color-not-applied",
                format!(
                    "`{key} = {}` is valid Ghostty syntax but requires per-cell rendering that Ghosttea does not apply yet",
                    setting.value
                ),
                setting,
            ));
            continue;
        }
        match parse_color(&setting.value) {
            Some(value) => {
                *output = value;
                dynamic = false;
            }
            None => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-color",
                format!("`{key}` must be a valid Ghostty color or cell color reference"),
                setting,
            )),
        }
    }
    dynamic
}

fn apply_padding(
    scalars: &[Setting],
    key: &str,
    output: &mut [f32; 2],
    reset: [f32; 2],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) {
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            continue;
        }
        let values = setting
            .value
            .split(',')
            .map(str::trim)
            .map(str::parse::<f32>)
            .collect::<Result<Vec<_>, _>>();
        match values {
            Ok(values)
                if (values.len() == 1 || values.len() == 2)
                    && values
                        .iter()
                        .all(|value| value.is_finite() && *value >= 0.0) =>
            {
                output[0] = values[0];
                output[1] = *values.get(1).unwrap_or(&values[0]);
            }
            _ => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-padding",
                format!("`{key}` must contain one or two non-negative numbers"),
                setting,
            )),
        }
    }
}

pub fn parse_color(value: &str) -> Option<[u8; 3]> {
    let value = value.trim_matches([' ', '\t']);
    if let Some(hex) = value.strip_prefix('#') {
        return parse_hash_hex_color(hex);
    }
    if let Some(named) = parse_x11_color(value) {
        return Some(named);
    }
    if matches!(value.len(), 3 | 6) {
        return parse_equal_width_hex_color(value);
    }
    if let Some(components) = value.strip_prefix("rgb:") {
        return parse_function_color(components, parse_scaled_hex_component);
    }
    if let Some(components) = value.strip_prefix("rgbi:") {
        return parse_function_color(components, parse_intensity_component);
    }
    None
}

fn parse_hash_hex_color(value: &str) -> Option<[u8; 3]> {
    if !matches!(value.len(), 3 | 6 | 9 | 12) {
        return None;
    }
    parse_equal_width_hex_color(value)
}

fn parse_equal_width_hex_color(value: &str) -> Option<[u8; 3]> {
    let width = value.len().checked_div(3)?;
    if !(1..=4).contains(&width)
        || width * 3 != value.len()
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some([
        parse_scaled_hex_component(&value[0..width])?,
        parse_scaled_hex_component(&value[width..width * 2])?,
        parse_scaled_hex_component(&value[width * 2..])?,
    ])
}

fn parse_function_color(value: &str, parse_component: fn(&str) -> Option<u8>) -> Option<[u8; 3]> {
    let mut components = value.split('/');
    let result = [
        parse_component(components.next()?)?,
        parse_component(components.next()?)?,
        parse_component(components.next()?)?,
    ];
    components.next().is_none().then_some(result)
}

fn parse_scaled_hex_component(value: &str) -> Option<u8> {
    if value.is_empty() || value.len() > 4 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let component = u32::from_str_radix(value, 16).ok()?;
    let divisor = (1_u32 << (value.len() * 4)) - 1;
    Some((component * u32::from(u8::MAX) / divisor) as u8)
}

fn parse_intensity_component(value: &str) -> Option<u8> {
    let component = value.parse::<f64>().ok()?;
    if !component.is_finite() || !(0.0..=1.0).contains(&component) {
        return None;
    }
    Some((component * f64::from(u8::MAX)) as u8)
}

fn parse_x11_color(value: &str) -> Option<[u8; 3]> {
    for line in X11_COLORS_TEXT.lines() {
        let name = line.get(12..)?.trim_matches([' ', '\t']);
        if !name.eq_ignore_ascii_case(value) {
            continue;
        }
        return Some([
            line.get(0..3)?.trim().parse().ok()?,
            line.get(4..7)?.trim().parse().ok()?,
            line.get(8..11)?.trim().parse().ok()?,
        ]);
    }
    None
}

const fn platform_default_font_size() -> f32 {
    if cfg!(target_os = "macos") {
        DEFAULT_FONT_SIZE_MACOS
    } else {
        DEFAULT_FONT_SIZE_OTHER
    }
}

fn known_keys() -> BTreeSet<&'static str> {
    KNOWN_KEYS_TEXT
        .lines()
        .filter(|line| !line.is_empty())
        .collect()
}

fn support_for_key(key: &str) -> ConfigSupport {
    match key {
        "link-url"
        | "background"
        | "background-opacity"
        | "background-opacity-cells"
        | "foreground"
        | "cursor-color"
        | "cursor-text"
        | "palette"
        | "selection-background"
        | "selection-foreground"
        | "scrollback-limit"
        | "custom-shader-animation" => ConfigSupport::Applied,
        "config-file" | "custom-shader" | "font-family" | "font-size" | "window-padding-x"
        | "window-padding-y" | "keybind" => ConfigSupport::Parsed,
        _ => ConfigSupport::Unsupported,
    }
}

fn diagnostic_at(
    severity: DiagnosticSeverity,
    code: &str,
    message: String,
    setting: &Setting,
) -> ConfigDiagnostic {
    ConfigDiagnostic {
        severity,
        code: code.to_owned(),
        message,
        source: Some(setting.source.clone()),
        line: Some(setting.line),
        key: Some(setting.key.clone()),
    }
}

fn diagnostic(
    severity: DiagnosticSeverity,
    code: &str,
    message: String,
    source: Option<&Path>,
    line: Option<usize>,
    key: Option<&str>,
) -> ConfigDiagnostic {
    ConfigDiagnostic {
        severity,
        code: code.to_owned(),
        message,
        source: source.map(|path| path.to_string_lossy().into_owned()),
        line,
        key: key.map(str::to_owned),
    }
}

fn snapshot_revision(snapshot: &ConfigSnapshot) -> String {
    // FNV-1a is deliberately simple and stable across Rust releases. Omit the
    // revision field itself while hashing.
    let mut clone = snapshot.clone();
    clone.revision.clear();
    stable_json_revision(&clone)
}

fn stable_json_revision(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn defaults_match_pinned_ghostty_and_disable_crt() {
        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: false,
            ..ConfigLoadOptions::default()
        });
        assert_eq!(snapshot.terminal.scrollback_bytes, 10_000_000);
        assert_eq!(snapshot.renderer.font_size, platform_default_font_size());
        assert_eq!(snapshot.renderer.padding_x, [2.0, 2.0]);
        assert_eq!(snapshot.renderer.post_process, RendererPostProcess::None);
        assert_eq!(snapshot.compatibility.known_key_count, 202);
        assert!(!snapshot.has_errors());
    }

    #[test]
    fn remote_presentation_excludes_host_private_configuration() {
        let mut snapshot = ConfigSnapshot {
            revision: "revision-1".into(),
            ..ConfigSnapshot::default()
        };
        let baseline = snapshot.terminal_presentation();
        snapshot.sources.push(ConfigSource {
            path: "/Users/example/.config/ghostty/config".into(),
            kind: ConfigSourceKind::GhosttyDefault,
        });
        snapshot.workspace.keybindings.push(KeybindingConfig {
            trigger: "super+x".into(),
            action: "close_surface".into(),
        });

        let private_only = snapshot.terminal_presentation();
        assert_eq!(private_only.revision, baseline.revision);

        snapshot.renderer.custom_shader_paths = vec!["/Users/example/private.glsl".into()];
        let presentation = snapshot.terminal_presentation();
        let json = serde_json::to_value(&presentation).unwrap();

        assert!(!presentation.revision.is_empty());
        assert_ne!(presentation.revision, baseline.revision);
        assert_eq!(presentation.custom_shader_count, 1);
        assert_eq!(presentation.background, snapshot.renderer.background);
        assert_eq!(presentation.cursor_text, snapshot.renderer.cursor_text);
        assert_eq!(presentation.palette, snapshot.renderer.palette);
        assert_eq!(
            presentation.background_opacity,
            snapshot.renderer.background_opacity
        );
        assert_eq!(
            presentation.background_opacity_cells,
            snapshot.renderer.background_opacity_cells
        );
        assert_eq!(
            presentation.shader_effects,
            snapshot.renderer.shader_effects
        );
        assert_eq!(
            presentation.custom_shader_animation,
            snapshot.renderer.custom_shader_animation
        );
        assert!(json.get("sources").is_none());
        assert!(json.get("diagnostics").is_none());
        assert!(json.get("workspace").is_none());
        assert!(json.get("customShaderPaths").is_none());
        assert!(!json.to_string().contains("/Users/example"));

        snapshot.renderer.background = [1, 2, 3];
        assert_ne!(
            snapshot.terminal_presentation().revision,
            presentation.revision
        );
    }

    #[test]
    fn older_remote_presentation_defaults_new_fields_from_its_background() {
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "revision": "legacy-peer",
            "foreground": [1, 2, 3],
            "background": [4, 5, 6],
            "cursor": [7, 8, 9],
            "selectionBackground": [10, 11, 12],
            "selectionForeground": [13, 14, 15],
            "fontSize": 13.0,
            "fontFamilies": [],
            "paddingX": [2.0, 2.0],
            "paddingY": [2.0, 2.0],
            "postProcess": "none",
            "customShaderCount": 0,
        });
        let presentation: TerminalPresentationConfig = serde_json::from_value(legacy).unwrap();

        assert_eq!(presentation.cursor_text, presentation.background);
        assert!(presentation.palette.is_empty());
        assert_eq!(presentation.background_opacity, 1.0);
        assert!(!presentation.background_opacity_cells);
        assert!(presentation.shader_effects.is_empty());
        assert!(!presentation.custom_shader_animation);
    }

    #[test]
    fn document_api_preserves_text_validates_without_writing_and_detects_conflicts() {
        let temporary = TempDir::new().unwrap();
        let overlay = temporary.path().join("config.ghostty");
        let included = temporary.path().join("colors.ghostty");
        let original = "\u{feff}# original comment\r\nscrollback-limit = 123\r\n";
        write(&overlay, original);
        write(&included, "foreground = aabbcc\n");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&overlay));

        let document = manager.document().unwrap();
        assert!(document.exists);
        assert_eq!(document.contents, original);
        assert_eq!(manager.snapshot().terminal.scrollback_bytes, 123);

        let candidate = concat!(
            "# comments, ordering, and unknown Ghostty keys remain exact\r\n",
            "config-file = colors.ghostty\r\n",
            "future-ghostty-option = enabled\r\n",
            "scrollback-limit = 654321\r\n",
        );
        let validation = manager.validate_document(candidate).unwrap();
        assert_eq!(validation.config.terminal.scrollback_bytes, 654_321);
        assert_eq!(validation.config.renderer.foreground, [0xaa, 0xbb, 0xcc]);
        assert!(
            validation
                .config
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "unknown-key")
        );
        assert_eq!(fs::read_to_string(&overlay).unwrap(), original);
        assert_eq!(manager.snapshot().terminal.scrollback_bytes, 123);

        let update = manager
            .replace_document(&document.revision, candidate)
            .unwrap();
        assert_eq!(update.document.contents, candidate);
        assert_eq!(update.config.terminal.scrollback_bytes, 654_321);
        assert!(update.effective_changed);
        assert_eq!(fs::read_to_string(&overlay).unwrap(), candidate);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&overlay).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(
            fs::read_dir(temporary.path())
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".ghosttea-config-"))
        );

        let external = "# changed in another editor\nscrollback-limit = 777\n";
        write(&overlay, external);
        let error = manager
            .replace_document(&update.document.revision, "scrollback-limit = 888\n")
            .unwrap_err();
        match error {
            ConfigDocumentError::Conflict { current } => {
                assert_eq!(current.contents, external);
                assert_ne!(current.revision, update.document.revision);
            }
            other => panic!("expected document conflict, got {other}"),
        }
        assert_eq!(fs::read_to_string(&overlay).unwrap(), external);
    }

    #[test]
    fn document_api_distinguishes_a_missing_overlay_from_an_empty_file() {
        let temporary = TempDir::new().unwrap();
        let overlay = temporary.path().join("config.ghostty");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&overlay));

        let missing = manager.document().unwrap();
        assert!(!missing.exists);
        assert!(missing.contents.is_empty());
        assert_eq!(missing.revision.len(), 64);
        let created = manager
            .replace_document(&missing.revision, "")
            .unwrap()
            .document;
        assert!(created.exists);
        assert!(created.contents.is_empty());
        assert_eq!(created.revision.len(), 64);
        assert_ne!(created.revision, missing.revision);
    }

    #[test]
    fn document_api_serializes_concurrent_writers() {
        let temporary = TempDir::new().unwrap();
        let overlay = temporary.path().join("config.ghostty");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&overlay));
        let revision = manager.document().unwrap().revision;
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let writers = ["background = 111111\n", "background = 222222\n"]
            .into_iter()
            .map(|contents| {
                let manager = manager.clone();
                let revision = revision.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    manager.replace_document(&revision, contents)
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let results = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(ConfigDocumentError::Conflict { .. })))
                .count(),
            1
        );
        assert!(matches!(
            fs::read_to_string(&overlay).unwrap().as_str(),
            "background = 111111\n" | "background = 222222\n"
        ));
    }

    #[test]
    fn document_api_requires_a_distinct_explicit_overlay_and_enforces_its_quota() {
        let unavailable = ConfigManager::load(ConfigLoadOptions {
            load_default_files: false,
            ..ConfigLoadOptions::default()
        });
        assert!(matches!(
            unavailable.document(),
            Err(ConfigDocumentError::Unavailable)
        ));

        let temporary = TempDir::new().unwrap();
        let standard = temporary.path().join("ghostty/config.ghostty");
        write(&standard, "background = 112233\n");
        let imported = ConfigManager::load(ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(standard.clone()),
            home_dir: Some(temporary.path().join("home")),
            xdg_config_home: Some(temporary.path().to_owned()),
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert!(matches!(
            imported.document(),
            Err(ConfigDocumentError::UnsafeOverlay { .. })
        ));

        let missing_standard = temporary.path().join("missing-root");
        let aliased_import = ConfigManager::load(ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(missing_standard.join("ghostty/nested/../config.ghostty")),
            home_dir: Some(temporary.path().join("other-home")),
            xdg_config_home: Some(missing_standard),
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert!(matches!(
            aliased_import.document(),
            Err(ConfigDocumentError::UnsafeOverlay { .. })
        ));

        let windows_root = temporary.path().join("windows-root");
        let windows_alias = ConfigManager::load(ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(windows_root.join("GHOSTTY/CONFIG.GHOSTTY")),
            home_dir: Some(temporary.path().join("windows-home")),
            xdg_config_home: Some(windows_root),
            local_app_data: None,
            macos: false,
            windows: true,
        });
        assert!(matches!(
            windows_alias.document(),
            Err(ConfigDocumentError::UnsafeOverlay { .. })
        ));

        let macos_root = temporary.path().join("macos-root");
        let macos_alias = ConfigManager::load(ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(
                macos_root.join("LIBRARY/APPLICATION SUPPORT/COM.MITCHELLH.GHOSTTY/CONFIG"),
            ),
            home_dir: Some(macos_root),
            xdg_config_home: Some(temporary.path().join("macos-xdg")),
            local_app_data: None,
            macos: true,
            windows: false,
        });
        assert!(matches!(
            macos_alias.document(),
            Err(ConfigDocumentError::UnsafeOverlay { .. })
        ));

        let overlay = temporary.path().join("app/config.ghostty");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(overlay));
        let oversized = "x".repeat(MAX_CONFIG_DOCUMENT_BYTES + 1);
        assert!(matches!(
            manager.validate_document(&oversized),
            Err(ConfigDocumentError::TooLarge { .. })
        ));
        fs::create_dir_all(
            manager
                .options
                .explicit_path
                .as_ref()
                .unwrap()
                .parent()
                .unwrap(),
        )
        .unwrap();
        fs::write(
            manager.options.explicit_path.as_ref().unwrap(),
            vec![b'x'; MAX_CONFIG_DOCUMENT_BYTES + 1],
        )
        .unwrap();
        assert!(matches!(
            manager.document(),
            Err(ConfigDocumentError::TooLarge { .. })
        ));
        fs::write(manager.options.explicit_path.as_ref().unwrap(), [0xff]).unwrap();
        assert!(matches!(
            manager.document(),
            Err(ConfigDocumentError::InvalidUtf8 { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn document_api_refuses_to_replace_a_symbolic_link() {
        use std::os::unix::fs::symlink;

        let temporary = TempDir::new().unwrap();
        let target = temporary.path().join("target.ghostty");
        let overlay = temporary.path().join("config.ghostty");
        write(&target, "scrollback-limit = 1\n");
        symlink(&target, &overlay).unwrap();
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&overlay));

        assert!(matches!(
            manager.document(),
            Err(ConfigDocumentError::UnsupportedFileType { .. })
        ));
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "scrollback-limit = 1\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn document_api_refuses_to_publish_a_lossy_path() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let temporary = TempDir::new().unwrap();
        let overlay = temporary
            .path()
            .join(OsString::from_vec(b"config-\xff.ghostty".to_vec()));
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(overlay));

        assert!(matches!(
            manager.document(),
            Err(ConfigDocumentError::NonUtf8Path { .. })
        ));
    }

    #[test]
    fn defaults_follow_the_selected_ghostty_platform() {
        let mut options = ConfigLoadOptions {
            load_default_files: false,
            macos: true,
            windows: false,
            ..ConfigLoadOptions::default()
        };
        assert_eq!(load_config(&options).renderer.font_size, 13.0);

        options.macos = false;
        assert_eq!(load_config(&options).renderer.font_size, 12.0);
    }

    #[test]
    fn parses_ghostty_syntax_and_projects_supported_values() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config.ghostty");
        write(
            &config,
            r#"
                # full-line comments only
                background = "102030"
                foreground = #abcdef
                cursor-color = orange
                selection-background = 135
                scrollback-limit = 123456
                font-family = "JetBrains Mono"
                font-family = Symbols Nerd Font
                font-size = 15.5
                window-padding-x = 3, 7
                window-padding-y = 4
                keybind = super+==increase_font_size:1
                keybind = super+shift+e=text:=
                custom-shader = ghosttea:better-crt
            "#,
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x10, 0x20, 0x30]);
        assert_eq!(snapshot.renderer.foreground, [0xab, 0xcd, 0xef]);
        assert_eq!(snapshot.renderer.cursor, [0xff, 0xa5, 0x00]);
        assert_eq!(snapshot.renderer.selection_background, [0x11, 0x33, 0x55]);
        assert_eq!(snapshot.terminal.scrollback_bytes, 123_456);
        assert_eq!(
            snapshot.renderer.font_families,
            ["JetBrains Mono", "Symbols Nerd Font"]
        );
        assert_eq!(snapshot.renderer.font_size, 15.5);
        assert_eq!(snapshot.renderer.padding_x, [3.0, 7.0]);
        assert_eq!(snapshot.renderer.padding_y, [4.0, 4.0]);
        assert_eq!(
            snapshot.renderer.post_process,
            RendererPostProcess::BetterCrt
        );
        assert_eq!(
            snapshot.workspace.keybindings,
            [
                KeybindingConfig {
                    trigger: "super+=".to_owned(),
                    action: "increase_font_size:1".to_owned()
                },
                KeybindingConfig {
                    trigger: "super+shift+e".to_owned(),
                    action: "text:=".to_owned()
                }
            ]
        );
        assert!(!snapshot.workspace.clear_keybindings);
        assert!(!snapshot.has_errors(), "{:?}", snapshot.diagnostics);
    }

    #[test]
    fn keybind_clear_and_blank_follow_ghostty_semantics() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config.ghostty");
        write(&config, "keybind = clear\nkeybind = super+t=previous_tab\n");
        let cleared = load_config(&ConfigLoadOptions::explicit(&config));
        assert!(cleared.workspace.clear_keybindings);
        assert_eq!(
            cleared.workspace.keybindings,
            [KeybindingConfig {
                trigger: "super+t".to_owned(),
                action: "previous_tab".to_owned(),
            }]
        );

        write(
            &config,
            "keybind = clear\nkeybind = super+t=previous_tab\nkeybind =\nkeybind = super+w=unbind\n",
        );
        let restored = load_config(&ConfigLoadOptions::explicit(&config));
        assert!(!restored.workspace.clear_keybindings);
        assert_eq!(
            restored.workspace.keybindings,
            [KeybindingConfig {
                trigger: "super+w".to_owned(),
                action: "unbind".to_owned(),
            }]
        );
    }

    #[test]
    fn includes_are_relative_deferred_optional_and_cycle_safe() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("config.ghostty");
        let included = temporary.path().join("nested/theme");
        write(
            &root,
            "background = 111111\nconfig-file = nested/theme\nbackground = 222222\nconfig-file = ?missing\n",
        );
        write(
            &included,
            "background = 333333\nconfig-file = ../config.ghostty\n",
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&root));
        // Ghostty's recursive de-duplication set does not pre-seed root files,
        // so the back-reference replays the root once before it is rejected.
        assert_eq!(snapshot.renderer.background, [0x22, 0x22, 0x22]);
        assert_eq!(snapshot.sources.len(), 3);
        assert_eq!(
            snapshot
                .configured_keys
                .iter()
                .find(|configured| configured.key == "config-file")
                .map(|configured| configured.occurrences),
            Some(5)
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "include-cycle")
        );
    }

    #[test]
    fn included_sources_are_regular_and_bounded() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("config.ghostty");
        let directory = temporary.path().join("not-a-file");
        fs::create_dir_all(&directory).unwrap();
        write(&root, "config-file = not-a-file\n");

        let directory_result = load_config(&ConfigLoadOptions::explicit(&root));
        assert!(directory_result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "source-read-failed"
                && diagnostic.message.contains("must be a regular file")
        }));

        #[cfg(unix)]
        {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};

            let fifo = temporary.path().join("named-pipe");
            let fifo_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);
            write(&root, "config-file = named-pipe\n");

            // This completes without a writer because sources are opened
            // non-blocking before the descriptor type is checked.
            let fifo_result = load_config(&ConfigLoadOptions::explicit(&root));
            assert!(fifo_result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == "source-read-failed"
                    && diagnostic.message.contains("must be a regular file")
            }));
        }

        let oversized = temporary.path().join("oversized.ghostty");
        fs::write(&oversized, vec![b'x'; MAX_CONFIG_SOURCE_BYTES + 1]).unwrap();
        write(&root, "config-file = oversized.ghostty\n");

        let oversized_result = load_config(&ConfigLoadOptions::explicit(&root));
        assert!(oversized_result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "source-read-failed"
                && diagnostic.message.contains("maximum remaining")
        }));

        let many_includes = (0..=MAX_CONFIG_INCLUDE_FILES)
            .map(|index| {
                let name = format!("include-{index}");
                write(&temporary.path().join(&name), "");
                format!("config-file = {name}\n")
            })
            .collect::<String>();
        write(&root, &many_includes);
        let include_count_result = load_config(&ConfigLoadOptions::explicit(&root));
        assert!(include_count_result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "source-limit-exceeded"
                && diagnostic.message.contains("limited to 128 files")
        }));

        let aggregate_includes = (0..8)
            .map(|index| {
                let name = format!("aggregate-{index}");
                let mut contents = vec![b'x'; MAX_CONFIG_SOURCE_BYTES];
                contents[0] = b'#';
                fs::write(temporary.path().join(&name), contents).unwrap();
                format!("config-file = {name}\n")
            })
            .collect::<String>();
        write(&root, &aggregate_includes);
        let aggregate_result = load_config(&ConfigLoadOptions::explicit(&root));
        assert!(aggregate_result.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "source-read-failed"
                && diagnostic.message.contains("maximum remaining")
        }));
    }

    #[test]
    fn include_paths_expand_and_blank_values_reset_the_queue() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("root/config.ghostty");
        let cleared = temporary.path().join("root/cleared");
        let quoted = temporary.path().join("root/optional theme");
        let home = temporary.path().join("home");
        let home_theme = home.join("theme");
        write(&cleared, "background = 111111\n");
        write(&quoted, "background = 333333\n");
        write(&home_theme, "background = 444444\n");
        write(
            &root,
            "config-file = cleared\nconfig-file =\nconfig-file = ?\"optional theme\"\nconfig-file = ?\nconfig-file = ~/theme\n",
        );

        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: false,
            explicit_path: Some(root),
            home_dir: Some(home),
            xdg_config_home: None,
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert_eq!(snapshot.renderer.background, [0x44, 0x44, 0x44]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| Path::new(&source.path).file_name().unwrap())
                .collect::<Vec<_>>(),
            ["config.ghostty", "optional theme", "theme"]
        );
    }

    #[test]
    fn includes_follow_ghostty_breadth_first_order() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("config.ghostty");
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        let nested = temporary.path().join("nested");
        write(&root, "config-file = first\nconfig-file = second\n");
        write(&first, "background = 111111\nconfig-file = nested\n");
        write(&second, "background = 222222\n");
        write(&nested, "background = 333333\n");

        let snapshot = load_config(&ConfigLoadOptions::explicit(&root));
        assert_eq!(snapshot.renderer.background, [0x33, 0x33, 0x33]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| Path::new(&source.path).file_name().unwrap())
                .collect::<Vec<_>>(),
            ["config.ghostty", "first", "second", "nested"]
        );
    }

    #[test]
    fn standard_sources_follow_ghostty_precedence_then_overlay() {
        let temporary = TempDir::new().unwrap();
        let xdg = temporary.path().join("xdg");
        let home = temporary.path().join("home");
        let xdg_legacy = xdg.join("ghostty/config");
        let xdg_current = xdg.join("ghostty/config.ghostty");
        let mac_directory = home.join("Library/Application Support/com.mitchellh.ghostty");
        let mac_legacy = mac_directory.join("config");
        let mac_current = mac_directory.join("config.ghostty");
        write(&xdg_legacy, "background = 111111\n");
        write(&xdg_current, "background = 222222\n");
        write(&mac_legacy, "background = 333333\n");
        write(&mac_current, "background = 444444\n");

        let defaults = ConfigLoadOptions {
            load_default_files: true,
            explicit_path: None,
            home_dir: Some(home.clone()),
            xdg_config_home: Some(xdg.clone()),
            local_app_data: None,
            macos: true,
            windows: false,
        };
        let snapshot = load_config(&defaults);
        assert_eq!(snapshot.renderer.background, [0x44, 0x44, 0x44]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| PathBuf::from(&source.path))
                .collect::<Vec<_>>(),
            [xdg_legacy, xdg_current, mac_legacy, mac_current]
        );

        let overlay = temporary.path().join("ghosttea/config.ghostty");
        write(&overlay, "background = 555555\n");
        let snapshot = load_config(&ConfigLoadOptions {
            explicit_path: Some(overlay.clone()),
            ..defaults
        });
        assert_eq!(snapshot.renderer.background, [0x55, 0x55, 0x55]);
        assert_eq!(snapshot.sources.len(), 5);
        assert_eq!(
            snapshot.sources.last(),
            Some(&ConfigSource {
                path: overlay.to_string_lossy().into_owned(),
                kind: ConfigSourceKind::GhostteaOverlay,
            })
        );
    }

    #[test]
    fn overlay_is_applied_after_standard_file_includes() {
        let temporary = TempDir::new().unwrap();
        let xdg = temporary.path().join("xdg");
        let standard = xdg.join("ghostty/config.ghostty");
        let included = xdg.join("ghostty/theme");
        let overlay = temporary.path().join("ghosttea/config.ghostty");
        write(&standard, "background = 111111\nconfig-file = theme\n");
        write(&included, "background = 222222\n");
        write(&overlay, "background = 333333\n");

        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(overlay),
            home_dir: None,
            xdg_config_home: Some(xdg),
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert_eq!(snapshot.renderer.background, [0x33, 0x33, 0x33]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| source.kind)
                .collect::<Vec<_>>(),
            [
                ConfigSourceKind::GhosttyDefault,
                ConfigSourceKind::Included,
                ConfigSourceKind::GhostteaOverlay,
            ]
        );
    }

    #[test]
    fn reset_unknown_unsupported_and_invalid_values_are_explicit() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "background = ff0000\nbackground =\nfont-size = nope\ncustom-shader = ~/crt.glsl\ncustom-shader-animation = always\ntheme = catppuccin\nmade-up = true\n",
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, DEFAULT_BACKGROUND);
        assert_eq!(snapshot.renderer.post_process, RendererPostProcess::None);
        assert_eq!(snapshot.renderer.custom_shader_paths, ["~/crt.glsl"]);
        assert!(snapshot.has_errors());
        for code in [
            "invalid-value",
            "unsupported-custom-shader",
            "recognized-not-applied",
            "unknown-key",
        ] {
            assert!(
                snapshot
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                snapshot.diagnostics
            );
        }
        assert!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "recognized-not-applied")
                .all(|diagnostic| matches!(diagnostic.key.as_deref(), Some("theme")))
        );
        assert_eq!(
            snapshot
                .configured_keys
                .iter()
                .find(|configured| configured.key == "custom-shader-animation")
                .map(|configured| configured.support),
            Some(ConfigSupport::Applied)
        );
    }

    #[test]
    fn rejects_values_that_cannot_round_trip_through_the_shared_schema() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "scrollback-limit = 9007199254740992\nkeybind = super+t=\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.terminal.scrollback_bytes, DEFAULT_SCROLLBACK_BYTES);
        assert!(snapshot.workspace.keybindings.is_empty());
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic.code == "invalid-value" || diagnostic.code == "invalid-keybind"
                })
                .count(),
            2
        );
    }

    #[test]
    fn invalid_scalar_updates_preserve_the_last_valid_value() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "background = 112233\nbackground = not-a-color\nscrollback-limit = 123456\nscrollback-limit = too-large\nfont-size = 15\nfont-size = nope\nwindow-padding-x = 7\nwindow-padding-x = -1\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.terminal.scrollback_bytes, 123_456);
        assert_eq!(snapshot.renderer.font_size, 15.0);
        assert_eq!(snapshot.renderer.padding_x, [7.0, 7.0]);
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
                .count(),
            4
        );
    }

    #[test]
    fn cursor_and_selection_cell_references_are_reported_as_parsed_only() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "foreground = 112233\nbackground = 445566\ncursor-color = cell-background\nselection-background = cell-foreground\nselection-foreground = cell-background\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.cursor, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.renderer.selection_background, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.renderer.selection_foreground, [0x44, 0x55, 0x66]);
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "dynamic-color-not-applied")
                .count(),
            3
        );
        for key in [
            "cursor-color",
            "selection-background",
            "selection-foreground",
        ] {
            assert_eq!(
                snapshot
                    .configured_keys
                    .iter()
                    .find(|configured| configured.key == key)
                    .map(|configured| configured.support),
                Some(ConfigSupport::Parsed)
            );
        }
        assert!(!snapshot.has_errors(), "{:?}", snapshot.diagnostics);
    }

    #[test]
    fn applies_palette_opacity_cursor_text_and_ordered_builtin_shaders() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "background = 101820\ncursor-text = f0e0d0\npalette = 0=010203\npalette = 15=#fdfcfb\nbackground-opacity = 0.72\nbackground-opacity-cells = true\ncustom-shader = ghosttea:crt\ncustom-shader = ghosttea:vhs\ncustom-shader = ghosttea:sparks-from-fire\ncustom-shader-animation = true\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.cursor_text, [0xf0, 0xe0, 0xd0]);
        assert_eq!(snapshot.renderer.background_opacity, 0.72);
        assert!(snapshot.renderer.background_opacity_cells);
        assert_eq!(
            snapshot.renderer.palette,
            vec![
                PaletteConfigEntry {
                    index: 0,
                    color: [1, 2, 3],
                },
                PaletteConfigEntry {
                    index: 15,
                    color: [0xfd, 0xfc, 0xfb],
                },
            ]
        );
        assert_eq!(snapshot.terminal.palette, snapshot.renderer.palette);
        assert_eq!(
            snapshot.renderer.shader_effects,
            vec![
                GHOSTTEA_CRT_SHADER,
                GHOSTTEA_VHS_SHADER,
                GHOSTTEA_SPARKS_SHADER
            ]
        );
        assert!(snapshot.renderer.custom_shader_animation);
        assert!(!snapshot.has_errors(), "{:?}", snapshot.diagnostics);
    }

    #[test]
    fn parses_ghostty_color_grammar_and_full_x11_catalog() {
        for (input, expected) in [
            ("#345", [0x33, 0x44, 0x55]),
            ("345", [0x33, 0x44, 0x55]),
            ("#123456789", [0x12, 0x45, 0x78]),
            ("#123456789abc", [0x12, 0x56, 0x9a]),
            ("rgb:7f/a0a0/0", [127, 160, 0]),
            ("rgbi:1.0/0.5/0", [255, 127, 0]),
            ("LawnGreen", [124, 252, 0]),
            ("medium spring green", [0, 250, 154]),
            (" Forest Green ", [34, 139, 34]),
            ("green", [0, 255, 0]),
        ] {
            assert_eq!(parse_color(input), Some(expected), "{input}");
        }
        for input in [
            "transparent",
            "forest_green",
            "rgb:0.5/0/1",
            "rgbi:NaN/0/1",
            "rgbi:1.1/0/1",
            "rgb:f/f/f/0",
            "#ffff",
            "#€",
            "123456789",
        ] {
            assert_eq!(parse_color(input), None, "{input}");
        }
    }

    #[test]
    fn strips_utf8_bom_and_accepts_bare_cli_style_options() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "\u{feff}background = 112233\nwindow-save-state\nfont-size\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x11, 0x22, 0x33]);
        assert!(
            snapshot
                .configured_keys
                .iter()
                .any(|configured| configured.key == "window-save-state")
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "recognized-not-applied"
                    && diagnostic.key.as_deref() == Some("window-save-state"))
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "invalid-value"
                    && diagnostic.key.as_deref() == Some("font-size"))
        );
        assert!(snapshot.diagnostics.iter().all(
            |diagnostic| diagnostic.code != "unknown-key" && diagnostic.code != "invalid-line"
        ));
    }

    #[test]
    fn windows_discovery_uses_local_app_data_before_home() {
        let temporary = TempDir::new().unwrap();
        let local_app_data = temporary.path().join("local");
        let home = temporary.path().join("home");
        let options = ConfigLoadOptions {
            load_default_files: true,
            explicit_path: None,
            home_dir: Some(home),
            xdg_config_home: None,
            local_app_data: Some(local_app_data.clone()),
            macos: false,
            windows: true,
        };

        assert_eq!(
            standard_config_paths(&options),
            [
                local_app_data.join("ghostty/config"),
                local_app_data.join("ghostty/config.ghostty"),
            ]
        );
    }

    #[test]
    fn reload_revision_changes_only_when_snapshot_changes() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(&config, "background = 111111\n");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&config));
        let first = manager.snapshot();
        let (same, changed) = manager.reload();
        assert!(!changed);
        assert_eq!(first.revision, same.revision);
        write(&config, "background = 222222\n");
        let (next, changed) = manager.reload();
        assert!(changed);
        assert_ne!(first.revision, next.revision);
    }
    #[test]
    fn link_url_defaults_on_and_reports_applied_configuration() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(&config, "link-url = false\n");
        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert!(!snapshot.renderer.link_url);
        assert!(
            snapshot
                .configured_keys
                .iter()
                .any(|key| key.key == "link-url" && key.support == ConfigSupport::Applied)
        );
        write(&config, "link-url = false\nlink-url =\n");
        assert!(
            load_config(&ConfigLoadOptions::explicit(&config))
                .renderer
                .link_url
        );
    }
}
