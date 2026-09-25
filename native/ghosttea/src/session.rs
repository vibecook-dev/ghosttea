use std::{
    collections::{HashMap, VecDeque},
    fmt,
    io::{Read, Write},
    path::Path,
    sync::{
        Arc, Condvar, Mutex, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

#[cfg(unix)]
mod unix_process_tree;

#[cfg(windows)]
mod process_tree;

use anyhow::{Context, Result};
use ghosttea_config::DEFAULT_SCROLLBACK_BYTES;
use ghosttea_core::{
    AttachRejection, ClipboardRequest, ControlChanged, ControlClaim, ControlSnapshot,
    ControllerState, InputOrderState, LogicalTerminalSnapshot, RenderRequest, ResumeEvidence,
    StateStreamCancel, TakeOver, TakeOverRequest, TerminalEffect, TerminalModel,
    TerminalModelOptions, TerminalRuntime, TerminalSelection, TerminalUpdate, ViewAccess,
    ViewAuthority,
};
use ghosttea_text::TextEngine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, watch};
use uuid::Uuid;

use crate::FrameHub;

const MAX_JSON_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

fn deserialize_optional_safe_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // `default` handles an absent field. Once the field is present it must be
    // a number; treating JSON null as absence would disagree with the public
    // `scrollbackBytes?: number` wire type and silently weaken validation.
    let value = u64::deserialize(deserializer)?;
    if value > MAX_JSON_SAFE_INTEGER {
        return Err(serde::de::Error::custom(
            "value exceeds JavaScript's safe-integer ceiling",
        ));
    }
    Ok(Some(value))
}

/// Stable control-wire metadata attached at the point where a create failure
/// still has typed causes. Display deliberately preserves the pre-metadata top
/// message byte-for-byte.
#[derive(Debug)]
pub(crate) struct ControlFailure {
    message: String,
    pub(crate) stage: &'static str,
    pub(crate) code: Option<&'static str>,
    pub(crate) os_error: Option<i32>,
}

impl fmt::Display for ControlFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn typed_io_error(error: &anyhow::Error) -> Option<&std::io::Error> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<std::io::Error>())
}

fn absolute_executable_error(executable: &str) -> Option<std::io::Error> {
    let path = Path::new(executable);
    if !path.is_absolute() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};

        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        if unsafe { libc::access(path.as_ptr(), libc::X_OK) } != 0 {
            return Some(std::io::Error::last_os_error());
        }
        None
    }

    #[cfg(windows)]
    {
        std::fs::metadata(path).err()
    }

    #[cfg(not(any(unix, windows)))]
    {
        std::fs::metadata(path).err()
    }
}

fn spawn_error_code(error: Option<&std::io::Error>) -> Option<&'static str> {
    let error = error?;
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::EMFILE) | Some(libc::ENFILE)
    ) {
        return Some("file-descriptor-exhausted");
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => Some("executable-not-found"),
        std::io::ErrorKind::PermissionDenied => Some("permission-denied"),
        std::io::ErrorKind::OutOfMemory => Some("resource-exhausted"),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Persistence {
    TerminateWithApp,
    KeepUntilExit,
    KeepUntilExplicitClose,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TerminationSource {
    #[default]
    User,
    Application,
    ServiceShutdown,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExitOutcome {
    Completed,
    Crashed,
    Signaled,
    UserTerminated,
    ApplicationTerminated,
    ServiceTerminated,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExit {
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub requested_termination: Option<TerminationSource>,
    pub exit_outcome: ExitOutcome,
}

fn classify_exit(
    exit_code: Option<i32>,
    exit_signal: Option<&str>,
    source: Option<TerminationSource>,
) -> ExitOutcome {
    match source {
        Some(TerminationSource::User) => ExitOutcome::UserTerminated,
        Some(TerminationSource::Application) => ExitOutcome::ApplicationTerminated,
        Some(TerminationSource::ServiceShutdown) => ExitOutcome::ServiceTerminated,
        None if exit_signal.is_some() => ExitOutcome::Signaled,
        None if exit_code == Some(0) => ExitOutcome::Completed,
        None if exit_code.is_some() => ExitOutcome::Crashed,
        None => ExitOutcome::Unknown,
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum SessionEnvironment {
    Inherit {
        #[serde(default)]
        overrides: HashMap<String, String>,
    },
    Clean {
        #[serde(default)]
        variables: HashMap<String, String>,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionProgramKind {
    InteractiveShell,
    Application,
    #[default]
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedProgramKind {
    InteractiveShell,
    Application,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivityKind {
    ShellIdle,
    ForegroundJob,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivitySource {
    ShellIntegration,
    ProcessGroup,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivityConfidence {
    Authoritative,
    Heuristic,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub kind: SessionActivityKind,
    pub source: SessionActivitySource,
    pub confidence: SessionActivityConfidence,
    pub root_process_group_id: Option<i32>,
    pub foreground_process_group_id: Option<i32>,
    pub observed_at_ms: u64,
}

impl SessionActivity {
    pub(crate) fn unsupported(observed_at_ms: u64) -> Self {
        Self {
            kind: SessionActivityKind::Unknown,
            source: SessionActivitySource::Unsupported,
            confidence: SessionActivityConfidence::Heuristic,
            root_process_group_id: None,
            foreground_process_group_id: None,
            observed_at_ms,
        }
    }

    fn same_observation(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.source == other.source
            && self.confidence == other.confidence
            && self.root_process_group_id == other.root_process_group_id
            && self.foreground_process_group_id == other.foreground_process_group_id
    }
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self::unsupported(0)
    }
}

/// Infer activity from the PTY's foreground process group. Windows has no
/// process groups and reports `SessionActivity::unsupported` instead.
#[cfg(unix)]
fn classify_process_group_activity(
    program_kind: ResolvedProgramKind,
    root_process_group_id: Option<i32>,
    foreground_process_group_id: Option<i32>,
) -> SessionActivityKind {
    match (
        program_kind,
        root_process_group_id,
        foreground_process_group_id,
    ) {
        (_, Some(root), Some(foreground)) if root != foreground => {
            SessionActivityKind::ForegroundJob
        }
        (ResolvedProgramKind::InteractiveShell, Some(_), Some(_)) => SessionActivityKind::ShellIdle,
        (ResolvedProgramKind::Application, Some(_), Some(_)) => SessionActivityKind::ForegroundJob,
        _ => SessionActivityKind::Unknown,
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AutomationInputOperation {
    Text { text: String },
    Paste { text: String, submit: bool },
    Interrupt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationInputResult {
    pub accepted: bool,
    pub human_input_epoch: u64,
    pub input_sequence: Option<u64>,
}

/// Notified once a session has concluded.
///
/// Deliberately carries no persistence value: retention is decided by reading
/// the session's current class under the registry lock, so a `set-persistence`
/// that returned success cannot be overtaken by a class sampled earlier.
pub type ExitCallback = Arc<dyn Fn(String, SessionExit) + Send + Sync>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Legacy additive environment overlay. New callers should use `environment`.
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub environment: Option<SessionEnvironment>,
    pub cols: u16,
    pub rows: u16,
    pub persistence: Persistence,
    #[serde(default)]
    pub program_kind: SessionProgramKind,
    pub owner_id: Option<String>,
    /// Per-session scrollback cap. Absent delegates to the service's current
    /// global default; zero intentionally disables scrollback.
    #[serde(default, deserialize_with = "deserialize_optional_safe_u64")]
    pub scrollback_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    #[serde(rename = "type")]
    pub action: KeyAction,
    pub key: String,
    pub code: String,
    pub repeat: bool,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
    #[serde(default)]
    pub unshifted_codepoint: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseInput {
    pub action: MouseAction,
    pub button: u8,
    pub x: f32,
    pub y: f32,
    pub screen_width: u32,
    pub screen_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub padding_left: u32,
    pub padding_top: u32,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub handle: String,
    pub executable: String,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub read_write: bool,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub bell_count: u64,
    pub pid: Option<u32>,
    pub created_at_ms: u64,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub requested_termination: Option<TerminationSource>,
    pub exit_outcome: Option<ExitOutcome>,
    pub owner_id: Option<String>,
    /// The retention class this host governs the session by, and the single
    /// source of truth for it — `set-persistence` rewrites it here.
    ///
    /// `None` for a replica of a session another host governs: reporting a
    /// class would assert a governance this host does not hold.
    pub persistence: Option<Persistence>,
    /// Effective local cap, or `None` for a replica governed by another host.
    pub scrollback_bytes: Option<u64>,
    pub activity: SessionActivity,
}

/// Why a session ended, decided once — at the moment it left the registry.
///
/// The distinction is only truthful if it is computed at a single choke point:
/// sessions leave through several racing paths (natural exit, explicit close,
/// owner closure) and letting each path name its own cause would record
/// `Exited` or `Closed` according to which one happened to win.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "kebab-case")]
pub enum SessionEndCause {
    Exited { code: Option<i32> },
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTombstone {
    pub cause: SessionEndCause,
    pub ended_at_ms: u64,
}

/// What a host can honestly say about a session id. `Unknown` covers an
/// expired or never-written tombstone and must never be upgraded to a
/// specific end reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SessionStatus {
    Live,
    Ended { cause: SessionEndCause },
    Unknown,
}

/// The exit evidence the removal choke point consults.
///
/// A trait rather than a direct [`Session`] call so the precedence rules can
/// be tested without spawning a pty.
pub trait SessionEndEvidence {
    /// Whether the child process is already known to have exited.
    fn has_exited(&self) -> bool;
    /// The exit code observed for that process, if it reported one.
    fn observed_exit_code(&self) -> Option<i32>;
}

impl SessionEndEvidence for Session {
    fn has_exited(&self) -> bool {
        Session::has_exited(self)
    }

    fn observed_exit_code(&self) -> Option<i32> {
        self.summary.lock().unwrap().exit_code
    }
}

/// Injectable so TTL expiry is testable without sleeping.
pub trait TombstoneClock: Send + Sync {
    fn now_ms(&self) -> u64;
}

struct SystemTombstoneClock;

impl TombstoneClock for SystemTombstoneClock {
    fn now_ms(&self) -> u64 {
        now_ms()
    }
}

pub const TOMBSTONE_CAPACITY: usize = 128;
pub const TOMBSTONE_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// Bounded evidence of why sessions ended, so a viewer that was disconnected
/// when it happened can still be told the truth instead of a guess.
///
/// Sits beside the session registry rather than inside it: the registry is a
/// bare `HashMap` type alias shared by every caller.
pub struct SessionTombstones {
    entries: Mutex<TombstoneEntries>,
    clock: Arc<dyn TombstoneClock>,
}

#[derive(Default)]
struct TombstoneEntries {
    by_id: HashMap<String, SessionTombstone>,
    /// Least recently used at the front; the eviction order for the cap.
    recency: VecDeque<String>,
}

impl Default for SessionTombstones {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionTombstones {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemTombstoneClock))
    }

    pub fn with_clock(clock: Arc<dyn TombstoneClock>) -> Self {
        Self {
            entries: Mutex::new(TombstoneEntries::default()),
            clock,
        }
    }

    /// The single removal choke point: take the session out of the registry
    /// and record why, atomically.
    ///
    /// Lock order is registry then tombstones. Callers that already hold the
    /// registry guard must use [`SessionTombstones::remove_with_cause_locked`]
    /// instead — calling this while holding it deadlocks.
    pub fn remove_with_cause<S: SessionEndEvidence>(
        &self,
        sessions: &RwLock<HashMap<String, Arc<S>>>,
        session_id: &str,
    ) -> Option<Arc<S>> {
        self.remove_with_cause_locked(&mut sessions.write().unwrap(), session_id)
    }

    /// [`SessionTombstones::remove_with_cause`] for a caller that already
    /// holds the registry lock — which is what makes the cause atomic with the
    /// removal.
    ///
    /// Precedence: an observed process exit wins no matter which path
    /// triggered the removal, so `Closed` is reserved for sessions removed
    /// while still running. The first writer commits; a later removal of the
    /// same id finds nothing to remove and overwrites nothing.
    pub fn remove_with_cause_locked<S: SessionEndEvidence>(
        &self,
        sessions: &mut HashMap<String, Arc<S>>,
        session_id: &str,
    ) -> Option<Arc<S>> {
        let removed = sessions.remove(session_id)?;
        let cause = if removed.has_exited() {
            SessionEndCause::Exited {
                code: removed.observed_exit_code(),
            }
        } else {
            SessionEndCause::Closed
        };
        self.commit(session_id, cause);
        Some(removed)
    }

    /// A session still in the registry is `Live` even if its process has
    /// exited: it is listed and attachable, which is what a resuming viewer
    /// is asking about.
    pub fn session_status<S>(
        &self,
        sessions: &RwLock<HashMap<String, Arc<S>>>,
        session_id: &str,
    ) -> SessionStatus {
        let live = sessions.read().unwrap().contains_key(session_id);
        self.status_after_registry(live, session_id)
    }

    pub fn session_status_locked<S>(
        &self,
        sessions: &HashMap<String, Arc<S>>,
        session_id: &str,
    ) -> SessionStatus {
        self.status_after_registry(sessions.contains_key(session_id), session_id)
    }

    fn status_after_registry(&self, live: bool, session_id: &str) -> SessionStatus {
        if live {
            return SessionStatus::Live;
        }
        match self.lookup(session_id) {
            Some(tombstone) => SessionStatus::Ended {
                cause: tombstone.cause,
            },
            None => SessionStatus::Unknown,
        }
    }

    /// Read a tombstone, refreshing its recency. Expired entries are dropped
    /// on the way past rather than by a timer.
    pub fn lookup(&self, session_id: &str) -> Option<SessionTombstone> {
        let now = self.clock.now_ms();
        let mut entries = self.entries.lock().unwrap();
        entries.expire(now);
        let tombstone = *entries.by_id.get(session_id)?;
        entries.touch(session_id);
        Some(tombstone)
    }

    pub fn len(&self) -> usize {
        let now = self.clock.now_ms();
        let mut entries = self.entries.lock().unwrap();
        entries.expire(now);
        entries.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn commit(&self, session_id: &str, cause: SessionEndCause) {
        let now = self.clock.now_ms();
        let mut entries = self.entries.lock().unwrap();
        entries.expire(now);
        if entries.by_id.contains_key(session_id) {
            return;
        }
        entries.by_id.insert(
            session_id.to_owned(),
            SessionTombstone {
                cause,
                ended_at_ms: now,
            },
        );
        entries.recency.push_back(session_id.to_owned());
        while entries.by_id.len() > TOMBSTONE_CAPACITY {
            let Some(evicted) = entries.recency.pop_front() else {
                break;
            };
            entries.by_id.remove(&evicted);
        }
    }
}

impl TombstoneEntries {
    fn expire(&mut self, now_ms: u64) {
        if self.by_id.is_empty() {
            return;
        }
        self.by_id
            .retain(|_, tombstone| now_ms.saturating_sub(tombstone.ended_at_ms) < TOMBSTONE_TTL_MS);
        let by_id = &self.by_id;
        self.recency
            .retain(|session_id| by_id.contains_key(session_id));
    }

    fn touch(&mut self, session_id: &str) {
        let Some(position) = self
            .recency
            .iter()
            .position(|candidate| candidate == session_id)
        else {
            return;
        };
        self.recency.remove(position);
        self.recency.push_back(session_id.to_owned());
    }
}

/// Wakes the termination escalator the moment the session concludes, so each
/// grace period lasts only as long as the child actually needs.
/// Why a ladder rung stopped waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhaseWait {
    /// The child is gone and the reader ended. Deliberately NOT "concluded":
    /// the reap, the exit broadcast and the retention decision all still
    /// follow, and the drain waits on that later signal, not this one.
    Exited,
    /// This rung's grace elapsed; escalate to the next one.
    GraceElapsed,
    /// A deadline arrived — skip the remaining rungs and force the end.
    DeadlineReached,
}

/// Wakes the termination escalator the moment the session concludes, so each
/// grace period lasts only as long as the child actually needs.
///
/// It also carries the deadline, because a deadline that arrives *mid-wait*
/// would otherwise be invisible until the current grace elapsed. Setting one
/// wakes the escalator immediately, which is what lets a shutdown compress a
/// ladder that is already running.
struct ExitLatch {
    state: Mutex<LatchState>,
    condvar: Condvar,
}

struct LatchState {
    exited: bool,
    deadline: Option<Instant>,
}

impl ExitLatch {
    fn new() -> Self {
        Self {
            state: Mutex::new(LatchState {
                exited: false,
                deadline: None,
            }),
            condvar: Condvar::new(),
        }
    }

    fn notify(&self) {
        self.state.lock().unwrap().exited = true;
        self.condvar.notify_all();
    }

    /// Bound the remaining ladder. Min-combines, so the tightest deadline any
    /// caller asked for wins and a later, looser one cannot relax it.
    fn set_deadline(&self, deadline: Instant) {
        {
            let mut state = self.state.lock().unwrap();
            state.deadline = Some(match state.deadline {
                Some(existing) => existing.min(deadline),
                None => deadline,
            });
        }
        self.condvar.notify_all();
    }

    /// Only the Unix ladder scales its graces to the remaining budget; the
    /// Windows path has a single grace and relies on the deadline jump alone,
    /// so it never reads this.
    #[cfg(unix)]
    fn deadline(&self) -> Option<Instant> {
        self.state.lock().unwrap().deadline
    }

    /// Wait out one ladder rung, ending early on conclusion or on the deadline.
    fn wait_phase(&self, grace: Duration) -> PhaseWait {
        let grace_ends = Instant::now() + grace;
        let mut state = self.state.lock().unwrap();
        loop {
            if state.exited {
                return PhaseWait::Exited;
            }
            let now = Instant::now();
            if state.deadline.is_some_and(|deadline| deadline <= now) {
                return PhaseWait::DeadlineReached;
            }
            if now >= grace_ends {
                return PhaseWait::GraceElapsed;
            }
            // Wake for whichever comes first; a `set_deadline` in between
            // notifies and re-runs this loop with the tighter bound.
            let wake_at = match state.deadline {
                Some(deadline) => deadline.min(grace_ends),
                None => grace_ends,
            };
            let (next, _) = self
                .condvar
                .wait_timeout(state, wake_at.saturating_duration_since(now))
                .unwrap();
            state = next;
        }
    }
}

pub struct Session {
    summary: Mutex<SessionSummary>,
    created_at_ms: u64,
    process: PtyProcess,
    exit_latch: ExitLatch,
    /// Flipped once the session has genuinely concluded: reaped, stamped, exit
    /// broadcast, retention decided. Strictly later than `exit_latch`, which
    /// fires at *exited* — before the reap — so a drain that must know the
    /// session is finished cannot use the latch for it.
    concluded: watch::Sender<bool>,
    model: Mutex<TerminalModel>,
    model_operation: Mutex<()>,
    exited: AtomicBool,
    frames: FrameHub,
    on_exit: ExitCallback,
    authority: Mutex<ViewAuthority>,
    input_tx: mpsc::SyncSender<InputOperation>,
    input_order: Mutex<InputOrderState>,
    termination_started: AtomicBool,
    requested_termination: Mutex<Option<TerminationSource>>,
    logical_tx: broadcast::Sender<LogicalTerminalSnapshot>,
    selection_txs: Mutex<HashMap<String, watch::Sender<Option<TerminalSelection>>>>,
    control_tx: broadcast::Sender<ControlChanged>,
    control_state_tx: broadcast::Sender<ControlSnapshot>,
    activity_tx: broadcast::Sender<SessionActivity>,
    program_kind: ResolvedProgramKind,
}

enum InputOperation {
    Shutdown,
    Text(String),
    Paste(String),
    Key(KeyInput),
    Mouse(MouseInput),
    Scroll(isize),
    ScrollTo(usize),
    Focus(bool),
    Interrupt,
    Automation(AutomationInputOperation),
}

struct PtyProcess {
    /// Released when the session ends. On Windows that release is what lets the
    /// reader observe end of file; see `Session::start_exit_watcher`.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Addresses the process group when signalling. Windows has no equivalent
    /// and consumes the identifier at spawn to build `tree` instead, so it
    /// keeps no copy.
    #[cfg(unix)]
    pid: Option<u32>,
    /// Write end of the reader's shutdown pipe. Termination's last resort:
    /// a surviving process that still holds the slave (an orphaned background
    /// job, a daemon that kept its stdio) would otherwise keep the reader from
    /// ever seeing end of file, and the session from ever concluding.
    #[cfg(unix)]
    reader_shutdown: Option<OwnedFd>,
    /// Stable birth identities and dynamically discovered membership for the
    /// Unix PTY session. Captured before the root can be reaped and reused.
    #[cfg(unix)]
    tree: Option<unix_process_tree::ProcessTree>,
    /// Owns the session's whole process tree. `None` when the job could not be
    /// created, which leaves termination on the direct child alone.
    #[cfg(windows)]
    tree: Option<process_tree::ProcessTree>,
}

struct ObservedProcessExit {
    exit_code: Option<i32>,
    exit_signal: Option<String>,
}

const INTERRUPT_GRACE: Duration = Duration::from_secs(2);
/// How long a Windows session outlives its child.
///
/// A session ends when its pseudoconsole closes, so this is both the window the
/// reader has to drain the child's last output and the window in which a client
/// can still attach to a session whose program returned at once. The Windows
/// integration fixtures print a marker and exit immediately, and rely on the
/// second of those; `windows_sessions_outlive_a_fast_child` states the bound.
#[cfg(windows)]
const EXIT_DRAIN: Duration = Duration::from_millis(150);
/// Grace between SIGTERM and SIGKILL. Windows escalates straight from the
/// interrupt to `Child::kill`, so it has no intermediate step to wait out.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(2);
/// Final grace between the SIGKILL sweep and forcing the reader shut. The
/// signals cover the root and foreground process groups, but a process outside
/// both that keeps the slave open would otherwise hold the reader — and with
/// it the session's exit accounting — forever.
#[cfg(unix)]
const FORCE_EOF_GRACE: Duration = Duration::from_secs(1);

impl PtyProcess {
    fn write(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let master = self.master.lock().unwrap();
        // Released once the session ends; a late resize has nothing to apply.
        let Some(master) = master.as_ref() else {
            return Ok(());
        };
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn wait(&self) -> ObservedProcessExit {
        match self.child.lock().unwrap().wait() {
            Ok(status) => ObservedProcessExit {
                exit_code: status
                    .signal()
                    .is_none()
                    .then(|| i32::try_from(status.exit_code()).ok())
                    .flatten(),
                exit_signal: status.signal().map(str::to_owned),
            },
            Err(_) => ObservedProcessExit {
                exit_code: None,
                exit_signal: None,
            },
        }
    }

    #[cfg(unix)]
    fn process_group_activity(
        &self,
        program_kind: ResolvedProgramKind,
        observed_at_ms: u64,
    ) -> SessionActivity {
        let foreground_process_group_id = self
            .master
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|master| master.process_group_leader());
        let root_process_group_id = self.pid.and_then(|pid| {
            let pid = i32::try_from(pid).ok()?;
            let process_group_id = unsafe { libc::getpgid(pid) };
            (process_group_id > 0).then_some(process_group_id)
        });
        let kind = classify_process_group_activity(
            program_kind,
            root_process_group_id,
            foreground_process_group_id,
        );
        SessionActivity {
            kind,
            source: SessionActivitySource::ProcessGroup,
            confidence: SessionActivityConfidence::Heuristic,
            root_process_group_id,
            foreground_process_group_id,
            observed_at_ms,
        }
    }

    #[cfg(not(unix))]
    fn process_group_activity(
        &self,
        _program_kind: ResolvedProgramKind,
        observed_at_ms: u64,
    ) -> SessionActivity {
        SessionActivity::unsupported(observed_at_ms)
    }

    /// Force the poll-based reader to end as though the PTY reached end of
    /// file. A no-op when the master fd could not be duplicated at spawn and
    /// the session fell back to a blocking reader.
    #[cfg(unix)]
    fn force_reader_shutdown(&self) {
        if let Some(fd) = &self.reader_shutdown {
            let byte = [1_u8];
            let _ = unsafe { libc::write(fd.as_raw_fd(), byte.as_ptr().cast(), 1) };
        }
    }
}

/// The floor a rung is worth waiting at all; below it, waiting only delays the
/// sweep without giving a child a real chance to finish.
#[cfg(unix)]
const MINIMUM_GRACE: Duration = Duration::from_millis(50);

/// Fit the ladder to the time actually available.
///
/// With no deadline every rung gets its full default. With one, the remaining
/// time is split in the defaults' proportions (2:2:1) so a small budget still
/// buys a real SIGTERM grace instead of collapsing straight to SIGKILL — and
/// a budget too small to matter degrades to the floor, with the deadline jump
/// as the backstop.
#[cfg(unix)]
fn scaled_graces(deadline: Option<Instant>) -> [Duration; 3] {
    const DEFAULTS: [Duration; 3] = [INTERRUPT_GRACE, TERMINATE_GRACE, FORCE_EOF_GRACE];
    let Some(deadline) = deadline else {
        return DEFAULTS;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    let full: Duration = DEFAULTS.iter().sum();
    if remaining >= full {
        return DEFAULTS;
    }
    DEFAULTS.map(|default| {
        let share = remaining.mul_f64(default.as_secs_f64() / full.as_secs_f64());
        share.clamp(MINIMUM_GRACE, default)
    })
}

/// Where the reader thread takes PTY output from.
///
/// Unix sessions poll a duplicate of the master alongside a shutdown pipe so
/// termination can force end of file; everywhere else (and on the rare Unix
/// host where the master exposes no fd) the reader blocks on the
/// `portable-pty` reader and ends when the platform closes the pipe.
enum ReaderSource {
    Blocking(Box<dyn Read + Send>),
    #[cfg(unix)]
    Polled {
        master: OwnedFd,
        shutdown: OwnedFd,
    },
}

#[cfg(unix)]
fn unix_reader_source(master: &(dyn MasterPty + Send)) -> Result<(ReaderSource, Option<OwnedFd>)> {
    let Some(fd) = master.as_raw_fd() else {
        return Ok((ReaderSource::Blocking(master.try_clone_reader()?), None));
    };
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicated < 0 {
        return Ok((ReaderSource::Blocking(master.try_clone_reader()?), None));
    }
    let master = unsafe { OwnedFd::from_raw_fd(duplicated) };
    let mut pipe_fds = [0_i32; 2];
    if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error()).context("create reader shutdown pipe");
    }
    let (shutdown_rx, shutdown_tx) = unsafe {
        (
            OwnedFd::from_raw_fd(pipe_fds[0]),
            OwnedFd::from_raw_fd(pipe_fds[1]),
        )
    };
    for fd in [&shutdown_rx, &shutdown_tx] {
        unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    Ok((
        ReaderSource::Polled {
            master,
            shutdown: shutdown_rx,
        },
        Some(shutdown_tx),
    ))
}

/// Read PTY output until end of file, an unrecoverable error, or a byte on the
/// shutdown pipe. The master fd stays blocking; poll gates every read, so a
/// read never blocks without data.
#[cfg(unix)]
fn polled_read_loop(master: &OwnedFd, shutdown: &OwnedFd, output_tx: &mpsc::SyncSender<Vec<u8>>) {
    let mut bytes = [0_u8; 16 * 1024];
    loop {
        let mut fds = [
            libc::pollfd {
                fd: master.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: shutdown.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
        // Shutdown wins over pending output: it only fires seconds after a
        // termination the client already observed, and a survivor that keeps
        // writing must not be able to hold the reader open by doing so.
        if fds[1].revents != 0 {
            return;
        }
        if fds[0].revents != 0 {
            let count =
                unsafe { libc::read(master.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                // Linux reports EIO once every slave has gone.
                return;
            }
            if count == 0 {
                // BSD and macOS report end of file instead.
                return;
            }
            if output_tx.send(bytes[..count as usize].to_vec()).is_err() {
                return;
            }
        }
    }
}

const PRIVATE_SERVICE_ENVIRONMENT_KEYS: &[&str] = &[
    "GHOSTTEA_AUTH_TOKEN",
    "TERMINALD_AUTH_TOKEN",
    "GHOSTTEA_CONTROL_SOCKET",
    "TERMINALD_CONTROL_SOCKET",
    "GHOSTTEA_FRAME_SOCKET",
    "TERMINALD_FRAME_SOCKET",
    "GHOSTTEA_FONT_DIR",
    "TERMINALD_FONT_DIR",
    "TRUFFLE_TEST_AUTHKEY",
    "TRUFFLE_SIDECAR_PATH",
];

const PRIVATE_SERVICE_ENVIRONMENT_PREFIXES: &[&str] = &[
    "GHOSTTEA_TRUFFLE_",
    "TERMINALD_TRUFFLE_",
    "GHOSTTEA_EXTERNAL_",
];

// Windows preserves environment-key spelling but resolves names without
// regard to ASCII case. Secret removal must make its keep/drop decision in
// that same case regime; Unix environment names remain byte-sensitive.
#[cfg(windows)]
fn environment_key_equals(key: &str, private_key: &str) -> bool {
    key.eq_ignore_ascii_case(private_key)
}

#[cfg(not(windows))]
fn environment_key_equals(key: &str, private_key: &str) -> bool {
    key == private_key
}

#[cfg(windows)]
fn environment_key_has_prefix(key: &str, private_prefix: &str) -> bool {
    key.as_bytes()
        .get(..private_prefix.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(private_prefix.as_bytes()))
}

#[cfg(not(windows))]
fn environment_key_has_prefix(key: &str, private_prefix: &str) -> bool {
    key.starts_with(private_prefix)
}

fn is_private_service_environment(key: &str, extra_prefixes: &[String]) -> bool {
    PRIVATE_SERVICE_ENVIRONMENT_KEYS
        .iter()
        .any(|private_key| environment_key_equals(key, private_key))
        || PRIVATE_SERVICE_ENVIRONMENT_PREFIXES
            .iter()
            .any(|prefix| environment_key_has_prefix(key, prefix))
        || extra_prefixes
            .iter()
            .any(|prefix| environment_key_has_prefix(key, prefix))
}

fn remove_private_service_environment(
    command: &mut CommandBuilder,
    inherited_keys: impl IntoIterator<Item = String>,
    extra_prefixes: &[String],
) {
    for key in inherited_keys {
        if is_private_service_environment(&key, extra_prefixes) {
            command.env_remove(key);
        }
    }
}

fn configure_environment(
    command: &mut CommandBuilder,
    legacy: HashMap<String, String>,
    environment: Option<SessionEnvironment>,
    extra_private_prefixes: &[String],
) {
    let environment = environment.unwrap_or(SessionEnvironment::Inherit { overrides: legacy });
    match environment {
        SessionEnvironment::Inherit { overrides } => {
            remove_private_service_environment(
                command,
                std::env::vars().map(|(key, _)| key),
                extra_private_prefixes,
            );
            for (key, value) in overrides {
                command.env(key, value);
            }
        }
        SessionEnvironment::Clean { variables } => {
            command.env_clear();
            for (key, value) in variables {
                command.env(key, value);
            }
        }
    }
    command.env("TERM", "xterm-256color");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn resolve_program_kind(
    configured: SessionProgramKind,
    executable: &str,
    args: &[String],
) -> ResolvedProgramKind {
    match configured {
        SessionProgramKind::InteractiveShell => ResolvedProgramKind::InteractiveShell,
        SessionProgramKind::Application => ResolvedProgramKind::Application,
        SessionProgramKind::Auto => {
            let executable = Path::new(executable)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(executable)
                .trim_start_matches('-');
            let recognized_shell = matches!(
                executable,
                "sh" | "ash"
                    | "bash"
                    | "dash"
                    | "elvish"
                    | "fish"
                    | "ksh"
                    | "mksh"
                    | "nu"
                    | "xonsh"
                    | "zsh"
            );
            let invokes_command = args
                .iter()
                .any(|arg| arg == "-c" || arg == "--command" || !arg.starts_with('-'));
            if recognized_shell && !invokes_command {
                ResolvedProgramKind::InteractiveShell
            } else if recognized_shell {
                ResolvedProgramKind::Application
            } else {
                ResolvedProgramKind::Unknown
            }
        }
    }
}

impl Session {
    pub fn spawn(
        options: SpawnOptions,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        Self::spawn_with_private_env_prefixes(options, frames, text_engine, &[], on_exit)
    }

    /// Spawn a standalone session while stripping additional host-private
    /// environment prefixes from inherited child state.
    ///
    /// Embedders that also run [`crate::TerminalService`] should normally use
    /// [`crate::ServiceSessions::spawn`], which additionally applies the live
    /// service configuration, registry, shutdown, tombstone, ownership, and
    /// lifecycle policy. This lower-level constructor exists for hosts that
    /// deliberately own those policies themselves.
    pub fn spawn_with_private_env_prefixes(
        options: SpawnOptions,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
        extra_private_prefixes: &[String],
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let scrollback_bytes =
            usize::try_from(options.scrollback_bytes.unwrap_or(DEFAULT_SCROLLBACK_BYTES))
                .context("scrollbackBytes does not fit this platform")?;
        Self::spawn_configured(
            options,
            frames,
            text_engine,
            extra_private_prefixes,
            scrollback_bytes,
            on_exit,
        )
    }

    pub(crate) fn spawn_configured(
        options: SpawnOptions,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
        extra_private_prefixes: &[String],
        scrollback_bytes: usize,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let SpawnOptions {
            executable,
            args,
            cwd,
            env,
            environment,
            cols,
            rows,
            persistence,
            program_kind,
            owner_id,
            scrollback_bytes: _,
        } = options;
        let program_kind = resolve_program_kind(program_kind, &executable, &args);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                // portable-pty has already rendered its io::Error into this
                // string, so stage is the only honest typed fact available.
                let message = error.to_string();
                error.context(ControlFailure {
                    message,
                    stage: "openpty",
                    code: None,
                    os_error: None,
                })
            })?;
        let mut command = CommandBuilder::new(&executable);
        command.args(args);
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        configure_environment(&mut command, env, environment, extra_private_prefixes);
        let link_cwd = command
            .get_cwd()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    std::env::current_dir().unwrap_or_default().join(path)
                }
            })
            .and_then(|path| path.into_os_string().into_string().ok());
        let link_home = command
            .get_env("HOME")
            .or_else(|| command.get_env("USERPROFILE"))
            .and_then(|value| value.to_str())
            .map(str::to_owned);
        let child = pair.slave.spawn_command(command).map_err(|error| {
            // `Command::spawn` keeps its io::Error in the anyhow chain, but
            // portable-pty resolves an absolute executable first and renders
            // a failed `access(2)` into a string. Probe the caller-supplied
            // absolute path while it is still available so that common
            // missing-path and permission refusals retain typed metadata too.
            // This is deliberately a filesystem probe, not error-string
            // parsing; a real spawn error remains the authoritative source.
            let path_error = if typed_io_error(&error).is_none() {
                absolute_executable_error(&executable)
            } else {
                None
            };
            let io_error = typed_io_error(&error).or(path_error.as_ref());
            let metadata = ControlFailure {
                message: "failed to spawn PTY command".to_owned(),
                stage: "spawn",
                code: spawn_error_code(io_error),
                os_error: io_error.and_then(std::io::Error::raw_os_error),
            };
            error.context(metadata)
        })?;
        let pid = child.process_id();
        // Adopt the tree before anything else so a shell that starts a
        // background job is already inside the job object. A failure here is
        // not fatal: termination falls back to the direct child.
        #[cfg(unix)]
        let process_tree = pid.and_then(|pid| {
            let tree = unix_process_tree::ProcessTree::capture(pid);
            if tree.is_none() {
                eprintln!("[ghosttea] could not pin process-tree identity for pid {pid}");
            }
            tree
        });
        // Duplicated before the child moves behind its mutex, so the exit
        // watcher never has to take that lock to learn the child is gone.
        #[cfg(windows)]
        let exit_handle = child.as_raw_handle().and_then(|handle| {
            process_tree::ExitHandle::duplicate(handle as isize)
                .inspect_err(|error| {
                    eprintln!("[ghosttea] failed to duplicate the child handle: {error}");
                })
                .ok()
        });
        #[cfg(windows)]
        let process_tree = pid.and_then(|pid| match process_tree::ProcessTree::adopt(pid) {
            Ok(tree) => Some(tree),
            Err(error) => {
                eprintln!("[ghosttea] failed to own the process tree for pid {pid}: {error}");
                None
            }
        });
        drop(pair.slave);
        #[cfg(unix)]
        let (reader_source, reader_shutdown) = unix_reader_source(pair.master.as_ref())?;
        #[cfg(not(unix))]
        let reader_source = ReaderSource::Blocking(pair.master.try_clone_reader()?);
        let writer = pair.master.take_writer()?;
        let (input_tx, input_rx) = mpsc::sync_channel(1024);
        let id = Uuid::new_v4().to_string();
        let id_bytes = *Uuid::parse_str(&id)?.as_bytes();
        let handle = u64::from_le_bytes(id_bytes[..8].try_into().unwrap());
        let session_epoch = u64::from_le_bytes(id_bytes[8..].try_into().unwrap()).max(1);
        let created_at_ms = now_ms();
        let (logical_tx, _) = broadcast::channel(8);
        let (control_tx, _) = broadcast::channel(16);
        let (control_state_tx, _) = broadcast::channel(16);
        let (activity_tx, _) = broadcast::channel(16);
        let runtime = Arc::new(TerminalRuntime::from_shared_text_engine(text_engine));
        let mut model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: handle,
                session_epoch,
                layout_epoch: 1,
                cols,
                rows,
                scrollback_bytes,
            },
        )?;
        model.set_link_context(link_cwd.clone(), link_home);
        let session = Arc::new(Self {
            summary: Mutex::new(SessionSummary {
                id,
                handle: handle.to_string(),
                executable,
                cols,
                rows,
                exited: false,
                read_write: true,
                title: None,
                cwd: link_cwd,
                bell_count: 0,
                pid,
                created_at_ms,
                exit_code: None,
                exit_signal: None,
                requested_termination: None,
                exit_outcome: None,
                owner_id,
                persistence: Some(persistence),
                scrollback_bytes: Some(scrollback_bytes as u64),
                activity: SessionActivity::unsupported(created_at_ms),
            }),
            created_at_ms,
            process: PtyProcess {
                master: Mutex::new(Some(pair.master)),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                #[cfg(unix)]
                pid,
                #[cfg(unix)]
                reader_shutdown,
                #[cfg(unix)]
                tree: process_tree,
                #[cfg(windows)]
                tree: process_tree,
            },
            exit_latch: ExitLatch::new(),
            concluded: watch::channel(false).0,
            model: Mutex::new(model),
            model_operation: Mutex::new(()),
            exited: AtomicBool::new(false),
            frames,
            on_exit,
            authority: Mutex::new(ViewAuthority::new(cols, rows)),
            input_tx,
            input_order: Mutex::new(InputOrderState::default()),
            termination_started: AtomicBool::new(false),
            requested_termination: Mutex::new(None),
            logical_tx,
            selection_txs: Mutex::new(HashMap::new()),
            control_tx,
            control_state_tx,
            activity_tx,
            program_kind,
        });
        let _ = session.sample_activity();
        Self::start_input_actor(&session, input_rx);
        #[cfg(windows)]
        Self::start_exit_watcher(&session, exit_handle);
        Self::start_reader(&session, reader_source);
        Ok(session)
    }

    fn start_input_actor(session: &Arc<Self>, input_rx: mpsc::Receiver<InputOperation>) {
        let session_id = session.id();
        let session = Arc::downgrade(session);
        std::thread::Builder::new()
            .name(format!("pty-input-{session_id}"))
            .spawn(move || {
                while let Ok(operation) = input_rx.recv() {
                    if matches!(operation, InputOperation::Shutdown) {
                        break;
                    }
                    let Some(session) = Weak::upgrade(&session) else {
                        break;
                    };
                    if session.has_exited() {
                        break;
                    }
                    if let Err(error) = session.execute_input(operation) {
                        eprintln!(
                            "[ghosttea] PTY input failed for {}: {error:#}",
                            session.id()
                        );
                    }
                    if session.has_exited() {
                        break;
                    }
                }
            })
            .expect("PTY input actor");
    }

    /// Make a Windows session's exit observable.
    ///
    /// A Unix PTY reports end of file on the master once the last slave handle
    /// closes, so the reader ends on its own when the child exits. ConPTY keeps
    /// the output pipe open until the pseudoconsole itself closes, which
    /// `portable-pty` does when the master drops — so without this the reader
    /// blocks forever, the session never reports its exit, and it never leaves
    /// the registry.
    ///
    /// Releasing the master closes the pseudoconsole and ends the reader, which
    /// runs the same teardown a Unix session reaches by itself.
    #[cfg(windows)]
    fn start_exit_watcher(session: &Arc<Self>, exit: Option<process_tree::ExitHandle>) {
        /// How long to block on the child before checking whether the session
        /// still exists. Long enough that an idle pane costs almost nothing,
        /// short enough that a dropped session releases its watcher promptly.
        const POLL: Duration = Duration::from_millis(500);
        /// Time for the reader to drain what the child wrote just before
        /// exiting. Closing the pseudoconsole discards anything still buffered.
        ///
        /// This also decides how long a session that exits immediately stays
        /// attachable, which the integration fixtures rely on; see
        /// [`EXIT_DRAIN`] and the test that holds the two together.
        const DRAIN: Duration = EXIT_DRAIN;

        let watcher_id = session.id();
        let session = Arc::downgrade(session);
        std::thread::Builder::new()
            .name(format!("pty-exit-{watcher_id}"))
            .spawn(move || {
                loop {
                    // Waiting on an owned duplicate rather than polling the
                    // child keeps this off the lock that terminating needs, and
                    // costs one wake per interval instead of one per poll.
                    let exited = match &exit {
                        Some(exit) => exit.exited(POLL),
                        // Without a handle to wait on, fall back to asking.
                        None => {
                            std::thread::sleep(POLL);
                            match Weak::upgrade(&session) {
                                Some(alive) => matches!(
                                    alive.process.child.lock().unwrap().try_wait(),
                                    Ok(Some(_))
                                ),
                                None => return,
                            }
                        }
                    };
                    if !exited {
                        // The session was dropped, which released the master
                        // with it, so there is nothing left to close.
                        if Weak::upgrade(&session).is_none() {
                            return;
                        }
                        continue;
                    }
                    std::thread::sleep(DRAIN);
                    let Some(alive) = Weak::upgrade(&session) else {
                        return;
                    };
                    alive.process.master.lock().unwrap().take();
                    return;
                }
            })
            .expect("PTY exit watcher");
    }

    fn start_reader(session: &Arc<Self>, source: ReaderSource) {
        const FRAME_INTERVAL: Duration = Duration::from_millis(8);
        const MAX_BATCH_BYTES: usize = 256 * 1024;
        let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let reader_id = session.id();
        std::thread::Builder::new()
            .name(format!("pty-read-{reader_id}"))
            .spawn(move || match source {
                ReaderSource::Blocking(mut reader) => {
                    let mut bytes = [0_u8; 16 * 1024];
                    while let Ok(count) = reader.read(&mut bytes) {
                        if count == 0 {
                            break;
                        }
                        if output_tx.send(bytes[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
                #[cfg(unix)]
                ReaderSource::Polled { master, shutdown } => {
                    polled_read_loop(&master, &shutdown, &output_tx);
                }
            })
            .expect("PTY read thread");

        let session = Arc::clone(session);
        std::thread::Builder::new()
            .name(format!("pty-frame-{}", session.id()))
            .spawn(move || {
                while let Ok(first) = output_rx.recv() {
                    let deadline = Instant::now() + FRAME_INTERVAL;
                    let mut batch = first;
                    while batch.len() < MAX_BATCH_BYTES {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match output_rx.recv_timeout(deadline.saturating_duration_since(now)) {
                            Ok(bytes) => batch.extend_from_slice(&bytes),
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    let render = if session.has_active_views() {
                        RenderRequest::Damage
                    } else {
                        RenderRequest::None
                    };
                    let _operation = session.model_operation.lock().unwrap();
                    let update = session.model.lock().unwrap().feed(&batch, render);
                    match update {
                        Ok(update) => session.execute_update(update),
                        Err(error) => {
                            eprintln!("terminal model feed failed for {}: {error:#}", session.id())
                        }
                    }
                }
                session.exited.store(true, Ordering::Release);
                session.exit_latch.notify();
                // Wake the input actor even when no more user input will arrive.
                // The actor only holds a Weak reference while blocked, so this
                // message is lifecycle coordination rather than an ownership
                // requirement.
                let _ = session.input_tx.try_send(InputOperation::Shutdown);
                let observed = session.process.wait();
                let requested_termination = *session.requested_termination.lock().unwrap();
                let exit_outcome = classify_exit(
                    observed.exit_code,
                    observed.exit_signal.as_deref(),
                    requested_termination,
                );
                let exit = SessionExit {
                    exit_code: observed.exit_code,
                    exit_signal: observed.exit_signal,
                    requested_termination,
                    exit_outcome,
                };
                {
                    let mut summary = session.summary.lock().unwrap();
                    summary.exited = true;
                    summary.exit_code = exit.exit_code;
                    summary.exit_signal.clone_from(&exit.exit_signal);
                    summary.requested_termination = exit.requested_termination;
                    summary.exit_outcome = Some(exit.exit_outcome);
                }
                if session.has_active_views() {
                    let _operation = session.model_operation.lock().unwrap();
                    // Drop the model guard before executing effects: selection
                    // publication snapshots the model again, and a match
                    // scrutinee temporary otherwise lives through the arm.
                    let update = session.model.lock().unwrap().refresh(RenderRequest::Damage);
                    match update {
                        Ok(update) => session.execute_update(update),
                        Err(error) => eprintln!(
                            "terminal model final refresh failed for {}: {error:#}",
                            session.id()
                        ),
                    }
                }
                (session.on_exit)(session.id(), exit);
                // Last act, deliberately after `on_exit` returns: an observer
                // that sees this knows the exit was broadcast and retention was
                // already decided, not merely that the child died.
                // `send_replace`, not `send`: `send` fails when no receiver
                // exists yet and then *discards the update*, so a session that
                // concludes before anyone subscribes would stay `false`
                // forever and every later subscriber would wait on a
                // transition that already happened.
                session.concluded.send_replace(true);
            })
            .expect("PTY reader thread");
    }

    fn execute_update(&self, update: TerminalUpdate) {
        self.announce_selections(self.model.lock().unwrap().view_selections());
        for effect in update {
            match effect {
                TerminalEffect::WriteToTransport(bytes) => {
                    if let Err(error) = self.process.write(&bytes) {
                        eprintln!(
                            "[ghosttea] terminal reply write failed for {}: {error:#}",
                            self.id()
                        );
                    }
                }
                TerminalEffect::MetadataChanged(metadata) => {
                    let mut summary = self.summary.lock().unwrap();
                    summary.cols = metadata.cols;
                    summary.rows = metadata.rows;
                    summary.title = metadata.title;
                    summary.cwd = metadata.cwd;
                }
                TerminalEffect::Bell => {
                    let mut summary = self.summary.lock().unwrap();
                    summary.bell_count = summary.bell_count.saturating_add(1);
                }
                TerminalEffect::ClipboardRequest(ClipboardRequest::Write(_)) => {
                    // The existing desktop renderer applies clipboard policy from the
                    // matching ordered TRF1 frame. Native Apple hosts handle this effect
                    // directly at their policy boundary.
                }
                TerminalEffect::LogicalSnapshotReady(snapshot) => {
                    let _ = self.logical_tx.send(snapshot);
                }
                TerminalEffect::FrameReady(frame) => {
                    self.frames.publish(frame);
                }
            }
        }
    }

    pub fn id(&self) -> String {
        self.summary.lock().unwrap().id.clone()
    }
    pub fn owner_id(&self) -> Option<String> {
        self.summary.lock().unwrap().owner_id.clone()
    }
    pub fn transfer_owner(&self, expected_owner_id: &str, owner_id: &str) -> bool {
        let mut summary = self.summary.lock().unwrap();
        if summary.owner_id.as_deref() != Some(expected_owner_id) {
            return false;
        }
        summary.owner_id = Some(owner_id.to_owned());
        true
    }
    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }

    pub fn sample_activity(&self) -> Option<SessionActivity> {
        if self.has_exited() {
            return None;
        }
        let next = self
            .process
            .process_group_activity(self.program_kind, now_ms());
        let changed = {
            let mut summary = self.summary.lock().unwrap();
            if summary.activity.observed_at_ms != 0 && summary.activity.same_observation(&next) {
                false
            } else {
                summary.activity = next.clone();
                true
            }
        };
        if !changed {
            return None;
        }
        let _ = self.activity_tx.send(next.clone());
        Some(next)
    }

    pub fn subscribe_activity(&self) -> broadcast::Receiver<SessionActivity> {
        self.activity_tx.subscribe()
    }

    pub fn announce_activity(&self) {
        let _ = self
            .activity_tx
            .send(self.summary.lock().unwrap().activity.clone());
    }

    pub fn selection_text(
        &self,
        view_id: &str,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    ) -> Result<String> {
        let _operation = self.model_operation.lock().unwrap();
        let (text, selection) = {
            let mut model = self.model.lock().unwrap();
            let text = model
                .selection_text_for(
                    view_id,
                    (start_column, start_row),
                    (end_column, end_row),
                    select_all,
                )
                .context("format terminal selection")?;
            (text, model.selection_for(view_id))
        };
        self.announce_selection(view_id, selection);
        Ok(text)
    }
    pub fn session_epoch(&self) -> u64 {
        self.model.lock().unwrap().session_epoch()
    }
    pub fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    pub fn logical_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
        self.model.lock().unwrap().latest_logical()
    }
    pub fn subscribe_logical(&self) -> broadcast::Receiver<LogicalTerminalSnapshot> {
        self.logical_tx.subscribe()
    }
    pub fn selection_snapshot(&self, view_id: &str) -> Option<TerminalSelection> {
        self.model.lock().unwrap().selection_for(view_id)
    }
    pub fn subscribe_selection(&self, view_id: &str) -> watch::Receiver<Option<TerminalSelection>> {
        let initial = self.model.lock().unwrap().selection_for(view_id);
        self.selection_txs
            .lock()
            .unwrap()
            .entry(view_id.to_owned())
            .or_insert_with(|| watch::channel(initial).0)
            .subscribe()
    }

    fn announce_selection(&self, view_id: &str, selection: Option<TerminalSelection>) {
        let mut publishers = self.selection_txs.lock().unwrap();
        let publisher = publishers
            .entry(view_id.to_owned())
            .or_insert_with(|| watch::channel(selection).0);
        if *publisher.borrow() != selection {
            publisher.send_replace(selection);
        }
    }

    fn announce_selections(&self, selections: Vec<(String, Option<TerminalSelection>)>) {
        for (view_id, selection) in selections {
            self.announce_selection(&view_id, selection);
        }
    }

    fn remove_view_selection(&self, view_id: &str) {
        let _operation = self.model_operation.lock().unwrap();
        self.model.lock().unwrap().remove_view_selection(view_id);
        self.selection_txs.lock().unwrap().remove(view_id);
    }
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    /// Whether the session has finished concluding — not merely exited.
    pub fn has_concluded(&self) -> bool {
        *self.concluded.borrow()
    }

    /// Await conclusion. Resolves immediately for a session that already has,
    /// so a subscriber cannot miss the transition by arriving late.
    pub fn subscribe_conclusion(&self) -> watch::Receiver<bool> {
        self.concluded.subscribe()
    }
    /// The session's retention class. `None` only for a session this host
    /// does not govern, which never reaches the local registry.
    pub fn persistence(&self) -> Option<Persistence> {
        self.summary.lock().unwrap().persistence
    }

    /// Re-class a live session.
    ///
    /// Callers must hold the registry lock across this and the retention
    /// decision that reads it back, so a set that returned success is the
    /// value that decides retention.
    pub fn set_persistence(&self, persistence: Persistence) {
        self.summary.lock().unwrap().persistence = Some(persistence);
    }
    pub fn attach_view(&self, view_id: &str, client_id: &str) -> Result<u64> {
        self.attach_view_with_access(view_id, client_id, ViewAccess::ReadWrite)
    }

    pub fn attach_view_with_access(
        &self,
        view_id: &str,
        client_id: &str,
        access: ViewAccess,
    ) -> Result<u64> {
        let attachment_epoch = {
            let mut authority = self.authority.lock().unwrap();
            authority.attach(view_id, client_id, access)?
        };
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().refresh(RenderRequest::Full)?;
        self.execute_update(update);
        Ok(attachment_epoch)
    }

    /// Attach with takeover semantics: a fresh attachment epoch even for a
    /// re-attach of the same view by the same client, ordered by
    /// `attach_generation` and fenced by `fence_conn_id`.
    ///
    /// Unlike [`Session::attach_view_with_access`] this publishes no snapshot;
    /// the caller decides, because an attach that declined the live-state
    /// stream must not force a full refresh. Call [`Session::refresh`] after a
    /// state-carrying takeover.
    ///
    /// The session epoch is read before the authority lock is taken, which is
    /// sound because the model's session epoch is fixed for its lifetime.
    pub fn take_over_view(
        &self,
        view_id: &str,
        client_id: &str,
        access: ViewAccess,
        attach_generation: u64,
        fence_conn_id: u64,
        resume: Option<ResumeEvidence>,
    ) -> std::result::Result<TakeOver, AttachRejection> {
        let session_epoch = self.session_epoch();
        let mut authority = self.authority.lock().unwrap();
        let taken = authority.take_over(TakeOverRequest {
            view_id,
            client_id,
            access,
            attach_generation,
            fence_conn_id,
            session_epoch,
            resume,
        })?;
        if taken.controller_cleared {
            let snapshot = authority.control_snapshot();
            drop(authority);
            self.announce_control_state(snapshot);
        }
        Ok(taken)
    }

    pub fn detach_view(&self, view_id: &str, client_id: &str) -> bool {
        let (detached, control_snapshot) = {
            let mut authority = self.authority.lock().unwrap();
            let revision = authority.control_revision();
            let detached = authority.detach(view_id, client_id);
            let control_snapshot =
                (authority.control_revision() != revision).then(|| authority.control_snapshot());
            (detached, control_snapshot)
        };
        if let Some(snapshot) = control_snapshot {
            self.announce_control_state(snapshot);
        }
        if detached {
            self.remove_view_selection(view_id);
        }
        detached
    }

    /// Detach only the named incarnation, so a cleanup path that fires after a
    /// takeover cannot evict the attachment that replaced it.
    pub fn detach_view_if_epoch(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
    ) -> bool {
        let (detached, control_snapshot) = {
            let mut authority = self.authority.lock().unwrap();
            let revision = authority.control_revision();
            let detached = authority.detach_view_if_epoch(view_id, client_id, attachment_epoch);
            let control_snapshot =
                (authority.control_revision() != revision).then(|| authority.control_snapshot());
            (detached, control_snapshot)
        };
        if let Some(snapshot) = control_snapshot {
            self.announce_control_state(snapshot);
        }
        if detached {
            self.remove_view_selection(view_id);
        }
        detached
    }

    /// Bind a state stream's cancel handle to one attachment incarnation.
    /// Fails if the incarnation was already superseded, which is how a handler
    /// that lost the takeover race learns to abort instead of spawning.
    ///
    /// The handle is fired with the authority lock held, so it must only
    /// signal cancellation — it must not call back into the session.
    pub fn register_state_stream(
        &self,
        view_id: &str,
        attachment_epoch: u64,
        cancel: StateStreamCancel,
    ) -> Result<()> {
        self.authority
            .lock()
            .unwrap()
            .register_state_stream(view_id, attachment_epoch, cancel)
    }

    /// Release attach watermarks whose fencing connections have all
    /// terminated. See `ViewAuthority::gc_attach_watermarks`.
    pub fn gc_attach_watermarks(&self, client_id: &str, terminated_through_conn_id: u64) -> usize {
        self.authority
            .lock()
            .unwrap()
            .gc_attach_watermarks(client_id, terminated_through_conn_id)
    }

    /// Outstanding attach watermarks held for a client. See
    /// `ViewAuthority::attach_watermark_count`.
    pub fn attach_watermark_count(&self, client_id: &str) -> usize {
        self.authority
            .lock()
            .unwrap()
            .attach_watermark_count(client_id)
    }

    pub fn view_attachment_epoch(&self, view_id: &str) -> Option<u64> {
        self.authority.lock().unwrap().attachment_epoch(view_id)
    }

    pub fn has_active_views(&self) -> bool {
        self.authority.lock().unwrap().has_views()
    }

    pub fn claim_control(
        &self,
        view_id: &str,
        client_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ControlChanged> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let mut next = authority.clone();
        let changed = next.claim_control(view_id, client_id, cols, rows)?;
        if changed.size_changed {
            self.apply_resize(cols, rows, changed.layout_epoch, previous_size)?;
        }
        *authority = next;
        let snapshot = authority.control_snapshot();
        drop(authority);
        let _ = self.control_tx.send(changed.clone());
        self.announce_control_state(snapshot);
        Ok(changed)
    }

    /// [`Session::claim_control`] fenced by the claimant's attachment epoch and,
    /// when `expected_control_revision` is `Some`, by a compare-and-swap on the
    /// control revision.
    ///
    /// A rejection is an `Ok` carrying the state to announce — the loser needs
    /// to see it to decide between retrying and standing down — and leaves the
    /// terminal size untouched.
    pub fn claim_control_checked(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        expected_control_revision: Option<u64>,
    ) -> Result<ControlClaim> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let mut next = authority.clone();
        let claim = next.claim_control_checked(
            view_id,
            client_id,
            attachment_epoch,
            cols,
            rows,
            expected_control_revision,
        )?;
        let ControlClaim::Granted(changed) = claim else {
            return Ok(claim);
        };
        if changed.size_changed {
            self.apply_resize(cols, rows, changed.layout_epoch, previous_size)?;
        }
        *authority = next;
        let snapshot = authority.control_snapshot();
        drop(authority);
        let _ = self.control_tx.send(changed.clone());
        self.announce_control_state(snapshot);
        Ok(ControlClaim::Granted(changed))
    }

    /// [`Session::resize_view`] with the attachment-epoch check, so a
    /// superseded incarnation cannot resize the terminal its successor owns.
    #[allow(clippy::too_many_arguments)]
    pub fn resize_view_checked(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let Some(prepared) = authority.prepare_resize_checked(
            view_id,
            client_id,
            attachment_epoch,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        if prepared.size_changed() {
            self.apply_resize(cols, rows, prepared.layout_epoch(), previous_size)?;
        }
        authority.commit_resize(view_id, prepared);
        Ok(prepared.size_changed())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn resize_view(
        &self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let Some(prepared) = authority.prepare_resize(
            view_id,
            client_id,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        if prepared.size_changed() {
            self.apply_resize(cols, rows, prepared.layout_epoch(), previous_size)?;
        }
        authority.commit_resize(view_id, prepared);
        Ok(prepared.size_changed())
    }

    pub fn control_state(&self) -> (Option<ControllerState>, u16, u16, u64) {
        let authority = self.authority.lock().unwrap();
        let (cols, rows) = authority.size();
        (
            authority.controller().cloned(),
            cols,
            rows,
            authority.layout_epoch(),
        )
    }

    /// The revisioned controller state, including "no controller" — the
    /// observation [`ControlChanged`] structurally cannot carry.
    pub fn control_snapshot(&self) -> ControlSnapshot {
        self.authority.lock().unwrap().control_snapshot()
    }

    pub fn subscribe_control(&self) -> broadcast::Receiver<ControlChanged> {
        self.control_tx.subscribe()
    }

    /// Every controller change, clears included. `subscribe_control` reports
    /// claims only, so a viewer watching it alone can never learn that the
    /// controller went away.
    pub fn subscribe_control_state(&self) -> broadcast::Receiver<ControlSnapshot> {
        self.control_state_tx.subscribe()
    }

    fn announce_control_state(&self, snapshot: ControlSnapshot) {
        let _ = self.control_state_tx.send(snapshot);
    }

    /// Re-announce the current controller state on **both** channels.
    ///
    /// This is the repair path — a rejected resize, a subscriber that lagged —
    /// so it has to reach the revisioned channel the state streams actually
    /// watch, not only the legacy one. A repair that publishes solely to
    /// `control_tx` cannot fix a lagged `control_state_tx` consumer by
    /// construction.
    ///
    /// The snapshot goes out even when there is no controller: that is exactly
    /// the state the legacy frame cannot express, and therefore the one most
    /// likely to need repairing. The legacy emission keeps its original
    /// controller-only behaviour for consumers that cannot represent a clear.
    pub fn announce_control(&self) {
        let authority = self.authority.lock().unwrap();
        let snapshot = authority.control_snapshot();
        let (cols, rows) = authority.size();
        let legacy = authority
            .controller()
            .cloned()
            .map(|controller| ControlChanged {
                controller,
                cols,
                rows,
                layout_epoch: authority.layout_epoch(),
                size_changed: false,
            });
        drop(authority);
        if let Some(changed) = legacy {
            let _ = self.control_tx.send(changed);
        }
        self.announce_control_state(snapshot);
    }

    pub fn refresh(&self) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().refresh(RenderRequest::Full)?;
        self.execute_update(update);
        Ok(())
    }

    fn authorize_and_enqueue(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: InputOperation,
        counts_as_human_input: bool,
    ) -> Result<()> {
        if !self.authority.lock().unwrap().authorize_input(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
        )? {
            return Ok(());
        }
        let mut order = self.input_order.lock().unwrap();
        self.input_tx
            .try_send(operation)
            .map_err(|error| anyhow::anyhow!("terminal input queue unavailable: {error}"))?;
        if counts_as_human_input {
            order.record_input(true);
        } else {
            order.record_input(false);
        }
        Ok(())
    }

    pub fn automation_state(&self) -> u64 {
        self.input_order.lock().unwrap().human_input_epoch()
    }

    pub fn automation_input(
        &self,
        expected_human_input_epoch: u64,
        operation: AutomationInputOperation,
    ) -> Result<AutomationInputResult> {
        let mut order = self.input_order.lock().unwrap();
        if !order.accepts_automation(expected_human_input_epoch) {
            return Ok(AutomationInputResult {
                accepted: false,
                human_input_epoch: order.human_input_epoch(),
                input_sequence: None,
            });
        }
        self.input_tx
            .try_send(InputOperation::Automation(operation))
            .map_err(|error| anyhow::anyhow!("terminal input queue unavailable: {error}"))?;
        let input_sequence = order.record_input(false);
        Ok(AutomationInputResult {
            accepted: true,
            human_input_epoch: order.human_input_epoch(),
            input_sequence: Some(input_sequence),
        })
    }

    pub fn send_text(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Text(text),
            true,
        )
    }

    pub fn paste(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Paste(text),
            true,
        )
    }

    pub fn key(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        input: KeyInput,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Key(input),
            true,
        )
    }

    pub fn mouse(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        input: MouseInput,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Mouse(input),
            true,
        )
    }

    pub fn focus(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        focused: bool,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Focus(focused),
            false,
        )
    }

    pub fn scroll(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        rows: isize,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Scroll(rows),
            true,
        )
    }

    pub fn scroll_to(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        row: usize,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::ScrollTo(row),
            true,
        )
    }

    pub fn interrupt(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Interrupt,
            true,
        )
    }

    fn execute_input(&self, operation: InputOperation) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        match operation {
            InputOperation::Shutdown => Ok(()),
            InputOperation::Text(text) => self.process.write(text.as_bytes()),
            InputOperation::Paste(text) => {
                let bytes = self.model.lock().unwrap().encode_paste(&text)?;
                self.process.write(&bytes)
            }
            InputOperation::Key(input) => self.execute_key(&input),
            InputOperation::Mouse(input) => self.execute_mouse(&input),
            InputOperation::Scroll(rows) => self.execute_scroll(rows),
            InputOperation::ScrollTo(row) => self.execute_scroll_to(row),
            InputOperation::Focus(focused) => {
                let bytes = self.model.lock().unwrap().encode_focus(focused)?;
                self.process.write(&bytes)
            }
            InputOperation::Interrupt => self.process.write(b"\x03"),
            InputOperation::Automation(operation) => self.execute_automation_input(operation),
        }
    }

    fn execute_automation_input(&self, operation: AutomationInputOperation) -> Result<()> {
        match operation {
            AutomationInputOperation::Text { text } => self.process.write(text.as_bytes()),
            AutomationInputOperation::Paste { text, submit } => {
                let bytes = {
                    let mut model = self.model.lock().unwrap();
                    let mut bytes = model.encode_paste(&text)?;
                    if submit {
                        bytes.extend_from_slice(&model.encode_key("Enter", "", 0, 0, 1)?);
                    }
                    bytes
                };
                self.process.write(&bytes)
            }
            AutomationInputOperation::Interrupt => self.process.write(b"\x03"),
        }
    }

    fn execute_key(&self, input: &KeyInput) -> Result<()> {
        let mut mods = 0_u16;
        if input.shift {
            mods |= 1 << 0;
        }
        if input.control {
            mods |= 1 << 1;
        }
        if input.alt {
            mods |= 1 << 2;
        }
        if input.meta {
            mods |= 1 << 3;
        }
        let action = match input.action {
            KeyAction::Up => 0,
            KeyAction::Down if input.repeat => 2,
            KeyAction::Down => 1,
        };
        let text = if !matches!(input.action, KeyAction::Up)
            && input.key.chars().count() == 1
            && !input.key.chars().any(char::is_control)
        {
            input.key.as_str()
        } else {
            ""
        };
        let bytes = self.model.lock().unwrap().encode_key(
            &input.code,
            text,
            input.unshifted_codepoint,
            mods,
            action,
        )?;
        self.process.write(&bytes)
    }

    fn execute_mouse(&self, input: &MouseInput) -> Result<()> {
        let action = match input.action {
            MouseAction::Press => 0,
            MouseAction::Release => 1,
            MouseAction::Motion => 2,
        };
        let mut mods = 0_u16;
        if input.shift {
            mods |= 1 << 0;
        }
        if input.control {
            mods |= 1 << 1;
        }
        if input.alt {
            mods |= 1 << 2;
        }
        if input.meta {
            mods |= 1 << 3;
        }
        let bytes = self.model.lock().unwrap().encode_mouse(
            action,
            input.button,
            mods,
            input.x,
            input.y,
            input.screen_width,
            input.screen_height,
            input.cell_width,
            input.cell_height,
            input.padding_left,
            input.padding_top,
        )?;
        self.process.write(&bytes)
    }

    fn execute_scroll(&self, rows: isize) -> Result<()> {
        if rows == 0 {
            return Ok(());
        }
        let (update, alternate_input) = {
            let mut model = self.model.lock().unwrap();
            if model.alternate_scroll() {
                let code = if rows < 0 { "ArrowUp" } else { "ArrowDown" };
                let mut input = Vec::new();
                for _ in 0..rows.unsigned_abs().min(100) {
                    input.extend_from_slice(&model.encode_key(code, "", 0, 0, 1)?);
                }
                (None, input)
            } else {
                (Some(model.scroll(rows, RenderRequest::Damage)?), Vec::new())
            }
        };
        if !alternate_input.is_empty() {
            self.process.write(&alternate_input)?;
        }
        if let Some(update) = update {
            self.execute_update(update);
        }
        Ok(())
    }

    fn execute_scroll_to(&self, row: usize) -> Result<()> {
        let update = self
            .model
            .lock()
            .unwrap()
            .scroll_to(row, RenderRequest::Damage)?;
        self.execute_update(update);
        Ok(())
    }

    fn apply_resize(
        &self,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
        previous_size: (u16, u16),
    ) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        self.process.resize(cols, rows)?;
        let update =
            match self
                .model
                .lock()
                .unwrap()
                .resize(cols, rows, layout_epoch, RenderRequest::Full)
            {
                Ok(update) => update,
                Err(error) => {
                    let _ = self.process.resize(previous_size.0, previous_size.1);
                    return Err(error);
                }
            };
        self.execute_update(update);
        Ok(())
    }

    pub fn set_colors(
        &self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    ) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().set_colors(
            foreground,
            background,
            cursor,
            RenderRequest::Full,
        )?;
        self.execute_update(update);
        Ok(())
    }

    pub fn set_appearance(
        &self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
        palette: &[(u8, [u8; 3])],
    ) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().set_appearance(
            foreground,
            background,
            cursor,
            palette,
            RenderRequest::Full,
        )?;
        self.execute_update(update);
        Ok(())
    }

    /// Terminate, bounded by `deadline`.
    ///
    /// The deadline lands in the latch before the ladder is asked to start, so
    /// it applies whether this call begins the ladder or finds one already
    /// running: `terminate` is idempotent and no-ops in the latter case, but
    /// the deadline still compresses the ladder in place. A session already
    /// terminating therefore keeps its original `TerminationSource` — the
    /// first requester's stamp is the honest one — while still concluding
    /// inside the new bound.
    pub fn terminate_within(
        self: &Arc<Self>,
        source: TerminationSource,
        deadline: Instant,
    ) -> Result<()> {
        self.exit_latch.set_deadline(deadline);
        self.terminate(source)
    }

    pub fn terminate(self: &Arc<Self>, source: TerminationSource) -> Result<()> {
        if self.has_exited() {
            return Ok(());
        }
        if self.termination_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        *self.requested_termination.lock().unwrap() = Some(source);
        self.summary.lock().unwrap().requested_termination = Some(source);
        #[cfg(unix)]
        let termination_tree = {
            let root_pid = self.process.pid.and_then(|pid| i32::try_from(pid).ok());
            let mut tree = self.process.tree.clone().or_else(|| {
                self.process
                    .pid
                    .and_then(unix_process_tree::ProcessTree::capture)
            });
            if let Some(tree) = &mut tree {
                tree.refresh();
            }
            (root_pid, tree)
        };
        {
            let mut order = self.input_order.lock().unwrap();
            if self.input_tx.try_send(InputOperation::Interrupt).is_ok() {
                order.record_input(false);
            } else {
                let _operation = self.model_operation.lock().unwrap();
                let _ = self.process.write(b"\x03");
            }
        }
        let session = Arc::clone(self);
        if let Err(error) = thread::Builder::new()
            .name(format!("pty-terminate-{}", session.id()))
            .spawn(move || {
                // Each rung returns the moment the session concludes, so the
                // escalator never outlives the child by more than one grace —
                // and returns early on a deadline, so a shutdown can compress a
                // ladder that is already running.
                #[cfg(unix)]
                let graces = scaled_graces(session.exit_latch.deadline());
                #[cfg(unix)]
                let [interrupt_grace, terminate_grace, force_eof_grace] = graces;
                #[cfg(unix)]
                let (root_pid, mut process_tree) = termination_tree;
                #[cfg(not(unix))]
                let interrupt_grace = INTERRUPT_GRACE;
                match session.exit_latch.wait_phase(interrupt_grace) {
                    PhaseWait::Exited => {
                        #[cfg(unix)]
                        if !process_tree
                            .as_mut()
                            .is_some_and(|tree| tree.has_live_members())
                        {
                            return;
                        }
                        #[cfg(not(unix))]
                        return;
                    }
                    PhaseWait::GraceElapsed => {}
                    // Nothing gentler is affordable; fall through to the sweep.
                    PhaseWait::DeadlineReached => {}
                }
                #[cfg(unix)]
                {
                    // Every group is discovered from a currently verified
                    // process identity. No cached PID or PGID crosses a grace
                    // period and becomes authority for a later signal.
                    // A deadline at any rung skips straight to the end: the
                    // remaining graces are courtesies the budget cannot afford.
                    let mut jump = false;
                    if let Some(tree) = &mut process_tree {
                        tree.signal(libc::SIGTERM, "terminate", &session.id());
                    } else if let Some(root_pid) = root_pid {
                        // Without a birth identity, only address the root while
                        // the reader proves it has not yet been reaped.
                        let _ = unsafe { libc::kill(root_pid, libc::SIGTERM) };
                    }
                    let mut terminate_deadline = Instant::now() + terminate_grace;
                    if let Some(overall_deadline) = session.exit_latch.deadline() {
                        terminate_deadline = terminate_deadline.min(overall_deadline);
                    }
                    match session.exit_latch.wait_phase(terminate_grace) {
                        PhaseWait::Exited => {
                            if !process_tree
                                .as_mut()
                                .is_some_and(|tree| tree.wait_for_exit(terminate_deadline))
                            {
                                return;
                            }
                        }
                        PhaseWait::GraceElapsed => {}
                        PhaseWait::DeadlineReached => jump = true,
                    }
                    if let Some(tree) = &mut process_tree {
                        tree.signal(libc::SIGKILL, "sweep", &session.id());
                    } else {
                        let _ = session.process.child.lock().unwrap().kill();
                    }
                    if !jump {
                        match session.exit_latch.wait_phase(force_eof_grace) {
                            PhaseWait::Exited => return,
                            PhaseWait::GraceElapsed | PhaseWait::DeadlineReached => {}
                        }
                    }
                    // A process that escaped both the verified descendant
                    // snapshot and signalled groups can still hold the slave;
                    // the session itself must nevertheless conclude.
                    session.process.force_reader_shutdown();
                }
                #[cfg(windows)]
                {
                    // The interrupt above is this platform's graceful step, so
                    // there is no second signal to wait out before sweeping.
                    match &session.process.tree {
                        // Reaches whatever the session started, which
                        // `Child::kill` on its own would leave running.
                        Some(tree) => {
                            if let Err(error) = tree.terminate() {
                                eprintln!(
                                    "[ghosttea] failed to sweep process tree {}: {error:#}",
                                    session.id()
                                );
                            }
                        }
                        None => {
                            let _ = session.process.child.lock().unwrap().kill();
                        }
                    }
                }
                #[cfg(not(any(unix, windows)))]
                {
                    let _ = session.process.child.lock().unwrap().kill();
                }
            })
        {
            self.termination_started.store(false, Ordering::Release);
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    /// The Windows integration fixtures create a session, then subscribe and
    /// attach before reading the marker it printed. Their programs return
    /// immediately, so the session has to outlive its child by long enough for
    /// those round trips. Shortening this silently breaks them, in a way that
    /// looks like a lost marker rather than a timing change.
    #[cfg(windows)]
    #[test]
    fn windows_sessions_outlive_a_fast_child() {
        assert!(
            super::EXIT_DRAIN >= std::time::Duration::from_millis(100),
            "the fixtures need a session to stay attachable for at least 100ms"
        );
    }

    use super::*;

    fn spawn_options_json(scrollback_bytes: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "executable": "/bin/sh",
            "args": [],
            "cols": 80,
            "rows": 24,
            "persistence": "keep-until-exit",
            "scrollbackBytes": scrollback_bytes,
        })
    }

    #[test]
    fn scrollback_override_accepts_zero_and_the_safe_integer_ceiling() {
        let zero: SpawnOptions = serde_json::from_value(spawn_options_json(0.into())).unwrap();
        assert_eq!(zero.scrollback_bytes, Some(0));
        let maximum: SpawnOptions =
            serde_json::from_value(spawn_options_json(MAX_JSON_SAFE_INTEGER.into())).unwrap();
        assert_eq!(maximum.scrollback_bytes, Some(MAX_JSON_SAFE_INTEGER));
    }

    #[test]
    fn scrollback_override_rejects_negative_fractional_and_unsafe_numbers() {
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::Value::Null,
            serde_json::json!(MAX_JSON_SAFE_INTEGER + 1),
        ] {
            assert!(serde_json::from_value::<SpawnOptions>(spawn_options_json(value)).is_err());
        }
    }

    #[test]
    fn spawn_error_codes_are_typed_not_string_parsed() {
        let missing = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            spawn_error_code(Some(&missing)),
            Some("executable-not-found")
        );
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(spawn_error_code(Some(&denied)), Some("permission-denied"));

        #[cfg(unix)]
        for raw in [libc::EMFILE, libc::ENFILE] {
            let exhausted = std::io::Error::from_raw_os_error(raw);
            assert_eq!(
                spawn_error_code(Some(&exhausted)),
                Some("file-descriptor-exhausted"),
            );
            assert_eq!(exhausted.raw_os_error(), Some(raw));
        }
    }

    /// A session whose exit evidence the test controls directly — the pty is
    /// irrelevant to the precedence rules and would only make them slow.
    struct FakeSession {
        exited: bool,
        exit_code: Option<i32>,
    }

    impl FakeSession {
        fn running() -> Arc<Self> {
            Arc::new(Self {
                exited: false,
                exit_code: None,
            })
        }

        fn exited(code: Option<i32>) -> Arc<Self> {
            Arc::new(Self {
                exited: true,
                exit_code: code,
            })
        }
    }

    impl SessionEndEvidence for FakeSession {
        fn has_exited(&self) -> bool {
            self.exited
        }

        fn observed_exit_code(&self) -> Option<i32> {
            self.exit_code
        }
    }

    struct TestClock(Mutex<u64>);

    impl TestClock {
        fn new() -> Arc<Self> {
            Arc::new(Self(Mutex::new(1_000)))
        }

        fn advance(&self, millis: u64) {
            *self.0.lock().unwrap() += millis;
        }
    }

    impl TombstoneClock for TestClock {
        fn now_ms(&self) -> u64 {
            *self.0.lock().unwrap()
        }
    }

    fn registry_of(
        entries: Vec<(&str, Arc<FakeSession>)>,
    ) -> RwLock<HashMap<String, Arc<FakeSession>>> {
        RwLock::new(
            entries
                .into_iter()
                .map(|(id, session)| (id.to_owned(), session))
                .collect(),
        )
    }

    #[test]
    fn an_observed_exit_outranks_the_path_that_removed_the_session() {
        let tombstones = SessionTombstones::new();
        // The close command wins the race, but the process is already gone:
        // the truthful cause is the exit, not the close.
        let registry = registry_of(vec![("session", FakeSession::exited(Some(3)))]);
        assert!(tombstones.remove_with_cause(&registry, "session").is_some());
        assert_eq!(
            tombstones
                .lookup("session")
                .map(|tombstone| tombstone.cause),
            Some(SessionEndCause::Exited { code: Some(3) })
        );
    }

    #[test]
    fn a_session_removed_while_running_is_recorded_as_closed() {
        let tombstones = SessionTombstones::new();
        let registry = registry_of(vec![("session", FakeSession::running())]);
        assert!(tombstones.remove_with_cause(&registry, "session").is_some());
        assert_eq!(
            tombstones
                .lookup("session")
                .map(|tombstone| tombstone.cause),
            Some(SessionEndCause::Closed)
        );
    }

    #[test]
    fn the_first_writer_commits_and_later_removals_do_not_overwrite() {
        let tombstones = SessionTombstones::new();
        let registry = registry_of(vec![("session", FakeSession::running())]);
        tombstones.remove_with_cause(&registry, "session");

        // A racing path arriving late finds nothing to remove...
        assert!(tombstones.remove_with_cause(&registry, "session").is_none());
        // ...and even if the id is somehow present again with different
        // evidence, the first verdict stands.
        registry
            .write()
            .unwrap()
            .insert("session".to_owned(), FakeSession::exited(Some(9)));
        assert!(tombstones.remove_with_cause(&registry, "session").is_some());
        assert_eq!(
            tombstones
                .lookup("session")
                .map(|tombstone| tombstone.cause),
            Some(SessionEndCause::Closed)
        );
    }

    #[test]
    fn tombstones_are_bounded_and_evict_least_recently_used_first() {
        let tombstones = SessionTombstones::new();
        let registry = registry_of(vec![]);
        for index in 0..TOMBSTONE_CAPACITY {
            let session_id = format!("session-{index}");
            registry
                .write()
                .unwrap()
                .insert(session_id.clone(), FakeSession::running());
            tombstones.remove_with_cause(&registry, &session_id);
        }
        assert_eq!(tombstones.len(), TOMBSTONE_CAPACITY);

        // Reading the oldest entry makes it recent, so the next one along is
        // what the cap sheds.
        assert!(tombstones.lookup("session-0").is_some());
        registry
            .write()
            .unwrap()
            .insert("overflow".to_owned(), FakeSession::running());
        tombstones.remove_with_cause(&registry, "overflow");

        assert_eq!(tombstones.len(), TOMBSTONE_CAPACITY);
        assert!(tombstones.lookup("session-0").is_some());
        assert!(tombstones.lookup("session-1").is_none());
        assert!(tombstones.lookup("overflow").is_some());
    }

    #[test]
    fn tombstones_expire_after_their_ttl() {
        let clock = TestClock::new();
        let tombstones = SessionTombstones::with_clock(clock.clone());
        let registry = registry_of(vec![("session", FakeSession::exited(Some(0)))]);
        tombstones.remove_with_cause(&registry, "session");

        clock.advance(TOMBSTONE_TTL_MS - 1);
        assert!(tombstones.lookup("session").is_some());

        clock.advance(1);
        assert!(tombstones.lookup("session").is_none());
        assert_eq!(tombstones.len(), 0);
        // An outage longer than the TTL leaves no evidence, and the honest
        // answer is `Unknown` rather than a guess.
        assert_eq!(
            tombstones.session_status(&registry, "session"),
            SessionStatus::Unknown
        );
    }

    #[test]
    fn session_status_prefers_the_registry_over_any_tombstone() {
        let tombstones = SessionTombstones::new();
        let registry = registry_of(vec![("session", FakeSession::exited(Some(0)))]);
        // Still listed and attachable, so still `Live` — a viewer resuming
        // onto it must not be told the session ended.
        assert_eq!(
            tombstones.session_status(&registry, "session"),
            SessionStatus::Live
        );
        assert_eq!(
            tombstones.session_status(&registry, "never-existed"),
            SessionStatus::Unknown
        );

        tombstones.remove_with_cause(&registry, "session");
        assert_eq!(
            tombstones.session_status(&registry, "session"),
            SessionStatus::Ended {
                cause: SessionEndCause::Exited { code: Some(0) },
            }
        );
    }

    /// §4.2.3: the clear announcement is the entire reason `ControlState`
    /// exists, and a detach is how a controller most often goes away.
    #[cfg(unix)]
    #[test]
    fn detaching_the_controller_announces_the_clear_on_both_detach_paths() {
        let frames = FrameHub::new(8);
        let session = Session::spawn(
            SpawnOptions {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 30".into()],
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::KeepUntilExit,
                program_kind: SessionProgramKind::Application,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {}),
        )
        .unwrap();

        let controlling = session.attach_view("a", "client").unwrap();
        session.claim_control("a", "client", 100, 30).unwrap();
        let mut states = session.subscribe_control_state();
        let claimed = session.control_snapshot().control_revision;

        // The epoch-conditional path the host uses.
        assert!(session.detach_view_if_epoch("a", "client", controlling));
        let cleared = states
            .try_recv()
            .expect("an epoch-conditional detach that clears control must announce it");
        assert!(cleared.controller.is_none());
        assert!(
            cleared.control_revision > claimed,
            "a clear is a controller change and must move the revision"
        );

        // The legacy path any other caller may still use.
        session.attach_view("b", "client").unwrap();
        session.claim_control("b", "client", 100, 30).unwrap();
        let claimed = states
            .try_recv()
            .expect("a claim announces")
            .control_revision;
        assert!(session.detach_view("b", "client"));
        let cleared = states
            .try_recv()
            .expect("the legacy detach path must announce the clear too");
        assert!(cleared.controller.is_none());
        assert!(cleared.control_revision > claimed);

        // A detach that clears nothing stays quiet — the guard's actual job,
        // and the reason it cannot be replaced by announcing unconditionally.
        session.attach_view("c", "client").unwrap();
        assert!(session.detach_view("c", "client"));
        assert!(
            matches!(
                states.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "detaching a non-controlling view is not a controller change"
        );

        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn tracked_selection_updates_are_isolated_per_view() {
        let frames = FrameHub::new(8);
        let session = Session::spawn(
            SpawnOptions {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 30".into()],
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 12,
                rows: 3,
                persistence: Persistence::KeepUntilExit,
                program_kind: SessionProgramKind::Application,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {}),
        )
        .unwrap();
        session.attach_view("view-a", "client").unwrap();
        session.attach_view("view-b", "client").unwrap();
        let mut view_a = session.subscribe_selection("view-a");
        let mut view_b = session.subscribe_selection("view-b");

        {
            let _operation = session.model_operation.lock().unwrap();
            let update = session
                .model
                .lock()
                .unwrap()
                .feed(b"\x1b[?1049hfirst\r\nsecond\r\nthird", RenderRequest::None)
                .unwrap();
            session.execute_update(update);
        }
        assert_eq!(
            session.selection_text("view-a", 0, 1, 5, 1, false).unwrap(),
            "second"
        );
        assert!(view_a.has_changed().unwrap());
        assert_eq!(view_a.borrow_and_update().unwrap().anchor.row, 1);
        assert!(!view_b.has_changed().unwrap());

        assert_eq!(
            session.selection_text("view-b", 0, 2, 4, 2, false).unwrap(),
            "third"
        );
        assert!(!view_a.has_changed().unwrap());
        assert!(view_b.has_changed().unwrap());
        assert_eq!(view_b.borrow_and_update().unwrap().anchor.row, 2);

        {
            let _operation = session.model_operation.lock().unwrap();
            let update = session
                .model
                .lock()
                .unwrap()
                .feed(b"\x1b[1S", RenderRequest::None)
                .unwrap();
            session.execute_update(update);
        }
        assert!(view_a.has_changed().unwrap());
        assert!(view_b.has_changed().unwrap());
        assert_eq!(view_a.borrow_and_update().unwrap().anchor.row, 0);
        assert_eq!(view_b.borrow_and_update().unwrap().anchor.row, 1);

        assert!(session.detach_view("view-a", "client"));
        assert_eq!(session.selection_snapshot("view-a"), None);
        assert_eq!(session.selection_snapshot("view-b").unwrap().anchor.row, 1);
        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
    }

    /// The repair path exists to fix a consumer that missed a change — a
    /// rejected resize, a lagged state stream. Publishing it only to the
    /// legacy channel cannot repair the revisioned one that actually lagged.
    #[cfg(unix)]
    #[test]
    fn control_repair_announcements_reach_revisioned_subscribers() {
        let frames = FrameHub::new(8);
        let session = Session::spawn(
            SpawnOptions {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 30".into()],
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::KeepUntilExit,
                program_kind: SessionProgramKind::Application,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {}),
        )
        .unwrap();

        session.attach_view("a", "client").unwrap();
        session.claim_control("a", "client", 100, 30).unwrap();
        let mut states = session.subscribe_control_state();
        let mut legacy = session.subscribe_control();

        session.announce_control();
        let repaired = states
            .try_recv()
            .expect("a control repair must reach the revisioned channel");
        assert_eq!(
            repaired.controller.map(|controller| controller.view_id),
            Some("a".to_owned())
        );
        assert!(repaired.control_revision >= 1);
        assert!(
            legacy.try_recv().is_ok(),
            "legacy subscribers must keep being served"
        );

        // The repair a legacy-only announcement can never deliver: after the
        // controller goes away there is nothing for `ControlChanged` to carry,
        // so the revisioned channel is the only one that can state it.
        assert!(session.detach_view("a", "client"));
        let _ = states.try_recv();
        let _ = legacy.try_recv();

        session.announce_control();
        let repaired = states
            .try_recv()
            .expect("a no-controller repair must still announce");
        assert!(repaired.controller.is_none());
        assert!(
            matches!(
                legacy.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ),
            "the legacy frame structurally cannot say 'no controller'"
        );

        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
    }

    #[cfg(unix)]
    fn wait_for_activity(
        session: &Session,
        expected: SessionActivityKind,
        timeout: Duration,
    ) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            let _ = session.sample_activity();
            if session.summary().activity.kind == expected {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn clean_environment_contains_only_explicit_variables_and_terminal_contract() {
        let mut command = CommandBuilder::new("test");
        configure_environment(
            &mut command,
            HashMap::new(),
            Some(SessionEnvironment::Clean {
                variables: HashMap::from([
                    ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                    ("AGENT_TOKEN".to_owned(), "allowed".to_owned()),
                ]),
            }),
            &[],
        );
        assert_eq!(
            command.get_env("PATH"),
            Some(std::ffi::OsStr::new("/usr/bin:/bin"))
        );
        assert_eq!(
            command.get_env("AGENT_TOKEN"),
            Some(std::ffi::OsStr::new("allowed"))
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(command.get_env("GHOSTTEA_AUTH_TOKEN"), None);
    }

    #[test]
    fn identifies_service_environment_that_must_not_be_inherited() {
        assert!(is_private_service_environment("GHOSTTEA_AUTH_TOKEN", &[]));
        assert!(is_private_service_environment(
            "GHOSTTEA_TRUFFLE_CAPABILITY",
            &[],
        ));
        assert!(is_private_service_environment("TRUFFLE_TEST_AUTHKEY", &[]));
        assert!(is_private_service_environment(
            "FIELD_CONTROL_TOKEN",
            &["FIELD_".to_owned()],
        ));
        assert!(!is_private_service_environment(
            "HOME",
            &["FIELD_".to_owned()],
        ));
        assert!(!is_private_service_environment(
            "CLAUDE_CODE_OAUTH_TOKEN",
            &["FIELD_".to_owned()],
        ));

        let case_variants = [
            ("Ghosttea_Auth_Token", Vec::new()),
            ("Ghosttea_Truffle_Capability", Vec::new()),
            ("Terminald_Auth_Token", Vec::new()),
            ("Terminald_Truffle_Capability", Vec::new()),
            ("Field_Control_Token", vec!["FIELD_".to_owned()]),
        ];
        for (key, extra_prefixes) in case_variants {
            assert_eq!(
                is_private_service_environment(key, &extra_prefixes),
                cfg!(windows),
                "case-variant environment key {key} must follow the host platform's rules"
            );
        }
    }

    #[test]
    fn strips_host_private_prefixes_from_an_inherited_command() {
        let mut command = CommandBuilder::new("test");
        command.env("FIELD_CONTROL_TOKEN", "private");
        command.env("Field_Native_Terminal_Mirror_Write", "private-variant");
        command.env("CLAUDE_CODE_OAUTH_TOKEN", "agent-owned");
        remove_private_service_environment(
            &mut command,
            [
                "FIELD_CONTROL_TOKEN".to_owned(),
                "Field_Native_Terminal_Mirror_Write".to_owned(),
                "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            ],
            &["FIELD_".to_owned()],
        );
        assert_eq!(command.get_env("FIELD_CONTROL_TOKEN"), None);
        assert_eq!(
            command.get_env("Field_Native_Terminal_Mirror_Write"),
            if cfg!(windows) {
                None
            } else {
                Some(std::ffi::OsStr::new("private-variant"))
            }
        );
        assert_eq!(
            command.get_env("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(std::ffi::OsStr::new("agent-owned"))
        );
    }

    #[test]
    fn classifies_requested_and_observed_exit_outcomes() {
        assert_eq!(classify_exit(Some(0), None, None), ExitOutcome::Completed);
        assert_eq!(classify_exit(Some(2), None, None), ExitOutcome::Crashed);
        assert_eq!(
            classify_exit(None, Some("Terminated"), None),
            ExitOutcome::Signaled
        );
        assert_eq!(
            classify_exit(None, Some("Killed"), Some(TerminationSource::Application)),
            ExitOutcome::ApplicationTerminated
        );
    }

    #[test]
    fn resolves_explicit_and_auto_program_kinds_without_mistaking_shell_scripts_for_prompts() {
        assert_eq!(
            resolve_program_kind(SessionProgramKind::InteractiveShell, "/bin/custom", &[]),
            ResolvedProgramKind::InteractiveShell
        );
        assert_eq!(
            resolve_program_kind(SessionProgramKind::Auto, "/bin/zsh", &[]),
            ResolvedProgramKind::InteractiveShell
        );
        assert_eq!(
            resolve_program_kind(
                SessionProgramKind::Auto,
                "/bin/sh",
                &["-c".into(), "sleep 1".into()]
            ),
            ResolvedProgramKind::Application
        );
        assert_eq!(
            resolve_program_kind(SessionProgramKind::Auto, "/usr/bin/vim", &[]),
            ResolvedProgramKind::Unknown
        );
    }

    #[cfg(unix)]
    #[test]
    fn classifies_process_groups_only_when_program_identity_supports_the_inference() {
        assert_eq!(
            classify_process_group_activity(
                ResolvedProgramKind::InteractiveShell,
                Some(10),
                Some(10)
            ),
            SessionActivityKind::ShellIdle
        );
        assert_eq!(
            classify_process_group_activity(
                ResolvedProgramKind::InteractiveShell,
                Some(10),
                Some(20)
            ),
            SessionActivityKind::ForegroundJob
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Application, Some(10), Some(10)),
            SessionActivityKind::ForegroundJob
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Unknown, Some(10), Some(10)),
            SessionActivityKind::Unknown
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Unknown, Some(10), Some(20)),
            SessionActivityKind::ForegroundJob
        );
    }

    /// An interactive bash ignores SIGTERM, and a `sleep 30 &` it starts sits
    /// in its own process group — outside both the root and foreground groups.
    /// Termination must both conclude the session and kill that descendant.
    #[cfg(unix)]
    #[test]
    fn terminate_sweeps_background_descendants_outside_the_terminal_groups() {
        if !Path::new("/bin/bash").exists() {
            eprintln!("skipping: /bin/bash unavailable");
            return;
        }
        let frames = FrameHub::new(8);
        let (exited_tx, exited_rx) = mpsc::channel();
        let session = Session::spawn(
            SpawnOptions {
                executable: "/bin/bash".into(),
                args: vec!["--norc".into(), "--noprofile".into(), "-i".into()],
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::TerminateWithApp,
                program_kind: SessionProgramKind::InteractiveShell,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {
                let _ = exited_tx.send(());
            }),
        )
        .unwrap();
        let view_id = "background-holder-view";
        let client_id = "background-holder-client";
        let attachment_epoch = session.attach_view(view_id, client_id).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pid_path = directory.path().join("background.pid");
        session
            .send_text(
                view_id,
                client_id,
                attachment_epoch,
                1,
                format!("sleep 30 & echo $! > '{}'\n", pid_path.display()),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let background_pid = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_path)
                && let Ok(pid) = contents.trim().parse::<i32>()
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "shell did not report its background pid"
            );
            thread::sleep(Duration::from_millis(25));
        };
        session.terminate(TerminationSource::User).unwrap();
        exited_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("session did not conclude while a background child held the pty");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let alive = unsafe { libc::kill(background_pid, 0) } == 0;
            if !alive {
                break;
            }
            if Instant::now() >= deadline {
                let _ = unsafe { libc::kill(background_pid, libc::SIGKILL) };
                panic!("background descendant {background_pid} survived terminal termination");
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    /// The class a session was created with is visible from the outside and
    /// can be rewritten while it runs — the two halves re-policy needs.
    #[cfg(unix)]
    #[test]
    fn persistence_is_reported_and_can_be_reclassified_while_running() {
        let frames = FrameHub::new(8);
        let session = Session::spawn(
            SpawnOptions {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), "sleep 30".into()],
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::KeepUntilExit,
                program_kind: SessionProgramKind::Application,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {}),
        )
        .unwrap();

        assert_eq!(session.persistence(), Some(Persistence::KeepUntilExit));
        assert_eq!(
            session.summary().persistence,
            Some(Persistence::KeepUntilExit),
            "the summary is the surface an observer reads the class from"
        );

        session.set_persistence(Persistence::KeepUntilExplicitClose);

        assert_eq!(
            session.persistence(),
            Some(Persistence::KeepUntilExplicitClose)
        );
        assert_eq!(
            session.summary().persistence,
            Some(Persistence::KeepUntilExplicitClose),
            "a reclassification must be visible to observers, not only internally"
        );

        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn naturally_exited_sessions_release_under_churn() {
        let frames = FrameHub::new(8);
        let text_engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let mut sessions = Vec::with_capacity(128);
        for index in 0..128 {
            let (exited_tx, exited_rx) = mpsc::channel();
            let session = Session::spawn(
                SpawnOptions {
                    executable: "/bin/sh".into(),
                    args: vec!["-c".into(), "exit 0".into()],
                    cwd: None,
                    env: HashMap::new(),
                    environment: Some(SessionEnvironment::Clean {
                        variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                    }),
                    cols: 80,
                    rows: 24,
                    persistence: Persistence::KeepUntilExit,
                    program_kind: SessionProgramKind::Application,
                    owner_id: None,
                    scrollback_bytes: None,
                },
                frames.clone(),
                Arc::clone(&text_engine),
                Arc::new(move |_, _| {
                    let _ = exited_tx.send(());
                }),
            )
            .unwrap_or_else(|error| {
                // A host that has run out of pseudo-terminals fails here with a
                // bare `openpty` errno, which reads as a defect in this crate.
                // It is not one: the pool is machine-wide and shared with every
                // terminal, editor and test running, and the sessions above
                // release theirs on drop. Say which of the two it is, because
                // the message alone sends a reader looking in the wrong place.
                panic!(
                    "spawning churn session {index} of 128 failed: {error:#}\n\
                     an `openpty` failure here means the host's pty pool is \
                     exhausted rather than this crate retaining terminals; \
                     `sysctl kern.tty.ptmx_max` is the ceiling it hit"
                )
            });
            sessions.push(Arc::downgrade(&session));
            exited_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("short-lived session did not report exit");
            drop(session);
        }

        let started = Instant::now();
        while sessions.iter().any(|session| session.strong_count() > 0)
            && started.elapsed() < Duration::from_secs(5)
        {
            thread::yield_now();
        }
        assert!(
            sessions.iter().all(|session| session.strong_count() == 0),
            "one or more exited sessions are still retained by a per-session actor"
        );
    }

    #[cfg(unix)]
    #[test]
    fn observes_real_shell_foreground_jobs_interrupts_pipelines_and_background_jobs() {
        let shell = if Path::new("/bin/zsh").exists() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let frames = FrameHub::new(8);
        let (exited_tx, exited_rx) = mpsc::channel();
        let session = Session::spawn(
            SpawnOptions {
                executable: shell.into(),
                args: Vec::new(),
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::TerminateWithApp,
                program_kind: SessionProgramKind::InteractiveShell,
                owner_id: None,
                scrollback_bytes: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _| {
                let _ = exited_tx.send(());
            }),
        )
        .unwrap();
        let view_id = "activity-test-view";
        let client_id = "activity-test-client";
        let attachment_epoch = session.attach_view(view_id, client_id).unwrap();

        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));
        let mut changes = session.subscribe_activity();
        assert!(session.sample_activity().is_none());
        assert!(matches!(
            changes.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        session
            .send_text(
                view_id,
                client_id,
                attachment_epoch,
                1,
                "sleep 5 | cat\n".into(),
            )
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        session
            .interrupt(view_id, client_id, attachment_epoch, 2)
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .send_text(view_id, client_id, attachment_epoch, 3, "sleep 1\n".into())
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(3)
        ));

        session
            .send_text(view_id, client_id, attachment_epoch, 4, "cat\n".into())
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        session
            .interrupt(view_id, client_id, attachment_epoch, 5)
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .send_text(
                view_id,
                client_id,
                attachment_epoch,
                6,
                "sleep 1 &\n".into(),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(250));
        let _ = session.sample_activity();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
        exited_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("shell did not exit during test cleanup");
        assert!(session.sample_activity().is_none());
    }
}
