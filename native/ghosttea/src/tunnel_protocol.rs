use anyhow::{Context, Result, bail};
use ghosttea_config::TerminalPresentationConfig;
pub use ghosttea_core::{
    LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, RowReplacement,
};
use serde::{
    Deserialize, Serialize,
    de::{DeserializeOwned, Error as _, IgnoredAny, SeqAccess, Visitor},
    ser::{Error as _, SerializeSeq, SerializeTuple, SerializeTupleVariant},
};

use crate::session::{KeyInput, MouseInput, SessionActivity};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 9;
pub const SESSION_ACTIVITY_PROTOCOL_MINOR: u16 = 4;
pub const TERMINAL_PRESENTATION_PROTOCOL_MINOR: u16 = 5;
/// Gates every remote-reconnect behaviour: resume takeover, heartbeats,
/// `ControlState`, `SessionEnded`/`HostShutdown`, and tombstone lookups.
///
/// The design doc calls this family "1.5"; minor 5 was spent by terminal
/// presentation sync before this work landed, so it ships as minor 6.
pub const REMOTE_RECONNECT_PROTOCOL_MINOR: u16 = 6;
pub const TRACKED_SELECTION_PROTOCOL_MINOR: u16 = 7;
/// Carries terminal-default and palette-index cell colors without baking the
/// host presentation into a replica's logical state.
pub const SEMANTIC_CELL_COLOR_PROTOCOL_MINOR: u16 = 8;
/// `optionAsAlt` inside a [`TunnelInput::Key`]: the typing viewer's Option
/// policy, Ghostty's `macos-option-as-alt`, which the host's key encoder
/// honours. A key without the field keeps Option as Alt at every minor.
///
/// It has its own minor for the reason the control protocol gives its
/// `OPTION_AS_ALT_PROTOCOL_MINOR` (`service.rs`): serde ignores fields it does
/// not know, so a minor-8 host drops the field and encodes Option as Alt, and
/// only the negotiated minor tells a viewer that the host reads it.
pub const OPTION_AS_ALT_PROTOCOL_MINOR: u16 = 9;
pub const MAX_PREFACE_METADATA_BYTES: usize = 4 * 1024;
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_STATE_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// Heartbeat frames are fixed-shape and tiny; the stream never carries
/// anything else, so it gets a limit of its own rather than borrowing the
/// control-stream budget.
pub const MAX_HEARTBEAT_MESSAGE_BYTES: usize = 1024;

const MAGIC: [u8; 4] = *b"TSP1";
const PREFACE_HEADER_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactChannel {
    Control,
    State,
}

impl CompactChannel {
    pub fn as_byte(self) -> u8 {
        match self {
            Self::Control => 1,
            Self::State => 2,
        }
    }

    pub fn from_byte(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::Control),
            2 => Ok(Self::State),
            _ => bail!("unknown compact terminal channel"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamKind {
    ConnectionControl,
    SessionControl,
    LiveState,
    Scrollback,
    Asset,
    /// One per QUIC connection, viewer-opened, gated on
    /// [`REMOTE_RECONNECT_PROTOCOL_MINOR`]. Carries [`HeartbeatMessage`] only:
    /// the connection-control stream is lockstep request/response, so
    /// unsolicited liveness traffic cannot ride on it.
    Heartbeat,
}

impl StreamKind {
    fn as_byte(self) -> u8 {
        match self {
            Self::ConnectionControl => 1,
            Self::SessionControl => 2,
            Self::LiveState => 3,
            Self::Scrollback => 4,
            Self::Asset => 5,
            Self::Heartbeat => 6,
        }
    }

    fn from_byte(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::ConnectionControl),
            2 => Ok(Self::SessionControl),
            3 => Ok(Self::LiveState),
            4 => Ok(Self::Scrollback),
            5 => Ok(Self::Asset),
            6 => Ok(Self::Heartbeat),
            _ => bail!("unknown terminal stream kind"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamPreface {
    pub stream_kind: StreamKind,
    pub session_id: Option<String>,
    pub view_id: Option<String>,
}

pub fn encode_preface(preface: &StreamPreface) -> Result<Vec<u8>> {
    let metadata = serde_json::to_vec(preface).context("serialize stream preface")?;
    if metadata.len() > MAX_PREFACE_METADATA_BYTES {
        bail!("stream preface metadata exceeds limit");
    }
    let mut encoded = Vec::with_capacity(PREFACE_HEADER_BYTES + metadata.len());
    encoded.extend_from_slice(&MAGIC);
    encoded.extend_from_slice(&PROTOCOL_MAJOR.to_be_bytes());
    encoded.extend_from_slice(&PROTOCOL_MINOR.to_be_bytes());
    encoded.push(preface.stream_kind.as_byte());
    encoded.extend_from_slice(&[0; 3]);
    encoded.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&metadata);
    Ok(encoded)
}

pub fn decode_preface(bytes: &[u8]) -> Result<(StreamPreface, usize)> {
    if bytes.len() < PREFACE_HEADER_BYTES {
        bail!("truncated stream preface");
    }
    if bytes[..4] != MAGIC {
        bail!("invalid stream preface magic");
    }
    let major = u16::from_be_bytes(bytes[4..6].try_into().unwrap());
    if major != PROTOCOL_MAJOR {
        bail!("unsupported terminal protocol major {major}");
    }
    let kind = StreamKind::from_byte(bytes[8])?;
    let metadata_len = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if metadata_len > MAX_PREFACE_METADATA_BYTES {
        bail!("stream preface metadata exceeds limit");
    }
    let total = PREFACE_HEADER_BYTES + metadata_len;
    if bytes.len() < total {
        bail!("truncated stream preface metadata");
    }
    let preface: StreamPreface = serde_json::from_slice(&bytes[PREFACE_HEADER_BYTES..total])
        .context("decode stream preface")?;
    if preface.stream_kind != kind {
        bail!("stream preface kind mismatch");
    }
    Ok((preface, total))
}

pub fn encode_message<T: Serialize>(message: &T, limit: usize) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(message).context("serialize terminal protocol message")?;
    if payload.len() > limit {
        bail!("terminal protocol message exceeds limit");
    }
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_message<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<(T, usize)> {
    if bytes.len() < 4 {
        bail!("truncated terminal protocol frame");
    }
    let payload_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if payload_len > limit {
        bail!("terminal protocol message exceeds limit");
    }
    let total = 4 + payload_len;
    if bytes.len() < total {
        bail!("truncated terminal protocol payload");
    }
    let message =
        serde_json::from_slice(&bytes[4..total]).context("decode terminal protocol message")?;
    Ok((message, total))
}

pub fn encode_state_message(
    message: &StateMessage,
    codec: StateCodec,
    limit: usize,
) -> Result<Vec<u8>> {
    encode_state_message_for_minor(message, codec, PROTOCOL_MINOR, limit)
}

pub fn encode_state_message_for_minor(
    message: &StateMessage,
    codec: StateCodec,
    protocol_minor: u16,
    limit: usize,
) -> Result<Vec<u8>> {
    match codec {
        StateCodec::Json => {
            let uses_semantic_colors = validate_semantic_colors(message)?;
            if protocol_minor < SEMANTIC_CELL_COLOR_PROTOCOL_MINOR && uses_semantic_colors {
                encode_message(&legacy_state_message(message), limit)
            } else {
                encode_message(message, limit)
            }
        }
        StateCodec::CompactJsonV1 => encode_message(
            &CompactStateMessageRef {
                message,
                semantic_colors: protocol_minor >= SEMANTIC_CELL_COLOR_PROTOCOL_MINOR,
            },
            limit,
        ),
    }
}

pub fn decode_state_message(
    bytes: &[u8],
    codec: StateCodec,
    limit: usize,
) -> Result<(StateMessage, usize)> {
    decode_state_message_for_minor(bytes, codec, PROTOCOL_MINOR, limit)
}

pub fn decode_state_message_for_minor(
    bytes: &[u8],
    codec: StateCodec,
    protocol_minor: u16,
    limit: usize,
) -> Result<(StateMessage, usize)> {
    match codec {
        StateCodec::Json => {
            let (message, consumed) = decode_message(bytes, limit)?;
            let uses_semantic_colors = validate_semantic_colors(&message)?;
            if protocol_minor < SEMANTIC_CELL_COLOR_PROTOCOL_MINOR && uses_semantic_colors {
                bail!("semantic cell colors require protocol minor 8");
            }
            Ok((message, consumed))
        }
        StateCodec::CompactJsonV1 => {
            let (message, consumed) = decode_message::<CompactStateMessage>(bytes, limit)?;
            if protocol_minor < SEMANTIC_CELL_COLOR_PROTOCOL_MINOR
                && compact_message_uses_semantic_colors(&message)
            {
                bail!("semantic compact cell colors require protocol minor 8");
            }
            Ok((message.try_into()?, consumed))
        }
    }
}

pub fn encode_compact_message<T: Serialize>(
    channel: CompactChannel,
    message: &T,
    limit: usize,
) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(message).context("serialize compact terminal message")?;
    if payload.len() > limit {
        bail!("compact terminal message exceeds limit");
    }
    let framed_len = payload
        .len()
        .checked_add(1)
        .context("compact terminal message length overflow")?;
    let mut encoded = Vec::with_capacity(4 + framed_len);
    encoded.extend_from_slice(&u32::try_from(framed_len)?.to_be_bytes());
    encoded.push(channel.as_byte());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_compact_message<T: DeserializeOwned>(
    bytes: &[u8],
    expected_channel: CompactChannel,
    limit: usize,
) -> Result<(T, usize)> {
    if bytes.len() < 5 {
        bail!("truncated compact terminal frame");
    }
    let framed_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if framed_len == 0 || framed_len - 1 > limit {
        bail!("compact terminal message exceeds limit");
    }
    let total = 4 + framed_len;
    if bytes.len() < total {
        bail!("truncated compact terminal payload");
    }
    let channel = CompactChannel::from_byte(bytes[4])?;
    if channel != expected_channel {
        bail!("compact terminal channel mismatch");
    }
    let message = serde_json::from_slice(&bytes[5..total])
        .context("decode compact terminal protocol message")?;
    Ok((message, total))
}

/// The whole vocabulary of the QUIC heartbeat stream ([`StreamKind::Heartbeat`]).
///
/// Deliberately not part of [`ConnectionMessage`]: the connection-control
/// stream is a lockstep request/response channel under a mutex, and pushing
/// unsolicited frames onto it would desynchronize every in-flight request.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum HeartbeatMessage {
    Ping { nonce: u64 },
    Pong { nonce: u64 },
    HostShutdown {},
}

pub fn encode_heartbeat_message(message: &HeartbeatMessage) -> Result<Vec<u8>> {
    encode_message(message, MAX_HEARTBEAT_MESSAGE_BYTES)
}

pub fn decode_heartbeat_message(bytes: &[u8]) -> Result<(HeartbeatMessage, usize)> {
    decode_message(bytes, MAX_HEARTBEAT_MESSAGE_BYTES)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ConnectionMessage {
    ClientHello {
        protocol_major: u16,
        protocol_minor: u16,
        host_instance_id: String,
        local_device_id: String,
        nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state_codecs: Option<Vec<StateCodec>>,
    },
    ServerHello {
        protocol_major: u16,
        protocol_minor: u16,
        host_instance_id: String,
        nonce: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state_codec: Option<StateCodec>,
    },
    ListSessions {
        request_id: String,
    },
    Sessions {
        request_id: String,
        sessions: Vec<SharedSessionSummary>,
    },
    /// Tombstone lookup: why is a session we used to hold no longer listed?
    /// Gated on [`REMOTE_RECONNECT_PROTOCOL_MINOR`].
    SessionStatus {
        request_id: String,
        session_id: String,
    },
    SessionStatusResult {
        request_id: String,
        status: SessionStatusKind,
    },
    Error {
        request_id: Option<String>,
        code: String,
        message: String,
    },
}

/// The evidence a host can offer about a session's fate. `Unknown` is the
/// honest answer for a session whose tombstone expired or was never written —
/// viewers must never upgrade it to `closed` or `exited`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionStatusKind {
    Live,
    Ended { reason: SessionEndReason },
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionEndReason {
    Exited {
        #[serde(default)]
        code: Option<i32>,
    },
    Closed,
}

impl From<crate::session::SessionEndCause> for SessionEndReason {
    fn from(cause: crate::session::SessionEndCause) -> Self {
        match cause {
            crate::session::SessionEndCause::Exited { code } => Self::Exited { code },
            crate::session::SessionEndCause::Closed => Self::Closed,
        }
    }
}

impl From<crate::session::SessionStatus> for SessionStatusKind {
    fn from(status: crate::session::SessionStatus) -> Self {
        match status {
            crate::session::SessionStatus::Live => Self::Live,
            crate::session::SessionStatus::Ended { cause } => Self::Ended {
                reason: cause.into(),
            },
            crate::session::SessionStatus::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionControlMessage {
    AttachView {
        request_id: String,
        session_id: String,
        view_id: String,
        access_token: Option<String>,
        cols: u16,
        rows: u16,
        /// Monotonic per wire-view lineage across **every** attempt, initial
        /// retries included — the ordering mechanism the host fences takeover
        /// with. `0` means a pre-reconnect client that never orders attempts.
        #[serde(default)]
        attach_generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<ResumeHint>,
        /// Secondary views decline the live-state stream: a `false` attach
        /// creates no stream and no snapshot.
        #[serde(default = "default_true")]
        wants_state: bool,
    },
    ViewAttached {
        request_id: String,
        session_epoch: u64,
        layout_epoch: u64,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        read_write: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<TerminalPresentationConfig>,
        /// Whether this attach replaced a live attachment of the same view.
        #[serde(default)]
        resumed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        controller: Option<ControllerInfo>,
        /// `0` is unreachable for a revisioned host (they initialize at 1) and
        /// therefore means "legacy host, controller state unknown" — never
        /// a CAS-able observation.
        #[serde(default)]
        control_revision: u64,
    },
    FocusAndResize {
        view_id: String,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        client_sequence: u64,
        /// `None` = legacy last-write-wins claim. `Some(rev)` compares against
        /// the host's current control revision and loses to any intervening
        /// claim *or* clear.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_control_revision: Option<u64>,
    },
    /// A definitive attach failure. Hosts that predate this variant can only
    /// close the stream, which reads as an ambiguous transport fault.
    AttachRejected {
        request_id: String,
        code: AttachRejectCode,
        /// Advisory telemetry only. The code's action table governs; a host
        /// that contradicts it does not change what the viewer does.
        retryable: bool,
    },
    ControlChanged {
        controller_view_id: String,
        control_epoch: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    Resize {
        view_id: String,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    },
    ResizeRejected {
        current_controller_view_id: Option<String>,
        current_control_epoch: Option<u64>,
        cols: u16,
        rows: u16,
    },
    Input {
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    },
    StateAck {
        session_epoch: u64,
        layout_epoch: u64,
        patch_sequence: u64,
        terminal_revision: u64,
    },
    RequestSnapshot,
    SelectionText {
        request_id: String,
        view_id: String,
        attachment_epoch: u64,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    },
    SelectionTextResult {
        request_id: String,
        text: String,
    },
    Detach {
        view_id: String,
        attachment_epoch: u64,
    },
    /// Compact-transport liveness. A compact connection carries exactly one
    /// view on one control channel, so heartbeats ride it directly; QUIC uses
    /// [`StreamKind::Heartbeat`] and [`HeartbeatMessage`] instead.
    Ping {
        nonce: u64,
    },
    Pong {
        nonce: u64,
    },
}

fn default_true() -> bool {
    true
}

/// Resume evidence. Ordering does *not* live here — that is
/// `AttachView::attach_generation`, which every attempt carries.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResumeHint {
    pub previous_session_epoch: u64,
    pub previous_attachment_epoch: u64,
    pub previous_terminal_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ControllerInfo {
    pub controller_view_id: String,
    pub control_epoch: u64,
}

/// Closed set, enforced by the decoder: an unrecognized code decodes to
/// [`AttachRejectCode::Unknown`], which viewers must treat as an ambiguous
/// failure (close the connection, advance the generation) rather than guessing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AttachRejectCode {
    StaleResume,
    ViewInvalid,
    ViewLimit,
    UnknownSession,
    SessionEpochMismatch,
    AccessDenied,
    #[default]
    Unknown,
}

impl AttachRejectCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaleResume => "stale-resume",
            Self::ViewInvalid => "view-invalid",
            Self::ViewLimit => "view-limit",
            Self::UnknownSession => "unknown-session",
            Self::SessionEpochMismatch => "session-epoch-mismatch",
            Self::AccessDenied => "access-denied",
            Self::Unknown => "unknown",
        }
    }
}

impl Serialize for AttachRejectCode {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

// Hand-written because serde's `#[serde(other)]` is unavailable on an
// externally tagged enum; the closed-set guarantee is worth the impl.
impl<'de> Deserialize<'de> for AttachRejectCode {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "stale-resume" => Self::StaleResume,
            "view-invalid" => Self::ViewInvalid,
            "view-limit" => Self::ViewLimit,
            "unknown-session" => Self::UnknownSession,
            "session-epoch-mismatch" => Self::SessionEpochMismatch,
            "access-denied" => Self::AccessDenied,
            _ => Self::Unknown,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TunnelInput {
    Text(String),
    Paste(String),
    Key(KeyInput),
    Mouse(MouseInput),
    Scroll(i64),
    ScrollTo(u64),
    Focus(bool),
    Interrupt,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StateMessage {
    Snapshot(LogicalTerminalSnapshot),
    Patch(LogicalTerminalPatch),
    ControlChanged {
        controller_view_id: String,
        control_epoch: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    ActivityChanged {
        activity: SessionActivity,
    },
    ConfigurationChanged {
        presentation: TerminalPresentationConfig,
    },
    SelectionChanged {
        selection: Option<TrackedSelection>,
    },
    /// The revisioned replacement for `ControlChanged`, which structurally
    /// cannot say "no controller" — its `controller_view_id` is required.
    /// Hosts send this to viewers at [`REMOTE_RECONNECT_PROTOCOL_MINOR`] or
    /// above, clears included; those viewers still accept `ControlChanged`
    /// from legacy hosts.
    ControlState {
        controller: Option<ControllerInfo>,
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    SessionEnded {
        reason: SessionEndReason,
    },
    HostShutdown {},
}

fn visit_styles_mut(message: &mut StateMessage, mut visit: impl FnMut(&mut LogicalCellStyle)) {
    let rows: Box<dyn Iterator<Item = &mut LogicalRow> + '_> = match message {
        StateMessage::Snapshot(snapshot) => Box::new(snapshot.rows.iter_mut()),
        StateMessage::Patch(patch) => Box::new(
            patch
                .row_replacements
                .iter_mut()
                .map(|value| &mut value.row),
        ),
        _ => return,
    };
    for row in rows {
        for cell in &mut row.cells {
            visit(&mut cell.style);
        }
    }
}

fn legacy_state_message(message: &StateMessage) -> StateMessage {
    let mut legacy = message.clone();
    visit_styles_mut(&mut legacy, |style| {
        style.foreground_default = false;
        style.foreground_palette = None;
        style.background_default = false;
        style.background_palette = None;
    });
    legacy
}

fn validate_semantic_colors(message: &StateMessage) -> Result<bool> {
    let rows: Box<dyn Iterator<Item = &LogicalRow> + '_> = match message {
        StateMessage::Snapshot(snapshot) => Box::new(snapshot.rows.iter()),
        StateMessage::Patch(patch) => {
            Box::new(patch.row_replacements.iter().map(|value| &value.row))
        }
        _ => return Ok(false),
    };
    let mut uses_semantic_colors = false;
    for style in rows.flat_map(|row| row.cells.iter().map(|cell| &cell.style)) {
        if style.foreground_default && style.foreground_palette.is_some() {
            bail!("foreground color cannot be both default and palette-indexed");
        }
        if style.background_default && style.background_palette.is_some() {
            bail!("background color cannot be both default and palette-indexed");
        }
        uses_semantic_colors |= style.foreground_default
            || style.foreground_palette.is_some()
            || style.background_default
            || style.background_palette.is_some();
    }
    Ok(uses_semantic_colors)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackedSelectionPoint {
    pub column: u16,
    pub row: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackedSelection {
    pub anchor: TrackedSelectionPoint,
    pub focus: TrackedSelectionPoint,
}

impl From<ghosttea_core::TerminalSelection> for TrackedSelection {
    fn from(selection: ghosttea_core::TerminalSelection) -> Self {
        Self {
            anchor: TrackedSelectionPoint {
                column: selection.anchor.column,
                row: selection.anchor.row,
            },
            focus: TrackedSelectionPoint {
                column: selection.focus.column,
                row: selection.focus.row,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StateCodec {
    #[default]
    Json,
    CompactJsonV1,
}

struct CompactStateMessageRef<'a> {
    message: &'a StateMessage,
    semantic_colors: bool,
}

impl Serialize for CompactStateMessageRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self.message {
            StateMessage::Snapshot(snapshot) => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                0,
                "s",
                &CompactSnapshotRef {
                    snapshot,
                    semantic_colors: self.semantic_colors,
                },
            ),
            StateMessage::Patch(patch) => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                1,
                "p",
                &CompactPatchRef {
                    patch,
                    semantic_colors: self.semantic_colors,
                },
            ),
            StateMessage::ControlChanged {
                controller_view_id,
                control_epoch,
                cols,
                rows,
                layout_epoch,
            } => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                2,
                "c",
                &CompactControlChangedRef {
                    controller_view_id,
                    control_epoch: *control_epoch,
                    cols: *cols,
                    rows: *rows,
                    layout_epoch: *layout_epoch,
                },
            ),
            StateMessage::ActivityChanged { activity } => {
                serializer.serialize_newtype_variant("CompactStateMessage", 3, "a", activity)
            }
            StateMessage::ConfigurationChanged { presentation } => {
                serializer.serialize_newtype_variant("CompactStateMessage", 4, "g", presentation)
            }
            StateMessage::SelectionChanged { selection } => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                8,
                "l",
                &CompactTrackedSelectionRef(selection.as_ref()),
            ),
            StateMessage::ControlState {
                controller,
                control_revision,
                cols,
                rows,
                layout_epoch,
            } => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                5,
                "cs",
                &CompactControlStateRef {
                    controller: controller.as_ref(),
                    control_revision: *control_revision,
                    cols: *cols,
                    rows: *rows,
                    layout_epoch: *layout_epoch,
                },
            ),
            StateMessage::SessionEnded { reason } => serializer.serialize_newtype_variant(
                "CompactStateMessage",
                6,
                "se",
                &CompactSessionEndedRef(*reason),
            ),
            StateMessage::HostShutdown {} => serializer
                .serialize_tuple_variant("CompactStateMessage", 7, "hs", 0)?
                .end(),
        }
    }
}

struct CompactSnapshotRef<'a> {
    snapshot: &'a LogicalTerminalSnapshot,
    semantic_colors: bool,
}

struct CompactTrackedSelectionRef<'a>(Option<&'a TrackedSelection>);

impl Serialize for CompactTrackedSelectionRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let Some(selection) = self.0 else {
            return serializer.serialize_none();
        };
        let mut tuple = serializer.serialize_tuple(4)?;
        tuple.serialize_element(&selection.anchor.column)?;
        tuple.serialize_element(&selection.anchor.row)?;
        tuple.serialize_element(&selection.focus.column)?;
        tuple.serialize_element(&selection.focus.row)?;
        tuple.end()
    }
}

impl Serialize for CompactSnapshotRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let snapshot = self.snapshot;
        let mut tuple = serializer.serialize_tuple(10)?;
        tuple.serialize_element(&snapshot.session_epoch)?;
        tuple.serialize_element(&snapshot.layout_epoch)?;
        tuple.serialize_element(&snapshot.terminal_revision)?;
        tuple.serialize_element(&snapshot.cols)?;
        tuple.serialize_element(&CompactRowsRef {
            rows: &snapshot.rows,
            semantic_colors: self.semantic_colors,
        })?;
        tuple.serialize_element(&CompactCursor::from(snapshot.cursor))?;
        tuple.serialize_element(&snapshot.mouse_tracking)?;
        tuple.serialize_element(&CompactScrollbar::from(snapshot.scrollbar))?;
        tuple.serialize_element(&snapshot.title)?;
        tuple.serialize_element(&snapshot.cwd)?;
        tuple.end()
    }
}

struct CompactPatchRef<'a> {
    patch: &'a LogicalTerminalPatch,
    semantic_colors: bool,
}

impl Serialize for CompactPatchRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let patch = self.patch;
        let mut tuple = serializer.serialize_tuple(9)?;
        tuple.serialize_element(&patch.session_epoch)?;
        tuple.serialize_element(&patch.layout_epoch)?;
        tuple.serialize_element(&patch.patch_sequence)?;
        tuple.serialize_element(&patch.terminal_revision)?;
        tuple.serialize_element(&CompactReplacementsRef {
            replacements: &patch.row_replacements,
            semantic_colors: self.semantic_colors,
        })?;
        tuple.serialize_element(&patch.cursor.map(CompactCursor::from))?;
        tuple.serialize_element(&patch.mouse_tracking)?;
        tuple.serialize_element(&patch.scrollbar.map(CompactScrollbar::from))?;
        tuple.serialize_element(&0_u8)?;
        tuple.end()
    }
}

struct CompactRowsRef<'a> {
    rows: &'a [LogicalRow],
    semantic_colors: bool,
}

impl Serialize for CompactRowsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut rows = serializer.serialize_seq(Some(self.rows.len()))?;
        for row in self.rows {
            rows.serialize_element(&CompactRowRef {
                row,
                semantic_colors: self.semantic_colors,
            })?;
        }
        rows.end()
    }
}

struct CompactReplacementsRef<'a> {
    replacements: &'a [RowReplacement],
    semantic_colors: bool,
}

impl Serialize for CompactReplacementsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut replacements = serializer.serialize_seq(Some(self.replacements.len()))?;
        for replacement in self.replacements {
            replacements.serialize_element(&CompactReplacementRef {
                replacement,
                semantic_colors: self.semantic_colors,
            })?;
        }
        replacements.end()
    }
}

struct CompactReplacementRef<'a> {
    replacement: &'a RowReplacement,
    semantic_colors: bool,
}

impl Serialize for CompactReplacementRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let replacement = self.replacement;
        let mut tuple = serializer.serialize_tuple(3)?;
        tuple.serialize_element(&replacement.row_index)?;
        tuple.serialize_element(&replacement.row_revision)?;
        tuple.serialize_element(&CompactRowRef {
            row: &replacement.row,
            semantic_colors: self.semantic_colors,
        })?;
        tuple.end()
    }
}

struct CompactRowRef<'a> {
    row: &'a LogicalRow,
    semantic_colors: bool,
}

impl Serialize for CompactRowRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(&self.row.text)?;
        tuple.serialize_element(&CompactCellsRef {
            cells: &self.row.cells,
            semantic_colors: self.semantic_colors,
        })?;
        tuple.end()
    }
}

struct CompactCellsRef<'a> {
    cells: &'a [LogicalCell],
    semantic_colors: bool,
}

impl Serialize for CompactCellsRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut cells = serializer.serialize_seq(Some(self.cells.len()))?;
        for cell in self.cells {
            cells.serialize_element(&CompactCellRef {
                cell,
                semantic_colors: self.semantic_colors,
            })?;
        }
        cells.end()
    }
}

struct CompactCellRef<'a> {
    cell: &'a LogicalCell,
    semantic_colors: bool,
}

impl Serialize for CompactCellRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let cell = self.cell;
        let mut tuple = serializer.serialize_tuple(4)?;
        tuple.serialize_element(&cell.column)?;
        tuple.serialize_element(&cell.span)?;
        tuple.serialize_element(&cell.text)?;
        tuple.serialize_element(&CompactCellStyleRef {
            style: cell.style,
            semantic_colors: self.semantic_colors,
        })?;
        tuple.end()
    }
}

struct CompactControlChangedRef<'a> {
    controller_view_id: &'a str,
    control_epoch: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
}

impl Serialize for CompactControlChangedRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(5)?;
        tuple.serialize_element(self.controller_view_id)?;
        tuple.serialize_element(&self.control_epoch)?;
        tuple.serialize_element(&self.cols)?;
        tuple.serialize_element(&self.rows)?;
        tuple.serialize_element(&self.layout_epoch)?;
        tuple.end()
    }
}

struct CompactControlStateRef<'a> {
    controller: Option<&'a ControllerInfo>,
    control_revision: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
}

impl Serialize for CompactControlStateRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(5)?;
        tuple.serialize_element(&self.controller.map(CompactControllerRef))?;
        tuple.serialize_element(&self.control_revision)?;
        tuple.serialize_element(&self.cols)?;
        tuple.serialize_element(&self.rows)?;
        tuple.serialize_element(&self.layout_epoch)?;
        tuple.end()
    }
}

struct CompactControllerRef<'a>(&'a ControllerInfo);

impl Serialize for CompactControllerRef<'_> {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(&self.0.controller_view_id)?;
        tuple.serialize_element(&self.0.control_epoch)?;
        tuple.end()
    }
}

struct CompactSessionEndedRef(SessionEndReason);

impl Serialize for CompactSessionEndedRef {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let (reason, exit_code) = match self.0 {
            SessionEndReason::Exited { code } => ("exited", code),
            SessionEndReason::Closed => ("closed", None),
        };
        let mut tuple = serializer.serialize_tuple(2)?;
        tuple.serialize_element(reason)?;
        tuple.serialize_element(&exit_code)?;
        tuple.end()
    }
}

/// Compact tuples are **never widened** — an appended element is a decode
/// error on the peer, not a default — so new semantics get a new tag. `"c"`
/// stays byte-identical for legacy hosts; `"cs"` carries the revisioned shape.
#[derive(Deserialize)]
enum CompactStateMessage {
    #[serde(rename = "s")]
    Snapshot(CompactSnapshot),
    #[serde(rename = "p")]
    Patch(CompactPatch),
    #[serde(rename = "c")]
    ControlChanged(CompactControlChanged),
    #[serde(rename = "a")]
    ActivityChanged(SessionActivity),
    #[serde(rename = "g")]
    ConfigurationChanged(TerminalPresentationConfig),
    #[serde(rename = "cs")]
    ControlState(CompactControlState),
    #[serde(rename = "se")]
    SessionEnded(CompactSessionEnded),
    #[serde(rename = "hs")]
    HostShutdown(),
    #[serde(rename = "l")]
    SelectionChanged(Option<CompactTrackedSelection>),
}

#[derive(Deserialize)]
struct CompactSnapshot(
    u64,
    u64,
    u64,
    u16,
    Vec<CompactRow>,
    CompactCursor,
    bool,
    CompactScrollbar,
    Option<String>,
    Option<String>,
);

#[derive(Deserialize)]
struct CompactPatch(
    u64,
    u64,
    u64,
    u64,
    Vec<CompactReplacement>,
    Option<CompactCursor>,
    Option<bool>,
    Option<CompactScrollbar>,
    u8,
);

#[derive(Deserialize)]
struct CompactReplacement(u16, u64, CompactRow);

#[derive(Deserialize)]
struct CompactRow(String, Vec<CompactCell>);

#[derive(Deserialize)]
struct CompactCell(u16, u16, String, CompactCellStyle);

struct CompactCellStyleRef {
    style: LogicalCellStyle,
    semantic_colors: bool,
}

#[derive(Clone, Copy)]
enum CompactSemanticColorRef {
    Default,
    Palette(u8),
    Rgb([u8; 3]),
}

impl Serialize for CompactSemanticColorRef {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Default => serializer.serialize_none(),
            Self::Palette(index) => serializer.serialize_u8(*index),
            Self::Rgb(rgb) => rgb.serialize(serializer),
        }
    }
}

fn compact_semantic_color(
    is_default: bool,
    palette: Option<u8>,
    rgb: Option<[u8; 3]>,
) -> CompactSemanticColorRef {
    if is_default {
        CompactSemanticColorRef::Default
    } else if let Some(index) = palette {
        CompactSemanticColorRef::Palette(index)
    } else if let Some(rgb) = rgb {
        CompactSemanticColorRef::Rgb(rgb)
    } else {
        CompactSemanticColorRef::Default
    }
}

impl Serialize for CompactCellStyleRef {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let style = self.style;
        if style.foreground_default && style.foreground_palette.is_some() {
            return Err(S::Error::custom(
                "foreground color cannot be both default and palette-indexed",
            ));
        }
        if style.background_default && style.background_palette.is_some() {
            return Err(S::Error::custom(
                "background color cannot be both default and palette-indexed",
            ));
        }
        let mut flags = u8::from(style.bold)
            | (u8::from(style.italic) << 1)
            | (u8::from(style.faint) << 2)
            | (u8::from(style.inverse) << 3)
            | (u8::from(style.invisible) << 4)
            | (u8::from(style.strikethrough) << 5)
            | (u8::from(style.underline) << 6);
        let mut tuple = serializer.serialize_tuple(3)?;
        let uses_semantic_colors = self.semantic_colors
            && (style.foreground_default
                || style.foreground_palette.is_some()
                || style.background_default
                || style.background_palette.is_some());
        if uses_semantic_colors {
            flags |= 0x80;
            tuple.serialize_element(&flags)?;
            tuple.serialize_element(&compact_semantic_color(
                style.foreground_default,
                style.foreground_palette,
                style.foreground,
            ))?;
            tuple.serialize_element(&compact_semantic_color(
                style.background_default,
                style.background_palette,
                style.background,
            ))?;
        } else {
            tuple.serialize_element(&flags)?;
            tuple.serialize_element(&style.foreground)?;
            tuple.serialize_element(&style.background)?;
        }
        tuple.end()
    }
}

#[derive(Clone, Copy)]
enum CompactCellColor {
    Palette(u8),
    Rgb([u8; 3]),
}

struct CompactCellColorVisitor;

impl<'de> Visitor<'de> for CompactCellColorVisitor {
    type Value = CompactCellColor;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a palette index or three-byte RGB array")
    }

    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        u8::try_from(value)
            .map(CompactCellColor::Palette)
            .map_err(|_| E::custom("compact palette index is outside 0...255"))
    }

    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        u8::try_from(value)
            .map(CompactCellColor::Palette)
            .map_err(|_| E::custom("compact palette index is outside 0...255"))
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut rgb = [0_u8; 3];
        for (index, component) in rgb.iter_mut().enumerate() {
            *component = sequence
                .next_element()?
                .ok_or_else(|| A::Error::custom(format!("RGB component {index} is missing")))?;
        }
        if sequence.next_element::<IgnoredAny>()?.is_some() {
            return Err(A::Error::custom(
                "compact RGB color has more than three components",
            ));
        }
        Ok(CompactCellColor::Rgb(rgb))
    }
}

impl<'de> Deserialize<'de> for CompactCellColor {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(CompactCellColorVisitor)
    }
}

#[derive(Clone, Copy)]
struct CompactCellStyle(u8, Option<CompactCellColor>, Option<CompactCellColor>);

struct CompactCellStyleVisitor;

impl<'de> Visitor<'de> for CompactCellStyleVisitor {
    type Value = CompactCellStyle;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a three-element compact cell-style tuple")
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let flags: u8 = sequence
            .next_element()?
            .ok_or_else(|| A::Error::custom("compact cell style is missing flags"))?;
        let (foreground, background) = if flags & 0x80 != 0 {
            let foreground = sequence
                .next_element::<Option<CompactCellColor>>()?
                .ok_or_else(|| A::Error::custom("compact cell style is missing foreground"))?;
            let background = sequence
                .next_element::<Option<CompactCellColor>>()?
                .ok_or_else(|| A::Error::custom("compact cell style is missing background"))?;
            (foreground, background)
        } else {
            let foreground = sequence
                .next_element::<Option<[u8; 3]>>()?
                .ok_or_else(|| A::Error::custom("compact cell style is missing foreground"))?
                .map(CompactCellColor::Rgb);
            let background = sequence
                .next_element::<Option<[u8; 3]>>()?
                .ok_or_else(|| A::Error::custom("compact cell style is missing background"))?
                .map(CompactCellColor::Rgb);
            (foreground, background)
        };
        Ok(CompactCellStyle(flags, foreground, background))
    }
}

impl<'de> Deserialize<'de> for CompactCellStyle {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_tuple(3, CompactCellStyleVisitor)
    }
}

impl TryFrom<CompactCellStyle> for LogicalCellStyle {
    type Error = anyhow::Error;

    fn try_from(style: CompactCellStyle) -> Result<Self> {
        let semantic = style.0 & 0x80 != 0;
        let color = |value: Option<CompactCellColor>| -> Result<_> {
            Ok(match (semantic, value) {
                // `null` is a semantic default on this wire. The in-memory
                // optional RGB already represents that faithfully, so it need
                // not retain a second marker after decoding.
                (true, None) => (None, false, None),
                (true, Some(CompactCellColor::Palette(index))) => (None, false, Some(index)),
                (true, Some(CompactCellColor::Rgb(rgb))) => (Some(rgb), false, None),
                (false, None) => (None, false, None),
                (false, Some(CompactCellColor::Rgb(rgb))) => (Some(rgb), false, None),
                (false, Some(CompactCellColor::Palette(_))) => {
                    bail!("legacy compact cell color cannot be a palette index")
                }
            })
        };
        let foreground = color(style.1)?;
        let background = color(style.2)?;
        Ok(Self {
            bold: style.0 & 1 != 0,
            italic: style.0 & 2 != 0,
            faint: style.0 & 4 != 0,
            inverse: style.0 & 8 != 0,
            invisible: style.0 & 16 != 0,
            strikethrough: style.0 & 32 != 0,
            underline: style.0 & 64 != 0,
            foreground: foreground.0,
            background: background.0,
            foreground_default: foreground.1,
            foreground_palette: foreground.2,
            background_default: background.1,
            background_palette: background.2,
        })
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CompactCursor(u16, u16, bool, u8, bool);

impl From<LogicalCursor> for CompactCursor {
    fn from(cursor: LogicalCursor) -> Self {
        Self(
            cursor.x,
            cursor.y,
            cursor.visible,
            cursor.style,
            cursor.blinking,
        )
    }
}

impl From<CompactCursor> for LogicalCursor {
    fn from(cursor: CompactCursor) -> Self {
        Self {
            x: cursor.0,
            y: cursor.1,
            visible: cursor.2,
            style: cursor.3,
            blinking: cursor.4,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct CompactScrollbar(u64, u64, u64);

impl From<LogicalScrollbar> for CompactScrollbar {
    fn from(scrollbar: LogicalScrollbar) -> Self {
        Self(scrollbar.total, scrollbar.offset, scrollbar.len)
    }
}

impl From<CompactScrollbar> for LogicalScrollbar {
    fn from(scrollbar: CompactScrollbar) -> Self {
        Self {
            total: scrollbar.0,
            offset: scrollbar.1,
            len: scrollbar.2,
        }
    }
}

#[derive(Deserialize)]
struct CompactControlChanged(String, u64, u16, u16, u64);

#[derive(Deserialize)]
struct CompactControlState(Option<CompactController>, u64, u16, u16, u64);

#[derive(Deserialize)]
struct CompactController(String, u64);

#[derive(Deserialize)]
struct CompactSessionEnded(String, Option<i32>);

#[derive(Deserialize)]
struct CompactTrackedSelection(u16, u32, u16, u32);

fn compact_message_uses_semantic_colors(message: &CompactStateMessage) -> bool {
    let rows: Box<dyn Iterator<Item = &CompactRow> + '_> = match message {
        CompactStateMessage::Snapshot(snapshot) => Box::new(snapshot.4.iter()),
        CompactStateMessage::Patch(patch) => {
            Box::new(patch.4.iter().map(|replacement| &replacement.2))
        }
        _ => return false,
    };
    rows.flat_map(|row| row.1.iter())
        .any(|cell| cell.3.0 & 0x80 != 0)
}

impl TryFrom<CompactSessionEnded> for SessionEndReason {
    type Error = anyhow::Error;

    fn try_from(ended: CompactSessionEnded) -> Result<Self> {
        match ended.0.as_str() {
            "exited" => Ok(Self::Exited { code: ended.1 }),
            "closed" if ended.1.is_none() => Ok(Self::Closed),
            "closed" => bail!("compact session end carries an exit code for a closed session"),
            other => bail!("unknown compact session end reason {other}"),
        }
    }
}

impl TryFrom<CompactStateMessage> for StateMessage {
    type Error = anyhow::Error;

    fn try_from(message: CompactStateMessage) -> Result<Self> {
        Ok(match message {
            CompactStateMessage::Snapshot(snapshot) => Self::Snapshot(snapshot.try_into()?),
            CompactStateMessage::Patch(patch) => Self::Patch(patch.try_into()?),
            CompactStateMessage::ControlChanged(control) => Self::ControlChanged {
                controller_view_id: control.0,
                control_epoch: control.1,
                cols: control.2,
                rows: control.3,
                layout_epoch: control.4,
            },
            CompactStateMessage::ActivityChanged(activity) => Self::ActivityChanged { activity },
            CompactStateMessage::ConfigurationChanged(presentation) => {
                Self::ConfigurationChanged { presentation }
            }
            CompactStateMessage::ControlState(control) => Self::ControlState {
                controller: control.0.map(|controller| ControllerInfo {
                    controller_view_id: controller.0,
                    control_epoch: controller.1,
                }),
                control_revision: control.1,
                cols: control.2,
                rows: control.3,
                layout_epoch: control.4,
            },
            CompactStateMessage::SessionEnded(ended) => Self::SessionEnded {
                reason: ended.try_into()?,
            },
            CompactStateMessage::HostShutdown() => Self::HostShutdown {},
            CompactStateMessage::SelectionChanged(selection) => Self::SelectionChanged {
                selection: selection.map(|selection| TrackedSelection {
                    anchor: TrackedSelectionPoint {
                        column: selection.0,
                        row: selection.1,
                    },
                    focus: TrackedSelectionPoint {
                        column: selection.2,
                        row: selection.3,
                    },
                }),
            },
        })
    }
}

impl TryFrom<CompactSnapshot> for LogicalTerminalSnapshot {
    type Error = anyhow::Error;

    fn try_from(snapshot: CompactSnapshot) -> Result<Self> {
        Ok(Self {
            session_epoch: snapshot.0,
            layout_epoch: snapshot.1,
            terminal_revision: snapshot.2,
            cols: snapshot.3,
            rows: snapshot
                .4
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            cursor: snapshot.5.into(),
            mouse_tracking: snapshot.6,
            scrollbar: snapshot.7.into(),
            title: snapshot.8,
            cwd: snapshot.9,
        })
    }
}

impl TryFrom<CompactPatch> for LogicalTerminalPatch {
    type Error = anyhow::Error;

    fn try_from(patch: CompactPatch) -> Result<Self> {
        if patch.8 != 0 {
            bail!("compact state patch has unsupported extension flags");
        }
        Ok(Self {
            session_epoch: patch.0,
            layout_epoch: patch.1,
            patch_sequence: patch.2,
            terminal_revision: patch.3,
            row_replacements: patch
                .4
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
            cursor: patch.5.map(Into::into),
            mouse_tracking: patch.6,
            scrollbar: patch.7.map(Into::into),
        })
    }
}

impl TryFrom<CompactReplacement> for RowReplacement {
    type Error = anyhow::Error;

    fn try_from(replacement: CompactReplacement) -> Result<Self> {
        Ok(Self {
            row_index: replacement.0,
            row_revision: replacement.1,
            row: replacement.2.try_into()?,
        })
    }
}

impl TryFrom<CompactRow> for LogicalRow {
    type Error = anyhow::Error;

    fn try_from(row: CompactRow) -> Result<Self> {
        Ok(Self {
            text: row.0,
            cells: row
                .1
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_>>()?,
        })
    }
}

impl TryFrom<CompactCell> for LogicalCell {
    type Error = anyhow::Error;

    fn try_from(cell: CompactCell) -> Result<Self> {
        Ok(Self {
            column: cell.0,
            span: cell.1,
            text: cell.2,
            style: cell.3.try_into()?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostAdvertisement {
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub quic_port: u16,
    pub host_instance_id: String,
    pub published_at_ms: u64,
    pub expires_at_ms: u64,
    pub sessions: Vec<SharedSessionSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSessionSummary {
    pub session_id: String,
    pub title: String,
    pub cwd_label: Option<String>,
    pub running: bool,
    pub attachable: bool,
    pub read_write: bool,
    pub created_at_ms: u64,
    #[serde(default)]
    pub activity: SessionActivity,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preface_round_trips_and_rejects_kind_tampering() {
        let preface = StreamPreface {
            stream_kind: StreamKind::LiveState,
            session_id: Some("session".into()),
            view_id: Some("view".into()),
        };
        let encoded = encode_preface(&preface).unwrap();
        let (decoded, consumed) = decode_preface(&encoded).unwrap();
        assert_eq!(decoded, preface);
        assert_eq!(consumed, encoded.len());

        let mut tampered = encoded;
        tampered[8] = StreamKind::Asset.as_byte();
        assert!(decode_preface(&tampered).is_err());
    }

    #[test]
    fn framed_messages_round_trip_and_enforce_limits() {
        let message = ConnectionMessage::ListSessions {
            request_id: "request".into(),
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, consumed) = decode_message::<ConnectionMessage>(&encoded, 1024).unwrap();
        assert!(matches!(decoded, ConnectionMessage::ListSessions { .. }));
        assert_eq!(consumed, encoded.len());

        let mut oversized = vec![0, 0, 4, 1];
        oversized.resize(1029, 0);
        assert!(decode_message::<ConnectionMessage>(&oversized, 1024).is_err());
    }

    #[test]
    fn compact_messages_preserve_channel_and_existing_json_contract() {
        let message = SessionControlMessage::RequestSnapshot;
        let encoded = encode_compact_message(CompactChannel::Control, &message, 1024).unwrap();
        assert_eq!(encoded[4], CompactChannel::Control.as_byte());
        let (decoded, consumed) = decode_compact_message::<SessionControlMessage>(
            &encoded,
            CompactChannel::Control,
            1024,
        )
        .unwrap();
        assert!(matches!(decoded, SessionControlMessage::RequestSnapshot));
        assert_eq!(consumed, encoded.len());
        assert!(
            decode_compact_message::<SessionControlMessage>(&encoded, CompactChannel::State, 1024)
                .is_err()
        );
    }

    #[test]
    fn apple_connection_control_fixture_matches_rust_contract() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            client_hello: ConnectionMessage,
            server_hello: ConnectionMessage,
            sessions: ConnectionMessage,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../apple/GhostteaKit/Tests/GhostteaTruffleTests/Fixtures/connection-control-v1.json"
        ))
        .unwrap();
        assert!(matches!(
            fixture.client_hello,
            ConnectionMessage::ClientHello {
                protocol_major: 1,
                protocol_minor: 3,
                ref host_instance_id,
                ref local_device_id,
                ref nonce,
                ..
            } if host_instance_id == "desktop-instance"
                && local_device_id == "01J4K9M2Z8AB3RNYQPW6H5TC0X"
                && nonce == "nonce-1"
        ));
        assert!(matches!(
            fixture.server_hello,
            ConnectionMessage::ServerHello {
                protocol_major: 1,
                protocol_minor: 3,
                ref host_instance_id,
                ref nonce,
                ..
            } if host_instance_id == "desktop-instance" && nonce == "nonce-1"
        ));
        assert!(matches!(
            fixture.sessions,
            ConnectionMessage::Sessions {
                ref request_id,
                ref sessions,
            } if request_id == "request-1"
                && sessions.len() == 1
                && sessions[0].session_id == "session-1"
                && sessions[0].read_write
        ));
    }

    #[test]
    fn typed_terminal_input_round_trips() {
        let message = SessionControlMessage::Input {
            view_id: "view".into(),
            attachment_epoch: 7,
            input_sequence: 9,
            operation: TunnelInput::Interrupt,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::Input {
                attachment_epoch: 7,
                input_sequence: 9,
                operation: TunnelInput::Interrupt,
                ..
            }
        ));
    }

    #[test]
    fn absolute_scroll_input_round_trips() {
        let message = SessionControlMessage::Input {
            view_id: "view".into(),
            attachment_epoch: 7,
            input_sequence: 10,
            operation: TunnelInput::ScrollTo(42),
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::Input {
                operation: TunnelInput::ScrollTo(42),
                ..
            }
        ));
    }

    /// A key's Option policy crosses the mesh inside the key, at a minor of its
    /// own: a minor-8 host drops `optionAsAlt` unread. A key that names no
    /// policy keeps Option as Alt, and a relay states that default to the host
    /// rather than leaving it out.
    #[test]
    fn key_input_carries_the_option_policy_at_its_own_minor() {
        assert_eq!(OPTION_AS_ALT_PROTOCOL_MINOR, 9);
        let input = |option_as_alt: Option<bool>| {
            let mut key = serde_json::json!({
                "type": "down",
                "key": "@",
                "code": "KeyL",
                "repeat": false,
                "shift": false,
                "control": false,
                "alt": true,
                "meta": false,
                "unshiftedCodepoint": 108,
            });
            if let Some(option_as_alt) = option_as_alt {
                key["optionAsAlt"] = serde_json::json!(option_as_alt);
            }
            serde_json::from_value::<SessionControlMessage>(serde_json::json!({
                "type": "input",
                "viewId": "view",
                "attachmentEpoch": 7,
                "inputSequence": 11,
                "operation": { "type": "key", "value": key },
            }))
            .unwrap()
        };

        for (value, expected) in [(Some(false), false), (Some(true), true), (None, true)] {
            let message = input(value);
            match &message {
                SessionControlMessage::Input {
                    operation: TunnelInput::Key(key),
                    ..
                } => assert_eq!(key.option_as_alt, expected),
                _ => panic!("expected key input"),
            }
            let relayed = serde_json::to_value(&message).unwrap();
            assert_eq!(relayed["operation"]["value"]["optionAsAlt"], expected);
        }
    }

    #[test]
    fn control_changes_round_trip_on_the_live_state_stream() {
        let message = StateMessage::ControlChanged {
            controller_view_id: "view".into(),
            control_epoch: 11,
            cols: 120,
            rows: 40,
            layout_epoch: 5,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<StateMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            StateMessage::ControlChanged {
                control_epoch: 11,
                cols: 120,
                rows: 40,
                layout_epoch: 5,
                ..
            }
        ));
    }

    #[test]
    fn activity_changes_round_trip_in_json_and_compact_state_codecs() {
        let message = StateMessage::ActivityChanged {
            activity: SessionActivity {
                kind: crate::SessionActivityKind::ForegroundJob,
                source: crate::SessionActivitySource::ProcessGroup,
                confidence: crate::SessionActivityConfidence::Heuristic,
                root_process_group_id: Some(42),
                foreground_process_group_id: Some(43),
                observed_at_ms: 100,
            },
        };
        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            let encoded = encode_state_message(&message, codec, 4096).unwrap();
            let (decoded, consumed) = decode_state_message(&encoded, codec, 4096).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn presentation_changes_round_trip_in_json_and_compact_state_codecs() {
        let snapshot = ghosttea_config::ConfigSnapshot {
            revision: "remote-revision".into(),
            ..ghosttea_config::ConfigSnapshot::default()
        };
        let message = StateMessage::ConfigurationChanged {
            presentation: snapshot.terminal_presentation(),
        };
        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            let encoded = encode_state_message(&message, codec, 4096).unwrap();
            let (decoded, consumed) = decode_state_message(&encoded, codec, 4096).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn older_shared_summaries_default_activity_to_unknown() {
        let summary: SharedSessionSummary = serde_json::from_value(serde_json::json!({
            "sessionId": "session",
            "title": "shell",
            "cwdLabel": null,
            "running": true,
            "attachable": true,
            "readWrite": true,
            "createdAtMs": 1
        }))
        .unwrap();
        assert_eq!(summary.activity.kind, crate::SessionActivityKind::Unknown);
        assert_eq!(
            summary.activity.source,
            crate::SessionActivitySource::Unsupported
        );
    }

    #[test]
    fn compact_state_codec_round_trips_cells_and_reduces_json_size() {
        let snapshot = LogicalTerminalSnapshot {
            session_epoch: 7,
            layout_epoch: 3,
            terminal_revision: 11,
            cols: 2,
            rows: vec![LogicalRow {
                text: "ab".into(),
                cells: vec![
                    LogicalCell {
                        column: 0,
                        span: 1,
                        text: "a".into(),
                        style: LogicalCellStyle {
                            bold: true,
                            italic: true,
                            underline: true,
                            foreground: Some([1, 2, 3]),
                            background: Some([4, 5, 6]),
                            ..LogicalCellStyle::default()
                        },
                    },
                    LogicalCell {
                        column: 1,
                        span: 1,
                        text: "b".into(),
                        style: LogicalCellStyle {
                            faint: true,
                            inverse: true,
                            invisible: true,
                            strikethrough: true,
                            ..LogicalCellStyle::default()
                        },
                    },
                ],
            }],
            cursor: LogicalCursor {
                x: 1,
                y: 0,
                visible: true,
                style: 2,
                blinking: true,
            },
            mouse_tracking: true,
            scrollbar: LogicalScrollbar {
                total: 20,
                offset: 10,
                len: 1,
            },
            title: Some("title".into()),
            cwd: Some("/cwd".into()),
        };
        let message = StateMessage::Snapshot(snapshot.clone());
        let json = encode_state_message(&message, StateCodec::Json, 4096).unwrap();
        let compact = encode_state_message(&message, StateCodec::CompactJsonV1, 4096).unwrap();
        let legacy_compact = encode_state_message_for_minor(
            &message,
            StateCodec::CompactJsonV1,
            TRACKED_SELECTION_PROTOCOL_MINOR,
            4096,
        )
        .unwrap();
        assert_eq!(compact, legacy_compact);
        let (decoded, consumed) =
            decode_state_message(&compact, StateCodec::CompactJsonV1, 4096).unwrap();

        assert!(compact.len() * 2 < json.len());
        assert_eq!(consumed, compact.len());
        let StateMessage::Snapshot(decoded) = decoded else {
            panic!("compact snapshot decoded as the wrong state variant");
        };
        assert_eq!(decoded, snapshot);

        for message in [
            StateMessage::Patch(LogicalTerminalPatch {
                session_epoch: 7,
                layout_epoch: 3,
                patch_sequence: 1,
                terminal_revision: 12,
                row_replacements: vec![RowReplacement {
                    row_index: 0,
                    row_revision: 12,
                    row: snapshot.rows[0].clone(),
                }],
                cursor: Some(snapshot.cursor),
                mouse_tracking: Some(false),
                scrollbar: Some(snapshot.scrollbar),
            }),
            StateMessage::ControlChanged {
                controller_view_id: "view".into(),
                control_epoch: 9,
                cols: 2,
                rows: 1,
                layout_epoch: 3,
            },
        ] {
            let encoded = encode_state_message(&message, StateCodec::CompactJsonV1, 4096).unwrap();
            let decoded = decode_state_message(&encoded, StateCodec::CompactJsonV1, 4096)
                .unwrap()
                .0;
            assert_eq!(decoded, message);
        }
    }

    #[test]
    fn compact_state_fixture_is_canonical_rust_encoding() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apple/GhostteaKit/Tests/GhostteaTruffleTests/Fixtures/compact-state-v1.json"
        ))
        .unwrap();
        for key in ["snapshot", "patch", "controlChanged"] {
            let compact: CompactStateMessage =
                serde_json::from_value(fixture[key].clone()).unwrap();
            let state = StateMessage::try_from(compact).unwrap();
            let encoded = encode_state_message_for_minor(
                &state,
                StateCodec::CompactJsonV1,
                TRACKED_SELECTION_PROTOCOL_MINOR,
                4096,
            )
            .unwrap();
            let encoded_value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
            assert_eq!(encoded_value, fixture[key], "fixture mismatch for {key}");
        }
    }

    #[test]
    fn semantic_colors_are_minor_gated_and_legacy_bytes_keep_resolved_rgb() {
        let snapshot = LogicalTerminalSnapshot {
            session_epoch: 1,
            layout_epoch: 1,
            terminal_revision: 1,
            cols: 1,
            rows: vec![LogicalRow {
                text: "x".into(),
                cells: vec![LogicalCell {
                    column: 0,
                    span: 1,
                    text: "x".into(),
                    style: LogicalCellStyle {
                        foreground: Some([0x12, 0x34, 0x56]),
                        foreground_palette: Some(1),
                        background_default: true,
                        ..LogicalCellStyle::default()
                    },
                }],
            }],
            cursor: LogicalCursor::default(),
            mouse_tracking: false,
            scrollbar: LogicalScrollbar::default(),
            title: None,
            cwd: None,
        };
        let message = StateMessage::Snapshot(snapshot.clone());
        let legacy = encode_state_message_for_minor(
            &message,
            StateCodec::CompactJsonV1,
            TRACKED_SELECTION_PROTOCOL_MINOR,
            4096,
        )
        .unwrap();
        let current = encode_state_message_for_minor(
            &message,
            StateCodec::CompactJsonV1,
            SEMANTIC_CELL_COLOR_PROTOCOL_MINOR,
            4096,
        )
        .unwrap();
        let legacy_json: serde_json::Value = serde_json::from_slice(&legacy[4..]).unwrap();
        let current_json: serde_json::Value = serde_json::from_slice(&current[4..]).unwrap();
        assert_eq!(
            legacy_json["s"][4][0][1][0][3],
            serde_json::json!([0, [18, 52, 86], null])
        );
        assert_eq!(
            current_json["s"][4][0][1][0][3],
            serde_json::json!([128, 1, null])
        );
        assert!(current.len() < legacy.len());
        assert!(
            decode_state_message_for_minor(
                &current,
                StateCodec::CompactJsonV1,
                TRACKED_SELECTION_PROTOCOL_MINOR,
                4096,
            )
            .is_err()
        );
        let decoded = decode_state_message_for_minor(
            &current,
            StateCodec::CompactJsonV1,
            SEMANTIC_CELL_COLOR_PROTOCOL_MINOR,
            4096,
        )
        .unwrap()
        .0;
        let StateMessage::Snapshot(decoded) = decoded else {
            panic!("semantic snapshot decoded as another state variant")
        };
        assert_eq!(decoded.rows[0].cells[0].style.foreground_palette, Some(1));
        assert_eq!(decoded.rows[0].cells[0].style.foreground, None);
        assert_eq!(decoded.rows[0].cells[0].style.background, None);

        let legacy_json = encode_state_message_for_minor(
            &message,
            StateCodec::Json,
            TRACKED_SELECTION_PROTOCOL_MINOR,
            4096,
        )
        .unwrap();
        let legacy_json: serde_json::Value = serde_json::from_slice(&legacy_json[4..]).unwrap();
        let style = &legacy_json["rows"][0]["cells"][0]["style"];
        assert!(style.get("foregroundPalette").is_none());
        assert!(style.get("backgroundDefault").is_none());
    }

    #[test]
    fn contradictory_semantic_colors_are_rejected_on_encode_and_json_decode() {
        let snapshot = LogicalTerminalSnapshot {
            session_epoch: 1,
            layout_epoch: 1,
            terminal_revision: 1,
            cols: 1,
            rows: vec![LogicalRow {
                text: "x".into(),
                cells: vec![LogicalCell {
                    column: 0,
                    span: 1,
                    text: "x".into(),
                    style: LogicalCellStyle {
                        foreground_default: true,
                        foreground_palette: Some(4),
                        ..LogicalCellStyle::default()
                    },
                }],
            }],
            cursor: LogicalCursor::default(),
            mouse_tracking: false,
            scrollbar: LogicalScrollbar::default(),
            title: None,
            cwd: None,
        };
        let message = StateMessage::Snapshot(snapshot);

        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            assert!(
                encode_state_message_for_minor(
                    &message,
                    codec,
                    SEMANTIC_CELL_COLOR_PROTOCOL_MINOR,
                    4096,
                )
                .is_err()
            );
        }

        let invalid_json = encode_message(&message, 4096).unwrap();
        assert!(
            decode_state_message_for_minor(
                &invalid_json,
                StateCodec::Json,
                SEMANTIC_CELL_COLOR_PROTOCOL_MINOR,
                4096,
            )
            .is_err()
        );
    }

    #[test]
    fn compact_cell_style_rejects_trailing_tuple_values() {
        assert!(serde_json::from_str::<CompactCellStyle>("[0,null,null,0]").is_err());
    }

    /// The four framed forms a compact state message can take, minus the
    /// length prefix: what a peer actually parses.
    fn compact_state_json(message: &StateMessage) -> serde_json::Value {
        let encoded = encode_state_message(message, StateCodec::CompactJsonV1, 4096).unwrap();
        serde_json::from_slice(&encoded[4..]).unwrap()
    }

    fn round_trips_in_both_state_codecs(message: &StateMessage) {
        for codec in [StateCodec::Json, StateCodec::CompactJsonV1] {
            let encoded = encode_state_message(message, codec, 4096).unwrap();
            let (decoded, consumed) = decode_state_message(&encoded, codec, 4096).unwrap();
            assert_eq!(&decoded, message);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn heartbeat_messages_round_trip_on_a_stream_of_their_own() {
        let preface = StreamPreface {
            stream_kind: StreamKind::Heartbeat,
            session_id: None,
            view_id: None,
        };
        let encoded = encode_preface(&preface).unwrap();
        assert_eq!(decode_preface(&encoded).unwrap().0, preface);

        for message in [
            HeartbeatMessage::Ping { nonce: 7 },
            HeartbeatMessage::Pong { nonce: 7 },
            HeartbeatMessage::HostShutdown {},
        ] {
            let encoded = encode_heartbeat_message(&message).unwrap();
            let (decoded, consumed) = decode_heartbeat_message(&encoded).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(consumed, encoded.len());
        }

        // The shutdown push must be a bare tagged object, so a Swift or TS
        // decoder needs no payload handling for it.
        assert_eq!(
            serde_json::to_value(HeartbeatMessage::HostShutdown {}).unwrap(),
            serde_json::json!({ "type": "host-shutdown" })
        );
    }

    #[test]
    fn compact_transport_heartbeats_ride_the_control_channel() {
        for message in [
            SessionControlMessage::Ping { nonce: 3 },
            SessionControlMessage::Pong { nonce: 3 },
        ] {
            let encoded = encode_compact_message(CompactChannel::Control, &message, 1024).unwrap();
            let (decoded, _) = decode_compact_message::<SessionControlMessage>(
                &encoded,
                CompactChannel::Control,
                1024,
            )
            .unwrap();
            assert!(matches!(
                decoded,
                SessionControlMessage::Ping { nonce: 3 } | SessionControlMessage::Pong { nonce: 3 }
            ));
        }
    }

    #[test]
    fn attach_view_carries_ordering_resume_evidence_and_state_intent() {
        let message = SessionControlMessage::AttachView {
            request_id: "request".into(),
            session_id: "session".into(),
            view_id: "view".into(),
            access_token: None,
            cols: 80,
            rows: 24,
            attach_generation: 4,
            resume: Some(ResumeHint {
                previous_session_epoch: 11,
                previous_attachment_epoch: 12,
                previous_terminal_revision: 13,
            }),
            wants_state: false,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::AttachView {
                attach_generation: 4,
                wants_state: false,
                resume: Some(ResumeHint {
                    previous_session_epoch: 11,
                    previous_attachment_epoch: 12,
                    previous_terminal_revision: 13,
                }),
                ..
            }
        ));
    }

    #[test]
    fn pre_reconnect_attach_view_decodes_with_reconnect_defaults() {
        let legacy = serde_json::json!({
            "type": "attach-view",
            "requestId": "request",
            "sessionId": "session",
            "viewId": "view",
            "accessToken": null,
            "cols": 80,
            "rows": 24
        });
        let decoded: SessionControlMessage = serde_json::from_value(legacy).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::AttachView {
                attach_generation: 0,
                resume: None,
                // Absent means "this client predates secondary-view opt-out",
                // so it must still get its snapshot.
                wants_state: true,
                ..
            }
        ));
    }

    #[test]
    fn pre_reconnect_view_attached_decodes_with_reconnect_defaults() {
        let legacy = serde_json::json!({
            "type": "view-attached",
            "requestId": "request",
            "sessionEpoch": 2,
            "layoutEpoch": 3,
            "attachmentEpoch": 4,
            "cols": 80,
            "rows": 24,
            "readWrite": true
        });
        let decoded: SessionControlMessage = serde_json::from_value(legacy).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::ViewAttached {
                resumed: false,
                controller: None,
                // 0 is the legacy sentinel: never a CAS-able observation.
                control_revision: 0,
                ..
            }
        ));
    }

    #[test]
    fn view_attached_reports_the_controller_and_its_revision() {
        let message = SessionControlMessage::ViewAttached {
            request_id: "request".into(),
            session_epoch: 2,
            layout_epoch: 3,
            attachment_epoch: 4,
            cols: 80,
            rows: 24,
            read_write: true,
            presentation: None,
            resumed: true,
            controller: Some(ControllerInfo {
                controller_view_id: "other".into(),
                control_epoch: 9,
            }),
            control_revision: 17,
        };
        let encoded = encode_message(&message, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        let SessionControlMessage::ViewAttached {
            resumed,
            controller,
            control_revision,
            ..
        } = decoded
        else {
            panic!("view-attached decoded as the wrong control variant");
        };
        assert!(resumed);
        assert_eq!(control_revision, 17);
        assert_eq!(
            controller,
            Some(ControllerInfo {
                controller_view_id: "other".into(),
                control_epoch: 9,
            })
        );
    }

    #[test]
    fn focus_and_resize_defaults_to_legacy_last_write_wins() {
        let legacy = serde_json::json!({
            "type": "focus-and-resize",
            "viewId": "view",
            "attachmentEpoch": 4,
            "cols": 80,
            "rows": 24,
            "clientSequence": 1
        });
        let decoded: SessionControlMessage = serde_json::from_value(legacy).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::FocusAndResize {
                expected_control_revision: None,
                ..
            }
        ));

        let cas = SessionControlMessage::FocusAndResize {
            view_id: "view".into(),
            attachment_epoch: 4,
            cols: 80,
            rows: 24,
            client_sequence: 1,
            expected_control_revision: Some(17),
        };
        let encoded = encode_message(&cas, 1024).unwrap();
        let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::FocusAndResize {
                expected_control_revision: Some(17),
                ..
            }
        ));
    }

    #[test]
    fn attach_rejections_are_a_closed_set_that_decodes_unknown_codes() {
        for code in [
            AttachRejectCode::StaleResume,
            AttachRejectCode::ViewInvalid,
            AttachRejectCode::ViewLimit,
            AttachRejectCode::UnknownSession,
            AttachRejectCode::SessionEpochMismatch,
            AttachRejectCode::AccessDenied,
        ] {
            let message = SessionControlMessage::AttachRejected {
                request_id: "request".into(),
                code,
                retryable: false,
            };
            let encoded = encode_message(&message, 1024).unwrap();
            let (decoded, _) = decode_message::<SessionControlMessage>(&encoded, 1024).unwrap();
            let SessionControlMessage::AttachRejected {
                code: decoded_code, ..
            } = decoded
            else {
                panic!("attach-rejected decoded as the wrong control variant");
            };
            assert_eq!(decoded_code, code);
        }

        assert_eq!(
            serde_json::to_value(AttachRejectCode::SessionEpochMismatch).unwrap(),
            serde_json::json!("session-epoch-mismatch")
        );

        // A code minted after this viewer shipped must not fail the frame; it
        // takes the ambiguous-failure path instead.
        let future = serde_json::json!({
            "type": "attach-rejected",
            "requestId": "request",
            "code": "quota-exhausted",
            "retryable": true
        });
        let decoded: SessionControlMessage = serde_json::from_value(future).unwrap();
        assert!(matches!(
            decoded,
            SessionControlMessage::AttachRejected {
                code: AttachRejectCode::Unknown,
                retryable: true,
                ..
            }
        ));
    }

    #[test]
    fn session_status_lookups_round_trip() {
        for status in [
            SessionStatusKind::Live,
            SessionStatusKind::Ended {
                reason: SessionEndReason::Exited { code: Some(3) },
            },
            SessionStatusKind::Ended {
                reason: SessionEndReason::Exited { code: None },
            },
            SessionStatusKind::Ended {
                reason: SessionEndReason::Closed,
            },
            SessionStatusKind::Unknown,
        ] {
            let message = ConnectionMessage::SessionStatusResult {
                request_id: "request".into(),
                status,
            };
            let encoded = encode_message(&message, 1024).unwrap();
            let (decoded, _) = decode_message::<ConnectionMessage>(&encoded, 1024).unwrap();
            let ConnectionMessage::SessionStatusResult {
                status: decoded_status,
                ..
            } = decoded
            else {
                panic!("session-status-result decoded as the wrong connection variant");
            };
            assert_eq!(decoded_status, status);
        }

        let request = ConnectionMessage::SessionStatus {
            request_id: "request".into(),
            session_id: "session".into(),
        };
        let encoded = encode_message(&request, 1024).unwrap();
        let (decoded, _) = decode_message::<ConnectionMessage>(&encoded, 1024).unwrap();
        assert!(matches!(
            decoded,
            ConnectionMessage::SessionStatus { ref session_id, .. } if session_id == "session"
        ));
    }

    #[test]
    fn control_state_round_trips_with_and_without_a_controller() {
        round_trips_in_both_state_codecs(&StateMessage::ControlState {
            controller: Some(ControllerInfo {
                controller_view_id: "view".into(),
                control_epoch: 9,
            }),
            control_revision: 17,
            cols: 120,
            rows: 40,
            layout_epoch: 5,
        });
        // "No controller at revision 17" — the observation `ControlChanged`
        // structurally cannot express.
        round_trips_in_both_state_codecs(&StateMessage::ControlState {
            controller: None,
            control_revision: 17,
            cols: 120,
            rows: 40,
            layout_epoch: 5,
        });
    }

    #[test]
    fn tracked_selection_round_trips_and_uses_a_new_compact_tag() {
        let selected = StateMessage::SelectionChanged {
            selection: Some(TrackedSelection {
                anchor: TrackedSelectionPoint { column: 2, row: 41 },
                focus: TrackedSelectionPoint { column: 8, row: 43 },
            }),
        };
        round_trips_in_both_state_codecs(&selected);
        round_trips_in_both_state_codecs(&StateMessage::SelectionChanged { selection: None });
        assert_eq!(
            compact_state_json(&selected),
            serde_json::json!({"l": [2, 41, 8, 43]})
        );
        assert_eq!(
            compact_state_json(&StateMessage::SelectionChanged { selection: None }),
            serde_json::json!({"l": null})
        );
    }

    #[test]
    fn session_end_and_host_shutdown_round_trip_in_both_state_codecs() {
        for reason in [
            SessionEndReason::Exited { code: Some(130) },
            SessionEndReason::Exited { code: None },
            SessionEndReason::Closed,
        ] {
            round_trips_in_both_state_codecs(&StateMessage::SessionEnded { reason });
        }
        round_trips_in_both_state_codecs(&StateMessage::HostShutdown {});
    }

    #[test]
    fn new_compact_state_tags_match_the_specified_shapes() {
        assert_eq!(
            compact_state_json(&StateMessage::ControlState {
                controller: Some(ControllerInfo {
                    controller_view_id: "view".into(),
                    control_epoch: 9,
                }),
                control_revision: 17,
                cols: 120,
                rows: 40,
                layout_epoch: 5,
            }),
            serde_json::json!({ "cs": [["view", 9], 17, 120, 40, 5] })
        );
        assert_eq!(
            compact_state_json(&StateMessage::ControlState {
                controller: None,
                control_revision: 17,
                cols: 120,
                rows: 40,
                layout_epoch: 5,
            }),
            serde_json::json!({ "cs": [null, 17, 120, 40, 5] })
        );
        assert_eq!(
            compact_state_json(&StateMessage::SessionEnded {
                reason: SessionEndReason::Exited { code: Some(130) },
            }),
            serde_json::json!({ "se": ["exited", 130] })
        );
        assert_eq!(
            compact_state_json(&StateMessage::SessionEnded {
                reason: SessionEndReason::Closed,
            }),
            serde_json::json!({ "se": ["closed", null] })
        );
        assert_eq!(
            compact_state_json(&StateMessage::HostShutdown {}),
            serde_json::json!({ "hs": [] })
        );
    }

    #[test]
    fn compact_control_changed_stays_byte_identical_for_legacy_peers() {
        // Widening this tuple would be a decode error on every peer that
        // predates the change, which is why `ControlState` got its own tag.
        assert_eq!(
            compact_state_json(&StateMessage::ControlChanged {
                controller_view_id: "view".into(),
                control_epoch: 9,
                cols: 2,
                rows: 1,
                layout_epoch: 3,
            }),
            serde_json::json!({ "c": ["view", 9, 2, 1, 3] })
        );
    }

    #[test]
    fn compact_session_end_rejects_contradictory_and_unknown_reasons() {
        for malformed in [
            serde_json::json!({ "se": ["closed", 3] }),
            serde_json::json!({ "se": ["vanished", null] }),
        ] {
            let compact: CompactStateMessage = serde_json::from_value(malformed).unwrap();
            assert!(StateMessage::try_from(compact).is_err());
        }
    }

    #[test]
    fn unknown_protocol_major_is_rejected_before_json() {
        let mut encoded = encode_preface(&StreamPreface {
            stream_kind: StreamKind::ConnectionControl,
            session_id: None,
            view_id: None,
        })
        .unwrap();
        encoded[4..6].copy_from_slice(&2_u16.to_be_bytes());
        assert!(decode_preface(&encoded).is_err());
    }
}
