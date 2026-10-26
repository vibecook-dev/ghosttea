use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, bail};
use async_trait::async_trait;
use ghosttea_text::TextEngine;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::{
    FrameHub, TerminalPresentationConfig,
    service::Registry,
    session::{SessionActivity, SessionStatus, SessionSummary},
    tunnel_protocol::{SharedSessionSummary, TunnelInput},
};

#[derive(Clone, Debug)]
pub struct RemoteControlClaim {
    pub controller_view_id: String,
    pub control_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

#[derive(Clone, Debug)]
pub struct RemoteControlChanged {
    pub session_id: String,
    pub controller_view_id: String,
    pub control_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

#[derive(Clone, Debug)]
pub struct RemoteActivityChanged {
    pub session_id: String,
    pub activity: SessionActivity,
}

/// A replica's working directory or title changed. Both are carried as
/// absolute state, as the local `session-metadata-changed` event carries them.
#[derive(Clone, Debug)]
pub struct RemoteMetadataChanged {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

pub struct RemoteResize {
    pub attachment_epoch: u64,
    pub control_epoch: u64,
    pub resize_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}

pub struct RemoteSelection {
    pub attachment_epoch: u64,
    pub start_column: u16,
    pub start_row: u32,
    pub end_column: u16,
    pub end_row: u32,
    pub select_all: bool,
}

pub struct RemoteAttachment {
    pub attachment_epoch: u64,
    pub read_write: bool,
}

/// Lifecycle of one open remote session, owned by the mesh runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteLifecycleState {
    Opening,
    Live,
    Synchronizing,
    Reconnecting,
    Suspended,
    Ended,
}

impl RemoteLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Live => "live",
            Self::Synchronizing => "synchronizing",
            Self::Reconnecting => "reconnecting",
            Self::Suspended => "suspended",
            Self::Ended => "ended",
        }
    }
}

/// Terminal lifecycle reasons. Each is claimed only on the evidence defined by
/// the reconnect design, so a viewer never reports a cause it did not observe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteEndedReason {
    SessionClosed,
    SessionExited,
    SessionUnavailable,
    HostRestarted,
    HostShutdown,
    ClosedLocally,
}

impl RemoteEndedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionClosed => "session-closed",
            Self::SessionExited => "session-exited",
            Self::SessionUnavailable => "session-unavailable",
            Self::HostRestarted => "host-restarted",
            Self::HostShutdown => "host-shutdown",
            Self::ClosedLocally => "closed-locally",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExitInfo {
    pub code: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteViewState {
    Pending,
    Attached,
    Failed,
}

impl RemoteViewState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RemoteLifecycleChanged {
    pub session_id: String,
    pub lifecycle_seq: u64,
    pub device_id: String,
    pub device_name: String,
    pub state: RemoteLifecycleState,
    pub reason: Option<RemoteEndedReason>,
    pub exit: Option<RemoteExitInfo>,
    pub attempt: u32,
    pub next_retry_ms: Option<u64>,
    pub last_contact_ms: Option<u64>,
}

/// Per-view attachment readiness. `attachment_epoch` and `read_write` are
/// populated only while `view_state` is `Attached`; inventing either for a
/// pending or failed view would recreate the stale-epoch bug this replaces.
#[derive(Clone, Debug)]
pub struct RemoteViewStateChanged {
    pub session_id: String,
    pub local_view_id: String,
    pub view_state_seq: u64,
    pub view_state: RemoteViewState,
    pub attachment_epoch: Option<u64>,
    pub read_write: Option<bool>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct RemoteViewRecord {
    pub local_view_id: String,
    pub view_state_seq: u64,
    pub view_state: RemoteViewState,
    pub attachment_epoch: Option<u64>,
    pub read_write: Option<bool>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
}

/// Who holds control, if anyone. `view_id` is a *local* view id: the mesh
/// translates wire identities at its boundary, so callers never see a rotated
/// or hashed one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteController {
    pub view_id: String,
    pub control_epoch: u64,
}

/// A session's controller state as of one revision. `controller: None` is
/// finally expressible — which is the whole reason this exists rather than
/// another field on [`RemoteControlChanged`].
#[derive(Clone, Debug)]
pub struct RemoteControlState {
    pub session_id: String,
    pub controller: Option<RemoteController>,
    /// 0 means "legacy, unknown": the host negotiated below the reconnect
    /// minor and cannot report revisions or clears. A reconnect-capable
    /// authority starts at 1, so 0 is unreachable for it — never CAS against
    /// this value.
    pub control_revision: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

/// The outcome of a compare-and-swap claim.
///
/// The asymmetric reclaim rule reads off the announced state: `Rejected`
/// showing *another* view holding control ends the reclaim — do not retry;
/// `Rejected` showing *no* controller at a newer revision may be retried with
/// that revision, while the pane still holds meaningful focus.
#[derive(Clone, Debug)]
pub enum RemoteControlOutcome {
    Claimed(RemoteControlState),
    Rejected(RemoteControlState),
}

/// Recovery tunables. These belong to the mesh rather than the local IPC
/// config: they describe how this viewer treats a host that has gone quiet,
/// not how clients reach this daemon.
#[derive(Clone, Copy, Debug)]
pub struct MeshReconnectConfig {
    /// Full jitter, AWS definition:
    /// `delay(n) = max(floor, uniform(0, min(cap, base · 2ⁿ)))`, `n` 0-based.
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    pub backoff_floor: Duration,
    /// How long a host may stay absent before the engine stops burning dials
    /// and the session comes to rest in Suspended, still watching.
    pub suspend_after: Duration,
    /// How long a synchronizing session waits for its feed's first snapshot
    /// before abandoning the attempt.
    pub synchronize_timeout: Duration,
    /// Whether a fresh advertisement short-circuits the backoff timer.
    pub advertisement_fast_path: bool,
    /// Whether a resumed session purges the attachments it stranded. Purely an
    /// acceleration: the host reaps them itself once it notices the abandoned
    /// connection died.
    pub zombie_purge: bool,
    /// How long a connection carrying an attached view may go without contact
    /// before the viewer probes it. Idle-triggered, not a fixed interval: a
    /// session whose state stream never falls quiet never pings at all.
    pub heartbeat_idle: Duration,
    /// How long without contact declares the connection dead. Counts from the
    /// same contact clock as [`Self::heartbeat_idle`], so it is the total
    /// silence tolerated, not an extra wait after the ping.
    pub heartbeat_fail: Duration,
}

impl Default for MeshReconnectConfig {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_millis(500),
            backoff_cap: Duration::from_secs(10),
            backoff_floor: Duration::from_millis(250),
            suspend_after: Duration::from_secs(10 * 60),
            synchronize_timeout: Duration::from_secs(10),
            advertisement_fast_path: true,
            zombie_purge: true,
            heartbeat_idle: Duration::from_secs(3),
            heartbeat_fail: Duration::from_secs(6),
        }
    }
}

/// The authoritative reconciliation snapshot for one remote session.
#[derive(Clone, Debug)]
pub struct RemoteSessionLifecycle {
    pub session_id: String,
    pub lifecycle_seq: u64,
    pub device_id: String,
    pub device_name: String,
    pub state: RemoteLifecycleState,
    pub reason: Option<RemoteEndedReason>,
    pub exit: Option<RemoteExitInfo>,
    pub attempt: u32,
    pub next_retry_ms: Option<u64>,
    pub last_contact_ms: Option<u64>,
    pub views: Vec<RemoteViewRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostSummary {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub host_instance_id: String,
    pub sessions: Vec<SharedSessionSummary>,
}

pub struct RemoteSessionOpen {
    pub device_id: String,
    pub remote_session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub owner_id: Option<String>,
    pub frames: FrameHub,
    pub text_engine: Arc<Mutex<TextEngine>>,
}

#[async_trait]
pub trait RemoteTerminalRuntime: Send + Sync {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged>;
    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged>;
    /// Working-directory and title changes of the replicas this runtime holds.
    ///
    /// Defaulted to a closed channel, so a runtime that holds no replicas, or
    /// predates the event, need not implement it.
    fn subscribe_metadata(&self) -> broadcast::Receiver<RemoteMetadataChanged> {
        let (sender, receiver) = broadcast::channel(1);
        drop(sender);
        receiver
    }
    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>>;
    async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>>;
    async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary>;
    async fn summaries(&self) -> Vec<SessionSummary>;
    async fn summary(&self, session_id: &str) -> Option<SessionSummary>;
    async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment>;
    async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()>;
    async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim>;
    async fn resize(&self, session_id: &str, view_id: &str, request: RemoteResize) -> Result<()>;
    async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String>;
    async fn refresh(&self, session_id: &str) -> Result<()>;
    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64);
    async fn close_session(&self, session_id: &str) -> bool;

    /// Compare-and-swap the application lifetime owner of a retained replica.
    /// Implementations must not dial the remote host: ownership is local to
    /// this viewer daemon.
    async fn transfer_owner(
        &self,
        _session_id: &str,
        _expected_owner_id: &str,
        _owner_id: &str,
    ) -> bool {
        false
    }

    fn subscribe_lifecycle(&self) -> broadcast::Receiver<RemoteLifecycleChanged> {
        closed_channel()
    }

    fn subscribe_view_state(&self) -> broadcast::Receiver<RemoteViewStateChanged> {
        closed_channel()
    }

    /// The full reconciliation snapshot for a session, including every view's
    /// current state. Clients rebuild from this rather than from the lossy
    /// event broadcast.
    async fn session_lifecycle(&self, _session_id: &str) -> Option<RemoteSessionLifecycle> {
        None
    }

    /// The authoritative attachment lookup. Callers must consult this at use
    /// time instead of caching an epoch, so a dead view re-dials rather than
    /// answering with a stale epoch.
    async fn current_attachment(&self, _session_id: &str, _view_id: &str) -> Option<(u64, bool)> {
        None
    }

    /// One-shot resume: invalidate the cached connection, dial exactly once,
    /// and re-attach this session's views under an advanced generation.
    async fn reconnect_session(&self, _session_id: &str) -> Result<RemoteSessionLifecycle> {
        unavailable()
    }

    /// A true remote refresh of a live session: a generation-advanced
    /// re-attach of its feed. Errors when the session is not live — there is
    /// no host to ask, and a local re-render is `refresh`'s job.
    async fn refresh_remote(&self, _session_id: &str) -> Result<()> {
        unavailable()
    }

    /// Every controller change, clears included. The reconnect-capable path
    /// publishes here; legacy hosts still populate it, but only ever with a
    /// controller present and `control_revision: 0`.
    fn subscribe_control_state(&self) -> broadcast::Receiver<RemoteControlState> {
        closed_channel()
    }

    /// The last observed controller state — the reconciliation source, so a
    /// lost clear has a repair path.
    async fn control_state(&self, _session_id: &str) -> Option<RemoteControlState> {
        None
    }

    /// Claim control, optionally compare-and-swapping against the revision the
    /// caller observed. `expected_control_revision: None` is legacy
    /// unconditional last-write-wins, which is all a pre-reconnect host
    /// understands.
    ///
    /// On [`RemoteControlOutcome::Rejected`] the announced state is *also*
    /// published through [`subscribe_control_state`](Self::subscribe_control_state)
    /// before this returns, so a client's retry rule fires off its own
    /// subscription rather than depending on the host's frame racing in.
    /// Duplicate announcements at one revision are expected; consumers are
    /// idempotent by revision.
    async fn claim_control_at(
        &self,
        _session_id: &str,
        _view_id: &str,
        _attachment_epoch: u64,
        _cols: u16,
        _rows: u16,
        _expected_control_revision: Option<u64>,
    ) -> Result<RemoteControlOutcome> {
        unavailable()
    }

    /// Re-attach one non-feed view of a live session — the per-pane retry for
    /// a view that failed while the rest of the session kept working. Errors
    /// when the session is not live or the view is the replica's feed; both are
    /// recovered through the session-level paths instead.
    async fn retry_view(&self, _session_id: &str, _view_id: &str) -> Result<RemoteViewRecord> {
        unavailable()
    }

    /// Liveness round-trip on a device's cached connection, bypassing
    /// advertisement validation. Used as a probe, never as a teardown trigger.
    async fn probe_connection(&self, _device_id: &str) -> Result<()> {
        unavailable()
    }

    /// Selection text extracted from the retained replica viewport, for use
    /// while the session is not live. `request.attachment_epoch` is ignored:
    /// there is no live attachment to fence against.
    async fn offline_selection_text(
        &self,
        _session_id: &str,
        _request: RemoteSelection,
    ) -> Result<String> {
        unavailable()
    }
}

fn closed_channel<T: Clone>() -> broadcast::Receiver<T> {
    let (sender, receiver) = broadcast::channel(1);
    drop(sender);
    receiver
}

/// What a host can honestly answer about a session id it is no longer
/// listing. The daemon owns the evidence — its registry and its tombstones —
/// and the mesh only asks; nothing about *how* a host remembers crosses this
/// seam, because a resuming viewer needs the verdict and nothing else.
pub trait SessionStatusSource: Send + Sync {
    fn session_status(&self, session_id: &str) -> SessionStatus;
}

/// Tells every connected viewer, once, that this host is going away.
///
/// It exists as a separate handle because [`TerminalMesh::serve`] consumes the
/// mesh: a drain running long after that still needs something to call, and
/// this is cheap to clone and safe to hold. Announcing is idempotent, and a
/// connection accepted after the announcement sees it immediately rather than
/// missing it.
#[derive(Clone)]
pub struct HostShutdownAnnouncer {
    announced: tokio::sync::watch::Sender<bool>,
}

impl Default for HostShutdownAnnouncer {
    fn default() -> Self {
        Self::new()
    }
}

impl HostShutdownAnnouncer {
    pub fn new() -> Self {
        Self {
            announced: tokio::sync::watch::channel(false).0,
        }
    }

    /// Publish the announcement to every connection watching. Returns as soon
    /// as it is published, not when viewers have acted on it: a drain must not
    /// be able to stall on a viewer that has stopped reading.
    pub fn announce(&self) {
        self.announced.send_replace(true);
    }

    pub fn announced(&self) -> bool {
        *self.announced.borrow()
    }

    /// For the mesh implementation: one receiver per connection handler.
    pub fn watch(&self) -> tokio::sync::watch::Receiver<bool> {
        self.announced.subscribe()
    }
}

#[async_trait]
pub trait TerminalMesh: Send {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime>;
    async fn serve(
        self: Box<Self>,
        registry: Registry,
        host_config: tokio::sync::watch::Receiver<Arc<TerminalPresentationConfig>>,
    ) -> Result<()>;

    /// Hand the mesh the lookup it answers session-status requests from, and
    /// that a resuming viewer's own consult goes through. Call before `serve`;
    /// a mesh without one answers `Unknown`, which is the honest reading of
    /// "this host cannot say".
    fn set_session_status_source(&mut self, _source: Arc<dyn SessionStatusSource>) {}

    /// The handle a drain keeps to announce shutdown. Defaulted to a detached
    /// announcer so a mesh that cannot announce is not a special case at the
    /// call site — announcing into it is a no-op rather than an error.
    fn shutdown_announcer(&self) -> HostShutdownAnnouncer {
        HostShutdownAnnouncer::new()
    }
}

#[derive(Default)]
pub(crate) struct NoRemoteRuntime;

fn unavailable<T>() -> Result<T> {
    bail!("remote terminal transport is not configured")
}

#[async_trait]
impl RemoteTerminalRuntime for NoRemoteRuntime {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged> {
        let (sender, receiver) = broadcast::channel(1);
        drop(sender);
        receiver
    }

    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged> {
        let (sender, receiver) = broadcast::channel(1);
        drop(sender);
        receiver
    }

    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        Ok(Vec::new())
    }

    async fn list_sessions(&self, _device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        unavailable()
    }

    async fn open_session(&self, _request: RemoteSessionOpen) -> Result<SessionSummary> {
        unavailable()
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        Vec::new()
    }

    async fn summary(&self, _session_id: &str) -> Option<SessionSummary> {
        None
    }

    async fn attach_view(&self, _session_id: &str, _view_id: &str) -> Result<RemoteAttachment> {
        unavailable()
    }

    async fn send_input(
        &self,
        _session_id: &str,
        _view_id: &str,
        _attachment_epoch: u64,
        _input_sequence: u64,
        _operation: TunnelInput,
    ) -> Result<()> {
        unavailable()
    }

    async fn claim_control(
        &self,
        _session_id: &str,
        _view_id: &str,
        _attachment_epoch: u64,
        _cols: u16,
        _rows: u16,
    ) -> Result<RemoteControlClaim> {
        unavailable()
    }

    async fn resize(
        &self,
        _session_id: &str,
        _view_id: &str,
        _request: RemoteResize,
    ) -> Result<()> {
        unavailable()
    }

    async fn selection_text(
        &self,
        _session_id: &str,
        _view_id: &str,
        _request: RemoteSelection,
    ) -> Result<String> {
        unavailable()
    }

    async fn refresh(&self, _session_id: &str) -> Result<()> {
        unavailable()
    }

    async fn detach_view(&self, _session_id: &str, _view_id: &str, _attachment_epoch: u64) {}

    async fn close_session(&self, _session_id: &str) -> bool {
        false
    }
}
