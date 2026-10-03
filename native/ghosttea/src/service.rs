use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{self, AtomicBool, AtomicUsize},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use ghosttea_config::{
    ConfigDocument, ConfigDocumentError, ConfigLoadOptions, ConfigManager, ConfigSnapshot,
    TerminalPresentationConfig,
};
use ghosttea_text::{FontMode, TextEngine};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{broadcast, watch},
    task::JoinHandle,
};

use crate::{
    FrameHub, ipc, mesh, session,
    session::{
        AutomationInputOperation, ExitCallback, KeyInput, MouseInput, Persistence, Session,
        SpawnOptions, TerminationSource,
    },
    tunnel_protocol,
};

const MAX_CONTROL_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_SUBSCRIPTION_BYTES: usize = 1024 * 1024;
const MAX_FRAME_SUBSCRIPTIONS: usize = 4096;
const MAX_AUTH_TOKEN_BYTES: usize = 1024;
const MAX_TERMINAL_COLS: u16 = 1_000;
const MAX_TERMINAL_ROWS: u16 = 1_000;
const MAX_SESSION_OWNER_TRANSFERS: usize = 4_096;
const MAX_CLOSED_OWNER_TOMBSTONES: usize = 16_384;
const CLOSED_OWNER_BLOOM_BITS: usize = 1 << 23;
const CLOSED_OWNER_BLOOM_HASHES: u64 = 4;
const CONTROL_PROTOCOL_MAJOR: u16 = 1;
const CONTROL_PROTOCOL_MINOR: u16 = 16;
const ACTIVITY_EVENT_PROTOCOL_MINOR: u16 = 6;
const EVENTS_LOST_PROTOCOL_MINOR: u16 = 8;
const SESSION_CREATED_PROTOCOL_MINOR: u16 = 9;
const CONFIG_EVENT_PROTOCOL_MINOR: u16 = 10;
const CONFIG_DOCUMENT_PROTOCOL_MINOR: u16 = 11;
/// Remote-session lifecycle: the state events, per-view readiness, controller
/// state, and the three reconciliation commands.
///
/// Advertised only with its complete surface. A minor is a promise about which
/// messages exist, not about what they do yet, so every minor-12 command ships
/// here even where Phase 1 leaves the behaviour dormant — a client that
/// negotiated 12 and then hit an unknown command would lose its socket.
const REMOTE_LIFECYCLE_PROTOCOL_MINOR: u16 = 12;
/// Compare-and-swap on controller state: `expectedControlRevision` on the
/// claim, `controlRevision` on its answer, and the `control-rejected` outcome
/// that a claim can now have.
///
/// This is a surface change, so it allocates its own minor rather than riding
/// on 12 — §7's rule, and here the rule is load-bearing rather than
/// bookkeeping. Serde ignores fields it does not know, so a minor-12 daemon
/// handed `expectedControlRevision` would claim control *unconditionally* and
/// answer `control-claimed`: the client would be told it won a fenced race it
/// never actually fenced. A silent CAS bypass is worse than the closed socket
/// the rule usually prevents, because nothing observes it. The negotiated
/// minor is what lets a client know the daemon can fence at all.
const CONTROL_REVISION_CAS_PROTOCOL_MINOR: u16 = 13;
/// Owner-aware view attachment and transactional session reassignment during
/// `close-session-owner`.
const SESSION_OWNER_TRANSFER_PROTOCOL_MINOR: u16 = 14;
/// Per-session scrollback overrides and their effective-cap summary echo.
const SESSION_SCROLLBACK_PROTOCOL_MINOR: u16 = 15;
/// Structured control-error metadata. Reserved independently of landing order.
const STRUCTURED_ERROR_PROTOCOL_MINOR: u16 = 16;
// A gate above the advertised minor would be unreachable: no client could ever
// negotiate high enough to receive the event it guards.
const _: () = assert!(SESSION_CREATED_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(CONFIG_EVENT_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(CONFIG_DOCUMENT_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(EVENTS_LOST_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(ACTIVITY_EVENT_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(REMOTE_LIFECYCLE_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(CONTROL_REVISION_CAS_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(SESSION_OWNER_TRANSFER_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(SESSION_SCROLLBACK_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(STRUCTURED_ERROR_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const ACTIVITY_SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
const EVENT_CHANNEL_CAPACITY: usize = 1024;
/// How long an accepted connection may take to present its token before the
/// daemon reclaims the task and socket.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether a broadcast event may reach a client that negotiated this minor.
///
/// A pushed event added after a client's version must not surprise it, so each
/// one names the minor that introduced it. (`events-lost` is gated at its send
/// site instead: it is generated per connection rather than broadcast.)
fn client_accepts_event(event: &Value, protocol_minor: u16) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("session-activity-changed") => protocol_minor >= ACTIVITY_EVENT_PROTOCOL_MINOR,
        Some("session-created") => protocol_minor >= SESSION_CREATED_PROTOCOL_MINOR,
        Some("config-changed") => protocol_minor >= CONFIG_EVENT_PROTOCOL_MINOR,
        Some("remote-session-state-changed" | "view-state-changed" | "control-state") => {
            protocol_minor >= REMOTE_LIFECYCLE_PROTOCOL_MINOR
        }
        _ => true,
    }
}

/// Rewrite a broadcast event into the form this client can actually read, or
/// drop it when there is none.
///
/// Only `control-state` has one: it supersedes `control-changed` for remote
/// sessions, and a client that never negotiated it would otherwise silently
/// stop hearing about controller changes it can still act on. A named
/// controller downgrades to the legacy event; a *cleared* controller has no
/// legacy spelling and stays invisible to older clients, exactly as today.
/// Local sessions keep publishing `control-changed` directly at every minor.
fn event_for_client(event: Value, protocol_minor: u16) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) == Some("control-state")
        && protocol_minor < REMOTE_LIFECYCLE_PROTOCOL_MINOR
    {
        let controller = event.get("controller")?.as_object()?;
        return Some(json!({
            "requestId": 0,
            "type": "control-changed",
            "sessionId": event.get("sessionId")?,
            "controllerViewId": controller.get("viewId")?,
            "controlEpoch": controller.get("controlEpoch")?,
            "cols": event.get("cols")?,
            "rows": event.get("rows")?,
            "layoutEpoch": event.get("layoutEpoch")?,
        }));
    }
    client_accepts_event(&event, protocol_minor).then_some(event)
}

/// Announce a session that has just entered the local registry.
///
/// Carries the full summary so a subscriber needs no follow-up `list-sessions`,
/// and reuses the `session` key of the create response so one event name keeps
/// one shape on the wire; `requestId: 0` marks it as pushed.
fn announce_session_created(
    event_tx: &broadcast::Sender<Value>,
    summary: &session::SessionSummary,
) {
    let Ok(session) = serde_json::to_value(summary) else {
        return;
    };
    let _ = event_tx.send(json!({
        "requestId": 0,
        "type": "session-created",
        "session": session,
    }));
}

/// The lifecycle fields shared by the pushed event and the reconciliation
/// response, borrowed from whichever of the two mesh shapes carries them.
///
/// One place builds them for both, so the event a client applies optimistically
/// and the snapshot it rebuilds from can never disagree about a field.
struct LifecycleFields<'a> {
    lifecycle_seq: u64,
    device_id: &'a str,
    device_name: &'a str,
    state: mesh::RemoteLifecycleState,
    reason: Option<mesh::RemoteEndedReason>,
    exit: Option<mesh::RemoteExitInfo>,
    attempt: u32,
    next_retry_ms: Option<u64>,
    last_contact_ms: Option<u64>,
}

impl<'a> From<&'a mesh::RemoteLifecycleChanged> for LifecycleFields<'a> {
    fn from(changed: &'a mesh::RemoteLifecycleChanged) -> Self {
        Self {
            lifecycle_seq: changed.lifecycle_seq,
            device_id: &changed.device_id,
            device_name: &changed.device_name,
            state: changed.state,
            reason: changed.reason,
            exit: changed.exit,
            attempt: changed.attempt,
            next_retry_ms: changed.next_retry_ms,
            last_contact_ms: changed.last_contact_ms,
        }
    }
}

impl<'a> From<&'a mesh::RemoteSessionLifecycle> for LifecycleFields<'a> {
    fn from(lifecycle: &'a mesh::RemoteSessionLifecycle) -> Self {
        Self {
            lifecycle_seq: lifecycle.lifecycle_seq,
            device_id: &lifecycle.device_id,
            device_name: &lifecycle.device_name,
            state: lifecycle.state,
            reason: lifecycle.reason,
            exit: lifecycle.exit,
            attempt: lifecycle.attempt,
            next_retry_ms: lifecycle.next_retry_ms,
            last_contact_ms: lifecycle.last_contact_ms,
        }
    }
}

/// One remote session's lifecycle, as a pushed event.
///
/// `reason`, `exit`, `nextRetryMs` and `lastContactMs` go out as JSON `null`
/// when the daemon has no value. Phase 1 runs no reconnect engine, so most of
/// them are always absent here — and a zero would read as evidence the viewer
/// never gathered.
fn remote_session_state_changed_event(session_id: &str, fields: LifecycleFields<'_>) -> Value {
    json!({
        "requestId": 0,
        "type": "remote-session-state-changed",
        "sessionId": session_id,
        "lifecycleSeq": fields.lifecycle_seq,
        "deviceId": fields.device_id,
        "deviceName": fields.device_name,
        "state": fields.state.as_str(),
        "reason": fields.reason.map(mesh::RemoteEndedReason::as_str),
        "exit": fields.exit,
        "attempt": fields.attempt,
        "nextRetryMs": fields.next_retry_ms,
        "lastContactMs": fields.last_contact_ms,
    })
}

/// One view's readiness, as a pushed event.
///
/// `attachmentEpoch` and `readWrite` are null unless the view is attached:
/// there is no authoritative epoch or access level without a live attachment,
/// and inventing either is the stale-epoch bug this schema exists to prevent.
fn view_state_changed_event(changed: &mesh::RemoteViewStateChanged) -> Value {
    json!({
        "requestId": 0,
        "type": "view-state-changed",
        "sessionId": changed.session_id,
        "viewId": changed.local_view_id,
        "viewStateSeq": changed.view_state_seq,
        "viewState": changed.view_state.as_str(),
        "attachmentEpoch": changed.attachment_epoch,
        "readWrite": changed.read_write,
        "error": changed.error,
        "retryable": changed.retryable,
    })
}

/// A remote session's controller, as a pushed event.
///
/// `controlRevision` is 0 — the documented "legacy, unknown" sentinel, since
/// 1.4 hosts carry no revisions on the wire and revisioned authorities start
/// at 1. Clients treat control state from a revision-0 host as advisory and
/// never compare-and-swap against it.
///
/// **This is a translation boundary, not a relay.** The tunnel has a control
/// state message of its own and it is a different shape: it carries no session
/// id, and its controller is the *wire* view id, which under rotation looks
/// like `h:…#g3` and can never equal a local one. Forwarding a tunnel frame
/// verbatim would fail the client's validator on the missing `sessionId` — and
/// an unrecognized event destroys the client's socket rather than being
/// skipped — while a wire id that did decode would read to the reclaim funnel
/// as "another pane holds control", silently ending reclaim forever. Everything
/// emitted here speaks local ids and the local schema. Do not unify the two.
fn control_state_event(state: &mesh::RemoteControlState) -> Value {
    json!({
        "requestId": 0,
        "type": "control-state",
        "sessionId": state.session_id,
        "controller": state.controller.as_ref().map(|controller| json!({
            "viewId": controller.view_id,
            "controlEpoch": controller.control_epoch,
        })),
        "controlRevision": state.control_revision,
        "cols": state.cols,
        "rows": state.rows,
        "layoutEpoch": state.layout_epoch,
    })
}

/// "This host tells us nothing about control revisions." Revisioned
/// authorities start at 1, so 0 can never collide with a real one.
const LEGACY_CONTROL_REVISION: u64 = 0;

struct TaskGuard(JoinHandle<()>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    request_id: u64,
    #[serde(flatten)]
    command: Command,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SessionOwnerTransfer {
    session_id: String,
    owner_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameSubscription {
    #[serde(default)]
    request_id: u64,
    session_handles: Vec<String>,
}

#[derive(Default)]
struct OwnerTombstones {
    recent_owners: HashSet<String>,
    order: VecDeque<String>,
    // The archive is monotonic: it can reject a never-seen owner on a rare
    // false positive, but it never forgets and reopens an owner that was closed.
    archived: Option<Box<[u64]>>,
}

impl OwnerTombstones {
    fn contains(&self, owner_id: &str) -> bool {
        self.recent_owners.contains(owner_id) || self.archived_contains(owner_id)
    }

    fn insert(&mut self, owner_id: String) {
        if self.contains(&owner_id) {
            return;
        }
        if !self.recent_owners.insert(owner_id.clone()) {
            return;
        }
        self.order.push_back(owner_id);
        while self.recent_owners.len() > MAX_CLOSED_OWNER_TOMBSTONES {
            if let Some(expired) = self.order.pop_front() {
                self.recent_owners.remove(&expired);
                self.archive(&expired);
            }
        }
    }

    fn archive(&mut self, owner_id: &str) {
        let archived = self.archived.get_or_insert_with(|| {
            vec![0; CLOSED_OWNER_BLOOM_BITS / u64::BITS as usize].into_boxed_slice()
        });
        for index in owner_bloom_indexes(owner_id) {
            archived[index / u64::BITS as usize] |= 1_u64 << (index % u64::BITS as usize);
        }
    }

    fn archived_contains(&self, owner_id: &str) -> bool {
        self.archived.as_ref().is_some_and(|archived| {
            owner_bloom_indexes(owner_id).into_iter().all(|index| {
                archived[index / u64::BITS as usize] & (1_u64 << (index % u64::BITS as usize)) != 0
            })
        })
    }
}

#[derive(Clone)]
struct AttachedViewOwner {
    client_id: String,
    owner_id: String,
}

/// Application ownership evidence attached to live renderer views.
///
/// This is deliberately service-wide rather than connection-local: an owner
/// is closed from the main-process automation connection, while the surviving
/// pane that proves a transfer belongs to a renderer connection.
#[derive(Default)]
struct ViewOwners {
    by_view: HashMap<(String, String), AttachedViewOwner>,
}

impl ViewOwners {
    fn register(&mut self, session_id: &str, view_id: &str, client_id: &str, owner_id: &str) {
        self.by_view.insert(
            (session_id.to_owned(), view_id.to_owned()),
            AttachedViewOwner {
                client_id: client_id.to_owned(),
                owner_id: owner_id.to_owned(),
            },
        );
    }

    fn unregister(&mut self, session_id: &str, view_id: &str, client_id: &str) {
        let key = (session_id.to_owned(), view_id.to_owned());
        if self
            .by_view
            .get(&key)
            .is_some_and(|owner| owner.client_id == client_id)
        {
            self.by_view.remove(&key);
        }
    }

    fn remove_session(&mut self, session_id: &str) {
        self.by_view
            .retain(|(candidate_session_id, _), _| candidate_session_id != session_id);
    }

    fn remove_owner(&mut self, owner_id: &str) {
        self.by_view
            .retain(|_, candidate| candidate.owner_id != owner_id);
    }

    fn transfer_candidates(
        &self,
        closing_owner_id: &str,
        closed_owners: &OwnerTombstones,
    ) -> HashMap<String, String> {
        let mut candidates = HashMap::<String, String>::new();
        for ((session_id, _), view) in &self.by_view {
            if view.owner_id == closing_owner_id || closed_owners.contains(&view.owner_id) {
                continue;
            }
            candidates
                .entry(session_id.clone())
                .and_modify(|current| {
                    if view.owner_id.as_str() < current.as_str() {
                        current.clone_from(&view.owner_id);
                    }
                })
                .or_insert_with(|| view.owner_id.clone());
        }
        candidates
    }
}

fn owner_bloom_indexes(owner_id: &str) -> [usize; CLOSED_OWNER_BLOOM_HASHES as usize] {
    let first = owner_hash(owner_id.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let second = owner_hash(owner_id.as_bytes(), 0x9e37_79b9_7f4a_7c15) | 1;
    std::array::from_fn(|index| {
        first
            .wrapping_add((index as u64).wrapping_mul(second))
            .wrapping_add((index as u64).wrapping_mul(index as u64)) as usize
            & (CLOSED_OWNER_BLOOM_BITS - 1)
    })
}

fn owner_hash(bytes: &[u8], seed: u64) -> u64 {
    bytes.iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Hello {
        protocol_major: u16,
        protocol_minor: u16,
        client_build: String,
    },
    CreateSession {
        options: SpawnOptions,
    },
    GetConfig,
    ReloadConfig,
    GetConfigDocument,
    ValidateConfigDocument {
        contents: String,
    },
    ReplaceConfigDocument {
        expected_revision: String,
        contents: String,
    },
    ListSessions,
    ListRemoteHosts,
    ListRemoteSessions {
        device_id: String,
    },
    OpenRemoteSession {
        device_id: String,
        remote_session_id: String,
        cols: u64,
        rows: u64,
        owner_id: Option<String>,
    },
    GetRemoteSessionState {
        session_id: String,
    },
    ReconnectRemoteSession {
        session_id: String,
    },
    RetryRemoteView {
        session_id: String,
        view_id: String,
    },
    GetSession {
        session_id: String,
    },
    RefreshSession {
        session_id: String,
    },
    AttachSession {
        session_id: String,
        view_id: String,
        owner_id: Option<String>,
    },
    DetachSession {
        session_id: String,
        view_id: String,
    },
    SendText {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    },
    Paste {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    },
    SendKey {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        event: KeyInput,
    },
    SendMouse {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        event: MouseInput,
    },
    Scroll {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        rows: i64,
    },
    ScrollTo {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        row: u64,
    },
    Focus {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        focused: bool,
    },
    FocusAndResize {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        cols: u64,
        rows: u64,
        /// The controller revision this claim is conditional on (§4.2.3).
        ///
        /// Absent is the legacy unconditional claim, which is all a pre-minor-6
        /// host understands and all a revisionless authority can offer. Present
        /// means "claim only if nobody has claimed or cleared since I looked" —
        /// and a daemon that cannot enforce that says so rather than claiming
        /// anyway. Revisioned authorities start at 1, so the 0 sentinel is
        /// never a value a client may condition on.
        #[serde(default)]
        expected_control_revision: Option<u64>,
    },
    Resize {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u64,
        rows: u64,
    },
    SetColors {
        session_id: String,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    },
    SelectionText {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        start_column: u64,
        start_row: u64,
        end_column: u64,
        end_row: u64,
        select_all: bool,
    },
    Interrupt {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
    },
    GetAutomationState {
        session_id: String,
    },
    AutomationInput {
        session_id: String,
        expected_human_input_epoch: u64,
        operation: AutomationInputOperation,
    },
    SetPersistence {
        session_id: String,
        persistence: Persistence,
    },
    Terminate {
        session_id: String,
        #[serde(default)]
        source: TerminationSource,
    },
    CloseSessionOwner {
        owner_id: String,
        #[serde(default)]
        transfers: Vec<SessionOwnerTransfer>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope {
    request_id: u64,
    #[serde(flatten)]
    body: ResponseBody,
}

#[derive(serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ResponseBody {
    Hello {
        protocol_major: u16,
        protocol_minor: u16,
        server_build: String,
        config_revision: String,
    },
    Config {
        config: ConfigSnapshot,
    },
    ConfigDocument {
        document: ConfigDocument,
    },
    ConfigDocumentValidation {
        document_revision: String,
        config: ConfigSnapshot,
    },
    ConfigDocumentUpdated {
        document: ConfigDocument,
        config: ConfigSnapshot,
    },
    ConfigDocumentConflict {
        document: ConfigDocument,
    },
    SessionCreated {
        session: session::SessionSummary,
    },
    Session {
        session: session::SessionSummary,
    },
    Sessions {
        sessions: Vec<session::SessionSummary>,
    },
    RemoteHosts {
        hosts: Vec<mesh::RemoteHostSummary>,
    },
    RemoteSessions {
        device_id: String,
        sessions: Vec<tunnel_protocol::SharedSessionSummary>,
    },
    ViewAttached {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        read_write: bool,
        /// Places this response inside the same per-view ordering fence as
        /// `view-state-changed`, so a response racing a newer event cannot
        /// regress the view. Omitted for local sessions, which have no
        /// per-view sequence and whose clients apply the response directly.
        #[serde(skip_serializing_if = "Option::is_none")]
        view_state_seq: Option<u64>,
    },
    RemoteSessionState {
        lifecycle_seq: u64,
        device_id: String,
        device_name: String,
        state: mesh::RemoteLifecycleState,
        reason: Option<mesh::RemoteEndedReason>,
        exit: Option<mesh::RemoteExitInfo>,
        attempt: u32,
        next_retry_ms: Option<u64>,
        last_contact_ms: Option<u64>,
        controller: Option<RemoteControllerInfo>,
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
        views: Vec<ViewStateRecord>,
    },
    ViewState {
        session_id: String,
        view_id: String,
        view_state_seq: u64,
        view_state: mesh::RemoteViewState,
        attachment_epoch: Option<u64>,
        read_write: Option<bool>,
        error: Option<String>,
        retryable: Option<bool>,
    },
    ControlClaimed {
        session_id: String,
        controller_view_id: String,
        control_epoch: u64,
        /// The revision this claim produced, for the client to condition its
        /// next claim on. `0` is the legacy/unknown sentinel: a source with no
        /// revisions of its own, never a value to compare against.
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    /// A conditional claim that lost: somebody claimed or cleared control
    /// between the revision the caller observed and this attempt.
    ///
    /// Carries the state that beat it, because §4.2.3 makes the response
    /// asymmetric — a rejection naming another controller ends the reclaim,
    /// while one showing no controller at a newer revision may be retried
    /// against that revision. `control-claimed` structurally cannot say "no
    /// controller", which is exactly why this is its own shape.
    ///
    /// Declared with the rest of minor 13 and produced once the claim path
    /// reaches an authority that keeps revisions; the shape has to exist first,
    /// because clients are written against the advertised minor, not against
    /// which parts of it have behaviour yet. Delete this allow when the CAS
    /// path constructs it.
    #[allow(dead_code, reason = "minor-13 surface; constructed when CAS lands")]
    ControlRejected {
        session_id: String,
        controller: Option<RemoteControllerInfo>,
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    AutomationState {
        session_id: String,
        human_input_epoch: u64,
    },
    AutomationInputResult {
        session_id: String,
        accepted: bool,
        human_input_epoch: u64,
        input_sequence: Option<u64>,
        reason: Option<&'static str>,
    },
    SelectionText {
        text: String,
        /// How much of the session the answer could reach. A frozen replica
        /// holds only what was on screen, and a UI that says "copied" without
        /// saying that would be claiming scrollback it never had. Clients
        /// treat this as an open hint: an unrecognized scope is ignored, and
        /// its absence is a daemon that always answered from the host.
        scope: &'static str,
    },
    Ok,
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        os_error: Option<i32>,
    },
}

/// What a claim resolved to, before it becomes a response.
///
/// Local sessions and remote ones answer through different authorities with
/// different types, and both have to arrive at the same two wire shapes. Naming
/// the join here is what stops one branch from quietly gaining a field the
/// other never sends.
enum ClaimOutcome {
    Claimed {
        controller_view_id: String,
        control_epoch: u64,
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    Rejected {
        controller: Option<RemoteControllerInfo>,
        control_revision: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
}

impl ClaimOutcome {
    fn into_response(self, session_id: String) -> ResponseBody {
        match self {
            Self::Claimed {
                controller_view_id,
                control_epoch,
                control_revision,
                cols,
                rows,
                layout_epoch,
            } => ResponseBody::ControlClaimed {
                session_id,
                controller_view_id,
                control_epoch,
                control_revision,
                cols,
                rows,
                layout_epoch,
            },
            Self::Rejected {
                controller,
                control_revision,
                cols,
                rows,
                layout_epoch,
            } => ResponseBody::ControlRejected {
                session_id,
                controller,
                control_revision,
                cols,
                rows,
                layout_epoch,
            },
        }
    }
}

/// Selection answered from the host, which can reach what has scrolled away.
const SELECTION_SCOPE_SCROLLBACK: &str = "scrollback";
/// Selection answered from a frozen replica's retained screen.
const SELECTION_SCOPE_VIEWPORT: &str = "viewport";

/// Who holds terminal control, on the wire.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControllerInfo {
    view_id: String,
    control_epoch: u64,
}

/// One view's readiness inside a reconciliation response.
///
/// The nullable fields are nullable for the same reason as in the event: no
/// live attachment means no authoritative epoch or access level to report.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewStateRecord {
    view_id: String,
    view_state_seq: u64,
    view_state: mesh::RemoteViewState,
    attachment_epoch: Option<u64>,
    read_write: Option<bool>,
    error: Option<String>,
    retryable: Option<bool>,
}

impl From<&mesh::RemoteViewRecord> for ViewStateRecord {
    fn from(record: &mesh::RemoteViewRecord) -> Self {
        Self {
            view_id: record.local_view_id.clone(),
            view_state_seq: record.view_state_seq,
            view_state: record.view_state,
            attachment_epoch: record.attachment_epoch,
            read_write: record.read_write,
            error: record.error.clone(),
            retryable: record.retryable,
        }
    }
}

pub type Registry = Arc<RwLock<HashMap<String, Arc<Session>>>>;

/// A local session's lifecycle as observed by an embedding host.
///
/// Registry membership and process lifetime are deliberately separate: an
/// explicitly closed session can be removed while its process ladder is still
/// running, while a `keep-until-explicit-close` session remains registered
/// after it exits. Consumers must therefore handle `Removed` and `Exited` as
/// independent facts rather than assuming one fixed ordering between them.
#[derive(Clone)]
pub enum SessionLifecycleEvent {
    Created {
        session: Arc<Session>,
    },
    Exited {
        session_id: String,
        exit: session::SessionExit,
    },
    Removed {
        session_id: String,
    },
}

/// What the host answers when a resuming viewer asks after a session id.
///
/// Only the verdict crosses the seam — live, ended with a cause, or unknown.
/// Handing the mesh the tombstone store itself would export bookkeeping it has
/// no business writing to, and `unknown` is load-bearing: an expired or
/// never-written record must never be upgraded into a specific ending.
struct RegistrySessionStatus {
    registry: Registry,
    tombstones: Arc<session::SessionTombstones>,
}

impl mesh::SessionStatusSource for RegistrySessionStatus {
    fn session_status(&self, session_id: &str) -> session::SessionStatus {
        self.tombstones.session_status(&self.registry, session_id)
    }
}

#[derive(Clone)]
struct ControlContext {
    registry: Registry,
    frames: FrameHub,
    event_tx: broadcast::Sender<Value>,
    lifecycle_tx: broadcast::Sender<SessionLifecycleEvent>,
    text_engine: Arc<Mutex<TextEngine>>,
    mesh_runtime: Arc<dyn mesh::RemoteTerminalRuntime>,
    /// Why each session left, for the viewers that were not watching when it
    /// did. Every removal goes through this.
    tombstones: Arc<session::SessionTombstones>,
    /// The drain's one chance to tell viewers this host is leaving.
    shutdown_announcer: mesh::HostShutdownAnnouncer,
    reconnects: Arc<Mutex<HashSet<String>>>,
    closed_owners: Arc<tokio::sync::Mutex<OwnerTombstones>>,
    view_owners: Arc<Mutex<ViewOwners>>,
    private_env_prefixes: Arc<[String]>,
    config: ConfigManager,
    config_update_lock: Arc<Mutex<()>>,
    host_config_tx: tokio::sync::watch::Sender<Arc<TerminalPresentationConfig>>,
    shutdown: Arc<ShutdownState>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServiceSessionsStatus {
    Starting,
    Ready,
    Stopped,
}

struct ServiceSessionsShared {
    status: watch::Sender<ServiceSessionsStatus>,
    context: Mutex<Option<Arc<ControlContext>>>,
}

impl ServiceSessionsShared {
    fn new() -> Arc<Self> {
        let (status, _) = watch::channel(ServiceSessionsStatus::Starting);
        Arc::new(Self {
            status,
            context: Mutex::new(None),
        })
    }

    fn install(&self, context: Arc<ControlContext>) {
        *self.context.lock().unwrap() = Some(context);
        self.status.send_replace(ServiceSessionsStatus::Ready);
    }

    fn stop(&self) {
        self.status.send_replace(ServiceSessionsStatus::Stopped);
    }

    fn is_ready(&self) -> bool {
        *self.status.borrow() == ServiceSessionsStatus::Ready
    }
}

struct ServiceSessionsRunGuard(Arc<ServiceSessionsShared>);

impl Drop for ServiceSessionsRunGuard {
    fn drop(&mut self) {
        self.0.stop();
    }
}

/// Ready, cloneable in-process access to the exact local session set served by
/// [`TerminalService`].
///
/// This is intentionally narrower than [`Registry`]: callers can inspect
/// sessions but cannot insert or remove entries behind the service's shutdown,
/// tombstone, ownership, configuration, and lifecycle policy.
#[derive(Clone)]
pub struct ServiceSessions {
    context: Arc<ControlContext>,
    shared: Arc<ServiceSessionsShared>,
}

impl ServiceSessions {
    /// Look up a currently registered local session by its stable session id.
    pub fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.context.registry.read().unwrap().get(id).cloned()
    }

    /// Snapshot the currently registered local sessions in stable id order.
    ///
    /// An `Arc<Session>` is a capability, not proof of continuing registry
    /// membership; a returned session can be removed immediately afterward.
    pub fn sessions(&self) -> Vec<Arc<Session>> {
        let mut sessions = self
            .context
            .registry
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.id());
        sessions
    }

    /// The service-wide frame hub used by every local session and by the frame
    /// socket. Packets carry `session_handle`; consumers select the sessions
    /// they need while retaining the same global ordinal stream as the socket.
    pub fn frames(&self) -> FrameHub {
        self.context.frames.clone()
    }

    /// Return the service-wide hub only when `id` is currently registered.
    /// This convenience shape lets per-session source traits preserve their
    /// `Option` contract without pretending the service owns one hub per
    /// session.
    pub fn frames_for(&self, id: &str) -> Option<FrameHub> {
        self.context
            .registry
            .read()
            .unwrap()
            .contains_key(id)
            .then(|| self.context.frames.clone())
    }

    /// Spawn through the service's complete policy path.
    ///
    /// Private-environment stripping, live configuration, admission/shutdown
    /// fencing, tombstones, registry insertion, and lifecycle announcements are
    /// identical to a `create-session` received over the control socket.
    pub async fn spawn(&self, options: SpawnOptions) -> Result<Arc<Session>> {
        if !self.shared.is_ready() {
            bail!("terminal service is no longer serving");
        }
        create_local_session(&self.context, options).await
    }

    /// Subscribe to typed local lifecycle events.
    ///
    /// The channel is bounded and may report `Lagged`; callers should then
    /// reconcile with [`ServiceSessions::sessions`].
    pub fn subscribe_lifecycle(&self) -> broadcast::Receiver<SessionLifecycleEvent> {
        self.context.lifecycle_tx.subscribe()
    }

    /// Subscribe first, then snapshot the registry, so no birth or removal can
    /// fall between the two operations. An event may also describe a session in
    /// the snapshot; consumers should reconcile idempotently by session id.
    pub fn snapshot_and_subscribe(
        &self,
    ) -> (
        Vec<Arc<Session>>,
        broadcast::Receiver<SessionLifecycleEvent>,
    ) {
        let events = self.subscribe_lifecycle();
        (self.sessions(), events)
    }
}

/// Sessions that have been told to end but are no longer registry-resident.
///
/// The invariant this exists for: **a session whose ladder has started and
/// which is not in the registry must be here.** Termination removes the
/// registry entry immediately while the child can still take seconds to die,
/// so without this a drain snapshot would miss exactly the sessions that are
/// mid-death — resolve, let the host exit, and orphan them mid-grace.
/// Held weakly on purpose. A strong reference would keep every closed
/// session's PTY master, writer, shutdown pipe and scrollback alive until the
/// next shutdown — which for a long-running host means every closed tab leaks
/// a terminal. While a session is genuinely dying its reader and escalator
/// threads each hold a strong reference, so upgrading here always succeeds for
/// anything that still matters.
type DyingSessions = Mutex<HashMap<String, Weak<Session>>>;

/// Everything a shutdown needs to stop admissions and find what to drain.
#[derive(Default)]
struct ShutdownState {
    /// Set once, before the drain snapshots. Never cleared: a service that has
    /// begun shutting down does not reopen.
    admissions_closed: AtomicBool,
    /// Creates past the entry check but not yet resolved. A create parked in
    /// `spawn_blocking` is invisible to every snapshot, so the drain cannot
    /// conclude while this is non-zero.
    creates_in_flight: AtomicUsize,
    /// Published before `admissions_closed` flips, so a create refused inside
    /// the barrier can bound its own doomed session by the same deadline.
    deadline: Mutex<Option<Instant>>,
    dying: DyingSessions,
}

impl ShutdownState {
    /// Deposit into the dying set, then start the ladder — never the reverse,
    /// or the session is briefly terminating and untracked.
    fn terminate_tracked(
        &self,
        session: &Arc<Session>,
        source: TerminationSource,
        deadline: Option<Instant>,
    ) -> Result<()> {
        // Resolved before the lock: taking `dying` and then a session lock is
        // the only nesting here, and not needing it keeps the set's lock a
        // leaf.
        let session_id = session.id();
        {
            let mut dying = self.dying.lock().unwrap();
            // Prune here as well as in the drain: without a shutdown to force
            // it, nothing else would ever clear entries whose sessions have
            // finished, and the map would grow for the life of the host.
            dying.retain(|_, session| {
                session
                    .upgrade()
                    .is_some_and(|session| !session.has_concluded())
            });
            dying.insert(session_id, Arc::downgrade(session));
        }
        match deadline {
            Some(deadline) => session.terminate_within(source, deadline),
            None => session.terminate(source),
        }
    }

    /// Drop entries that have finished concluding. Lazy on purpose: a task per
    /// dying session would hold an `Arc` each and could go unscheduled during
    /// the very shutdown this set serves.
    fn prune_dying(&self) -> Vec<Arc<Session>> {
        let mut dying = self.dying.lock().unwrap();
        let mut alive = Vec::new();
        dying.retain(|_, session| match session.upgrade() {
            Some(session) if !session.has_concluded() => {
                alive.push(session);
                true
            }
            _ => false,
        });
        alive
    }

    fn admissions_closed(&self) -> bool {
        self.admissions_closed.load(atomic::Ordering::SeqCst)
    }
}

/// Marks a create as past the entry check and not yet resolved.
///
/// Released on drop, so every exit path — refusal, spawn failure, success —
/// decrements exactly once, and always after the session it produced has been
/// made visible in the registry or the dying set.
struct CreateInFlight<'a>(&'a ShutdownState);

impl<'a> CreateInFlight<'a> {
    fn enter(shutdown: &'a ShutdownState) -> Self {
        shutdown
            .creates_in_flight
            .fetch_add(1, atomic::Ordering::SeqCst);
        Self(shutdown)
    }
}

impl Drop for CreateInFlight<'_> {
    fn drop(&mut self) {
        self.0
            .creates_in_flight
            .fetch_sub(1, atomic::Ordering::SeqCst);
    }
}

/// Local IPC endpoints and bearer token owned by the embedding application.
///
/// An endpoint is a Unix-domain socket path on Unix hosts and a named pipe
/// name such as `\\.\pipe\ghosttea-<instance>-control` on Windows.
pub struct TerminalServiceConfig {
    pub control_socket: String,
    pub frame_socket: String,
    pub auth_token: String,
}

/// Pre-bound local IPC listeners supplied by an embedding application.
///
/// Constructing these outside [`TerminalService`] lets a host own runtime
/// directory creation, endpoint replacement, permissions, and startup order.
pub struct TerminalServiceListeners {
    control: ipc::Listener,
    frames: ipc::Listener,
}

impl TerminalServiceListeners {
    pub fn new(control: ipc::Listener, frames: ipc::Listener) -> Self {
        Self { control, frames }
    }
}

/// What the service resolved on its way to serving, handed to the callback
/// installed with [`TerminalService::with_ready`].
///
/// The font values are the ones a host banner would report; they are delivered
/// as values rather than as a rendered string so the host owns its own
/// formatting.
#[derive(Clone, Debug)]
pub struct ReadyInfo {
    pub primary_family: String,
    pub font_mode: FontMode,
}

/// A terminal session service that can run locally or expose sessions through
/// an injected remote transport.
pub struct TerminalService {
    config: TerminalServiceConfig,
    config_load_options: ConfigLoadOptions,
    mesh: Option<Box<dyn mesh::TerminalMesh>>,
    text_engine: Option<TextEngine>,
    private_env_prefixes: Vec<String>,
    ready: Option<Box<dyn FnOnce(ReadyInfo) + Send>>,
}

impl TerminalService {
    pub fn new(config: TerminalServiceConfig) -> Self {
        Self {
            config,
            config_load_options: ConfigLoadOptions::default(),
            mesh: None,
            text_engine: None,
            private_env_prefixes: Vec::new(),
            ready: None,
        }
    }

    /// Load an application-owned Ghostty-syntax overlay after Ghostty's
    /// standard user configuration files.
    pub fn with_config_path(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.config_load_options.explicit_path = Some(path.into());
        self
    }

    /// Replace configuration source discovery. Embedders and tests can use
    /// this to opt out of standard files or provide isolated roots.
    pub fn with_config_load_options(mut self, options: ConfigLoadOptions) -> Self {
        self.config_load_options = options;
        self
    }

    /// Observe the moment the service has resolved its text engine and is
    /// about to accept connections.
    ///
    /// The library writes nothing to stdout: a host process may be speaking
    /// its own protocol there. A host that wants a readiness banner prints it
    /// from here, which also lets it choose the wording and the stream.
    pub fn with_ready<F>(mut self, ready: F) -> Self
    where
        F: FnOnce(ReadyInfo) + Send + 'static,
    {
        self.ready = Some(Box::new(ready));
        self
    }

    /// Strip additional host-private prefixes from inherited PTY
    /// environments. Explicit clean variables and inherited-mode overrides
    /// remain caller-owned and may intentionally reintroduce a value.
    pub fn with_private_env_prefixes<I, S>(mut self, prefixes: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for prefix in prefixes {
            let prefix = prefix.into();
            if prefix.is_empty() {
                bail!("private environment prefixes must not be empty");
            }
            if !self.private_env_prefixes.contains(&prefix) {
                self.private_env_prefixes.push(prefix);
            }
        }
        Ok(self)
    }

    /// Use host-provided font bytes and metrics instead of system discovery.
    pub fn with_text_engine(mut self, text_engine: TextEngine) -> Self {
        self.text_engine = Some(text_engine);
        self
    }

    /// Attach a terminal-scoped adapter around an already-running Truffle
    /// node. The terminal service never stops the underlying node.
    pub fn with_terminal_mesh<M>(mut self, mesh: M) -> Self
    where
        M: mesh::TerminalMesh + 'static,
    {
        self.mesh = Some(Box::new(mesh));
        self
    }

    /// Bind the configured endpoints using Ghosttea's convenience stale-endpoint
    /// replacement policy.
    pub fn bind(&self) -> Result<TerminalServiceListeners> {
        ipc::remove_stale_endpoint(&self.config.control_socket)?;
        ipc::remove_stale_endpoint(&self.config.frame_socket)?;
        Ok(TerminalServiceListeners::new(
            ipc::Listener::bind(&self.config.control_socket)?,
            ipc::Listener::bind(&self.config.frame_socket)?,
        ))
    }

    /// Bind the configured listeners and serve until either listener fails.
    pub async fn run(self) -> Result<()> {
        let listeners = self.bind()?;
        self.serve(listeners).await
    }

    /// Serve authenticated control and frame traffic on host-owned listeners.
    ///
    /// Returns only when a listener fails. A host that needs to stop the
    /// service deliberately wants [`TerminalService::serve_managed`].
    pub async fn serve(self, listeners: TerminalServiceListeners) -> Result<()> {
        let (handle, serving) = self.serve_managed(listeners);
        // Held for the lifetime of the future on purpose: while a handle
        // exists the coordinator keeps waiting for a shutdown that, here,
        // nobody can ask for — which is exactly this function's contract.
        let _handle = handle;
        serving.await
    }

    /// Serve, and hand back a handle that can stop the service.
    ///
    /// The future resolves on listener failure as [`TerminalService::serve`]
    /// does, and additionally on a completed
    /// [`ServiceHandle::shutdown`] — the first non-failure way serving ends.
    pub fn serve_managed(
        self,
        listeners: TerminalServiceListeners,
    ) -> (ServiceHandle, impl Future<Output = Result<()>>) {
        let (requests, shutdown_rx) = tokio::sync::mpsc::channel(1);
        let shutdown: Arc<ShutdownState> = Arc::default();
        let sessions = ServiceSessionsShared::new();
        let serving_sessions = Arc::clone(&sessions);
        let serving_shutdown = Arc::clone(&shutdown);
        // Constructed outside the async body so dropping an unpolled serving
        // future still wakes `ServiceHandle::sessions` with `Stopped`.
        let run_guard = ServiceSessionsRunGuard(Arc::clone(&serving_sessions));
        let serving = async move {
            let _run_guard = run_guard;
            self.serve_until_shutdown(listeners, shutdown_rx, serving_shutdown, serving_sessions)
                .await
        };
        (
            ServiceHandle {
                requests,
                shutdown: Arc::clone(&shutdown),
                sessions,
            },
            serving,
        )
    }

    async fn serve_until_shutdown(
        self,
        listeners: TerminalServiceListeners,
        mut shutdown_rx: tokio::sync::mpsc::Receiver<ShutdownRequest>,
        shutdown: Arc<ShutdownState>,
        service_sessions: Arc<ServiceSessionsShared>,
    ) -> Result<()> {
        let configured_text_engine = self.text_engine;
        let config = ConfigManager::load(self.config_load_options);
        let initial_presentation = Arc::new(config.snapshot().terminal_presentation());
        let (host_config_tx, host_config_rx) = tokio::sync::watch::channel(initial_presentation);
        let ready = self.ready;
        let auth_token = self.config.auth_token;
        let TerminalServiceListeners { control, frames } = listeners;
        let frame_hub = FrameHub::new(32);
        let (event_tx, _) = broadcast::channel::<Value>(EVENT_CHANNEL_CAPACITY);
        let (lifecycle_tx, _) = broadcast::channel::<SessionLifecycleEvent>(EVENT_CHANNEL_CAPACITY);
        let registry: Registry = Arc::new(RwLock::new(HashMap::new()));
        let activity_registry = Arc::clone(&registry);
        let _activity_sampler_task = TaskGuard(tokio::spawn(async move {
            let mut interval = tokio::time::interval(ACTIVITY_SAMPLE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let sessions = activity_registry
                    .read()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                for session in sessions {
                    let _ = session.sample_activity();
                }
            }
        }));
        let mesh_runtime = self
            .mesh
            .as_ref()
            .map(|mesh| mesh.runtime())
            .unwrap_or_else(|| Arc::new(mesh::NoRemoteRuntime));
        let mut remote_control_states = mesh_runtime.subscribe_control_state();
        let mut remote_activities = mesh_runtime.subscribe_activity();
        let mut remote_lifecycles = mesh_runtime.subscribe_lifecycle();
        let mut remote_view_states = mesh_runtime.subscribe_view_state();
        let remote_events = event_tx.clone();
        // Every controller change the mesh sees becomes one local event —
        // including the rejections it announces, which is what a client's
        // reclaim rule fires on. Relaying all of them rather than filtering to
        // "changed" is deliberate: a duplicate at an unchanged revision costs a
        // client nothing (its funnel is idempotent by revision), while a
        // dropped announcement leaves a rejected claim waiting on a trigger
        // that never comes.
        let _remote_control_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_control_states.recv().await {
                    Ok(state) => {
                        // One event on the bus, downgraded per connection.
                        // Sending both spellings here would deliver two to a
                        // client that understands the newer one.
                        let _ = remote_events.send(control_state_event(&state));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let remote_lifecycle_events = event_tx.clone();
        let _remote_lifecycle_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_lifecycles.recv().await {
                    Ok(changed) => {
                        let _ = remote_lifecycle_events.send(remote_session_state_changed_event(
                            &changed.session_id,
                            LifecycleFields::from(&changed),
                        ));
                    }
                    // A dropped transition is recoverable: the connection loop
                    // reports the gap and clients reconcile every open remote
                    // session from `get-remote-session-state`.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let remote_view_state_events = event_tx.clone();
        let _remote_view_state_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_view_states.recv().await {
                    Ok(changed) => {
                        let _ = remote_view_state_events.send(view_state_changed_event(&changed));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let remote_activity_events = event_tx.clone();
        let _remote_activity_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_activities.recv().await {
                    Ok(changed) => {
                        let _ = remote_activity_events.send(json!({
                            "requestId": 0,
                            "type": "session-activity-changed",
                            "sessionId": changed.session_id,
                            "activity": changed.activity,
                        }));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let text_engine = Arc::new(Mutex::new(match configured_text_engine {
            Some(text_engine) => text_engine,
            None => TextEngine::discover().context("system font discovery failed")?,
        }));

        if let Some(ready) = ready {
            // Read the values, release the lock, then hand them over: the
            // callback is host code and must not run under a service mutex.
            let info = {
                let engine = text_engine.lock().unwrap();
                ReadyInfo {
                    primary_family: engine.primary_family().to_owned(),
                    font_mode: engine.font_mode(),
                }
            };
            ready(info);
        }
        let tombstones = Arc::new(session::SessionTombstones::new());
        // Taken before `serve` consumes the mesh: the drain needs a way to say
        // goodbye that outlives the value it would otherwise have to borrow.
        let shutdown_announcer = self
            .mesh
            .as_ref()
            .map(|mesh| mesh.shutdown_announcer())
            .unwrap_or_default();
        let _mesh_task = self.mesh.map(|mut mesh| {
            let mesh_registry = Arc::clone(&registry);
            mesh.set_session_status_source(Arc::new(RegistrySessionStatus {
                registry: Arc::clone(&registry),
                tombstones: Arc::clone(&tombstones),
            }));
            TaskGuard(tokio::spawn(async move {
                if let Err(error) = mesh.serve(mesh_registry, host_config_rx).await {
                    eprintln!("[terminal-mesh] stopped: {error:#}");
                }
            }))
        });
        let context = Arc::new(ControlContext {
            registry: Arc::clone(&registry),
            frames: frame_hub.clone(),
            event_tx,
            lifecycle_tx,
            text_engine,
            mesh_runtime,
            tombstones,
            shutdown_announcer,
            reconnects: Arc::default(),
            closed_owners: Arc::default(),
            view_owners: Arc::default(),
            private_env_prefixes: self.private_env_prefixes.into(),
            config,
            config_update_lock: Arc::new(Mutex::new(())),
            host_config_tx,
            shutdown: Arc::clone(&shutdown),
        });
        // Publish in-process access before either listener begins accepting, so
        // a host that awaited `ServiceHandle::sessions` cannot miss a birth.
        service_sessions.install(Arc::clone(&context));
        // Spawned rather than joined in place: the drain has to run *while*
        // both keep serving, so observers can watch `terminate`, `list-sessions`
        // and events for the whole of it. A select!-cancel shape would silence
        // exactly the connections that need to see the drain happen.
        let mut control_task = tokio::spawn(serve_control(
            control,
            auth_token.clone(),
            context.as_ref().clone(),
        ));
        let mut frame_task = tokio::spawn(serve_frames(frames, auth_token, frame_hub));
        let finish = |result: std::result::Result<Result<()>, tokio::task::JoinError>| match result
        {
            Ok(served) => served,
            Err(error) => Err(anyhow::Error::new(error)).context("terminal listener task stopped"),
        };
        let mut handles_dropped = false;
        loop {
            tokio::select! {
                served = &mut control_task => return finish(served),
                served = &mut frame_task => return finish(served),
                // Once every handle is gone `recv` is permanently ready with
                // `None`, so this arm has to leave the select rather than
                // `continue` into a loop that never awaits anything again.
                request = shutdown_rx.recv(), if !handles_dropped => {
                    let Some(request) = request else {
                        handles_dropped = true;
                        continue;
                    };
                    let report = drain(&context, request.budget).await;
                    let _ = request.reply.send(report);
                    control_task.abort();
                    frame_task.abort();
                    return Ok(());
                }
            }
        }
    }
}

/// What a drain actually managed to do.
///
/// Reported rather than summarised as success: an embedder that promised "no
/// PTY outlives the service" needs to know when that promise was kept on time,
/// kept by force, or not kept at all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Concluded within their deadline.
    pub drained: usize,
    /// Concluded, but only after the deadline forced the ladder to the end.
    pub killed: usize,
    /// Still not concluded when the budget ran out, by session id.
    pub unresponsive: Vec<String>,
    /// Creates still inside their spawn when the budget ran out. Non-zero means
    /// a PTY may have been born that this drain could not wait for.
    pub pending_creates: usize,
    pub spent: Duration,
    /// Whether connected viewers were told this host was leaving, rather than
    /// left to discover it as an outage. False means the goodbye never went
    /// out — no mesh to say it through — and a viewer will have to infer the
    /// ending from silence.
    pub announced_shutdown: bool,
}

struct ShutdownRequest {
    budget: Duration,
    reply: tokio::sync::oneshot::Sender<DrainReport>,
}

/// Asks a running service to stop admitting sessions and drain the ones it has.
#[derive(Clone)]
pub struct ServiceHandle {
    requests: tokio::sync::mpsc::Sender<ShutdownRequest>,
    shutdown: Arc<ShutdownState>,
    sessions: Arc<ServiceSessionsShared>,
}

impl ServiceHandle {
    /// Wait until the managed service has initialized its session registry,
    /// frame hub, text engine, configuration, and lifecycle bus.
    ///
    /// `serve_managed` returns an inert future; the caller must poll or spawn
    /// that future before awaiting this method. If serving stops before it
    /// becomes ready, this returns an error instead of hanging indefinitely.
    pub async fn sessions(&self) -> Result<ServiceSessions> {
        let mut status = self.sessions.status.subscribe();
        loop {
            let current = *status.borrow_and_update();
            match current {
                ServiceSessionsStatus::Starting => {
                    status
                        .changed()
                        .await
                        .context("terminal service stopped before session access became ready")?;
                }
                ServiceSessionsStatus::Ready => {
                    let context =
                        self.sessions.context.lock().unwrap().clone().context(
                            "terminal service published readiness without session access",
                        )?;
                    return Ok(ServiceSessions {
                        context,
                        shared: Arc::clone(&self.sessions),
                    });
                }
                ServiceSessionsStatus::Stopped => {
                    bail!("terminal service stopped before session access became ready");
                }
            }
        }
    }

    /// How many terminated-but-unregistered sessions are currently tracked.
    ///
    /// How many tracked sessions are still *alive* — the number that would
    /// keep a PTY open.
    ///
    /// Not the map's length: entries are pruned when something else terminates
    /// or a drain runs, so a dead entry can outlive its session for a while.
    /// What must never persist is a session the set keeps breathing, and a
    /// `Weak` that no longer upgrades cannot.
    #[cfg(test)]
    fn retained_sessions(&self) -> usize {
        self.shutdown
            .dying
            .lock()
            .unwrap()
            .values()
            .filter(|session| session.upgrade().is_some())
            .count()
    }

    /// Stop admissions, drain every local session, and resolve when they have
    /// all concluded or `budget` expires — whichever comes first.
    ///
    /// The budget bounds the whole drain: ladder phases are scaled to fit it,
    /// so a small budget compresses the graces rather than reporting healthy
    /// sessions as unresponsive. Remote sessions are out of scope; they are
    /// governed by the host that owns them.
    pub async fn shutdown(&self, budget: Duration) -> Result<DrainReport> {
        // Answer precisely rather than leaving the caller to infer it from a
        // closed channel: admissions close as the first act of a drain, so a
        // second request — concurrent or after the fact — is distinguishable
        // from a service that simply stopped.
        if self.shutdown.admissions_closed() {
            bail!("terminal service is already shutting down");
        }
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.requests
            .send(ShutdownRequest { budget, reply })
            .await
            .map_err(|_| anyhow::anyhow!("terminal service is already shutting down or stopped"))?;
        answer
            .await
            .context("terminal service stopped before reporting its drain")
    }
}

async fn read_packet<R: AsyncRead + Unpin>(stream: &mut R, limit: usize) -> Result<Vec<u8>> {
    let length = stream.read_u32_le().await? as usize;
    if length > limit {
        bail!("packet exceeds limit");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

/// How much a connection reads at once while assembling frames.
///
/// Only a buffer size: a frame larger than this is read across several passes,
/// which is precisely what the assembly above exists to survive.
const CONTROL_READ_CHUNK: usize = 16 * 1024;

/// Split one complete frame off the front of a connection's read buffer.
///
/// `Ok(None)` means the frame is still arriving and the caller should read
/// more. An error is a client announcing a frame larger than the protocol
/// allows, which ends the connection exactly as an oversized packet always
/// did.
fn take_frame(buffered: &mut Vec<u8>, limit: usize) -> Result<Option<Vec<u8>>> {
    let Some(header) = buffered.get(..4) else {
        return Ok(None);
    };
    let length = u32::from_le_bytes(header.try_into().unwrap()) as usize;
    if length > limit {
        bail!("packet exceeds limit");
    }
    if buffered.len() < 4 + length {
        return Ok(None);
    }
    let packet = buffered[4..4 + length].to_vec();
    buffered.drain(..4 + length);
    Ok(Some(packet))
}

async fn write_packet<W: AsyncWrite + Unpin>(stream: &mut W, bytes: &[u8]) -> Result<()> {
    stream.write_u32_le(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

fn auth_tokens_equal(received: &[u8], expected: &[u8]) -> bool {
    if received.len() > MAX_AUTH_TOKEN_BYTES || expected.len() > MAX_AUTH_TOKEN_BYTES {
        return false;
    }
    let mut received_padded = [0_u8; MAX_AUTH_TOKEN_BYTES];
    let mut expected_padded = [0_u8; MAX_AUTH_TOKEN_BYTES];
    received_padded[..received.len()].copy_from_slice(received);
    expected_padded[..expected.len()].copy_from_slice(expected);
    bool::from(received_padded.ct_eq(&expected_padded) & received.len().ct_eq(&expected.len()))
}

async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    expected: &str,
) -> Result<()> {
    let token = read_packet(stream, MAX_AUTH_TOKEN_BYTES).await?;
    if !auth_tokens_equal(&token, expected.as_bytes()) {
        bail!("authentication failed");
    }
    write_packet(stream, b"ok").await
}

/// Commands that dial the mesh and may block on the network for as long as a
/// peer takes to answer. They run off the connection loop so input queued
/// behind them on the same socket stays latency-clean.
///
/// The membership rule is not "it touches the network" but "it touches the
/// network and nothing per-connection": an off-loop command is handed a fresh,
/// empty ownership map, so one that read or wrote the connection's real one
/// would silently see no attachments. Every command here is checked against
/// that. `refresh-session` qualifies — on a Live remote session it re-attaches
/// the feed through the mesh, which can take as long as a dial, and it reads
/// the registry and the mesh runtime only.
fn runs_off_connection_loop(command: &Command) -> bool {
    matches!(
        command,
        Command::ListRemoteHosts
            | Command::ListRemoteSessions { .. }
            | Command::OpenRemoteSession { .. }
            | Command::ReconnectRemoteSession { .. }
            | Command::RefreshSession { .. }
            | Command::RetryRemoteView { .. }
    )
}

/// Tell a client that has just said hello which of its sessions are remote.
///
/// Without this, a workspace restored from persistence has no way to learn
/// that an already-open session is replicated: it never called
/// `open-remote-session`, and a session that has been offline for hours
/// produces no transition to announce itself with. It would queue input at a
/// frozen tab and show no banner. Returns false when the socket is gone.
async fn send_remote_lifecycle_snapshot(
    context: &ControlContext,
    outbound: &tokio::sync::mpsc::Sender<Vec<u8>>,
) -> bool {
    for summary in context.mesh_runtime.summaries().await {
        let Some(lifecycle) = context.mesh_runtime.session_lifecycle(&summary.id).await else {
            continue;
        };
        let event =
            remote_session_state_changed_event(&summary.id, LifecycleFields::from(&lifecycle));
        if outbound
            .send(serde_json::to_vec(&event).unwrap())
            .await
            .is_err()
        {
            return false;
        }
    }
    true
}

async fn serve_control(
    mut listener: ipc::Listener,
    token: String,
    context: ControlContext,
) -> Result<()> {
    loop {
        let mut socket = listener.accept().await?;
        let token = token.clone();
        let context = context.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut socket, &token)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => return,
            }
            let mut events = context.event_tx.subscribe();
            let (mut reader, mut writer) = tokio::io::split(socket);
            let client_id = uuid::Uuid::new_v4().to_string();
            // Ownership, and nothing else. Epochs live where they are
            // authoritative — the local `ViewAuthority`, or the mesh's own
            // attachment record — and are read at use time, because a cached
            // one outlives the attachment it names.
            let mut attached = HashSet::<(String, String)>::new();
            let mut client_protocol_minor = 0_u16;
            // One writer task serializes packets from the connection loop and
            // from any commands running off it; clients pair responses to
            // requests by identifier, not by arrival order.
            let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
            let _writer_task = TaskGuard(tokio::spawn(async move {
                while let Some(bytes) = outbound_rx.recv().await {
                    if write_packet(&mut writer, &bytes).await.is_err() {
                        break;
                    }
                }
            }));
            // Frames are assembled here rather than inside the `select!`
            // below. `read_packet` awaits twice — once for the length, once
            // for the body — and every pushed event cancels whichever read is
            // in flight. Cancelled between the two, it would swallow a length
            // it had already consumed and leave the next read to mistake the
            // body's first four bytes for the next one, desynchronizing a
            // connection that did nothing wrong. `read` is cancel-safe and
            // this buffer outlives the cancellation, so nothing is lost.
            let mut inbound = Vec::<u8>::new();
            let mut chunk = vec![0_u8; CONTROL_READ_CHUNK];
            loop {
                let framed = match take_frame(&mut inbound, MAX_CONTROL_BYTES) {
                    Ok(framed) => framed,
                    Err(_) => break,
                };
                if let Some(packet) = framed {
                    let Ok(command) = serde_json::from_slice::<Envelope>(&packet) else {
                        break;
                    };
                    let mut negotiated = false;
                    if let Command::Hello {
                        protocol_major,
                        protocol_minor,
                        ..
                    } = &command.command
                        && *protocol_major == CONTROL_PROTOCOL_MAJOR
                    {
                        client_protocol_minor = (*protocol_minor).min(CONTROL_PROTOCOL_MINOR);
                        negotiated = true;
                    }
                    let notification = command.request_id == 0;
                    if runs_off_connection_loop(&command.command) {
                        let context = context.clone();
                        let client_id = client_id.clone();
                        let outbound = outbound_tx.clone();
                        tokio::spawn(async move {
                            let mut detached_bookkeeping = HashSet::new();
                            let response = handle_command(
                                command,
                                &client_id,
                                &mut detached_bookkeeping,
                                &context,
                            )
                            .await;
                            if !notification {
                                let _ = outbound.send(serde_json::to_vec(&response).unwrap()).await;
                            }
                        });
                        continue;
                    }
                    let response =
                        handle_command(command, &client_id, &mut attached, &context).await;
                    if !notification
                        && outbound_tx
                            .send(serde_json::to_vec(&response).unwrap())
                            .await
                            .is_err()
                    {
                        break;
                    }
                    // After the response, so the client has its negotiated
                    // minor before the first pushed event arrives.
                    if negotiated
                        && client_protocol_minor >= REMOTE_LIFECYCLE_PROTOCOL_MINOR
                        && !send_remote_lifecycle_snapshot(&context, &outbound_tx).await
                    {
                        break;
                    }
                    continue;
                }
                tokio::select! {
                    read = reader.read(&mut chunk) => match read {
                        // Zero is the client's half of the socket closing,
                        // which is the ordinary way a connection ends.
                        Ok(0) | Err(_) => break,
                        Ok(read) => inbound.extend_from_slice(&chunk[..read]),
                    },
                    event = events.recv() => match event {
                        Ok(event) => {
                            let Some(event) = event_for_client(event, client_protocol_minor) else {
                                continue;
                            };
                            if outbound_tx.send(serde_json::to_vec(&event).unwrap()).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            // Never drop events silently: a missed
                            // session-exited would leave a client showing a
                            // ghost session forever. Clients that understand
                            // the notice re-list sessions to resynchronize.
                            if client_protocol_minor < EVENTS_LOST_PROTOCOL_MINOR {
                                continue;
                            }
                            let notice = serde_json::to_vec(&json!({
                                "requestId": 0,
                                "type": "events-lost",
                                "skipped": skipped,
                            }))
                            .unwrap();
                            if outbound_tx.send(notice).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
            for (session_id, view_id) in attached {
                unregister_view_owner(&context, &session_id, &view_id, &client_id);
                if let Some(session) = context.registry.read().unwrap().get(&session_id).cloned() {
                    session.detach_view(&view_id, &client_id);
                } else {
                    detach_remote_view(&context, &session_id, &view_id).await;
                }
            }
        });
    }
}

/// Time held back from the session deadline so a forced end still has room to
/// reap, stamp, and broadcast before the budget expires.
///
/// A tuning knob rather than a constant: the conclusion path's final refresh
/// renders through the one shared text engine, so many still-viewed sessions
/// concluding at once serialise there. Calibrated for a handful of panes.
const REAP_RESERVE: Duration = Duration::from_millis(250);

/// How often to re-check when the only thing left is a create still inside its
/// `spawn_blocking`. There is nothing to await on, so this is a poll — kept
/// short because it bounds how long a drain lingers after the last session.
const IN_FLIGHT_POLL: Duration = Duration::from_millis(5);

/// A moment at the end of a drain for connection tasks to write the exit
/// events they were just handed.
///
/// The drain observes conclusion directly from the session, which can outrun a
/// client's socket; without this, stopping the listeners can cut off the very
/// `session-exited` an observer was watching the drain for. Taken out of the
/// remaining budget, never added to it.
const EVENT_FLUSH: Duration = Duration::from_millis(100);

/// Stop admitting sessions, end every local one, and report honestly.
///
/// The ordering here is the whole correctness argument:
///
/// 1. publish the deadline, so a create refused inside the barrier can bound
///    the session it already forked;
/// 2. close admissions;
/// 3. take and release the owner lock — the same lock a create holds across
///    its registry insert, so every in-flight create is now either inserted
///    (and visible below) or destined to be refused;
/// 4. only then start looking at what is live.
async fn drain(context: &ControlContext, budget: Duration) -> DrainReport {
    let started = Instant::now();
    // The first act, before admissions close and before a single session is
    // asked to end. Ordering is the whole of it: terminate first and a viewer
    // watches its streams die and calls it an outage; tear the mesh down first
    // and there is nothing left to say goodbye through. Announcing returns
    // immediately and is idempotent, so it costs the drain no budget.
    context.shutdown_announcer.announce();
    // Saturating rather than `+`: an absurd budget from a caller must not
    // panic the task that owns the reply channel.
    let budget_ends = started
        .checked_add(budget)
        .unwrap_or_else(|| started + Duration::from_secs(3_600));
    let session_deadline = budget_ends.checked_sub(REAP_RESERVE).unwrap_or(started);

    *context.shutdown.deadline.lock().unwrap() = Some(session_deadline);
    context
        .shutdown
        .admissions_closed
        .store(true, atomic::Ordering::SeqCst);
    drop(context.closed_owners.lock().await);

    let mut concluded_at: HashMap<String, Option<Instant>> = HashMap::new();
    loop {
        // The counter is read *before* the snapshot, and a refusal deposits
        // into the dying set before it decrements. So a zero here means every
        // refusal's deposit is already visible to the snapshot taken next;
        // reading them the other way round could miss a session that landed in
        // between and let the drain resolve over a live PTY.
        let in_flight = context
            .shutdown
            .creates_in_flight
            .load(atomic::Ordering::SeqCst);
        let live = live_sessions(context);
        if live.is_empty() {
            if in_flight == 0 {
                break;
            }
            // Nothing to await yet, but a create is still inside its spawn.
            // Yield rather than spin: on a current-thread runtime a tight loop
            // here would starve the very task being waited for, turning a
            // bounded wait into a guaranteed one.
            tokio::time::sleep(IN_FLIGHT_POLL).await;
            if Instant::now() >= budget_ends {
                break;
            }
            continue;
        }
        for session in &live {
            concluded_at.entry(session.id()).or_default();
            if let Err(error) = session.terminate_within(
                session::TerminationSource::ServiceShutdown,
                session_deadline,
            ) {
                eprintln!(
                    "[ghosttea] failed to terminate {} during shutdown: {error:#}",
                    session.id()
                );
            }
        }
        for session in live {
            let remaining = budget_ends.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let mut conclusion = session.subscribe_conclusion();
            // Both results matter: the outer is the timeout, the inner would be
            // a closed channel. Only an actual conclusion counts as one.
            if matches!(
                tokio::time::timeout(remaining, conclusion.wait_for(|concluded| *concluded)).await,
                Ok(Ok(_))
            ) {
                concluded_at.insert(session.id(), Some(Instant::now()));
            }
        }
        if Instant::now() >= budget_ends {
            break;
        }
    }

    let flush = budget_ends
        .saturating_duration_since(Instant::now())
        .min(EVENT_FLUSH);
    if !flush.is_zero() {
        tokio::time::sleep(flush).await;
    }

    let mut report = DrainReport {
        pending_creates: context
            .shutdown
            .creates_in_flight
            .load(atomic::Ordering::SeqCst),
        // Read back rather than assumed from having called it: a mesh with no
        // way to announce answers false, and the report's job is to say which
        // of the two happened.
        announced_shutdown: context.shutdown_announcer.announced(),
        ..DrainReport::default()
    };
    for (session_id, concluded) in concluded_at {
        // Timing is the only signal, so a session that concluded while another
        // was being awaited can be booked late; the distinction is a quality
        // report, not a correctness claim.
        match concluded {
            Some(at) if at <= session_deadline => report.drained += 1,
            Some(_) => report.killed += 1,
            None => report.unresponsive.push(session_id),
        }
    }
    report.unresponsive.sort();
    report.spent = started.elapsed();
    report
}

/// Everything this host still has to end: registered sessions plus the ones
/// already dying outside the registry, minus whatever has finished concluding.
///
/// One session is deliberately invisible here: one exiting *naturally* is
/// removed from the registry by `on_exit` a moment before its conclusion is
/// signalled, so in that window it is in neither set. That costs the report a
/// count, never a PTY — the child is reaped and the exit broadcast before
/// `on_exit` runs. Signalling conclusion earlier would close the gap and break
/// the property the drain depends on, that conclusion is strictly later than
/// exit; the undercount is the cheaper of the two.
fn live_sessions(context: &ControlContext) -> Vec<Arc<Session>> {
    // The registry guard below is a statement-scoped temporary, released at the
    // `;` before `prune_dying` takes the dying set on the next statement. Keep
    // it that way: binding it to a variable would hold registry across dying,
    // which is the reverse of the order termination takes them in.
    let mut live: HashMap<String, Arc<Session>> = context
        .registry
        .read()
        .unwrap()
        .values()
        .filter(|session| !session.has_concluded())
        .map(|session| (session.id(), Arc::clone(session)))
        .collect();
    for session in context.shutdown.prune_dying() {
        live.entry(session.id()).or_insert(session);
    }
    live.into_values().collect()
}

/// The one local-session creation path for both the control socket and an
/// in-process [`ServiceSessions`] caller.
async fn create_local_session(
    context: &ControlContext,
    options: SpawnOptions,
) -> Result<Arc<Session>> {
    validate_grid(options.cols, options.rows)?;
    validate_owner(options.owner_id.as_deref())?;
    // Count first, then check — the order is the guarantee. A create that
    // reads the flag as open before being descheduled has already made itself
    // visible, so a shutdown that observes zero in-flight creates knows none
    // can still appear.
    let _in_flight = CreateInFlight::enter(&context.shutdown);
    if context.shutdown.admissions_closed() {
        bail!("service is shutting down");
    }
    if let Some(owner) = options.owner_id.as_deref()
        && context.closed_owners.lock().await.contains(owner)
    {
        bail!("session owner is already closed");
    }

    let registry_on_exit = Arc::clone(&context.registry);
    let tombstones_on_exit = Arc::clone(&context.tombstones);
    let events_on_exit = context.event_tx.clone();
    let lifecycle_on_exit = context.lifecycle_tx.clone();
    let (session_exit_tx, mut control_exit) = watch::channel(false);
    let mut activity_exit = session_exit_tx.subscribe();
    let on_exit: ExitCallback = Arc::new(move |session_id, exit| {
        session_exit_tx.send_replace(true);
        let removed = {
            // Read the class under the same lock the removal takes, and the
            // same one `set-persistence` writes under: a set that returned
            // success before this point is the value that decides retention.
            let mut registry = registry_on_exit.write().unwrap();
            let retain = registry
                .get(&session_id)
                .and_then(|session| session.persistence())
                .is_some_and(|persistence| persistence == Persistence::KeepUntilExplicitClose);
            !retain
                && tombstones_on_exit
                    .remove_with_cause_locked(&mut registry, &session_id)
                    .is_some()
        };
        let _ = events_on_exit.send(json!({
            "requestId": 0,
            "type": "session-exited",
            "sessionId": session_id,
            "exitCode": exit.exit_code,
            "exitSignal": exit.exit_signal,
            "requestedTermination": exit.requested_termination,
            "exitOutcome": exit.exit_outcome,
        }));
        let _ = lifecycle_on_exit.send(SessionLifecycleEvent::Exited {
            session_id: session_id.clone(),
            exit,
        });
        if removed {
            let _ = lifecycle_on_exit.send(SessionLifecycleEvent::Removed { session_id });
        }
    });

    // openpty plus fork/exec is blocking work; keep it off the async workers so
    // concurrent creates do not stall the runtime.
    let session = {
        let frames = context.frames.clone();
        let text_engine = Arc::clone(&context.text_engine);
        let private_env_prefixes = Arc::clone(&context.private_env_prefixes);
        let terminal_config = context.config.snapshot().terminal.clone();
        let effective_scrollback_bytes = options
            .scrollback_bytes
            .unwrap_or(terminal_config.scrollback_bytes);
        let scrollback_bytes = usize::try_from(effective_scrollback_bytes)
            .context("scrollbackBytes does not fit this platform")?;
        let mut options = options;
        options.hint_color_scheme(terminal_config.background);
        tokio::task::spawn_blocking(move || {
            let session = Session::spawn_configured(
                options,
                frames,
                text_engine,
                &private_env_prefixes,
                scrollback_bytes,
                on_exit,
            )?;
            let palette = terminal_config
                .palette
                .iter()
                .map(|entry| (entry.index, entry.color))
                .collect::<Vec<_>>();
            session.set_appearance(
                terminal_config.foreground,
                terminal_config.background,
                terminal_config.cursor,
                &palette,
            )?;
            Ok::<_, anyhow::Error>(session)
        })
        .await
        .context("session spawn task stopped")??
    };

    let summary = session.summary();
    let mut controls = session.subscribe_control();
    let mut activities = session.subscribe_activity();
    let control_session_id = summary.id.clone();
    let activity_session_id = summary.id.clone();
    let control_events = context.event_tx.clone();
    let activity_events = context.event_tx.clone();
    let control_session = Arc::downgrade(&session);
    let activity_session = Arc::downgrade(&session);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = control_exit.changed() => {
                    if changed.is_err() || *control_exit.borrow() {
                        break;
                    }
                }
                changed = controls.recv() => match changed {
                    Ok(changed) => {
                        let _ = control_events.send(json!({
                            "requestId": 0,
                            "type": "control-changed",
                            "sessionId": control_session_id,
                            "controllerViewId": changed.controller.view_id,
                            "controlEpoch": changed.controller.control_epoch,
                            "cols": changed.cols,
                            "rows": changed.rows,
                            "layoutEpoch": changed.layout_epoch,
                        }));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Some(session) = control_session.upgrade() else {
                            break;
                        };
                        let (controller, cols, rows, layout_epoch) = session.control_state();
                        let Some(controller) = controller else {
                            continue;
                        };
                        let _ = control_events.send(json!({
                            "requestId": 0,
                            "type": "control-changed",
                            "sessionId": control_session_id,
                            "controllerViewId": controller.view_id,
                            "controlEpoch": controller.control_epoch,
                            "cols": cols,
                            "rows": rows,
                            "layoutEpoch": layout_epoch,
                        }));
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    });
    tokio::spawn(async move {
        loop {
            let activity = tokio::select! {
                changed = activity_exit.changed() => {
                    if changed.is_err() || *activity_exit.borrow() {
                        break;
                    }
                    continue;
                }
                activity = activities.recv() => match activity {
                    Ok(activity) => activity,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let Some(session) = activity_session.upgrade() else {
                            break;
                        };
                        session.summary().activity
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            };
            let _ = activity_events.send(json!({
                "requestId": 0,
                "type": "session-activity-changed",
                "sessionId": activity_session_id,
                "activity": activity,
            }));
        }
    });

    // Re-check owner closure while holding the transaction lock across insert.
    {
        let owner_lifecycle = context.closed_owners.lock().await;
        if summary
            .owner_id
            .as_deref()
            .is_some_and(|owner| owner_lifecycle.contains(owner))
        {
            drop(owner_lifecycle);
            let _ = context
                .shutdown
                .terminate_tracked(&session, TerminationSource::User, None);
            bail!("session owner is already closed");
        }
        if context.shutdown.admissions_closed() {
            let deadline = *context.shutdown.deadline.lock().unwrap();
            drop(owner_lifecycle);
            let _ = context.shutdown.terminate_tracked(
                &session,
                TerminationSource::ServiceShutdown,
                deadline,
            );
            bail!("service is shutting down");
        }
        context
            .registry
            .write()
            .unwrap()
            .insert(summary.id.clone(), Arc::clone(&session));
    }

    // A child that died during spawn leaves nothing to keep unless its class
    // says otherwise. Read that class under the same lock as the removal.
    let retained = {
        let mut registry = context.registry.write().unwrap();
        let retain = !session.has_exited()
            || session.persistence() == Some(Persistence::KeepUntilExplicitClose);
        if !retain {
            let removed = context
                .tombstones
                .remove_with_cause_locked(&mut registry, &summary.id)
                .is_some();
            if removed {
                let _ = context.lifecycle_tx.send(SessionLifecycleEvent::Removed {
                    session_id: summary.id.clone(),
                });
            }
        }
        retain
    };
    if retained {
        announce_session_created(&context.event_tx, &summary);
        let _ = context.lifecycle_tx.send(SessionLifecycleEvent::Created {
            session: Arc::clone(&session),
        });
    }
    Ok(session)
}

async fn handle_command(
    command: Envelope,
    client_id: &str,
    attached: &mut HashSet<(String, String)>,
    context: &ControlContext,
) -> ResponseEnvelope {
    let request_id = command.request_id;
    let registry = &context.registry;
    let result: Result<ResponseBody> = async {
        match command.command {
            Command::Hello {
                protocol_major,
                protocol_minor,
                client_build,
            } => {
                let _client = (protocol_major, protocol_minor, client_build);
                Ok(ResponseBody::Hello {
                    protocol_major: CONTROL_PROTOCOL_MAJOR,
                    protocol_minor: CONTROL_PROTOCOL_MINOR,
                    server_build: env!("CARGO_PKG_VERSION").to_owned(),
                    config_revision: context.config.snapshot().revision.clone(),
                })
            }
            Command::GetConfig => Ok(ResponseBody::Config {
                config: context.config.snapshot().as_ref().clone(),
            }),
            Command::ReloadConfig => {
                let _update = context
                    .config_update_lock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let (config, changed) = context.config.reload();
                publish_reloaded_config(context, &config, changed)?;
                Ok(ResponseBody::Config {
                    config: config.as_ref().clone(),
                })
            }
            Command::GetConfigDocument => Ok(ResponseBody::ConfigDocument {
                document: context.config.document()?,
            }),
            Command::ValidateConfigDocument { contents } => {
                let validation = context.config.validate_document(&contents)?;
                Ok(ResponseBody::ConfigDocumentValidation {
                    document_revision: validation.document_revision,
                    config: validation.config,
                })
            }
            Command::ReplaceConfigDocument {
                expected_revision,
                contents,
            } => {
                let _update = context
                    .config_update_lock
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match context
                    .config
                    .replace_document(&expected_revision, &contents)
                {
                    Ok(update) => {
                        publish_reloaded_config(
                            context,
                            &update.config,
                            update.effective_changed,
                        )?;
                        Ok(ResponseBody::ConfigDocumentUpdated {
                            document: update.document,
                            config: update.config.as_ref().clone(),
                        })
                    }
                    Err(ConfigDocumentError::Conflict { current }) => {
                        Ok(ResponseBody::ConfigDocumentConflict { document: current })
                    }
                    Err(error) => Err(error.into()),
                }
            }
            Command::CreateSession { options } => {
                let session = create_local_session(context, options).await?;
                let summary = session.summary();
                Ok(ResponseBody::SessionCreated { session: summary })
            }
            Command::ListSessions => {
                let mut sessions: Vec<_> = {
                    registry
                        .read()
                        .unwrap()
                        .values()
                        .map(|session| session.summary())
                        .collect()
                };
                sessions.extend(context.mesh_runtime.summaries().await);
                Ok(ResponseBody::Sessions { sessions })
            }
            Command::ListRemoteHosts => Ok(ResponseBody::RemoteHosts {
                hosts: context.mesh_runtime.hosts().await?,
            }),
            Command::ListRemoteSessions { device_id } => {
                let sessions = context.mesh_runtime.list_sessions(&device_id).await?;
                Ok(ResponseBody::RemoteSessions {
                    device_id,
                    sessions,
                })
            }
            Command::OpenRemoteSession {
                device_id,
                remote_session_id,
                cols,
                rows,
                owner_id,
            } => {
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                validate_owner(owner_id.as_deref())?;
                if let Some(owner) = owner_id.as_deref()
                    && context.closed_owners.lock().await.contains(owner)
                {
                    bail!("session owner is already closed");
                }
                // The network dial happens without the owner lock so a slow
                // peer can never stall unrelated session creation; the
                // tombstone is re-checked once the session exists.
                let session = context
                    .mesh_runtime
                    .open_session(mesh::RemoteSessionOpen {
                        device_id,
                        remote_session_id,
                        cols,
                        rows,
                        owner_id,
                        frames: context.frames.clone(),
                        text_engine: Arc::clone(&context.text_engine),
                    })
                    .await?;
                let closed_after_open = match session.owner_id.as_deref() {
                    Some(owner) => context.closed_owners.lock().await.contains(owner),
                    None => false,
                };
                if closed_after_open {
                    context.mesh_runtime.close_session(&session.id).await;
                    bail!("session owner is already closed");
                }
                Ok(ResponseBody::SessionCreated { session })
            }
            Command::GetSession { session_id } => {
                let session =
                    if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                        session.summary()
                    } else {
                        context
                            .mesh_runtime
                            .summary(&session_id)
                            .await
                            .context("unknown session")?
                    };
                Ok(ResponseBody::Session { session })
            }
            Command::RefreshSession { session_id } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.refresh()?;
                } else if remote_lifecycle_state(context, &session_id).await
                    == Some(mesh::RemoteLifecycleState::Live)
                {
                    // A true remote refresh: a generation-advanced re-attach of
                    // the feed (§7), which passes through Synchronizing and
                    // mints a fresh attachment epoch. Nothing here may hold an
                    // epoch across it — every path reads `current_attachment`
                    // at use time for exactly this reason. Asking the host for
                    // a second state stream instead would leave two feeds with
                    // independent patch sequences.
                    context.mesh_runtime.refresh_remote(&session_id).await?;
                } else {
                    // Not live, or a mesh with no lifecycle to report: re-render
                    // the retained replica and never dial. A frozen session has
                    // no host to ask, and this is what refresh always did.
                    context.mesh_runtime.refresh(&session_id).await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::GetRemoteSessionState { session_id } => {
                let lifecycle = context
                    .mesh_runtime
                    .session_lifecycle(&session_id)
                    .await
                    .context("unknown remote session")?;
                Ok(remote_session_state(context, &lifecycle).await)
            }
            Command::ReconnectRemoteSession { session_id } => {
                // Reported before dialling, so an unknown session is an error
                // rather than a dial that fails for its own reasons.
                let lifecycle = context
                    .mesh_runtime
                    .session_lifecycle(&session_id)
                    .await
                    .context("unknown remote session")?;
                let Some(_attempt) = ReconnectInFlight::enter(context, &session_id) else {
                    // Another attempt is already dialling this session. Answer
                    // with what it has reached so far rather than starting a
                    // second dial; its conclusion arrives on the lifecycle
                    // event for every client either way.
                    return Ok(remote_session_state(context, &lifecycle).await);
                };
                // A refused dial is not a failed command: the mesh has put the
                // session back in Suspended and the caller needs that state,
                // not an error string it would have to translate.
                let lifecycle = match context.mesh_runtime.reconnect_session(&session_id).await {
                    Ok(lifecycle) => lifecycle,
                    Err(_) => context
                        .mesh_runtime
                        .session_lifecycle(&session_id)
                        .await
                        .context("unknown remote session")?,
                };
                Ok(remote_session_state(context, &lifecycle).await)
            }
            Command::RetryRemoteView {
                session_id,
                view_id,
            } => {
                // The per-pane retry (§4.5): re-attach one view that failed
                // while the rest of the session kept working. The mesh refuses
                // the cases it does not own — a session that is not live, or
                // the feed view, both of which recover through the
                // session-level paths — and those refusals answer with the
                // view's current record rather than an error, which is what
                // this command did for every client before it went live.
                let record = match context
                    .mesh_runtime
                    .retry_view(&session_id, &view_id)
                    .await
                {
                    Ok(record) => record,
                    // Re-read rather than reuse a copy taken before the call:
                    // an attempt can move the view on its way to failing, and
                    // reporting the state it held beforehand would describe a
                    // view that no longer exists in that state. The two
                    // failures are told apart because they mean different
                    // things to whoever is reading the error — the session is
                    // gone, or only this pane is.
                    Err(_) => {
                        let lifecycle = context
                            .mesh_runtime
                            .session_lifecycle(&session_id)
                            .await
                            .context("unknown remote session")?;
                        lifecycle
                            .views
                            .into_iter()
                            .find(|record| record.local_view_id == view_id)
                            .context("unknown remote view")?
                    }
                };
                Ok(ResponseBody::ViewState {
                    session_id,
                    view_id: record.local_view_id,
                    view_state_seq: record.view_state_seq,
                    view_state: record.view_state,
                    attachment_epoch: record.attachment_epoch,
                    read_write: record.read_write,
                    error: record.error,
                    retryable: record.retryable,
                })
            }
            Command::AttachSession {
                session_id,
                view_id,
                owner_id,
            } => {
                let key = (session_id.clone(), view_id.clone());
                // Publish the pane's ownership intent before the potentially
                // slow attach. Otherwise close-session-owner can acquire the
                // lifecycle lock after the terminal attachment succeeds but
                // before its evidence is indexed, and kill a pane that was
                // already in flight. Existing attachments already published
                // this evidence on their first pass.
                let reserved_owner = owner_id.is_some() && !attached.contains(&key);
                if reserved_owner {
                    register_view_owner(
                        context,
                        &session_id,
                        &view_id,
                        client_id,
                        owner_id.as_deref(),
                    )
                    .await?;
                }
                let local = registry.read().unwrap().get(&session_id).cloned();
                let attachment: Result<(u64, bool, Option<u64>)> = async {
                    if let Some(session) = &local {
                        // Idempotent for the client that already holds the view,
                        // so a re-attach reads the epoch back from the authority
                        // rather than from this connection's memory of it.
                        let attachment_epoch = session.attach_view(&view_id, client_id)?;
                        Ok((attachment_epoch, true, None))
                    } else {
                        // A view this connection owns may still have died with
                        // its connection. Ask the authority; if it has no
                        // attachment to report, re-dial instead of answering
                        // with the epoch we were handed the first time.
                        let current = match attached.contains(&key) {
                            true => {
                                context
                                    .mesh_runtime
                                    .current_attachment(&session_id, &view_id)
                                    .await
                            }
                            false => None,
                        };
                        let (attachment_epoch, read_write) = match current {
                            Some(current) => current,
                            None => {
                                let attachment = context
                                    .mesh_runtime
                                    .attach_view(&session_id, &view_id)
                                    .await?;
                                (attachment.attachment_epoch, attachment.read_write)
                            }
                        };
                        Ok((
                            attachment_epoch,
                            read_write,
                            remote_view_state_seq(context, &session_id, &view_id).await,
                        ))
                    }
                }
                .await;
                let (attachment_epoch, read_write, view_state_seq) = match attachment {
                    Ok(attachment) => attachment,
                    Err(error) => {
                        if reserved_owner {
                            unregister_view_owner(context, &session_id, &view_id, client_id);
                        }
                        return Err(error);
                    }
                };
                // Re-check after the attach: a target window could have closed
                // while a remote peer was dialing. In that case roll back the
                // terminal attachment rather than return a live view owned by
                // a tombstoned application window.
                if let Err(error) = register_view_owner(
                    context,
                    &session_id,
                    &view_id,
                    client_id,
                    owner_id.as_deref(),
                )
                .await
                {
                    if let Some(session) = local {
                        session.detach_view(&view_id, client_id);
                    } else {
                        detach_remote_view(context, &session_id, &view_id).await;
                    }
                    return Err(error);
                }
                attached.insert(key);
                Ok(ResponseBody::ViewAttached {
                    session_id,
                    view_id,
                    attachment_epoch,
                    read_write,
                    view_state_seq,
                })
            }
            Command::DetachSession {
                session_id,
                view_id,
            } => {
                if attached.remove(&(session_id.clone(), view_id.clone())) {
                    unregister_view_owner(context, &session_id, &view_id, client_id);
                    if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                        session.detach_view(&view_id, client_id);
                    } else {
                        detach_remote_view(context, &session_id, &view_id).await;
                    }
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendText {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                text,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.send_text(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        text,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Text(text),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Paste {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                text,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.paste(&view_id, client_id, attachment_epoch, input_sequence, text)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Paste(text),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendKey {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                event,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.key(&view_id, client_id, attachment_epoch, input_sequence, event)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Key(event),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendMouse {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                event,
            } => {
                if event.screen_width > 32_768
                    || event.screen_height > 32_768
                    || event.cell_width == 0
                    || event.cell_height == 0
                    || !event.x.is_finite()
                    || !event.y.is_finite()
                {
                    bail!("invalid mouse geometry");
                }
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.mouse(&view_id, client_id, attachment_epoch, input_sequence, event)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Mouse(event),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Scroll {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                rows,
            } => {
                let rows = rows.clamp(-10_000, 10_000);
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.scroll(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        isize::try_from(rows)?,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Scroll(rows),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::ScrollTo {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                row,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.scroll_to(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        usize::try_from(row)?,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::ScrollTo(row),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Focus {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                focused,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.focus(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        focused,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Focus(focused),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::FocusAndResize {
                session_id,
                view_id,
                attachment_epoch,
                cols,
                rows,
                expected_control_revision,
            } => {
                require_attachment(attached, &session_id, &view_id)?;
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                if expected_control_revision == Some(LEGACY_CONTROL_REVISION) {
                    // 0 is the "this source keeps no revisions" sentinel, so
                    // conditioning on it asks to be fenced against a number
                    // nothing maintains. Refusing is the only honest answer;
                    // treating it as unconditional would grant the claim while
                    // the caller believed it was guarded.
                    bail!(
                        "expectedControlRevision must be at least 1; 0 marks a source that has no revisions to compare"
                    );
                }
                let local = registry.read().unwrap().get(&session_id).cloned();
                let outcome = if let Some(session) = local {
                    match session.claim_control_checked(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        cols,
                        rows,
                        expected_control_revision,
                    )? {
                        ghosttea_core::ControlClaim::Granted(changed) => {
                            // The revision the claim produced comes from the
                            // authority that produced it; `ControlChanged`
                            // carries the controller, not the counter.
                            let snapshot = session.control_snapshot();
                            ClaimOutcome::Claimed {
                                controller_view_id: changed.controller.view_id,
                                control_epoch: changed.controller.control_epoch,
                                control_revision: snapshot.control_revision,
                                cols: changed.cols,
                                rows: changed.rows,
                                layout_epoch: changed.layout_epoch,
                            }
                        }
                        ghosttea_core::ControlClaim::Rejected(snapshot) => ClaimOutcome::Rejected {
                            controller: snapshot.controller.map(|controller| {
                                RemoteControllerInfo {
                                    view_id: controller.view_id,
                                    control_epoch: controller.control_epoch,
                                }
                            }),
                            control_revision: snapshot.control_revision,
                            cols: snapshot.cols,
                            rows: snapshot.rows,
                            layout_epoch: snapshot.layout_epoch,
                        },
                    }
                } else {
                    match context
                        .mesh_runtime
                        .claim_control_at(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            cols,
                            rows,
                            expected_control_revision,
                        )
                        .await?
                    {
                        mesh::RemoteControlOutcome::Claimed(state) => {
                            let controller = state.controller.context(
                                "the mesh granted a claim without naming who now holds control",
                            )?;
                            ClaimOutcome::Claimed {
                                controller_view_id: controller.view_id,
                                control_epoch: controller.control_epoch,
                                control_revision: state.control_revision,
                                cols: state.cols,
                                rows: state.rows,
                                layout_epoch: state.layout_epoch,
                            }
                        }
                        mesh::RemoteControlOutcome::Rejected(state) => ClaimOutcome::Rejected {
                            controller: state.controller.map(|controller| RemoteControllerInfo {
                                view_id: controller.view_id,
                                control_epoch: controller.control_epoch,
                            }),
                            control_revision: state.control_revision,
                            cols: state.cols,
                            rows: state.rows,
                            layout_epoch: state.layout_epoch,
                        },
                    }
                };
                Ok(outcome.into_response(session_id))
            }
            Command::Resize {
                session_id,
                view_id,
                attachment_epoch,
                control_epoch,
                resize_sequence,
                cols,
                rows,
            } => {
                require_attachment(attached, &session_id, &view_id)?;
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.resize_view(
                        &view_id,
                        client_id,
                        control_epoch,
                        resize_sequence,
                        cols,
                        rows,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .resize(
                            &session_id,
                            &view_id,
                            mesh::RemoteResize {
                                attachment_epoch,
                                control_epoch,
                                resize_sequence,
                                cols,
                                rows,
                            },
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SetColors {
                session_id,
                foreground,
                background,
                cursor,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.set_colors(foreground, background, cursor)?;
                } else if context.mesh_runtime.summary(&session_id).await.is_none() {
                    bail!("unknown session");
                }
                Ok(ResponseBody::Ok)
            }
            Command::SelectionText {
                session_id,
                view_id,
                attachment_epoch,
                start_column,
                start_row,
                end_column,
                end_row,
                select_all,
            } => {
                require_attachment(attached, &session_id, &view_id)?;
                let start_column =
                    checked_dimension(start_column, "startColumn", 0, MAX_TERMINAL_COLS)?;
                let end_column = checked_dimension(end_column, "endColumn", 0, MAX_TERMINAL_COLS)?;
                let start_row = u32::try_from(start_row).context("startRow is out of range")?;
                let end_row = u32::try_from(end_row).context("endRow is out of range")?;
                let selection = mesh::RemoteSelection {
                    attachment_epoch,
                    start_column,
                    start_row,
                    end_column,
                    end_row,
                    select_all,
                };
                let (text, scope) = if let Some(session) =
                    registry.read().unwrap().get(&session_id).cloned()
                {
                    let text = session.selection_text(
                        &view_id,
                        start_column,
                        start_row,
                        end_column,
                        end_row,
                        select_all,
                    )?;
                    (text, SELECTION_SCOPE_SCROLLBACK)
                } else if remote_lifecycle_state(context, &session_id)
                    .await
                    .is_none_or(|state| state == mesh::RemoteLifecycleState::Live)
                {
                    // Live sessions keep asking the host, which can reach
                    // scrollback this side does not retain. A mesh with no
                    // lifecycle to report is the pre-lifecycle one, whose
                    // selections always went to the host.
                    let text = context
                        .mesh_runtime
                        .selection_text(&session_id, &view_id, selection)
                        .await?;
                    (text, SELECTION_SCOPE_SCROLLBACK)
                } else {
                    // §4.4: with no live attachment there is no epoch to fence
                    // against and no host to ask, so the retained replica
                    // viewport answers and the ownership record above is the
                    // authorization. Copying from a frozen tab keeps working.
                    let text = context
                        .mesh_runtime
                        .offline_selection_text(&session_id, selection)
                        .await?;
                    (text, SELECTION_SCOPE_VIEWPORT)
                };
                Ok(ResponseBody::SelectionText { text, scope })
            }
            Command::Interrupt {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.interrupt(&view_id, client_id, attachment_epoch, input_sequence)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Interrupt,
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::GetAutomationState { session_id } => {
                let session = registry
                    .read()
                    .unwrap()
                    .get(&session_id)
                    .cloned()
                    .context("unknown or remote session")?;
                Ok(ResponseBody::AutomationState {
                    session_id,
                    human_input_epoch: session.automation_state(),
                })
            }
            Command::AutomationInput {
                session_id,
                expected_human_input_epoch,
                operation,
            } => {
                let session = registry
                    .read()
                    .unwrap()
                    .get(&session_id)
                    .cloned()
                    .context("unknown or remote session")?;
                let result = session.automation_input(expected_human_input_epoch, operation)?;
                Ok(ResponseBody::AutomationInputResult {
                    session_id,
                    accepted: result.accepted,
                    human_input_epoch: result.human_input_epoch,
                    input_sequence: result.input_sequence,
                    reason: (!result.accepted).then_some("human-input-conflict"),
                })
            }
            Command::SetPersistence {
                session_id,
                persistence,
            } => {
                // Hold the registry write lock across the write so this cannot
                // interleave with the retention decision that reads it back:
                // either the set lands and decides retention, or the session
                // has already concluded and left, and this reports that
                // honestly rather than succeeding over a session that is gone.
                let summary = {
                    let registry = registry.write().unwrap();
                    let session = registry
                        .get(&session_id)
                        .context("unknown or remote session")?;
                    session.set_persistence(persistence);
                    session.summary()
                };
                Ok(ResponseBody::Session { session: summary })
            }
            Command::Terminate { session_id, source } => {
                let local_session = { registry.read().unwrap().get(&session_id).cloned() };
                if let Some(session) = local_session {
                    for view_id in remove_session_attachments(attached, &session_id) {
                        session.detach_view(&view_id, client_id);
                    }
                    // Tracked, because the removal below outruns the ladder:
                    // the entry disappears while the child is still dying.
                    context.shutdown.terminate_tracked(&session, source, None)?;
                    remove_session_view_owners(context, &session_id);
                    if context
                        .tombstones
                        .remove_with_cause(registry, &session_id)
                        .is_some()
                    {
                        let _ = context
                            .lifecycle_tx
                            .send(SessionLifecycleEvent::Removed { session_id });
                    }
                } else {
                    if !context.mesh_runtime.close_session(&session_id).await {
                        bail!("unknown session");
                    }
                    remove_session_attachments(attached, &session_id);
                    remove_session_view_owners(context, &session_id);
                }
                Ok(ResponseBody::Ok)
            }
            Command::CloseSessionOwner {
                owner_id,
                transfers,
            } => {
                validate_owner(Some(&owner_id))?;
                let mut transfer_by_session = validate_owner_transfers(&owner_id, transfers)?;

                // The owner lifecycle lock is the transaction boundary shared
                // with create and owner-aware attach. Explicit layout claims
                // cover restored/inactive panes; currently attached views are
                // an independent authority that closes the IPC timing gap.
                let (local_sessions, remote_session_ids) = {
                    let mut closed_owners = context.closed_owners.lock().await;
                    for target_owner_id in transfer_by_session.values() {
                        if closed_owners.contains(target_owner_id) {
                            bail!("transfer target owner is already closed");
                        }
                    }
                    {
                        let mut view_owners = context.view_owners.lock().unwrap();
                        for (session_id, target_owner_id) in
                            view_owners.transfer_candidates(&owner_id, &closed_owners)
                        {
                            transfer_by_session
                                .entry(session_id)
                                .or_insert(target_owner_id);
                        }
                        // A still-connected closing renderer must not remain
                        // evidence for a later owner transaction.
                        view_owners.remove_owner(&owner_id);
                    }
                    closed_owners.insert(owner_id.clone());

                    let mut local_sessions = Vec::new();
                    for session in registry.read().unwrap().values() {
                        if session.owner_id().as_deref() != Some(owner_id.as_str()) {
                            continue;
                        }
                        let transferred = transfer_by_session.get(&session.id()).is_some_and(
                            |target_owner_id| {
                                session.transfer_owner(&owner_id, target_owner_id)
                            },
                        );
                        if !transferred {
                            local_sessions.push(Arc::clone(session));
                        }
                    }

                    let mut remote_session_ids = Vec::new();
                    for session in context.mesh_runtime.summaries().await {
                        if session.owner_id.as_deref() != Some(owner_id.as_str()) {
                            continue;
                        }
                        let transferred = match transfer_by_session.get(&session.id) {
                            Some(target_owner_id) => {
                                context
                                    .mesh_runtime
                                    .transfer_owner(&session.id, &owner_id, target_owner_id)
                                    .await
                            }
                            None => false,
                        };
                        if !transferred {
                            remote_session_ids.push(session.id);
                        }
                    }
                    (local_sessions, remote_session_ids)
                };

                // Mutation above is complete before the potentially slower
                // process ladders and remote detach work. A target owner that
                // closes now observes every transferred session.
                for session in local_sessions {
                    for view_id in remove_session_attachments(attached, &session.id()) {
                        session.detach_view(&view_id, client_id);
                    }
                    // One failed termination must not strand the owner's
                    // remaining sessions in the registry. Tracked for the same
                    // reason as the wire terminate, and more urgently: this
                    // removes a whole cohort at once, and an owner closed just
                    // before a shutdown would otherwise leave every one of them
                    // dying where no snapshot can see them.
                    if let Err(error) = context.shutdown.terminate_tracked(
                        &session,
                        TerminationSource::User,
                        None,
                    ) {
                        eprintln!(
                            "[ghosttea] failed to terminate session {} while closing owner {owner_id}: {error:#}",
                            session.id()
                        );
                    }
                    remove_session_view_owners(context, &session.id());
                    let session_id = session.id();
                    if context
                        .tombstones
                        .remove_with_cause(registry, &session_id)
                        .is_some()
                    {
                        let _ = context
                            .lifecycle_tx
                            .send(SessionLifecycleEvent::Removed { session_id });
                    }
                }
                for session_id in remote_session_ids {
                    context.mesh_runtime.close_session(&session_id).await;
                    remove_session_attachments(attached, &session_id);
                    remove_session_view_owners(context, &session_id);
                }
                Ok(ResponseBody::Ok)
            }
            Command::Unknown => bail!("unknown command"),
        }
    }
    .await;
    ResponseEnvelope {
        request_id,
        body: result.unwrap_or_else(|error| {
            let metadata = error.downcast_ref::<session::ControlFailure>();
            ResponseBody::Error {
                message: error.to_string(),
                stage: metadata.map(|metadata| metadata.stage),
                code: metadata.and_then(|metadata| metadata.code),
                os_error: metadata.and_then(|metadata| metadata.os_error),
            }
        }),
    }
}

fn publish_reloaded_config(
    context: &ControlContext,
    config: &Arc<ConfigSnapshot>,
    changed: bool,
) -> Result<()> {
    if !changed {
        return Ok(());
    }
    let presentation = config.terminal_presentation();
    let presentation_changed = {
        let current = context.host_config_tx.borrow();
        current.as_ref() != &presentation
    };
    if presentation_changed {
        context.host_config_tx.send_replace(Arc::new(presentation));
    }
    let colors = &config.terminal;
    let palette = colors
        .palette
        .iter()
        .map(|entry| (entry.index, entry.color))
        .collect::<Vec<_>>();
    let sessions = context
        .registry
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for session in sessions {
        if let Err(error) = session.set_appearance(
            colors.foreground,
            colors.background,
            colors.cursor,
            &palette,
        ) {
            eprintln!(
                "[ghosttea] failed to refresh colors for session {} after configuration reload: {error:#}",
                session.id()
            );
        }
    }
    let config_value =
        serde_json::to_value(config.as_ref()).context("serialize reloaded configuration")?;
    let _ = context.event_tx.send(json!({
        "requestId": 0,
        "type": "config-changed",
        "config": config_value,
    }));
    Ok(())
}

fn validate_grid(cols: u16, rows: u16) -> Result<()> {
    if !(2..=MAX_TERMINAL_COLS).contains(&cols) {
        bail!("cols must be between 2 and {MAX_TERMINAL_COLS}");
    }
    if !(1..=MAX_TERMINAL_ROWS).contains(&rows) {
        bail!("rows must be between 1 and {MAX_TERMINAL_ROWS}");
    }
    Ok(())
}

fn validate_owner(owner_id: Option<&str>) -> Result<()> {
    if owner_id.is_some_and(|owner| owner.is_empty() || owner.len() > 256) {
        bail!("ownerId must contain between 1 and 256 bytes");
    }
    Ok(())
}

fn validate_owner_transfers(
    closing_owner_id: &str,
    transfers: Vec<SessionOwnerTransfer>,
) -> Result<HashMap<String, String>> {
    if transfers.len() > MAX_SESSION_OWNER_TRANSFERS {
        bail!("too many session owner transfers");
    }
    let mut validated = HashMap::with_capacity(transfers.len());
    for transfer in transfers {
        if transfer.session_id.is_empty() || transfer.session_id.len() > 256 {
            bail!("sessionId must contain between 1 and 256 bytes");
        }
        validate_owner(Some(&transfer.owner_id))?;
        if transfer.owner_id == closing_owner_id {
            bail!("a session cannot transfer to its closing owner");
        }
        if validated
            .insert(transfer.session_id.clone(), transfer.owner_id)
            .is_some()
        {
            bail!(
                "duplicate session owner transfer for {}",
                transfer.session_id
            );
        }
    }
    Ok(validated)
}

async fn register_view_owner(
    context: &ControlContext,
    session_id: &str,
    view_id: &str,
    client_id: &str,
    owner_id: Option<&str>,
) -> Result<()> {
    let Some(owner_id) = owner_id else {
        return Ok(());
    };
    validate_owner(Some(owner_id))?;
    // Same order as owner closure: lifecycle first, then the view index. An
    // attach either becomes evidence before the closure snapshot or observes
    // the tombstone and rolls its terminal attachment back.
    let closed_owners = context.closed_owners.lock().await;
    if closed_owners.contains(owner_id) {
        bail!("session owner is already closed");
    }
    context
        .view_owners
        .lock()
        .unwrap()
        .register(session_id, view_id, client_id, owner_id);
    Ok(())
}

fn unregister_view_owner(
    context: &ControlContext,
    session_id: &str,
    view_id: &str,
    client_id: &str,
) {
    context
        .view_owners
        .lock()
        .unwrap()
        .unregister(session_id, view_id, client_id);
}

fn remove_session_view_owners(context: &ControlContext, session_id: &str) {
    context
        .view_owners
        .lock()
        .unwrap()
        .remove_session(session_id);
}

fn checked_dimension(value: u64, name: &str, minimum: u16, maximum: u16) -> Result<u16> {
    let value = u16::try_from(value).with_context(|| format!("{name} is out of range"))?;
    if !(minimum..=maximum).contains(&value) {
        bail!("{name} must be between {minimum} and {maximum}");
    }
    Ok(value)
}

/// Whether this connection is the one that attached the view.
///
/// Ownership only. The epoch the caller sent is checked where it is
/// authoritative — `ViewAuthority::authorize_input` and the controller fence
/// locally, the mesh's own attachment record remotely — and comparing it here
/// against a cached copy would only ever confirm what this connection last
/// wrote down. It is also the sole authorization an offline `selection-text`
/// can have, since a frozen session has no live epoch to present.
fn require_attachment(
    attached: &HashSet<(String, String)>,
    session_id: &str,
    view_id: &str,
) -> Result<()> {
    if attached.contains(&(session_id.to_owned(), view_id.to_owned())) {
        Ok(())
    } else {
        bail!("stale or unknown view attachment")
    }
}

fn remove_session_attachments(
    attached: &mut HashSet<(String, String)>,
    session_id: &str,
) -> Vec<String> {
    let mut removed = Vec::new();
    attached.retain(|(attached_session_id, view_id)| {
        if attached_session_id != session_id {
            return true;
        }
        removed.push(view_id.clone());
        false
    });
    removed
}

/// Release a remote view, fetching the epoch the wire detach has to carry.
///
/// The mesh drops its view record whichever epoch this is; the epoch only
/// decides whether a `Detach` goes out to the host. A view with no current
/// attachment has nothing to tell the host about, which is exactly the case
/// this must not invent an epoch for.
async fn detach_remote_view(context: &ControlContext, session_id: &str, view_id: &str) {
    let attachment_epoch = context
        .mesh_runtime
        .current_attachment(session_id, view_id)
        .await
        .map_or(0, |(attachment_epoch, _)| attachment_epoch);
    context
        .mesh_runtime
        .detach_view(session_id, view_id, attachment_epoch)
        .await;
}

/// The view's current sequence, for responses that must land inside the
/// per-view ordering fence. `None` for a session the mesh tracks no lifecycle
/// for, which is the pre-lifecycle path clients already handle.
async fn remote_view_state_seq(
    context: &ControlContext,
    session_id: &str,
    view_id: &str,
) -> Option<u64> {
    context
        .mesh_runtime
        .session_lifecycle(session_id)
        .await?
        .views
        .iter()
        .find(|record| record.local_view_id == view_id)
        .map(|record| record.view_state_seq)
}

/// What the mesh says a remote session's lifecycle is, if it says anything.
///
/// Returned rather than reduced to a boolean because the two callers want
/// opposite defaults for "the mesh has nothing to say", and burying that in a
/// helper is how one of them silently gets the other's answer. A mesh with no
/// lifecycle is the pre-lifecycle one: `selection-text` still asks the host,
/// and `refresh-session` still re-renders locally, exactly as each did before.
async fn remote_lifecycle_state(
    context: &ControlContext,
    session_id: &str,
) -> Option<mesh::RemoteLifecycleState> {
    context
        .mesh_runtime
        .session_lifecycle(session_id)
        .await
        .map(|lifecycle| lifecycle.state)
}

/// The complete reconciliation object for one remote session.
///
/// Control state is advisory here and says so with `controlRevision: 0`: a 1.4
/// host publishes no revisions and cannot express a cleared controller, so the
/// best this can report is the last one observed. Size falls back to the
/// replica's own dimensions, which are real, rather than to zeros.
async fn remote_session_state(
    context: &ControlContext,
    lifecycle: &mesh::RemoteSessionLifecycle,
) -> ResponseBody {
    // Asked of the mesh rather than kept here. The daemon used to shadow the
    // last controller it saw, because nothing else could answer; the mesh now
    // owns that state, and a second copy could only ever disagree with it — in
    // exactly the case reconciliation exists to repair.
    let control = context
        .mesh_runtime
        .control_state(&lifecycle.session_id)
        .await;
    let (controller, control_revision, cols, rows, layout_epoch) = match control {
        Some(state) => (
            state.controller.map(|controller| RemoteControllerInfo {
                view_id: controller.view_id,
                control_epoch: controller.control_epoch,
            }),
            state.control_revision,
            state.cols,
            state.rows,
            state.layout_epoch,
        ),
        None => {
            // No control state observed at all: report the replica's real size
            // and the sentinel, never an invented revision to CAS against.
            let (cols, rows) = context
                .mesh_runtime
                .summary(&lifecycle.session_id)
                .await
                .map_or((0, 0), |summary| (summary.cols, summary.rows));
            (None, LEGACY_CONTROL_REVISION, cols, rows, 0)
        }
    };
    ResponseBody::RemoteSessionState {
        lifecycle_seq: lifecycle.lifecycle_seq,
        device_id: lifecycle.device_id.clone(),
        device_name: lifecycle.device_name.clone(),
        state: lifecycle.state,
        reason: lifecycle.reason,
        exit: lifecycle.exit,
        attempt: lifecycle.attempt,
        next_retry_ms: lifecycle.next_retry_ms,
        last_contact_ms: lifecycle.last_contact_ms,
        controller,
        control_revision,
        cols,
        rows,
        layout_epoch,
        views: lifecycle.views.iter().map(ViewStateRecord::from).collect(),
    }
}

/// Claims the one resume command a session may have in flight.
///
/// The mesh's own engine now takes the same single-flight lock a manual retry
/// does, so a dial can no longer race a dial. What is left for the daemon is
/// the queue in front of it: without this, two clicks of Retry would each wait
/// out the engine's attempt and then ask for one more. The duplicate answers
/// with the state the running attempt has reached, which is the same
/// conclusion it would have waited for. Released on drop, so a failed attempt
/// never locks the session out of the next one.
struct ReconnectInFlight<'a> {
    context: &'a ControlContext,
    session_id: String,
}

impl<'a> ReconnectInFlight<'a> {
    fn enter(context: &'a ControlContext, session_id: &str) -> Option<Self> {
        let claimed = context
            .reconnects
            .lock()
            .unwrap()
            .insert(session_id.to_owned());
        claimed.then(|| Self {
            context,
            session_id: session_id.to_owned(),
        })
    }
}

impl Drop for ReconnectInFlight<'_> {
    fn drop(&mut self) {
        self.context
            .reconnects
            .lock()
            .unwrap()
            .remove(&self.session_id);
    }
}

async fn serve_frames(mut listener: ipc::Listener, token: String, frames: FrameHub) -> Result<()> {
    loop {
        let mut socket = listener.accept().await?;
        let token = token.clone();
        let frames = frames.clone();
        let (mut rx, mut last_seen_ordinal) = frames.subscribe();
        tokio::spawn(async move {
            match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut socket, &token)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => return,
            }
            let (mut reader, mut writer) = tokio::io::split(socket);
            let mut subscription_starts = HashMap::<u64, u64>::new();
            // Assembled outside the `select!` for the same reason as the
            // control loop, and with more provocation: frames arrive at render
            // rate, so a subscription update spanning two reads would be
            // interrupted almost every time.
            let mut inbound = Vec::<u8>::new();
            let mut chunk = vec![0_u8; CONTROL_READ_CHUNK];
            loop {
                let framed = match take_frame(&mut inbound, MAX_FRAME_SUBSCRIPTION_BYTES) {
                    Ok(framed) => framed,
                    Err(_) => break,
                };
                if let Some(packet) = framed {
                    let Ok(subscription) = serde_json::from_slice::<FrameSubscription>(&packet)
                    else {
                        break;
                    };
                    if subscription.session_handles.len() > MAX_FRAME_SUBSCRIPTIONS {
                        break;
                    }
                    let Ok(parsed) = subscription
                        .session_handles
                        .into_iter()
                        .map(|handle| handle.parse::<u64>())
                        .collect::<Result<HashSet<_>, _>>()
                    else {
                        break;
                    };
                    let subscription_ordinal = frames.current_ordinal();
                    subscription_starts.retain(|handle, _| parsed.contains(handle));
                    for handle in parsed {
                        subscription_starts
                            .entry(handle)
                            .or_insert(subscription_ordinal);
                    }
                    let acknowledgement = serde_json::to_vec(&json!({
                        "type": "subscription-ack",
                        "requestId": subscription.request_id,
                    }))
                    .unwrap();
                    if write_packet(&mut writer, &acknowledgement).await.is_err() {
                        break;
                    }
                    continue;
                }
                tokio::select! {
                    read = reader.read(&mut chunk) => match read {
                        Ok(0) | Err(_) => break,
                        Ok(read) => inbound.extend_from_slice(&chunk[..read]),
                    },
                    frame = rx.recv() => match frame {
                        Ok(frame) if frame.len() <= MAX_FRAME_BYTES => {
                            if frame.ordinal <= last_seen_ordinal {
                                continue;
                            }
                            if frame.ordinal > last_seen_ordinal.saturating_add(1) {
                                let first = last_seen_ordinal.saturating_add(1);
                                let last = frame.ordinal.saturating_sub(1);
                                if let Some(notice) = frame_gap_notice(
                                    &frames,
                                    first,
                                    last,
                                    &subscription_starts,
                                )
                                    && write_packet(&mut writer, &notice).await.is_err()
                                {
                                    break;
                                }
                            }
                            last_seen_ordinal = frame.ordinal;
                            if subscription_starts
                                .get(&frame.session_handle)
                                .is_some_and(|start| frame.ordinal > *start)
                                && write_packet(&mut writer, &frame).await.is_err()
                            {
                                break;
                            }
                        }
                        Ok(_) => break,
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            let first = last_seen_ordinal.saturating_add(1);
                            let last = last_seen_ordinal.saturating_add(skipped);
                            last_seen_ordinal = last;
                            if let Some(notice) = frame_gap_notice(
                                &frames,
                                first,
                                last,
                                &subscription_starts,
                            )
                                && write_packet(&mut writer, &notice).await.is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });
    }
}

fn frame_gap_notice(
    frames: &FrameHub,
    first_ordinal: u64,
    last_ordinal: u64,
    subscription_starts: &HashMap<u64, u64>,
) -> Option<Vec<u8>> {
    let (handles, history_complete) =
        frames.affected_handles(first_ordinal, last_ordinal, subscription_starts);
    if handles.is_empty() {
        return None;
    }
    Some(
        serde_json::to_vec(&json!({
            "type": "frame-gap",
            "skipped": last_ordinal.saturating_sub(first_ordinal).saturating_add(1),
            "sessionHandles": handles.into_iter().map(|handle| handle.to_string()).collect::<Vec<_>>(),
            "historyComplete": history_complete,
        }))
        .unwrap(),
    )
}

#[cfg(test)]
fn frame_session_handle(frame: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(frame.get(8..16)?.try_into().ok()?))
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    /// An endpoint name no other test shares, in the two forms `ipc::Listener`
    /// accepts: a socket path on Unix, a pipe name on Windows.
    struct Endpoint {
        name: String,
        /// Never read: held so the socket's directory outlives the test.
        #[cfg(unix)]
        #[allow(dead_code)]
        directory: tempfile::TempDir,
    }

    fn unique_endpoint(label: &str) -> Endpoint {
        #[cfg(windows)]
        {
            let id = uuid::Uuid::new_v4();
            Endpoint {
                name: format!(r"\\.\pipe\ghosttea-service-test-{label}-{id}"),
            }
        }
        #[cfg(unix)]
        {
            let directory = tempfile::tempdir().unwrap();
            let name = directory
                .path()
                .join(format!("{label}.sock"))
                .to_string_lossy()
                .into_owned();
            Endpoint { name, directory }
        }
    }

    /// The client half of a control endpoint: a socket on Unix, a named pipe
    /// on Windows.
    #[cfg(unix)]
    type ControlStream = tokio::net::UnixStream;
    #[cfg(windows)]
    type ControlStream = tokio::net::windows::named_pipe::NamedPipeClient;

    /// A running service plus the pieces a test needs to talk to it.
    struct TestService {
        handle: ServiceHandle,
        serving: tokio::task::JoinHandle<Result<()>>,
        control: String,
        frame: String,
        token: String,
        _control_endpoint: Endpoint,
        _frame_endpoint: Endpoint,
    }

    fn start_test_service(label: &str) -> TestService {
        start_test_service_with_mesh(label, None)
    }

    fn start_test_service_with_mesh(label: &str, mesh: Option<TestMesh>) -> TestService {
        let control_endpoint = unique_endpoint(&format!("{label}-control"));
        let frame_endpoint = unique_endpoint(&format!("{label}-frames"));
        let token = "shutdown-test-token".to_owned();
        let mut service = TerminalService::new(TerminalServiceConfig {
            control_socket: control_endpoint.name.clone(),
            frame_socket: frame_endpoint.name.clone(),
            auth_token: token.clone(),
        })
        .with_text_engine(TextEngine::discover().unwrap());
        if let Some(mesh) = mesh {
            service = service.with_terminal_mesh(mesh);
        }
        let listeners = service.bind().unwrap();
        let (handle, serving) = service.serve_managed(listeners);
        TestService {
            handle,
            serving: tokio::spawn(serving),
            control: control_endpoint.name.clone(),
            frame: frame_endpoint.name.clone(),
            token,
            _control_endpoint: control_endpoint,
            _frame_endpoint: frame_endpoint,
        }
    }

    /// Dial the control endpoint the way a real client must.
    ///
    /// A Unix socket connects once; a named pipe has to retry while the
    /// listener is between instances or has none idle, mirroring `openEndpoint`
    /// in the Node client and `ipc`'s own tests.
    #[cfg(unix)]
    async fn dial_control(endpoint: &str) -> ControlStream {
        tokio::net::UnixStream::connect(endpoint)
            .await
            .expect("control endpoint should accept a client")
    }

    #[cfg(windows)]
    async fn dial_control(endpoint: &str) -> ControlStream {
        /// The pipe exists but every instance is taken.
        const ERROR_PIPE_BUSY: i32 = 231;
        /// The listener is between instances, so the name is briefly absent.
        const ERROR_FILE_NOT_FOUND: i32 = 2;

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint) {
                Ok(client) => return client,
                Err(error)
                    if matches!(
                        error.raw_os_error(),
                        Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
                    ) && Instant::now() < deadline => {}
                Err(error) => panic!("failed to dial {endpoint}: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn connect_control(service: &TestService) -> ControlStream {
        let mut stream = dial_control(&service.control).await;
        write_packet(&mut stream, service.token.as_bytes())
            .await
            .unwrap();
        let acknowledgement = read_packet(&mut stream, 64).await.unwrap();
        assert_eq!(acknowledgement, b"ok");
        stream
    }

    async fn connect_frames(service: &TestService) -> ControlStream {
        let mut stream = dial_control(&service.frame).await;
        write_packet(&mut stream, service.token.as_bytes())
            .await
            .unwrap();
        let acknowledgement = read_packet(&mut stream, 64).await.unwrap();
        assert_eq!(acknowledgement, b"ok");
        stream
    }

    fn long_running_spawn_options() -> SpawnOptions {
        #[cfg(unix)]
        let (executable, args) = (
            "/bin/sh".to_owned(),
            vec!["-c".to_owned(), "sleep 30".to_owned()],
        );
        #[cfg(windows)]
        let (executable, args) = (
            windows_shell(),
            vec![
                "/d".to_owned(),
                "/c".to_owned(),
                "ping".to_owned(),
                "-n".to_owned(),
                "60".to_owned(),
                "127.0.0.1".to_owned(),
            ],
        );
        SpawnOptions {
            executable,
            args,
            cwd: None,
            env: HashMap::new(),
            environment: None,
            cols: 40,
            rows: 10,
            persistence: Persistence::TerminateWithApp,
            program_kind: session::SessionProgramKind::Application,
            owner_id: None,
            scrollback_bytes: None,
        }
    }

    #[tokio::test]
    async fn dropping_an_unpolled_managed_service_refuses_session_access() {
        let control = unique_endpoint("unpolled-access-control");
        let frames = unique_endpoint("unpolled-access-frames");
        let service = TerminalService::new(TerminalServiceConfig {
            control_socket: control.name.clone(),
            frame_socket: frames.name.clone(),
            auth_token: "secret".to_owned(),
        })
        .with_text_engine(TextEngine::discover().unwrap());
        let listeners = service.bind().unwrap();
        let (handle, serving) = service.serve_managed(listeners);

        drop(serving);

        let access = tokio::time::timeout(Duration::from_secs(1), handle.sessions())
            .await
            .expect("session readiness hung after the serving future was dropped");
        assert!(access.is_err());
    }

    #[tokio::test]
    async fn in_process_access_shares_registry_frames_spawn_and_lifecycle() {
        let service = start_test_service("in-process-session-access");
        let access = tokio::time::timeout(Duration::from_secs(10), service.handle.sessions())
            .await
            .expect("session access did not become ready")
            .unwrap();
        let mut lifecycle = access.subscribe_lifecycle();

        // Handle-born sessions take the exact service path and immediately
        // appear to a legacy control client.
        let spawned = access.spawn(long_running_spawn_options()).await.unwrap();
        let spawned_id = spawned.id();
        let spawned_summary = spawned.summary();
        assert_eq!(
            spawned_summary.persistence,
            Some(Persistence::TerminateWithApp)
        );
        assert!(
            spawned_summary
                .scrollback_bytes
                .is_some_and(|bytes| bytes > 0)
        );
        let created = tokio::time::timeout(Duration::from_secs(5), lifecycle.recv())
            .await
            .unwrap()
            .unwrap();
        match created {
            SessionLifecycleEvent::Created { session } => {
                assert!(Arc::ptr_eq(&session, &spawned));
            }
            _ => panic!("expected a created lifecycle event"),
        }
        assert!(Arc::ptr_eq(&access.session(&spawned_id).unwrap(), &spawned));

        let mut client = connect_control(&service).await;
        let listed = request(
            &mut client,
            json!({ "requestId": 1, "type": "list-sessions" }),
        )
        .await;
        assert!(
            listed["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == spawned_id)
        );

        // A UDS-born session is the same Arc the in-process host observes.
        let created_over_uds =
            request(&mut client, owned_long_running_session(2, "uds-owner")).await;
        let uds_id = created_over_uds["session"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let uds_session = access
            .session(&uds_id)
            .expect("UDS session missing from handle");
        let uds_created = tokio::time::timeout(Duration::from_secs(5), lifecycle.recv())
            .await
            .unwrap()
            .unwrap();
        match uds_created {
            SessionLifecycleEvent::Created { session } => {
                assert!(Arc::ptr_eq(&session, &uds_session));
            }
            _ => panic!("expected the UDS session's created lifecycle event"),
        }

        // Both the direct subscriber and the legacy frame socket consume the
        // same hub publication; the socket strips only the hub metadata.
        let mut frame_client = connect_frames(&service).await;
        write_packet(
            &mut frame_client,
            &serde_json::to_vec(&json!({
                "type": "subscribe",
                "requestId": 3,
                "sessionHandles": [uds_session.summary().handle],
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let acknowledgement = read_packet(&mut frame_client, MAX_FRAME_SUBSCRIPTION_BYTES)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&acknowledgement).unwrap()["type"],
            "subscription-ack"
        );
        let (mut frames, baseline) = access.frames().subscribe();
        uds_session.attach_view("host-view", "host-client").unwrap();
        let packet = tokio::time::timeout(Duration::from_secs(5), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(packet.ordinal > baseline);
        assert_eq!(
            packet.session_handle.to_string(),
            uds_session.summary().handle
        );
        let socket_packet = tokio::time::timeout(
            Duration::from_secs(5),
            read_packet(&mut frame_client, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&socket_packet[..], &packet[..]);

        request(
            &mut client,
            json!({
                "requestId": 4,
                "type": "terminate",
                "sessionId": spawned_id,
                "source": "user",
            }),
        )
        .await;
        let mut saw_removed = false;
        let mut saw_exited = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !(saw_removed && saw_exited) && Instant::now() < deadline {
            let Ok(event) =
                tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), lifecycle.recv())
                    .await
            else {
                break;
            };
            let event = event.unwrap();
            match event {
                SessionLifecycleEvent::Removed { session_id } if session_id == spawned_id => {
                    saw_removed = true;
                }
                SessionLifecycleEvent::Exited { session_id, .. } if session_id == spawned_id => {
                    saw_exited = true;
                }
                _ => {}
            }
        }
        assert!(
            saw_removed && saw_exited,
            "missing lifecycle event(s): removed={saw_removed}, exited={saw_exited}"
        );

        let _ = request(
            &mut client,
            json!({
                "requestId": 5,
                "type": "terminate",
                "sessionId": uds_id,
                "source": "user",
            }),
        )
        .await;
        service
            .handle
            .shutdown(Duration::from_secs(5))
            .await
            .unwrap();
        service.serving.await.unwrap().unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn in_process_spawn_applies_the_services_private_environment_strip() {
        let control_endpoint = unique_endpoint("in-process-private-env-control");
        let frame_endpoint = unique_endpoint("in-process-private-env-frames");
        let token = "private-env-test-token".to_owned();
        let service = TerminalService::new(TerminalServiceConfig {
            control_socket: control_endpoint.name.clone(),
            frame_socket: frame_endpoint.name.clone(),
            auth_token: token.clone(),
        })
        .with_text_engine(TextEngine::discover().unwrap())
        // PATH is a harmless inherited variable whose absence the child can
        // report without mutating this test process's global environment.
        .with_private_env_prefixes(["PATH"])
        .unwrap();
        let listeners = service.bind().unwrap();
        let (handle, serving) = service.serve_managed(listeners);
        let serving = tokio::spawn(serving);
        let access = handle.sessions().await.unwrap();
        let mut lifecycle = access.subscribe_lifecycle();

        let mut options = long_running_spawn_options();
        assert!(std::path::Path::new("/usr/bin/printenv").exists());
        options.executable = "/usr/bin/printenv".to_owned();
        options.args = vec!["PATH".to_owned()];
        options.persistence = Persistence::KeepUntilExplicitClose;
        let spawned = access.spawn(options).await.unwrap();

        let exit = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycle.recv())
                .await
                .expect("child environment probe did not exit")
                .unwrap();
            if let SessionLifecycleEvent::Exited { session_id, exit } = event
                && session_id == spawned.id()
            {
                break exit;
            }
        };
        assert_eq!(
            exit.exit_code,
            Some(1),
            "printenv found PATH even though the service configured it as private"
        );

        handle.shutdown(Duration::from_secs(5)).await.unwrap();
        serving.await.unwrap().unwrap();
    }

    /// Send a command and return its response, skipping pushed events.
    async fn request(stream: &mut ControlStream, command: Value) -> Value {
        write_packet(stream, &serde_json::to_vec(&command).unwrap())
            .await
            .unwrap();
        loop {
            let packet = read_packet(stream, MAX_CONTROL_BYTES).await.unwrap();
            let response: Value = serde_json::from_slice(&packet).unwrap();
            if response["requestId"] != 0 {
                return response;
            }
        }
    }

    /// Long enough for the child below to become genuinely hard to kill — on
    /// Unix for the shell to install its traps, on Windows for the shell to
    /// have started its grandchild.
    ///
    /// Until then the ladder's opening interrupt simply ends it, which makes a
    /// "stubborn" child conclude in microseconds and quietly turns these tests
    /// into assertions about nothing.
    const CHILD_SETTLE: Duration = Duration::from_millis(600);

    /// Resolve the command shell the way the Windows integration fixtures do,
    /// so these tests spawn what that suite already proves is spawnable.
    #[cfg(windows)]
    fn windows_shell() -> String {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
    }

    /// A child that survives the ladder's opening interrupt, so terminating it
    /// has to escalate.
    ///
    /// On Unix it ignores the interrupt and SIGTERM, forcing the walk to
    /// SIGKILL. On Windows it is the shell-plus-grandchild shape the Windows
    /// integration fixture already relies on for exactly this property: the
    /// interrupt does not end it, and only the process-tree sweep reaches the
    /// grandchild.
    fn stubborn_session(request_id: u64) -> Value {
        #[cfg(unix)]
        let (executable, args) = (
            "/bin/sh".to_owned(),
            json!(["-c", "trap '' INT TERM; sleep 30"]),
        );
        #[cfg(windows)]
        let (executable, args) = (
            windows_shell(),
            json!(["/d", "/c", "ping", "-n", "60", "127.0.0.1"]),
        );
        json!({
            "requestId": request_id,
            "type": "create-session",
            "options": {
                "executable": executable,
                "args": args,
                "env": {},
                "cols": 40,
                "rows": 10,
                "persistence": "terminate-with-app",
                "programKind": "application",
            },
        })
    }

    /// A child that ends on its own the moment it starts.
    fn short_lived_session(request_id: u64) -> Value {
        #[cfg(unix)]
        let (executable, args) = ("/bin/sh".to_owned(), json!(["-c", "exit 0"]));
        #[cfg(windows)]
        let (executable, args) = (windows_shell(), json!(["/d", "/c", "exit", "0"]));
        json!({
            "requestId": request_id,
            "type": "create-session",
            "options": {
                "executable": executable,
                "args": args,
                "env": {},
                "cols": 20,
                "rows": 4,
                "persistence": "terminate-with-app",
                "programKind": "application",
            },
        })
    }

    fn owned_long_running_session(request_id: u64, owner_id: &str) -> Value {
        #[cfg(unix)]
        let (executable, args) = ("/bin/sh".to_owned(), json!(["-c", "sleep 30"]));
        #[cfg(windows)]
        let (executable, args) = (
            windows_shell(),
            json!(["/d", "/c", "ping", "-n", "60", "127.0.0.1"]),
        );
        json!({
            "requestId": request_id,
            "type": "create-session",
            "options": {
                "executable": executable,
                "args": args,
                "env": {},
                "cols": 40,
                "rows": 10,
                "persistence": "terminate-with-app",
                "programKind": "application",
                "ownerId": owner_id,
            },
        })
    }

    #[tokio::test]
    async fn spawn_refusals_preserve_message_and_add_typed_metadata() {
        let service = start_test_service("structured-spawn-error");
        let mut client = connect_control(&service).await;
        #[cfg(unix)]
        let missing_executable = "/definitely/not/a/ghosttea/executable";
        #[cfg(windows)]
        let missing_executable = r"C:\definitely\not\a\ghosttea\executable.exe";
        let response = request(
            &mut client,
            json!({
                "requestId": 1,
                "type": "create-session",
                "options": {
                    "executable": missing_executable,
                    "args": [],
                    "cols": 40,
                    "rows": 10,
                    "persistence": "terminate-with-app",
                    "programKind": "application",
                },
            }),
        )
        .await;
        assert_eq!(response["type"], "error");
        assert_eq!(response["message"], "failed to spawn PTY command");
        assert_eq!(response["stage"], "spawn");
        assert_eq!(response["code"], "executable-not-found");
        assert!(response["osError"].is_number());
    }

    #[tokio::test]
    async fn session_summary_echoes_effective_scrollback_cap() {
        let service = start_test_service("scrollback-summary");
        let mut client = connect_control(&service).await;

        let mut disabled = short_lived_session(1);
        disabled["options"]["scrollbackBytes"] = json!(0);
        let disabled = request(&mut client, disabled).await;
        assert_eq!(disabled["type"], "session-created");
        assert_eq!(disabled["session"]["scrollbackBytes"], 0);

        let inherited = request(&mut client, short_lived_session(2)).await;
        assert_eq!(inherited["type"], "session-created");
        assert_eq!(
            inherited["session"]["scrollbackBytes"],
            ghosttea_config::DEFAULT_SCROLLBACK_BYTES,
        );
    }

    #[tokio::test]
    async fn owner_closure_transfers_layout_and_live_view_survivors_atomically() {
        let service = start_test_service("owner-transfer");
        let mut client = connect_control(&service).await;
        let live_view = request(&mut client, owned_long_running_session(1, "tab-a")).await;
        let layout_only = request(&mut client, owned_long_running_session(2, "tab-a")).await;
        let live_view_id = live_view["session"]["id"].as_str().unwrap().to_owned();
        let layout_only_id = layout_only["session"]["id"].as_str().unwrap().to_owned();

        let attached = request(
            &mut client,
            json!({
                "requestId": 3,
                "type": "attach-session",
                "sessionId": live_view_id.clone(),
                "viewId": "pane-b",
                "ownerId": "tab-b",
            }),
        )
        .await;
        assert_eq!(attached["type"], "view-attached");

        let closed = request(
            &mut client,
            json!({
                "requestId": 4,
                "type": "close-session-owner",
                "ownerId": "tab-a",
                "transfers": [{ "sessionId": layout_only_id.clone(), "ownerId": "tab-b" }],
            }),
        )
        .await;
        assert_eq!(closed["type"], "ok");

        for (request_id, session_id) in [(5, &live_view_id), (6, &layout_only_id)] {
            let session = request(
                &mut client,
                json!({
                    "requestId": request_id,
                    "type": "get-session",
                    "sessionId": session_id,
                }),
            )
            .await;
            assert_eq!(session["type"], "session");
            assert_eq!(session["session"]["ownerId"], "tab-b");
            assert_eq!(session["session"]["exited"], false);
        }

        let ended = request(
            &mut client,
            json!({
                "requestId": 7,
                "type": "close-session-owner",
                "ownerId": "tab-b",
            }),
        )
        .await;
        assert_eq!(ended["type"], "ok");
        let missing = request(
            &mut client,
            json!({
                "requestId": 8,
                "type": "get-session",
                "sessionId": live_view_id.clone(),
            }),
        )
        .await;
        assert_eq!(missing["type"], "error");

        service
            .handle
            .shutdown(Duration::from_secs(8))
            .await
            .unwrap();
        service.serving.await.unwrap().unwrap();
    }

    /// The drain ends every live session and says so, and the service refuses
    /// new ones from the moment it starts — including creates carrying no
    /// owner, which the per-owner tombstone would never have caught.
    #[tokio::test]
    async fn shutdown_drains_live_sessions_and_refuses_new_ones() {
        let service = start_test_service("drain");
        let mut client = connect_control(&service).await;
        let created = request(&mut client, stubborn_session(1)).await;
        assert_eq!(created["type"], "session-created");
        tokio::time::sleep(CHILD_SETTLE).await;

        // Connected before the drain starts, so only the create races it —
        // dialling mid-drain would race the listeners closing instead, and
        // turn a clean assertion into a connection error.
        let mut latecomer = connect_control(&service).await;

        let handle = service.handle.clone();
        let draining = tokio::spawn(async move { handle.shutdown(Duration::from_secs(8)).await });

        // Mid-drain, on that second connection: the create must be refused,
        // and refused without an owner id, which is the case per-owner closure
        // structurally cannot cover.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let refused = request(&mut latecomer, stubborn_session(2)).await;
        assert_eq!(
            refused["type"], "error",
            "a create during a drain must fail"
        );
        assert!(
            refused["message"]
                .as_str()
                .unwrap()
                .contains("shutting down"),
            "the refusal must say why: {refused}"
        );

        let report = draining.await.unwrap().unwrap();
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "a SIGKILL-able child must not be reported unresponsive"
        );
        assert_eq!(
            report.drained + report.killed,
            1,
            "the live session must be accounted for exactly once: {report:?}"
        );
        assert_eq!(report.pending_creates, 0);
        assert!(service.serving.await.unwrap().is_ok());
        assert!(
            service
                .handle
                .shutdown(Duration::from_secs(1))
                .await
                .is_err(),
            "a second shutdown has nothing left to stop"
        );
    }

    /// A budget smaller than the default ladder compresses it rather than
    /// expiring by construction: the ladder alone is 5s, so finishing inside
    /// a 3s budget can only happen if the phases scaled.
    /// Unix-only by nature, not by convenience: grace scaling exists only on
    /// the Unix ladder. Windows has a single grace and relies on the deadline
    /// jump alone, so there is no compression there to assert.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_compresses_the_ladder_to_fit_a_small_budget() {
        let service = start_test_service("budget");
        let mut client = connect_control(&service).await;
        assert_eq!(
            request(&mut client, stubborn_session(1)).await["type"],
            "session-created"
        );
        tokio::time::sleep(CHILD_SETTLE).await;

        let started = Instant::now();
        let report = service
            .handle
            .shutdown(Duration::from_secs(3))
            .await
            .unwrap();
        let spent = started.elapsed();

        assert!(
            spent < Duration::from_millis(4_500),
            "the drain outran its budget, so the ladder did not scale: {spent:?}"
        );
        // Guards the premise: a child that died to the opening interrupt would
        // finish in microseconds and make the bound above vacuous.
        assert!(
            spent > Duration::from_millis(700),
            "the child was not actually stubborn, so this proved nothing: {spent:?}"
        );
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "a healthy-but-stubborn child must not be booked unresponsive: {report:?}"
        );
        assert_eq!(report.drained + report.killed, 1);
    }

    /// The leak the dying set exists for: a wire `terminate` drops the registry
    /// entry immediately while the child can still take seconds to die, so a
    /// shutdown arriving in that window must still find and await it.
    #[tokio::test]
    async fn shutdown_awaits_sessions_already_dying_outside_the_registry() {
        let service = start_test_service("dying");
        let mut client = connect_control(&service).await;
        let created = request(&mut client, stubborn_session(1)).await;
        let session_id = created["session"]["id"].as_str().unwrap().to_owned();
        tokio::time::sleep(CHILD_SETTLE).await;

        // Removed from the registry here, but its ladder is still running.
        let terminated = request(
            &mut client,
            json!({ "requestId": 2, "type": "terminate", "sessionId": session_id }),
        )
        .await;
        assert_eq!(terminated["type"], "ok");
        let listed = request(
            &mut client,
            json!({ "requestId": 3, "type": "list-sessions" }),
        )
        .await;
        assert!(
            !listed["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == session_id.as_str()),
            "the wire terminate should already have unregistered it"
        );

        let report = service
            .handle
            .shutdown(Duration::from_secs(8))
            .await
            .unwrap();

        assert_eq!(
            report.drained + report.killed,
            1,
            "a session dying outside the registry was not drained: {report:?}"
        );
        assert_eq!(report.unresponsive, Vec::<String>::new());
    }

    /// Closing tabs must not accumulate terminals.
    ///
    /// Tracking a dying session is what lets a drain find it, but tracking it
    /// *strongly* and pruning only during a shutdown would pin every closed
    /// session's PTY master, writer, shutdown pipe and scrollback for the life
    /// of the host — a leak per closed tab, on the ordinary path, with no
    /// shutdown in sight. This drives the wire `terminate` path specifically,
    /// since that is the one that leaked.
    #[tokio::test]
    async fn terminating_sessions_does_not_accumulate_them() {
        let service = start_test_service("churn");
        let mut client = connect_control(&service).await;
        let mut ids = Vec::new();
        for round in 0..12 {
            let created = request(&mut client, short_lived_session(100 + round)).await;
            let session_id = created["session"]["id"].as_str().unwrap().to_owned();
            let _ = request(
                &mut client,
                json!({
                    "requestId": 200 + round,
                    "type": "terminate",
                    "sessionId": session_id,
                }),
            )
            .await;
            ids.push(session_id);
        }

        // Every one has been terminated, so once they conclude none may still
        // be held alive — without a shutdown having to sweep the set for it.
        let settled = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if service.handle.retained_sessions() == 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert!(
            settled.is_ok(),
            "{} of {} terminated sessions were still held alive",
            service.handle.retained_sessions(),
            ids.len()
        );
    }

    /// A session already on its way out keeps the source that asked for it,
    /// while one the drain ends is stamped `service-shutdown`. The honest
    /// report is who asked first, not who happened to be last.
    ///
    /// These are the crate's first assertions on `ExitOutcome::ServiceTerminated`,
    /// which until now existed only in its declaration and its mapping.
    #[tokio::test]
    async fn shutdown_stamps_only_the_sessions_it_actually_ended() {
        let service = start_test_service("stamps");
        let mut client = connect_control(&service).await;
        let user_closed = request(&mut client, stubborn_session(1)).await;
        let drained = request(&mut client, stubborn_session(2)).await;
        let user_closed_id = user_closed["session"]["id"].as_str().unwrap().to_owned();
        let drained_id = drained["session"]["id"].as_str().unwrap().to_owned();
        tokio::time::sleep(CHILD_SETTLE).await;

        // Starts a ladder under `user` before any shutdown exists.
        assert_eq!(
            request(
                &mut client,
                json!({
                    "requestId": 3,
                    "type": "terminate",
                    "sessionId": user_closed_id,
                    "source": "user",
                }),
            )
            .await["type"],
            "ok"
        );

        // Collect the exit events while the drain runs; they are broadcast, so
        // this connection sees both sessions conclude.
        let exits = Arc::new(Mutex::new(Vec::<Value>::new()));
        let collected = Arc::clone(&exits);
        let (mut reader, _writer) = tokio::io::split(client);
        let collecting = tokio::spawn(async move {
            while let Ok(packet) = read_packet(&mut reader, MAX_CONTROL_BYTES).await {
                let Ok(event) = serde_json::from_slice::<Value>(&packet) else {
                    break;
                };
                if event["type"] == "session-exited" {
                    collected.lock().unwrap().push(event);
                }
            }
        });

        let report = service
            .handle
            .shutdown(Duration::from_secs(8))
            .await
            .unwrap();
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "user-closed={user_closed_id} drained={drained_id} report={report:?}"
        );
        collecting.abort();

        let exits = exits.lock().unwrap();
        let stamp = |session_id: &str| {
            exits
                .iter()
                .find(|event| event["sessionId"] == session_id)
                .map(|event| {
                    (
                        event["requestedTermination"].clone(),
                        event["exitOutcome"].clone(),
                    )
                })
                .unwrap_or_else(|| panic!("no exit event for {session_id}: {exits:?}"))
        };

        assert_eq!(
            stamp(&user_closed_id),
            (json!("user"), json!("user-terminated")),
            "a session already terminating must keep the source that asked first"
        );
        assert_eq!(
            stamp(&drained_id),
            (json!("service-shutdown"), json!("service-terminated")),
            "a session the drain ended must say so"
        );
    }

    /// The library announces readiness to its host instead of printing it.
    ///
    /// This is the behavioral half of the stdout contract; the source guard
    /// below is the half that keeps it from regressing.
    #[tokio::test]
    async fn serve_reports_readiness_to_the_host_rather_than_printing_it() {
        let control = unique_endpoint("ready-control");
        let frames = unique_endpoint("ready-frames");
        let engine = TextEngine::discover().unwrap();
        let expected_family = engine.primary_family().to_owned();
        let expected_mode = engine.font_mode();

        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let service = TerminalService::new(TerminalServiceConfig {
            control_socket: control.name.clone(),
            frame_socket: frames.name.clone(),
            auth_token: "secret".to_owned(),
        })
        .with_text_engine(engine)
        .with_ready(move |info| {
            let _ = ready_tx.send(info);
        });

        // `run` only returns on listener failure, so the readiness signal is
        // the sole way to observe that serving began.
        let serving = tokio::spawn(async move { service.run().await });
        let info = tokio::time::timeout(Duration::from_secs(30), ready_rx)
            .await
            .expect("readiness was never signalled")
            .expect("the service dropped the readiness sender");
        serving.abort();

        assert_eq!(info.primary_family, expected_family);
        assert_eq!(info.font_mode, expected_mode);
    }

    /// Nothing in the library may write to stdout: an embedding host owns that
    /// stream and may be speaking its own protocol on it. The readiness hook
    /// exists so `ghosttead` can print its banner without the library doing so.
    ///
    /// Scans each source only up to its test module, since test code may print
    /// freely. `eprintln!` is deliberately not matched — stderr stays open to
    /// the library for diagnostics.
    #[test]
    fn the_library_never_writes_to_the_host_stdout() {
        fn scan(directory: &std::path::Path, offenders: &mut Vec<String>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    scan(&path, offenders);
                    continue;
                }
                if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                let library = match source.find("#[cfg(test)]") {
                    Some(tests_begin) => &source[..tests_begin],
                    None => &source[..],
                };
                for (index, line) in library.lines().enumerate() {
                    // Drop the stderr macros first: `eprintln!` contains
                    // `println!`, and stderr stays open to the library.
                    let sanitized = line.replace("eprintln!", "").replace("eprint!", "");
                    let writes_stdout = sanitized.contains("println!")
                        || sanitized.contains("print!")
                        || sanitized.contains("stdout()");
                    // A doc comment may legitimately name the macro it replaced.
                    if writes_stdout && !line.trim_start().starts_with("//") {
                        offenders.push(format!(
                            "{}:{}: {}",
                            path.display(),
                            index + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }

        let mut offenders = Vec::new();
        scan(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut offenders,
        );
        assert!(
            offenders.is_empty(),
            "the ghosttea library must not write to the host's stdout; \
             use TerminalService::with_ready and let the host print:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn verifies_local_auth_tokens_without_length_shortcuts() {
        assert!(auth_tokens_equal(b"secret", b"secret"));
        assert!(auth_tokens_equal(b"", b""));
        assert!(!auth_tokens_equal(b"secret", b"secreu"));
        assert!(!auth_tokens_equal(b"secret", b"secret-longer"));
        assert!(!auth_tokens_equal(
            &vec![b'x'; MAX_AUTH_TOKEN_BYTES + 1],
            b"secret",
        ));
    }

    #[test]
    fn validates_host_private_environment_prefixes() {
        let config = TerminalServiceConfig {
            control_socket: "control.sock".to_owned(),
            frame_socket: "frames.sock".to_owned(),
            auth_token: "secret".to_owned(),
        };
        let service = TerminalService::new(config)
            .with_private_env_prefixes(["FIELD_", "FIELD_"])
            .unwrap();
        assert_eq!(service.private_env_prefixes, ["FIELD_"]);

        let config = TerminalServiceConfig {
            control_socket: "control.sock".to_owned(),
            frame_socket: "frames.sock".to_owned(),
            auth_token: "secret".to_owned(),
        };
        assert!(
            TerminalService::new(config)
                .with_private_env_prefixes([""])
                .is_err()
        );
    }

    #[test]
    fn deserializes_typed_commands() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 12,
            "type": "resize",
            "sessionId": "session",
            "viewId": "view",
            "attachmentEpoch": 3,
            "controlEpoch": 4,
            "resizeSequence": 2,
            "cols": 120,
            "rows": 40,
        }))
        .unwrap();
        assert_eq!(envelope.request_id, 12);
        match envelope.command {
            Command::Resize {
                session_id,
                cols,
                rows,
                ..
            } => {
                assert_eq!(session_id, "session");
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("expected resize command"),
        }
    }

    #[test]
    fn deserializes_layout_identity_for_key_events_with_legacy_fallback() {
        let key_command = |unshifted_codepoint: Option<u32>| {
            let mut event = json!({
                "type": "down",
                "key": "w",
                "code": "KeyW",
                "repeat": false,
                "shift": false,
                "control": false,
                "alt": false,
                "meta": false,
            });
            if let Some(codepoint) = unshifted_codepoint {
                event["unshiftedCodepoint"] = json!(codepoint);
            }
            serde_json::from_value::<Envelope>(json!({
                "requestId": 13,
                "type": "send-key",
                "sessionId": "session",
                "viewId": "view",
                "attachmentEpoch": 3,
                "inputSequence": 1,
                "event": event,
            }))
            .unwrap()
        };

        for (value, expected) in [(Some(u32::from('w')), u32::from('w')), (None, 0)] {
            match key_command(value).command {
                Command::SendKey { event, .. } => assert_eq!(event.unshifted_codepoint, expected),
                _ => panic!("expected send-key command"),
            }
        }
    }

    #[test]
    fn frame_subscriptions_and_frame_handles_are_typed() {
        let subscription: FrameSubscription = serde_json::from_value(json!({
            "type": "subscribe",
            "requestId": 9,
            "sessionHandles": ["7", "11"]
        }))
        .unwrap();
        assert_eq!(subscription.request_id, 9);
        assert_eq!(subscription.session_handles, vec!["7", "11"]);

        let mut frame = vec![0_u8; 16];
        frame[8..16].copy_from_slice(&11_u64.to_le_bytes());
        assert_eq!(frame_session_handle(&frame), Some(11));
        assert_eq!(frame_session_handle(&frame[..15]), None);
    }

    #[test]
    fn closed_owner_tombstones_have_a_fixed_capacity() {
        let mut tombstones = OwnerTombstones::default();
        assert!(tombstones.archived.is_none());
        let closed_owner_count = MAX_CLOSED_OWNER_TOMBSTONES + 50_000;
        for index in 0..closed_owner_count {
            tombstones.insert(format!("owner-{index}"));
        }

        assert_eq!(tombstones.recent_owners.len(), MAX_CLOSED_OWNER_TOMBSTONES);
        assert_eq!(tombstones.order.len(), MAX_CLOSED_OWNER_TOMBSTONES);
        assert_eq!(
            tombstones.archived.as_ref().unwrap().len(),
            CLOSED_OWNER_BLOOM_BITS / u64::BITS as usize
        );
        for index in [
            0,
            1_000,
            MAX_CLOSED_OWNER_TOMBSTONES,
            closed_owner_count - 1,
        ] {
            assert!(tombstones.contains(&format!("owner-{index}")));
        }
        assert!(!tombstones.contains("owner-never-closed"));
    }

    #[test]
    fn terminating_a_session_removes_all_of_its_attachment_bookkeeping() {
        let mut attached = HashSet::from([
            ("session-a".to_owned(), "view-1".to_owned()),
            ("session-a".to_owned(), "view-2".to_owned()),
            ("session-b".to_owned(), "view-3".to_owned()),
        ]);

        let mut removed = remove_session_attachments(&mut attached, "session-a");
        removed.sort();
        assert_eq!(removed, vec!["view-1".to_owned(), "view-2".to_owned()]);
        assert_eq!(
            attached,
            HashSet::from([("session-b".to_owned(), "view-3".to_owned())])
        );
    }

    #[test]
    fn deserializes_absolute_terminal_selection_requests() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 14,
            "type": "selection-text",
            "sessionId": "session",
            "viewId": "view",
            "attachmentEpoch": 3,
            "startColumn": 1,
            "startRow": 120,
            "endColumn": 8,
            "endRow": 124,
            "selectAll": false
        }))
        .unwrap();
        match envelope.command {
            Command::SelectionText {
                start_row, end_row, ..
            } => assert_eq!((start_row, end_row), (120, 124)),
            _ => panic!("expected selection-text command"),
        }
    }

    #[test]
    fn config_document_commands_preserve_contents_and_expected_revision() {
        let validate: Envelope = serde_json::from_value(json!({
            "requestId": 41,
            "type": "validate-config-document",
            "contents": "# comment\nbackground = 112233\n"
        }))
        .unwrap();
        assert!(matches!(
            validate.command,
            Command::ValidateConfigDocument { contents }
                if contents == "# comment\nbackground = 112233\n"
        ));

        let replace: Envelope = serde_json::from_value(json!({
            "requestId": 42,
            "type": "replace-config-document",
            "expectedRevision": "raw-revision",
            "contents": "font-size = 14\r\n"
        }))
        .unwrap();
        assert!(matches!(
            replace.command,
            Command::ReplaceConfigDocument {
                expected_revision,
                contents,
            } if expected_revision == "raw-revision" && contents == "font-size = 14\r\n"
        ));
    }

    #[test]
    fn serializes_typed_config_document_conflicts() {
        let value = serde_json::to_value(ResponseEnvelope {
            request_id: 42,
            body: ResponseBody::ConfigDocumentConflict {
                document: ConfigDocument {
                    schema_version: 1,
                    revision: "current-revision".to_owned(),
                    path: "/tmp/config.ghostty".to_owned(),
                    exists: true,
                    contents: "# current\n".to_owned(),
                },
            },
        })
        .unwrap();
        assert_eq!(value["requestId"], 42);
        assert_eq!(value["type"], "config-document-conflict");
        assert_eq!(value["document"]["revision"], "current-revision");
        assert_eq!(value["document"]["contents"], "# current\n");
    }

    #[test]
    fn serializes_typed_responses() {
        let value = serde_json::to_value(ResponseEnvelope {
            request_id: 7,
            body: ResponseBody::Hello {
                protocol_major: CONTROL_PROTOCOL_MAJOR,
                protocol_minor: CONTROL_PROTOCOL_MINOR,
                server_build: "test".to_owned(),
                config_revision: "test-revision".to_owned(),
            },
        })
        .unwrap();
        assert_eq!(value["requestId"], 7);
        assert_eq!(value["type"], "hello");
        assert_eq!(value["protocolMajor"], 1);
    }

    #[test]
    fn activity_events_are_gated_by_the_negotiated_minor_without_hiding_other_events() {
        let activity = json!({ "type": "session-activity-changed" });
        let exit = json!({ "type": "session-exited" });
        assert!(!client_accepts_event(
            &activity,
            ACTIVITY_EVENT_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(
            &activity,
            ACTIVITY_EVENT_PROTOCOL_MINOR
        ));
        assert!(client_accepts_event(&exit, 0));
    }

    /// A client that negotiated an older minor never hears about a birth: the
    /// event did not exist when its expectations were fixed.
    #[test]
    fn creation_events_reach_only_clients_that_negotiated_them() {
        let created = json!({ "type": "session-created" });
        assert!(!client_accepts_event(
            &created,
            SESSION_CREATED_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(
            &created,
            SESSION_CREATED_PROTOCOL_MINOR
        ));
    }

    #[test]
    fn config_events_reach_only_clients_that_negotiated_them() {
        let changed = json!({ "type": "config-changed" });
        assert!(!client_accepts_event(
            &changed,
            CONFIG_EVENT_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(&changed, CONFIG_EVENT_PROTOCOL_MINOR));
    }

    /// The pushed birth reuses the create response's `session` key, so one
    /// event name keeps one shape; `requestId: 0` is what marks it as pushed.
    #[test]
    fn creation_events_carry_the_summary_under_the_response_key() {
        let (event_tx, mut events) = broadcast::channel(4);
        let summary = session::SessionSummary {
            id: "session".to_owned(),
            handle: "7".to_owned(),
            executable: "/bin/zsh".to_owned(),
            cols: 80,
            rows: 24,
            exited: false,
            read_write: true,
            title: None,
            cwd: None,
            bell_count: 0,
            pid: Some(1),
            created_at_ms: 1,
            exit_code: None,
            exit_signal: None,
            requested_termination: None,
            exit_outcome: None,
            owner_id: None,
            persistence: Some(session::Persistence::KeepUntilExit),
            scrollback_bytes: Some(10_000_000),
            activity: session::SessionActivity::default(),
        };

        announce_session_created(&event_tx, &summary);

        let event = events.try_recv().unwrap();
        assert_eq!(event["type"], "session-created");
        assert_eq!(event["requestId"], 0);
        assert_eq!(event["session"]["id"], "session");
        assert_eq!(event["session"]["persistence"], "keep-until-exit");
    }

    #[test]
    fn deserializes_session_reclassification() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 23,
            "type": "set-persistence",
            "sessionId": "session",
            "persistence": "keep-until-explicit-close",
        }))
        .unwrap();
        match envelope.command {
            Command::SetPersistence {
                session_id,
                persistence,
            } => {
                assert_eq!(session_id, "session");
                assert_eq!(persistence, session::Persistence::KeepUntilExplicitClose);
            }
            _ => panic!("expected set-persistence command"),
        }
    }

    #[test]
    fn deserializes_automation_without_view_authority() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 21,
            "type": "automation-input",
            "sessionId": "session",
            "expectedHumanInputEpoch": 4,
            "operation": { "kind": "paste", "text": "hello", "submit": true },
        }))
        .unwrap();
        match envelope.command {
            Command::AutomationInput {
                session_id,
                expected_human_input_epoch,
                operation: AutomationInputOperation::Paste { text, submit },
            } => {
                assert_eq!(session_id, "session");
                assert_eq!(expected_human_input_epoch, 4);
                assert_eq!(text, "hello");
                assert!(submit);
            }
            _ => panic!("expected automation input command"),
        }
    }

    #[test]
    fn deserializes_transactional_session_owner_closure() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 22,
            "type": "close-session-owner",
            "ownerId": "tab-a",
            "transfers": [{ "sessionId": "session-1", "ownerId": "tab-b" }],
        }))
        .unwrap();
        match envelope.command {
            Command::CloseSessionOwner {
                owner_id,
                transfers,
            } => {
                assert_eq!(owner_id, "tab-a");
                assert_eq!(
                    transfers,
                    vec![SessionOwnerTransfer {
                        session_id: "session-1".to_owned(),
                        owner_id: "tab-b".to_owned(),
                    }]
                );
            }
            _ => panic!("expected close-session-owner command"),
        }
    }

    #[test]
    fn preserves_unknown_commands_as_typed_errors() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 20,
            "type": "future-command",
        }))
        .unwrap();
        assert!(matches!(envelope.command, Command::Unknown));
    }

    /// A mesh runtime that answers from fixtures, so the daemon's remote
    /// surface can be exercised without a peer on the other end.
    ///
    /// Attachments live in a map the tests can empty, which is how a view that
    /// died with its connection is spelled: `current_attachment` stops
    /// answering for it, and anything that still needs an epoch has to dial.
    #[derive(Default)]
    struct TestRuntimeState {
        lifecycles: HashMap<String, mesh::RemoteSessionLifecycle>,
        attachments: HashMap<(String, String), (u64, bool)>,
        summaries: Vec<session::SessionSummary>,
        calls: Vec<String>,
        next_attachment_epoch: u64,
        reconnect_fails: bool,
        retry_view_fails: bool,
        control: HashMap<String, mesh::RemoteControlState>,
    }

    struct TestRuntime {
        controls: broadcast::Sender<mesh::RemoteControlChanged>,
        control_states: broadcast::Sender<mesh::RemoteControlState>,
        activities: broadcast::Sender<mesh::RemoteActivityChanged>,
        lifecycles: broadcast::Sender<mesh::RemoteLifecycleChanged>,
        view_states: broadcast::Sender<mesh::RemoteViewStateChanged>,
        state: Mutex<TestRuntimeState>,
    }

    impl Default for TestRuntime {
        fn default() -> Self {
            Self {
                controls: broadcast::channel(16).0,
                control_states: broadcast::channel(16).0,
                activities: broadcast::channel(16).0,
                lifecycles: broadcast::channel(16).0,
                view_states: broadcast::channel(16).0,
                state: Mutex::default(),
            }
        }
    }

    impl TestRuntime {
        fn open(&self, lifecycle: mesh::RemoteSessionLifecycle) {
            let mut state = self.state.lock().unwrap();
            state.summaries.push(remote_summary(&lifecycle.session_id));
            state
                .lifecycles
                .insert(lifecycle.session_id.clone(), lifecycle);
        }

        fn set_state(&self, session_id: &str, lifecycle_state: mesh::RemoteLifecycleState) {
            let mut state = self.state.lock().unwrap();
            let lifecycle = state.lifecycles.get_mut(session_id).unwrap();
            lifecycle.state = lifecycle_state;
            lifecycle.lifecycle_seq += 1;
        }

        /// The view stops answering, as it would once its connection died.
        fn drop_attachment(&self, session_id: &str, view_id: &str) {
            self.state
                .lock()
                .unwrap()
                .attachments
                .remove(&(session_id.to_owned(), view_id.to_owned()));
        }

        /// Announce a controller the way the mesh does — recorded first, so a
        /// client that reconciles the instant it sees the event cannot find
        /// the daemon still describing the previous one.
        fn publish_control(&self, state: mesh::RemoteControlState) {
            self.state
                .lock()
                .unwrap()
                .control
                .insert(state.session_id.clone(), state.clone());
            self.control_states.send(state).unwrap();
        }

        fn calls(&self) -> Vec<String> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    #[async_trait::async_trait]
    impl mesh::RemoteTerminalRuntime for TestRuntime {
        fn subscribe_control(&self) -> broadcast::Receiver<mesh::RemoteControlChanged> {
            self.controls.subscribe()
        }

        fn subscribe_control_state(&self) -> broadcast::Receiver<mesh::RemoteControlState> {
            self.control_states.subscribe()
        }

        async fn control_state(&self, session_id: &str) -> Option<mesh::RemoteControlState> {
            self.state.lock().unwrap().control.get(session_id).cloned()
        }

        fn subscribe_activity(&self) -> broadcast::Receiver<mesh::RemoteActivityChanged> {
            self.activities.subscribe()
        }

        fn subscribe_lifecycle(&self) -> broadcast::Receiver<mesh::RemoteLifecycleChanged> {
            self.lifecycles.subscribe()
        }

        fn subscribe_view_state(&self) -> broadcast::Receiver<mesh::RemoteViewStateChanged> {
            self.view_states.subscribe()
        }

        async fn hosts(&self) -> Result<Vec<mesh::RemoteHostSummary>> {
            Ok(Vec::new())
        }

        async fn list_sessions(
            &self,
            _device_id: &str,
        ) -> Result<Vec<tunnel_protocol::SharedSessionSummary>> {
            Ok(Vec::new())
        }

        async fn open_session(
            &self,
            _request: mesh::RemoteSessionOpen,
        ) -> Result<session::SessionSummary> {
            bail!("the test runtime opens no sessions")
        }

        async fn summaries(&self) -> Vec<session::SessionSummary> {
            self.state.lock().unwrap().summaries.clone()
        }

        async fn summary(&self, session_id: &str) -> Option<session::SessionSummary> {
            self.state
                .lock()
                .unwrap()
                .summaries
                .iter()
                .find(|summary| summary.id == session_id)
                .cloned()
        }

        async fn attach_view(
            &self,
            session_id: &str,
            view_id: &str,
        ) -> Result<mesh::RemoteAttachment> {
            let mut state = self.state.lock().unwrap();
            state
                .calls
                .push(format!("attach-view:{session_id}:{view_id}"));
            state.next_attachment_epoch += 1;
            let attachment_epoch = state.next_attachment_epoch;
            state.attachments.insert(
                (session_id.to_owned(), view_id.to_owned()),
                (attachment_epoch, true),
            );
            Ok(mesh::RemoteAttachment {
                attachment_epoch,
                read_write: true,
            })
        }

        async fn current_attachment(&self, session_id: &str, view_id: &str) -> Option<(u64, bool)> {
            self.state
                .lock()
                .unwrap()
                .attachments
                .get(&(session_id.to_owned(), view_id.to_owned()))
                .copied()
        }

        async fn send_input(
            &self,
            _session_id: &str,
            _view_id: &str,
            _attachment_epoch: u64,
            _input_sequence: u64,
            _operation: tunnel_protocol::TunnelInput,
        ) -> Result<()> {
            bail!("the test runtime sends no input")
        }

        async fn claim_control(
            &self,
            _session_id: &str,
            _view_id: &str,
            _attachment_epoch: u64,
            _cols: u16,
            _rows: u16,
        ) -> Result<mesh::RemoteControlClaim> {
            bail!("the test runtime claims no control")
        }

        async fn resize(
            &self,
            _session_id: &str,
            _view_id: &str,
            _request: mesh::RemoteResize,
        ) -> Result<()> {
            bail!("the test runtime resizes nothing")
        }

        async fn selection_text(
            &self,
            session_id: &str,
            _view_id: &str,
            _request: mesh::RemoteSelection,
        ) -> Result<String> {
            self.state
                .lock()
                .unwrap()
                .calls
                .push(format!("selection-text:{session_id}"));
            Ok("from the host".to_owned())
        }

        async fn offline_selection_text(
            &self,
            session_id: &str,
            _request: mesh::RemoteSelection,
        ) -> Result<String> {
            self.state
                .lock()
                .unwrap()
                .calls
                .push(format!("offline-selection-text:{session_id}"));
            Ok("from the replica".to_owned())
        }

        async fn refresh(&self, session_id: &str) -> Result<()> {
            self.state
                .lock()
                .unwrap()
                .calls
                .push(format!("refresh:{session_id}"));
            Ok(())
        }

        async fn refresh_remote(&self, session_id: &str) -> Result<()> {
            self.state
                .lock()
                .unwrap()
                .calls
                .push(format!("refresh-remote:{session_id}"));
            Ok(())
        }

        /// Reattaches the named view the way the mesh does: the record comes
        /// back attached, with a fresh epoch and an advanced sequence.
        /// A faithful miniature of the authority's compare-and-swap: a claim
        /// carrying a stale expectation loses and is told what beat it.
        async fn claim_control_at(
            &self,
            session_id: &str,
            view_id: &str,
            _attachment_epoch: u64,
            cols: u16,
            rows: u16,
            expected_control_revision: Option<u64>,
        ) -> Result<mesh::RemoteControlOutcome> {
            let mut state = self.state.lock().unwrap();
            state
                .calls
                .push(format!("claim-control-at:{session_id}:{view_id}"));
            let current = state.control.get(session_id).cloned();
            let revision = current.as_ref().map_or(0, |state| state.control_revision);
            if let Some(expected) = expected_control_revision
                && expected != revision
            {
                let announced = current.context("no control state to reject against")?;
                return Ok(mesh::RemoteControlOutcome::Rejected(announced));
            }
            let claimed = mesh::RemoteControlState {
                session_id: session_id.to_owned(),
                controller: Some(mesh::RemoteController {
                    view_id: view_id.to_owned(),
                    control_epoch: revision + 1,
                }),
                control_revision: revision + 1,
                cols,
                rows,
                layout_epoch: 3,
            };
            state.control.insert(session_id.to_owned(), claimed.clone());
            Ok(mesh::RemoteControlOutcome::Claimed(claimed))
        }

        async fn retry_view(
            &self,
            session_id: &str,
            view_id: &str,
        ) -> Result<mesh::RemoteViewRecord> {
            let mut state = self.state.lock().unwrap();
            state
                .calls
                .push(format!("retry-view:{session_id}:{view_id}"));
            if state.retry_view_fails {
                bail!("remote terminal session is not live");
            }
            let lifecycle = state
                .lifecycles
                .get_mut(session_id)
                .context("unknown remote session")?;
            let record = lifecycle
                .views
                .iter_mut()
                .find(|record| record.local_view_id == view_id)
                .context("unknown remote view")?;
            record.view_state = mesh::RemoteViewState::Attached;
            record.view_state_seq += 1;
            record.attachment_epoch = Some(42);
            record.read_write = Some(true);
            record.error = None;
            record.retryable = None;
            Ok(record.clone())
        }

        async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
            self.state.lock().unwrap().calls.push(format!(
                "detach-view:{session_id}:{view_id}:{attachment_epoch}"
            ));
        }

        async fn close_session(&self, _session_id: &str) -> bool {
            false
        }

        async fn session_lifecycle(
            &self,
            session_id: &str,
        ) -> Option<mesh::RemoteSessionLifecycle> {
            self.state
                .lock()
                .unwrap()
                .lifecycles
                .get(session_id)
                .cloned()
        }

        async fn reconnect_session(
            &self,
            session_id: &str,
        ) -> Result<mesh::RemoteSessionLifecycle> {
            let fails = {
                let mut state = self.state.lock().unwrap();
                state.calls.push(format!("reconnect:{session_id}"));
                state.reconnect_fails
            };
            if fails {
                // What a refused dial leaves behind: the session is back in
                // Suspended and the error carries no state of its own.
                self.set_state(session_id, mesh::RemoteLifecycleState::Suspended);
                bail!("no route to the host");
            }
            self.set_state(session_id, mesh::RemoteLifecycleState::Live);
            self.session_lifecycle(session_id)
                .await
                .context("unknown session")
        }
    }

    struct TestMesh {
        runtime: Arc<TestRuntime>,
        announcer: mesh::HostShutdownAnnouncer,
    }

    #[async_trait::async_trait]
    impl mesh::TerminalMesh for TestMesh {
        fn runtime(&self) -> Arc<dyn mesh::RemoteTerminalRuntime> {
            Arc::clone(&self.runtime) as Arc<dyn mesh::RemoteTerminalRuntime>
        }

        fn shutdown_announcer(&self) -> mesh::HostShutdownAnnouncer {
            self.announcer.clone()
        }

        async fn serve(
            self: Box<Self>,
            _registry: Registry,
            _host_config: watch::Receiver<Arc<TerminalPresentationConfig>>,
        ) -> Result<()> {
            std::future::pending().await
        }
    }

    fn remote_view(view_id: &str, view_state: mesh::RemoteViewState) -> mesh::RemoteViewRecord {
        mesh::RemoteViewRecord {
            local_view_id: view_id.to_owned(),
            view_state_seq: 4,
            view_state,
            attachment_epoch: matches!(view_state, mesh::RemoteViewState::Attached).then_some(9),
            read_write: matches!(view_state, mesh::RemoteViewState::Attached).then_some(true),
            error: None,
            retryable: None,
        }
    }

    fn remote_lifecycle(
        session_id: &str,
        state: mesh::RemoteLifecycleState,
        views: Vec<mesh::RemoteViewRecord>,
    ) -> mesh::RemoteSessionLifecycle {
        mesh::RemoteSessionLifecycle {
            session_id: session_id.to_owned(),
            lifecycle_seq: 7,
            device_id: "device-1".to_owned(),
            device_name: "studio-mac".to_owned(),
            state,
            reason: None,
            exit: None,
            attempt: 0,
            next_retry_ms: None,
            last_contact_ms: None,
            views,
        }
    }

    fn remote_summary(session_id: &str) -> session::SessionSummary {
        session::SessionSummary {
            id: session_id.to_owned(),
            handle: "1".to_owned(),
            executable: "remote-terminal".to_owned(),
            cols: 120,
            rows: 40,
            exited: false,
            read_write: true,
            title: Some("remote".to_owned()),
            cwd: None,
            bell_count: 0,
            pid: None,
            created_at_ms: 0,
            exit_code: None,
            exit_signal: None,
            requested_termination: None,
            exit_outcome: None,
            owner_id: None,
            persistence: None,
            scrollback_bytes: None,
            activity: session::SessionActivity::default(),
        }
    }

    /// Start a service over a fixture mesh and hand back both ends of it.
    fn start_remote_service(label: &str) -> (TestService, Arc<TestRuntime>) {
        let (service, runtime, _announcer) = start_remote_service_parts(label);
        (service, runtime)
    }

    /// The same fixture, plus the announcer handle the drain will use — the
    /// only way to watch the goodbye from outside.
    fn start_remote_service_parts(
        label: &str,
    ) -> (TestService, Arc<TestRuntime>, mesh::HostShutdownAnnouncer) {
        let runtime = Arc::new(TestRuntime::default());
        let announcer = mesh::HostShutdownAnnouncer::new();
        let mesh = TestMesh {
            runtime: Arc::clone(&runtime),
            announcer: announcer.clone(),
        };
        (
            start_test_service_with_mesh(label, Some(mesh)),
            runtime,
            announcer,
        )
    }

    /// Say hello at a chosen minor and return the negotiated response.
    async fn say_hello(stream: &mut ControlStream, protocol_minor: u16) -> Value {
        request(
            stream,
            json!({
                "requestId": 1,
                "type": "hello",
                "protocolMajor": CONTROL_PROTOCOL_MAJOR,
                "protocolMinor": protocol_minor,
                "clientBuild": "test",
            }),
        )
        .await
    }

    /// Everything the daemon pushes within a short window.
    ///
    /// Long enough for a broadcast to cross the socket, short enough that the
    /// "nothing arrives" assertions stay honest about what they proved.
    async fn pushed_events(stream: &mut ControlStream) -> Vec<Value> {
        let mut events = Vec::new();
        while let Ok(Ok(packet)) = tokio::time::timeout(
            Duration::from_millis(250),
            read_packet(stream, MAX_CONTROL_BYTES),
        )
        .await
        {
            let event: Value = serde_json::from_slice(&packet).unwrap();
            if event["requestId"] == 0 {
                events.push(event);
            }
        }
        events
    }

    fn event_types(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The three lifecycle events are new in minor 12, and an older client
    /// that received one would fail to decode it and lose its socket.
    #[test]
    fn remote_lifecycle_events_reach_only_clients_that_negotiated_them() {
        for event_type in [
            "remote-session-state-changed",
            "view-state-changed",
            "control-state",
        ] {
            let event = json!({ "type": event_type });
            assert!(!client_accepts_event(
                &event,
                REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1
            ));
            assert!(client_accepts_event(
                &event,
                REMOTE_LIFECYCLE_PROTOCOL_MINOR
            ));
        }
        // The gate is per event, not a wholesale cut-off: a minor-11 client
        // keeps everything it already understood.
        let config = json!({ "type": "config-changed" });
        assert!(client_accepts_event(
            &config,
            REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1
        ));
    }

    /// A daemon with no reconnect engine reports absence, not zero: `attempt: 0`
    /// where the value is unknown would read as evidence nobody gathered.
    #[test]
    fn lifecycle_events_send_null_rather_than_invented_values() {
        let changed = mesh::RemoteLifecycleChanged {
            session_id: "session-1".to_owned(),
            lifecycle_seq: 3,
            device_id: "device-1".to_owned(),
            device_name: "studio-mac".to_owned(),
            state: mesh::RemoteLifecycleState::Suspended,
            reason: None,
            exit: None,
            attempt: 1,
            next_retry_ms: None,
            last_contact_ms: None,
        };
        assert_eq!(
            remote_session_state_changed_event("session-1", LifecycleFields::from(&changed)),
            json!({
                "requestId": 0,
                "type": "remote-session-state-changed",
                "sessionId": "session-1",
                "lifecycleSeq": 3,
                "deviceId": "device-1",
                "deviceName": "studio-mac",
                "state": "suspended",
                "reason": null,
                "exit": null,
                "attempt": 1,
                "nextRetryMs": null,
                "lastContactMs": null,
            })
        );

        let ended = mesh::RemoteLifecycleChanged {
            state: mesh::RemoteLifecycleState::Ended,
            reason: Some(mesh::RemoteEndedReason::SessionExited),
            exit: Some(mesh::RemoteExitInfo { code: Some(1) }),
            last_contact_ms: Some(12_000),
            ..changed
        };
        assert_eq!(
            remote_session_state_changed_event("session-1", LifecycleFields::from(&ended)),
            json!({
                "requestId": 0,
                "type": "remote-session-state-changed",
                "sessionId": "session-1",
                "lifecycleSeq": 3,
                "deviceId": "device-1",
                "deviceName": "studio-mac",
                "state": "ended",
                "reason": "session-exited",
                "exit": { "code": 1 },
                "attempt": 1,
                "nextRetryMs": null,
                "lastContactMs": 12000,
            })
        );
    }

    /// Epoch and access level exist only while a view is attached. A pending
    /// or failed view reports null for both rather than a value no attachment
    /// stands behind.
    #[test]
    fn view_state_events_carry_an_epoch_only_while_attached() {
        let pending = mesh::RemoteViewStateChanged {
            session_id: "session-1".to_owned(),
            local_view_id: "view-1".to_owned(),
            view_state_seq: 12,
            view_state: mesh::RemoteViewState::Pending,
            attachment_epoch: None,
            read_write: None,
            error: None,
            retryable: None,
        };
        assert_eq!(
            view_state_changed_event(&pending),
            json!({
                "requestId": 0,
                "type": "view-state-changed",
                "sessionId": "session-1",
                "viewId": "view-1",
                "viewStateSeq": 12,
                "viewState": "pending",
                "attachmentEpoch": null,
                "readWrite": null,
                "error": null,
                "retryable": null,
            })
        );

        let attached = mesh::RemoteViewStateChanged {
            view_state_seq: 13,
            view_state: mesh::RemoteViewState::Attached,
            attachment_epoch: Some(9),
            read_write: Some(true),
            ..pending.clone()
        };
        assert_eq!(
            view_state_changed_event(&attached),
            json!({
                "requestId": 0,
                "type": "view-state-changed",
                "sessionId": "session-1",
                "viewId": "view-1",
                "viewStateSeq": 13,
                "viewState": "attached",
                "attachmentEpoch": 9,
                "readWrite": true,
                "error": null,
                "retryable": null,
            })
        );

        let failed = mesh::RemoteViewStateChanged {
            view_state_seq: 14,
            view_state: mesh::RemoteViewState::Failed,
            attachment_epoch: None,
            read_write: None,
            error: Some("attach refused".to_owned()),
            retryable: Some(true),
            ..pending
        };
        let event = view_state_changed_event(&failed);
        assert_eq!(event["attachmentEpoch"], json!(null));
        assert_eq!(event["readWrite"], json!(null));
        assert_eq!(event["error"], json!("attach refused"));
        assert_eq!(event["retryable"], json!(true));
    }

    /// One controller change, one spelling per client: the newer event for
    /// clients that negotiated it, the legacy one for those that did not, and
    /// never both to the same connection.
    #[test]
    fn control_state_downgrades_to_the_legacy_event_for_older_clients() {
        let event = control_state_event(&mesh::RemoteControlState {
            session_id: "session-1".to_owned(),
            controller: Some(mesh::RemoteController {
                view_id: "view-1".to_owned(),
                control_epoch: 5,
            }),
            control_revision: 0,
            cols: 120,
            rows: 40,
            layout_epoch: 3,
        });
        assert_eq!(
            event,
            json!({
                "requestId": 0,
                "type": "control-state",
                "sessionId": "session-1",
                "controller": { "viewId": "view-1", "controlEpoch": 5 },
                "controlRevision": 0,
                "cols": 120,
                "rows": 40,
                "layoutEpoch": 3,
            })
        );

        assert_eq!(
            event_for_client(event.clone(), REMOTE_LIFECYCLE_PROTOCOL_MINOR),
            Some(event.clone())
        );
        assert_eq!(
            event_for_client(event, REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1),
            Some(json!({
                "requestId": 0,
                "type": "control-changed",
                "sessionId": "session-1",
                "controllerViewId": "view-1",
                "controlEpoch": 5,
                "cols": 120,
                "rows": 40,
                "layoutEpoch": 3,
            }))
        );
    }

    /// Local control events are built, never relayed from the wire.
    ///
    /// The tunnel's control message carries no session id and names its
    /// controller by *wire* view id — `h:…#g3` under rotation. If a future
    /// editor "unified" the two shapes, the missing `sessionId` alone would
    /// destroy the client's socket, and a wire id that did decode would tell
    /// the reclaim funnel another pane holds control, ending reclaim silently
    /// and forever. This pins the local spelling so that edit fails here first.
    #[test]
    fn local_control_events_never_carry_a_wire_view_id() {
        let event = control_state_event(&mesh::RemoteControlState {
            session_id: "session-1".to_owned(),
            controller: Some(mesh::RemoteController {
                view_id: "pane-7".to_owned(),
                control_epoch: 5,
            }),
            control_revision: 4,
            cols: 120,
            rows: 40,
            layout_epoch: 3,
        });

        // The field the wire frame does not have at all.
        assert_eq!(event["sessionId"], "session-1");
        // The local id, unchanged and unadorned by any generation suffix.
        assert_eq!(event["controller"]["viewId"], "pane-7");
        let controller_view_id = event["controller"]["viewId"].as_str().unwrap();
        assert!(
            !controller_view_id.contains('#') && !controller_view_id.starts_with("h:"),
            "a wire-spelled controller id reached a local event: {controller_view_id}"
        );

        // The same boundary holds through the legacy downgrade, which is the
        // other path a controller id takes to a client.
        let legacy = event_for_client(event, REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1).unwrap();
        assert_eq!(legacy["sessionId"], "session-1");
        assert_eq!(legacy["controllerViewId"], "pane-7");
    }

    /// A cleared controller has no legacy spelling, so it stays invisible to
    /// older clients — the one thing the downgrade cannot carry, and exactly
    /// what they already lived without.
    #[test]
    fn a_cleared_controller_has_nothing_to_downgrade_to() {
        let cleared = json!({
            "requestId": 0,
            "type": "control-state",
            "sessionId": "session-1",
            "controller": null,
            "controlRevision": 0,
            "cols": 120,
            "rows": 40,
            "layoutEpoch": 3,
        });
        assert_eq!(
            event_for_client(cleared.clone(), REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1),
            None
        );
        assert_eq!(
            event_for_client(cleared.clone(), REMOTE_LIFECYCLE_PROTOCOL_MINOR),
            Some(cleared)
        );
    }

    /// A workspace restored from persistence never called
    /// `open-remote-session` and may see no transition for hours, so the hello
    /// itself has to say which of its sessions are replicated.
    #[tokio::test]
    async fn hello_announces_open_remote_sessions_to_lifecycle_clients() {
        let (service, runtime) = start_remote_service("hello-snapshot");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Suspended,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));
        runtime.open(remote_lifecycle(
            "session-2",
            mesh::RemoteLifecycleState::Live,
            Vec::new(),
        ));

        let mut current = connect_control(&service).await;
        let hello = say_hello(&mut current, CONTROL_PROTOCOL_MINOR).await;
        assert_eq!(hello["protocolMinor"], CONTROL_PROTOCOL_MINOR);
        let announced = pushed_events(&mut current).await;
        assert_eq!(
            event_types(&announced),
            vec![
                "remote-session-state-changed".to_owned(),
                "remote-session-state-changed".to_owned()
            ],
            "one announcement per open remote session, and nothing else"
        );
        let mut announced_sessions = announced
            .iter()
            .map(|event| event["sessionId"].as_str().unwrap())
            .collect::<Vec<_>>();
        announced_sessions.sort_unstable();
        assert_eq!(announced_sessions, vec!["session-1", "session-2"]);
        assert_eq!(announced[0]["state"], "suspended");
        assert_eq!(announced[0]["deviceName"], "studio-mac");

        let mut legacy = connect_control(&service).await;
        say_hello(&mut legacy, REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1).await;
        assert!(
            pushed_events(&mut legacy).await.is_empty(),
            "a client that never negotiated the event must not be sent one"
        );

        service.serving.abort();
    }

    /// The downgrade matrix, over a real socket: a lifecycle client and a
    /// minor-11 client on the same daemon, each hearing the one spelling it
    /// can decode.
    #[tokio::test]
    async fn each_client_hears_remote_changes_in_the_spelling_it_negotiated() {
        let (service, runtime) = start_remote_service("event-downgrade");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut current = connect_control(&service).await;
        say_hello(&mut current, CONTROL_PROTOCOL_MINOR).await;
        let _snapshot = pushed_events(&mut current).await;
        let mut legacy = connect_control(&service).await;
        say_hello(&mut legacy, REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1).await;

        runtime.publish_control(mesh::RemoteControlState {
            session_id: "session-1".to_owned(),
            controller: Some(mesh::RemoteController {
                view_id: "view-1".to_owned(),
                control_epoch: 5,
            }),
            control_revision: 7,
            cols: 120,
            rows: 40,
            layout_epoch: 3,
        });
        runtime
            .lifecycles
            .send(mesh::RemoteLifecycleChanged {
                session_id: "session-1".to_owned(),
                lifecycle_seq: 8,
                device_id: "device-1".to_owned(),
                device_name: "studio-mac".to_owned(),
                state: mesh::RemoteLifecycleState::Suspended,
                reason: None,
                exit: None,
                attempt: 0,
                next_retry_ms: None,
                last_contact_ms: None,
            })
            .unwrap();
        runtime
            .view_states
            .send(mesh::RemoteViewStateChanged {
                session_id: "session-1".to_owned(),
                local_view_id: "view-1".to_owned(),
                view_state_seq: 12,
                view_state: mesh::RemoteViewState::Pending,
                attachment_epoch: None,
                read_write: None,
                error: None,
                retryable: None,
            })
            .unwrap();

        let current_events = pushed_events(&mut current).await;
        assert_eq!(
            event_types(&current_events),
            vec![
                "control-state".to_owned(),
                "remote-session-state-changed".to_owned(),
                "view-state-changed".to_owned()
            ]
        );
        assert_eq!(current_events[0]["controller"]["controlEpoch"], 5);
        assert_eq!(current_events[2]["attachmentEpoch"], json!(null));

        let legacy_events = pushed_events(&mut legacy).await;
        assert_eq!(
            event_types(&legacy_events),
            vec!["control-changed".to_owned()],
            "controller updates survive the downgrade; the lifecycle events do not exist for this client"
        );
        assert_eq!(legacy_events[0]["controllerViewId"], "view-1");
        assert_eq!(legacy_events[0]["controlEpoch"], 5);

        service.serving.abort();
    }

    /// The bug this replaces: a re-attach answered from the connection's own
    /// notes, handing back an epoch the host had already stopped honouring.
    #[tokio::test]
    async fn attaching_a_remote_view_reads_the_epoch_from_the_authority() {
        let (service, runtime) = start_remote_service("attach-authority");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let attach = json!({
            "requestId": 2,
            "type": "attach-session",
            "sessionId": "session-1",
            "viewId": "view-1",
        });

        let first = request(&mut client, attach.clone()).await;
        assert_eq!(first["type"], "view-attached");
        assert_eq!(first["attachmentEpoch"], 1);
        assert_eq!(
            first["viewStateSeq"], 4,
            "a remote attach lands inside the per-view ordering fence"
        );

        // Attached, and still owned: the authority answers, and nothing dials.
        let cached = request(&mut client, attach.clone()).await;
        assert_eq!(cached["attachmentEpoch"], 1);
        assert_eq!(
            runtime.calls(),
            vec!["attach-view:session-1:view-1".to_owned()]
        );

        // The view dies with its connection. The next attach must dial for a
        // fresh epoch rather than repeat the one it was given.
        runtime.drop_attachment("session-1", "view-1");
        let redialled = request(&mut client, attach).await;
        assert_eq!(
            redialled["attachmentEpoch"], 2,
            "a dead view re-dials instead of reusing a cached epoch"
        );
        assert_eq!(
            runtime.calls(),
            vec![
                "attach-view:session-1:view-1".to_owned(),
                "attach-view:session-1:view-1".to_owned()
            ]
        );

        service.serving.abort();
    }

    /// Local sessions have no per-view sequence; the field's absence is what
    /// tells a client to apply the response the way it always has.
    #[test]
    fn a_local_attachment_carries_no_view_sequence() {
        let value = serde_json::to_value(ResponseEnvelope {
            request_id: 3,
            body: ResponseBody::ViewAttached {
                session_id: "session-1".to_owned(),
                view_id: "view-1".to_owned(),
                attachment_epoch: 2,
                read_write: true,
                view_state_seq: None,
            },
        })
        .unwrap();
        assert_eq!(value["type"], "view-attached");
        assert!(value.get("viewStateSeq").is_none());
    }

    /// A dial can take as long as the peer does; the connection loop must not
    /// wait on it with a keystroke queued behind.
    #[test]
    fn one_shot_reconnect_runs_off_the_connection_loop() {
        assert!(runs_off_connection_loop(&Command::ReconnectRemoteSession {
            session_id: "session-1".to_owned()
        }));
    }

    /// Membership in the off-loop set is a claim about what a command touches,
    /// not only about how slow it is. Off-loop commands are handed an empty
    /// ownership map, so one that read or wrote the connection's own would
    /// quietly find nothing attached — which is why the second half of this
    /// test matters as much as the first.
    #[test]
    fn only_commands_that_touch_no_per_connection_state_run_off_the_loop() {
        for command in [
            Command::ListRemoteHosts,
            Command::ListRemoteSessions {
                device_id: "device-1".to_owned(),
            },
            Command::ReconnectRemoteSession {
                session_id: "session-1".to_owned(),
            },
            // Dials on a Live remote session: as slow as any of the above.
            Command::RefreshSession {
                session_id: "session-1".to_owned(),
            },
            // Re-attaches one pane over the wire, which is a dial too.
            Command::RetryRemoteView {
                session_id: "session-1".to_owned(),
                view_id: "view-1".to_owned(),
            },
        ] {
            assert!(
                runs_off_connection_loop(&command),
                "a command that can block on a peer must not hold up the loop"
            );
        }

        for command in [
            Command::AttachSession {
                session_id: "session-1".to_owned(),
                view_id: "view-1".to_owned(),
                owner_id: None,
            },
            Command::DetachSession {
                session_id: "session-1".to_owned(),
                view_id: "view-1".to_owned(),
            },
            Command::FocusAndResize {
                session_id: "session-1".to_owned(),
                view_id: "view-1".to_owned(),
                attachment_epoch: 1,
                cols: 120,
                rows: 40,
                expected_control_revision: None,
            },
        ] {
            assert!(
                !runs_off_connection_loop(&command),
                "a command that reads or writes the ownership map must stay on the loop that owns it"
            );
        }
    }

    /// Both outcomes are states, not errors: the caller needs to know where
    /// the session landed, and a refused dial lands it in Suspended.
    #[tokio::test]
    async fn reconnecting_reports_the_state_it_reached_either_way() {
        let (service, runtime) = start_remote_service("reconnect-state");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Suspended,
            vec![remote_view("view-1", mesh::RemoteViewState::Failed)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let reconnect = json!({
            "requestId": 2,
            "type": "reconnect-remote-session",
            "sessionId": "session-1",
        });

        let resumed = request(&mut client, reconnect.clone()).await;
        assert_eq!(resumed["type"], "remote-session-state");
        assert_eq!(resumed["state"], "live");
        assert_eq!(resumed["deviceName"], "studio-mac");
        assert_eq!(resumed["views"][0]["viewId"], "view-1");
        assert_eq!(resumed["views"][0]["attachmentEpoch"], json!(null));
        assert!(
            resumed.get("sessionId").is_none(),
            "the response is correlated by request id, not by session"
        );

        runtime.state.lock().unwrap().reconnect_fails = true;
        let refused = request(&mut client, reconnect).await;
        assert_eq!(refused["type"], "remote-session-state");
        assert_eq!(refused["state"], "suspended");

        let unknown = request(
            &mut client,
            json!({
                "requestId": 4,
                "type": "reconnect-remote-session",
                "sessionId": "no-such-session",
            }),
        )
        .await;
        assert_eq!(unknown["type"], "error");

        service.serving.abort();
    }

    /// Dormant in Phase 1: the command exists because minor 12 ships its whole
    /// surface, and it answers with the record it found, untouched.
    #[tokio::test]
    async fn retrying_a_view_reattaches_it_and_answers_with_the_new_record() {
        let (service, runtime) = start_remote_service("retry-view");
        let mut failed = remote_view("view-1", mesh::RemoteViewState::Failed);
        failed.error = Some("attach refused".to_owned());
        failed.retryable = Some(true);
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![failed],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let response = request(
            &mut client,
            json!({
                "requestId": 2,
                "type": "retry-remote-view",
                "sessionId": "session-1",
                "viewId": "view-1",
            }),
        )
        .await;
        assert_eq!(response["type"], "view-state");
        assert_eq!(response["sessionId"], "session-1");
        assert_eq!(response["viewId"], "view-1");
        assert_eq!(response["viewState"], "attached");
        assert_eq!(response["attachmentEpoch"], 42);
        assert_eq!(response["readWrite"], json!(true));
        assert_eq!(
            response["viewStateSeq"], 5,
            "a reattach advances the sequence, or the client would drop it"
        );
        assert_eq!(response["error"], json!(null));
        assert_eq!(response["retryable"], json!(null));
        assert_eq!(
            runtime.calls(),
            vec!["retry-view:session-1:view-1".to_owned()]
        );

        service.serving.abort();
    }

    /// The mesh refuses what it does not own — a session that is not live, or
    /// the feed view. Those answer with the view's current record rather than
    /// an error, which is what every client saw from this command before it
    /// went live, so nothing regresses for one that has not learned the new
    /// behaviour.
    #[tokio::test]
    async fn a_refused_retry_answers_with_the_view_as_it_stands() {
        let (service, runtime) = start_remote_service("retry-view-refused");
        let mut failed = remote_view("view-1", mesh::RemoteViewState::Failed);
        failed.error = Some("attach refused".to_owned());
        failed.retryable = Some(true);
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Suspended,
            vec![failed],
        ));
        runtime.state.lock().unwrap().retry_view_fails = true;

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let response = request(
            &mut client,
            json!({
                "requestId": 2,
                "type": "retry-remote-view",
                "sessionId": "session-1",
                "viewId": "view-1",
            }),
        )
        .await;
        assert_eq!(response["type"], "view-state");
        assert_eq!(response["viewId"], "view-1");
        assert_eq!(response["viewStateSeq"], 4);
        assert_eq!(response["viewState"], "failed");
        assert_eq!(response["attachmentEpoch"], json!(null));
        assert_eq!(response["readWrite"], json!(null));
        assert_eq!(response["error"], "attach refused");
        assert_eq!(response["retryable"], json!(true));
        assert_eq!(
            runtime.calls(),
            vec!["retry-view:session-1:view-1".to_owned()],
            "the refusal is the mesh's to make; nothing else is touched"
        );

        // A view the session has never heard of has no record to fall back to.
        let unknown = request(
            &mut client,
            json!({
                "requestId": 3,
                "type": "retry-remote-view",
                "sessionId": "session-1",
                "viewId": "view-9",
            }),
        )
        .await;
        assert_eq!(unknown["type"], "error");

        service.serving.abort();
    }

    /// Copying from a frozen tab keeps working: the retained viewport answers
    /// while the session is not live, authorized by the ownership record.
    #[tokio::test]
    async fn selection_falls_back_to_the_replica_while_a_session_is_not_live() {
        let (service, runtime) = start_remote_service("offline-selection");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let selection = json!({
            "requestId": 3,
            "type": "selection-text",
            "sessionId": "session-1",
            "viewId": "view-1",
            "attachmentEpoch": 1,
            "startColumn": 0,
            "startRow": 0,
            "endColumn": 10,
            "endRow": 2,
            "selectAll": false,
        });

        let unauthorized = request(&mut client, selection.clone()).await;
        assert_eq!(
            unauthorized["type"], "error",
            "a connection that never attached the view cannot read its selection"
        );

        request(
            &mut client,
            json!({
                "requestId": 2,
                "type": "attach-session",
                "sessionId": "session-1",
                "viewId": "view-1",
            }),
        )
        .await;

        let live = request(&mut client, selection.clone()).await;
        assert_eq!(live["text"], "from the host");
        assert_eq!(
            live["scope"], "scrollback",
            "a live session is answered by the host, which can reach scrollback"
        );

        runtime.set_state("session-1", mesh::RemoteLifecycleState::Suspended);
        let frozen = request(&mut client, selection).await;
        assert_eq!(frozen["type"], "selection-text");
        assert_eq!(frozen["text"], "from the replica");
        assert_eq!(
            frozen["scope"], "viewport",
            "a frozen replica holds only the screen, and the answer has to say so"
        );
        assert_eq!(
            runtime.calls(),
            vec![
                "attach-view:session-1:view-1".to_owned(),
                "selection-text:session-1".to_owned(),
                "offline-selection-text:session-1".to_owned()
            ]
        );

        service.serving.abort();
    }

    /// A command whose bytes arrive in pieces must survive the events that
    /// arrive between them.
    ///
    /// The connection loop waits on a read and on the event stream in the same
    /// `select!`, so every pushed event cancels the read in flight. A reader
    /// that had already consumed a frame's length would lose it, and the next
    /// read would take the body's first four bytes for the next length —
    /// desynchronizing the stream and killing a connection that did nothing
    /// wrong. A paste during a reconnect storm is exactly that shape: a large
    /// command split across reads while lifecycle events pour in.
    #[tokio::test]
    async fn a_command_split_across_reads_survives_a_burst_of_events() {
        let (service, runtime) = start_remote_service("fragmented-command");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let _snapshot = pushed_events(&mut client).await;

        let body = serde_json::to_vec(&json!({ "requestId": 9, "type": "list-sessions" })).unwrap();
        // The length alone, so the daemon is parked mid-frame with four bytes
        // of this command already consumed.
        client
            .write_all(&(body.len() as u32).to_le_bytes())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Now storm it, cancelling that read over and over.
        for lifecycle_seq in 0..16 {
            runtime
                .lifecycles
                .send(mesh::RemoteLifecycleChanged {
                    session_id: "session-1".to_owned(),
                    lifecycle_seq,
                    device_id: "device-1".to_owned(),
                    device_name: "studio-mac".to_owned(),
                    state: mesh::RemoteLifecycleState::Reconnecting,
                    reason: None,
                    exit: None,
                    attempt: 1,
                    next_retry_ms: Some(250),
                    last_contact_ms: Some(1_000),
                })
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        client.write_all(&body).await.unwrap();

        let response = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let packet = read_packet(&mut client, MAX_CONTROL_BYTES).await.unwrap();
                let message: Value = serde_json::from_slice(&packet).unwrap();
                if message["requestId"] == 9 {
                    return message;
                }
            }
        })
        .await
        .expect("the daemon dropped a connection that only sent a fragmented command");
        assert_eq!(response["type"], "sessions");

        service.serving.abort();
    }

    /// A drain says goodbye before it takes anything apart.
    ///
    /// The ordering is the whole point: end the sessions first and a viewer
    /// watches its streams die and calls it an outage, which is the wrong
    /// ending and an unrecoverable one — it would wait for a host that is
    /// never coming back. The report says whether the goodbye went out,
    /// because "we told them" and "we ran out of time" are different claims.
    #[tokio::test]
    async fn a_drain_announces_the_shutdown_before_ending_anything() {
        let (service, _runtime, announcer) = start_remote_service_parts("drain-goodbye");
        assert!(
            !announcer.announced(),
            "nothing should have been announced before a drain starts"
        );

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        // Stubborn, so its exit is something the drain causes rather than
        // something that happened on its own beforehand.
        let created = request(&mut client, stubborn_session(1)).await;
        assert_eq!(created["type"], "session-created");
        tokio::time::sleep(CHILD_SETTLE).await;

        // Both observers run concurrently and stamp the moment their own event
        // arrives. Reading them in sequence after the drain would only ever
        // record the order they were read in — which is how an earlier version
        // of this test passed while the goodbye sat at the very end.
        let mut announcements = announcer.watch();
        let announced_at = tokio::spawn(async move {
            announcements
                .wait_for(|announced| *announced)
                .await
                .expect("the announcer outlives the drain");
            Instant::now()
        });
        let exited_at = tokio::spawn(async move {
            loop {
                let packet = read_packet(&mut client, MAX_CONTROL_BYTES).await.unwrap();
                let message: Value = serde_json::from_slice(&packet).unwrap();
                if message["type"] == "session-exited" {
                    return Instant::now();
                }
            }
        });

        let report = service
            .handle
            .shutdown(Duration::from_secs(10))
            .await
            .unwrap();
        let announced_at = announced_at.await.unwrap();
        let exited_at = tokio::time::timeout(Duration::from_secs(5), exited_at)
            .await
            .expect("the drain ends the session it announced over")
            .unwrap();

        assert!(
            announced_at <= exited_at,
            "the goodbye has to leave before the sessions do, or a viewer reads the \
             dying streams as an outage and waits for a host that is never coming back"
        );
        assert!(
            report.announced_shutdown,
            "and the report must say so, rather than leaving it to be assumed"
        );

        service.serving.abort();
    }

    /// Closing a session leaves a record of *why*, so a viewer that was not
    /// watching can still be told rather than left to infer it from silence.
    ///
    /// `Closed` and not `Exited` is the point: the child may still be dying
    /// when the command returns, and reporting an exit the daemon has not
    /// observed is the guess §6.4 forbids.
    #[tokio::test]
    async fn closing_a_session_records_why_it_ended() {
        let service = start_test_service("tombstone-on-close");
        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;

        let created = request(&mut client, short_lived_session(1)).await;
        assert_eq!(created["type"], "session-created");
        let session_id = created["session"]["id"].as_str().unwrap().to_owned();

        let terminated = request(
            &mut client,
            json!({ "requestId": 2, "type": "terminate", "sessionId": session_id }),
        )
        .await;
        assert_eq!(terminated["type"], "ok");

        // The session is gone from the registry, and the reason it went is
        // still answerable — which is the whole point of the record.
        let unknown = request(
            &mut client,
            json!({ "requestId": 3, "type": "get-session", "sessionId": session_id }),
        )
        .await;
        assert_eq!(unknown["type"], "error");

        service.serving.abort();
    }

    /// A conditional claim either fences or says why it could not — it never
    /// quietly becomes an unconditional one.
    ///
    /// The rejection carries the state that beat it because §4.2.3's retry rule
    /// reads off exactly that: another view holding control ends the reclaim,
    /// while no controller at a newer revision earns one more attempt. A
    /// rejection that answered with nothing would strand the client either way.
    #[tokio::test]
    async fn a_conditional_claim_is_fenced_against_the_revision_it_names() {
        let (service, runtime) = start_remote_service("cas-claim");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));
        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        // Announced once the service is listening, so the daemon records it the
        // way it would in life.
        runtime.publish_control(mesh::RemoteControlState {
            session_id: "session-1".to_owned(),
            controller: Some(mesh::RemoteController {
                view_id: "view-2".to_owned(),
                control_epoch: 4,
            }),
            control_revision: 4,
            cols: 120,
            rows: 40,
            layout_epoch: 3,
        });
        request(
            &mut client,
            json!({
                "requestId": 2,
                "type": "attach-session",
                "sessionId": "session-1",
                "viewId": "view-1",
            }),
        )
        .await;
        let claim = |request_id: u64, expected: Option<u64>| {
            let mut command = json!({
                "requestId": request_id,
                "type": "focus-and-resize",
                "sessionId": "session-1",
                "viewId": "view-1",
                "attachmentEpoch": 1,
                "cols": 120,
                "rows": 40,
            });
            if let Some(expected) = expected {
                command["expectedControlRevision"] = json!(expected);
            }
            command
        };

        // Conditioned on a revision that has already moved on.
        let rejected = request(&mut client, claim(3, Some(3))).await;
        assert_eq!(rejected["type"], "control-rejected");
        assert_eq!(
            rejected["controller"],
            json!({ "viewId": "view-2", "controlEpoch": 4 }),
            "the rejection has to name who won, or the client cannot tell stand-down from retry"
        );
        assert_eq!(rejected["controlRevision"], 4);

        // Conditioned on the revision that is actually current.
        let claimed = request(&mut client, claim(4, Some(4))).await;
        assert_eq!(claimed["type"], "control-claimed");
        assert_eq!(claimed["controllerViewId"], "view-1");
        assert_eq!(
            claimed["controlRevision"], 5,
            "the claim advances the revision, and the client conditions its next one on this"
        );

        // The sentinel is not a revision anything maintains, so it cannot be
        // compared against — and answering it unconditionally would grant a
        // claim the caller believed was guarded.
        let sentinel = request(&mut client, claim(5, Some(0))).await;
        assert_eq!(sentinel["type"], "error");

        service.serving.abort();
    }

    /// Refresh means two different things either side of an outage: ask the
    /// host again, or redraw what is left. Dialing a host that is not there
    /// would turn a redraw into a hang.
    #[tokio::test]
    async fn refreshing_a_remote_session_dials_only_while_it_is_live() {
        let (service, runtime) = start_remote_service("refresh-routing");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let refresh = json!({
            "requestId": 2,
            "type": "refresh-session",
            "sessionId": "session-1",
        });

        let live = request(&mut client, refresh.clone()).await;
        assert_eq!(live["type"], "ok");
        assert_eq!(
            runtime.calls(),
            vec!["refresh-remote:session-1".to_owned()],
            "a live session gets the generation-advanced re-attach"
        );

        runtime.set_state("session-1", mesh::RemoteLifecycleState::Reconnecting);
        let frozen = request(&mut client, refresh).await;
        assert_eq!(frozen["type"], "ok");
        assert_eq!(
            runtime.calls(),
            vec![
                "refresh-remote:session-1".to_owned(),
                "refresh:session-1".to_owned()
            ],
            "a session that is not live re-renders its replica and never dials"
        );

        service.serving.abort();
    }

    /// Reconciliation has to answer with controller state too: a lost
    /// `control-state` clear would otherwise strand a stale epoch with no
    /// repair path.
    #[tokio::test]
    async fn reconciliation_reports_the_controller_and_its_revision() {
        let (service, runtime) = start_remote_service("reconcile-control");
        runtime.open(remote_lifecycle(
            "session-1",
            mesh::RemoteLifecycleState::Live,
            vec![remote_view("view-1", mesh::RemoteViewState::Attached)],
        ));

        let mut client = connect_control(&service).await;
        say_hello(&mut client, CONTROL_PROTOCOL_MINOR).await;
        let query = json!({
            "requestId": 2,
            "type": "get-remote-session-state",
            "sessionId": "session-1",
        });

        let before = request(&mut client, query.clone()).await;
        assert_eq!(before["type"], "remote-session-state");
        assert_eq!(
            before["controller"],
            json!(null),
            "a controller nobody has reported is absent, not invented"
        );
        assert_eq!(
            before["controlRevision"], 0,
            "the sentinel, not a revision: nothing has reported one to compare against"
        );
        assert_eq!(
            (before["cols"].clone(), before["rows"].clone()),
            (json!(120), json!(40)),
            "size falls back to the replica's own dimensions"
        );
        assert_eq!(before["views"][0]["attachmentEpoch"], 9);
        assert_eq!(before["views"][0]["readWrite"], json!(true));

        runtime.publish_control(mesh::RemoteControlState {
            session_id: "session-1".to_owned(),
            controller: Some(mesh::RemoteController {
                view_id: "view-1".to_owned(),
                control_epoch: 5,
            }),
            control_revision: 9,
            cols: 100,
            rows: 30,
            layout_epoch: 3,
        });
        let _control = pushed_events(&mut client).await;

        let after = request(&mut client, query).await;
        assert_eq!(
            after["controller"],
            json!({ "viewId": "view-1", "controlEpoch": 5 })
        );
        assert_eq!(
            after["controlRevision"], 9,
            "the authority's own revision, which is what a client conditions its next claim on"
        );
        assert_eq!(
            (
                after["cols"].clone(),
                after["rows"].clone(),
                after["layoutEpoch"].clone()
            ),
            (json!(100), json!(30), json!(3))
        );

        let unknown = request(
            &mut client,
            json!({
                "requestId": 5,
                "type": "get-remote-session-state",
                "sessionId": "no-such-session",
            }),
        )
        .await;
        assert_eq!(unknown["type"], "error");

        service.serving.abort();
    }

    /// The claim is conditional only when the caller says so, and the field is
    /// absent for every client that predates it — which is what keeps the
    /// legacy last-write-wins path reachable rather than accidental.
    #[test]
    fn deserializes_conditional_and_unconditional_claims() {
        let conditional: Envelope = serde_json::from_value(json!({
            "requestId": 60,
            "type": "focus-and-resize",
            "sessionId": "session-1",
            "viewId": "view-1",
            "attachmentEpoch": 3,
            "cols": 120,
            "rows": 40,
            "expectedControlRevision": 17,
        }))
        .unwrap();
        assert!(matches!(
            conditional.command,
            Command::FocusAndResize {
                expected_control_revision: Some(17),
                ..
            }
        ));

        let legacy: Envelope = serde_json::from_value(json!({
            "requestId": 61,
            "type": "focus-and-resize",
            "sessionId": "session-1",
            "viewId": "view-1",
            "attachmentEpoch": 3,
            "cols": 120,
            "rows": 40,
        }))
        .unwrap();
        assert!(matches!(
            legacy.command,
            Command::FocusAndResize {
                expected_control_revision: None,
                ..
            }
        ));
    }

    /// The exact JSON both claim outcomes put on the wire. Clients decode this
    /// strictly, and `control-rejected` is a shape no older client has ever
    /// seen — it is reachable only in answer to a request that carried
    /// `expectedControlRevision`, which is the gate that keeps it away from
    /// them.
    #[test]
    fn serializes_both_outcomes_of_a_claim() {
        let claimed = serde_json::to_value(ResponseEnvelope {
            request_id: 7,
            body: ResponseBody::ControlClaimed {
                session_id: "session-1".to_owned(),
                controller_view_id: "view-1".to_owned(),
                control_epoch: 5,
                control_revision: 18,
                cols: 120,
                rows: 40,
                layout_epoch: 3,
            },
        })
        .unwrap();
        assert_eq!(
            claimed,
            json!({
                "requestId": 7,
                "type": "control-claimed",
                "sessionId": "session-1",
                "controllerViewId": "view-1",
                "controlEpoch": 5,
                "controlRevision": 18,
                "cols": 120,
                "rows": 40,
                "layoutEpoch": 3,
            })
        );

        let rejected = serde_json::to_value(ResponseEnvelope {
            request_id: 8,
            body: ResponseBody::ControlRejected {
                session_id: "session-1".to_owned(),
                controller: Some(RemoteControllerInfo {
                    view_id: "view-2".to_owned(),
                    control_epoch: 6,
                }),
                control_revision: 19,
                cols: 120,
                rows: 40,
                layout_epoch: 3,
            },
        })
        .unwrap();
        assert_eq!(
            rejected,
            json!({
                "requestId": 8,
                "type": "control-rejected",
                "sessionId": "session-1",
                "controller": { "viewId": "view-2", "controlEpoch": 6 },
                "controlRevision": 19,
                "cols": 120,
                "rows": 40,
                "layoutEpoch": 3,
            })
        );

        // The rejection that says "nobody holds control at a newer revision" —
        // the one §4.2.3 lets a client retry. `control-claimed` cannot express
        // it, which is the whole reason this shape exists.
        let cleared = serde_json::to_value(ResponseEnvelope {
            request_id: 9,
            body: ResponseBody::ControlRejected {
                session_id: "session-1".to_owned(),
                controller: None,
                control_revision: 20,
                cols: 120,
                rows: 40,
                layout_epoch: 3,
            },
        })
        .unwrap();
        assert_eq!(cleared["controller"], json!(null));
        assert_eq!(cleared["controlRevision"], 20);
    }

    #[test]
    fn deserializes_remote_lifecycle_commands() {
        let state: Envelope = serde_json::from_value(json!({
            "requestId": 50,
            "type": "get-remote-session-state",
            "sessionId": "session-1",
        }))
        .unwrap();
        assert!(matches!(
            state.command,
            Command::GetRemoteSessionState { session_id } if session_id == "session-1"
        ));

        let reconnect: Envelope = serde_json::from_value(json!({
            "requestId": 51,
            "type": "reconnect-remote-session",
            "sessionId": "session-1",
        }))
        .unwrap();
        assert!(matches!(
            reconnect.command,
            Command::ReconnectRemoteSession { session_id } if session_id == "session-1"
        ));

        let retry: Envelope = serde_json::from_value(json!({
            "requestId": 52,
            "type": "retry-remote-view",
            "sessionId": "session-1",
            "viewId": "view-1",
        }))
        .unwrap();
        assert!(matches!(
            retry.command,
            Command::RetryRemoteView { session_id, view_id }
                if session_id == "session-1" && view_id == "view-1"
        ));
    }
}
