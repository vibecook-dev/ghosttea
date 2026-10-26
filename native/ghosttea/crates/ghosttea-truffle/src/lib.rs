use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::env;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use truffle_core as truffle;
use truffle_core::{
    Node, NodeError, Peer, StoreEvent,
    network::{NetworkError, TailscalePeerIdentity, tailscale::TailscaleProvider},
    session::PeerEvent,
    transport::quic::QuicStream,
};
use uuid::Uuid;

use ghosttea::{
    AttachRejectionCode, ControlClaim, ControlSnapshot, HostShutdownAnnouncer, MeshReconnectConfig,
    RemoteActivityChanged, RemoteAttachment, RemoteControlChanged, RemoteControlClaim,
    RemoteControlOutcome, RemoteControlState, RemoteController, RemoteEndedReason,
    RemoteHostSummary, RemoteLifecycleChanged, RemoteLifecycleState, RemoteMetadataChanged,
    RemoteReplica, RemoteResize, RemoteSelection, RemoteSessionLifecycle, RemoteSessionOpen,
    RemoteTerminalRuntime, RemoteViewRecord, RemoteViewState, RemoteViewStateChanged,
    ResumeEvidence, Session, SessionRegistry as Registry, SessionStatusSource, SessionSummary,
    StateStreamCancel, TakeOver, TerminalMesh, TerminalPresentationConfig, ViewAccess,
    tunnel_protocol::{
        AttachRejectCode, CompactChannel, ConnectionMessage, ControllerInfo, HeartbeatMessage,
        LogicalTerminalPatch, LogicalTerminalSnapshot, MAX_CONTROL_MESSAGE_BYTES,
        MAX_HEARTBEAT_MESSAGE_BYTES, MAX_STATE_MESSAGE_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR,
        REMOTE_RECONNECT_PROTOCOL_MINOR, ResumeHint, RowReplacement,
        SESSION_ACTIVITY_PROTOCOL_MINOR, SessionControlMessage, SessionEndReason,
        SessionStatusKind, SharedSessionSummary, StateCodec, StateMessage, StreamKind,
        StreamPreface, TERMINAL_PRESENTATION_PROTOCOL_MINOR, TRACKED_SELECTION_PROTOCOL_MINOR,
        TerminalHostAdvertisement, TunnelInput, decode_compact_message, decode_message,
        decode_preface, encode_compact_message, encode_message, encode_preface,
    },
};

pub const DEFAULT_QUIC_PORT: u16 = 9420;
pub const DEFAULT_COMPACT_PORT: u16 = 9421;
const ADVERTISEMENT_INTERVAL: Duration = Duration::from_secs(5);
const ADVERTISEMENT_TTL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

type HostStore = truffle::synced_store::SyncedStore<TerminalHostAdvertisement>;
type HostConfigReceiver = tokio::sync::watch::Receiver<Arc<TerminalPresentationConfig>>;

/// What a host connection needs from the daemon above it and cannot work out
/// for itself. Kept apart from [`TruffleTerminalConfig`], which is the knobs a
/// caller writes down literally; these are wiring the daemon hands over.
#[derive(Clone, Default)]
struct HostServices {
    /// Absent until the daemon supplies one, and absent forever in tests and
    /// in the loopback harness: a host with no source answers `Unknown`, which
    /// is exactly what "this host cannot say" means on the wire.
    session_status: Option<Arc<dyn SessionStatusSource>>,
    shutdown: HostShutdownAnnouncer,
}

#[derive(Clone)]
struct IncomingSessionContext {
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    client_id: String,
    state_codec: StateCodec,
    protocol_minor: u16,
    host_config: HostConfigReceiver,
    /// The connection this stream arrived on: its id orders attach attempts
    /// for the stage-2 fence, and holding the scope keeps the connection
    /// counted as live for exactly as long as this handler could still act.
    connection: ConnectionScope,
}

/// Samples a delay from a backoff window. Injectable so scheduling tests can
/// assert exact delays instead of sampling a distribution.
type JitterSource = Arc<dyn Fn(Duration) -> Duration + Send + Sync>;

fn uniform_jitter() -> JitterSource {
    Arc::new(|window| Duration::from_millis(rand::random_range(0..=window.as_millis() as u64)))
}

type RemoteViews = Arc<tokio::sync::Mutex<HashMap<(String, String), Arc<RemoteView>>>>;
type RemoteConnections = Arc<tokio::sync::Mutex<HashMap<String, Arc<RemoteHostConnection>>>>;

/// Local view ids that still fit a rotated wire id under the host's 128-byte
/// cap once the namespace prefix and the widest generation suffix are added.
const MAX_INLINE_LOCAL_VIEW_ID_BYTES: usize = 98;

static NEXT_CONNECTION_INCARNATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct MeshRuntime {
    ready: Arc<tokio::sync::RwLock<Option<MeshReady>>>,
    transport: Arc<tokio::sync::RwLock<Option<Arc<dyn HostTransport>>>>,
    replicas: Arc<tokio::sync::RwLock<HashMap<String, RemoteSession>>>,
    views: RemoteViews,
    connections: RemoteConnections,
    control_tx: broadcast::Sender<RemoteControlChanged>,
    activity_tx: broadcast::Sender<RemoteActivityChanged>,
    metadata_tx: broadcast::Sender<RemoteMetadataChanged>,
    lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
    view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
    control_state_tx: broadcast::Sender<RemoteControlState>,
    /// Last controller state seen per session — the reconciliation source, so
    /// a dropped clear has a repair path.
    control_states: Arc<SyncMutex<HashMap<String, RemoteControlState>>>,
    config: Arc<SyncMutex<MeshReconnectConfig>>,
    jitter: Arc<SyncMutex<JitterSource>>,
    /// Fires when a device looks reachable again, so a session waiting out its
    /// backoff can dial immediately instead of sleeping through the recovery.
    wakeup_tx: broadcast::Sender<String>,
}

impl Default for MeshRuntime {
    fn default() -> Self {
        let (control_tx, _) = broadcast::channel(64);
        let (activity_tx, _) = broadcast::channel(64);
        let (lifecycle_tx, _) = broadcast::channel(64);
        let (view_state_tx, _) = broadcast::channel(64);
        Self {
            ready: Arc::default(),
            transport: Arc::default(),
            replicas: Arc::default(),
            views: Arc::default(),
            connections: Arc::default(),
            control_tx,
            activity_tx,
            metadata_tx: broadcast::channel(64).0,
            lifecycle_tx,
            view_state_tx,
            control_state_tx: broadcast::channel(64).0,
            control_states: Arc::default(),
            config: Arc::new(SyncMutex::new(MeshReconnectConfig::default())),
            jitter: Arc::new(SyncMutex::new(uniform_jitter())),
            wakeup_tx: broadcast::channel(64).0,
        }
    }
}

#[derive(Clone)]
struct MeshReady {
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
    host_instance_id: String,
    capability: Option<String>,
}

/// How long a hello's device id may take to appear in discovery before the
/// host gives up on it. A peer that has just re-joined is briefly absent.
const PEER_RESOLVE_WAIT_MS: u64 = 3_000;

/// How long the tailnet's WhoIs answer may take. WhoIs is a local
/// control-plane query, so this only trips when the sidecar is wedged — and
/// then the connection is refused rather than admitted unauthenticated.
const WHOIS_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolves the device identity a client asserts in its hello into the
/// `client_id` that owns its view attachments.
#[async_trait]
trait ClientResolver: Send + Sync {
    async fn resolve(&self, device_id: &str, remote_ip: Option<IpAddr>) -> Result<String>;
}

struct NodeClientResolver {
    node: Arc<Node<TailscaleProvider>>,
}

#[async_trait]
impl ClientResolver for NodeClientResolver {
    /// Identity comes from the tailnet, not from the hello.
    ///
    /// [`Node::whois`] answers who owns the address a connection arrived from
    /// — a control-plane fact no peer can assert — and the `client_id` is
    /// derived from the peer that answer resolves to. The hello's
    /// `local_device_id` is demoted to corroboration: it must *agree* with what
    /// the registry publishes for that peer, and can no longer grant an
    /// identity. This closes the Phase 2 caveat (§9.1) — asserting another
    /// device's id now fails the comparison instead of inheriting its
    /// `client_id`, its attachments, and (under `allow_tailnet_write`) its
    /// input.
    ///
    /// Transports whose provider has no WhoIs at all keep the Phase 2 path
    /// below: in-process transports, and — measured, not hypothetical — a
    /// Truffle sidecar older than protocol v3, which is where `tsnet:whois`
    /// shipped. Those hosts keep working with the §9.1 caveat still open, and
    /// [`warn_whois_unsupported`] says so out loud. A WhoIs that exists and
    /// declines to answer is *not* that case: it is refused.
    async fn resolve(&self, device_id: &str, remote_ip: Option<IpAddr>) -> Result<String> {
        if device_id.trim().is_empty() {
            bail!("client hello carries no device id");
        }
        let node_id = match authenticated_node_id(self.whois(remote_ip).await) {
            Ok(Some(node_id)) => node_id,
            Ok(None) => return self.resolve_from_hello(device_id, remote_ip).await,
            Err(error) => return Err(reject_connection(remote_ip, error)),
        };
        let peer = self
            .node
            .peer(&node_id, Some(PEER_RESOLVE_WAIT_MS))
            .await
            .context("resolve the tailnet identity that opened the connection")?;
        bind_authenticated_peer(
            &node_id,
            peer.as_ref().map(PeerBinding::from).as_ref(),
            device_id,
        )
        .map_err(|error| reject_connection(remote_ip, error))
    }
}

impl NodeClientResolver {
    /// The tailnet's WhoIs answer for the address a connection arrived from.
    /// The port is irrelevant to WhoIs, so the address alone is asked about.
    async fn whois(&self, remote_ip: Option<IpAddr>) -> TailnetWhoIs {
        let Some(remote_ip) = remote_ip else {
            return TailnetWhoIs::Unavailable("connection carries no source address".into());
        };
        match tokio::time::timeout(WHOIS_TIMEOUT, self.node.whois(&remote_ip.to_string())).await {
            Ok(Ok(Some(identity))) => TailnetWhoIs::Identity(Box::new(identity)),
            Ok(Ok(None)) => TailnetWhoIs::Anonymous,
            Ok(Err(NodeError::Network(NetworkError::Unsupported(cause)))) => {
                warn_whois_unsupported(&cause);
                TailnetWhoIs::Unsupported
            }
            Ok(Err(error)) => TailnetWhoIs::Unavailable(error.to_string()),
            Err(_) => TailnetWhoIs::Unavailable(format!("no answer within {WHOIS_TIMEOUT:?}")),
        }
    }

    /// The pre-WhoIs binding, kept for transports that have no tailnet behind
    /// them: the hello's device id, validated against the live registry.
    ///
    /// The source address cannot carry identity here — an inbound connection
    /// arrives from whatever path the tailnet chose, which stops matching the
    /// address discovery recorded as soon as a node re-joins or a path rotates,
    /// and a host that matched on the address rejected every legitimate client
    /// (the Phase 2 failure). Reachable only when the provider has no WhoIs at
    /// all, so the device-id assertion carries the weight it once did
    /// everywhere.
    async fn resolve_from_hello(
        &self,
        device_id: &str,
        remote_ip: Option<IpAddr>,
    ) -> Result<String> {
        let peer = self
            .node
            .peer(device_id, Some(PEER_RESOLVE_WAIT_MS))
            .await
            .context("resolve the client's asserted device id")?
            .context("client hello asserts a device that is not a current Truffle peer")?;
        if peer.device_id.as_deref() != Some(device_id) {
            bail!("client hello device id did not resolve to itself");
        }
        if !peer.online {
            bail!("client hello asserts a device that discovery reports offline");
        }
        if let Some(remote_ip) = remote_ip
            && peer.ip != remote_ip
        {
            // Expected whenever discovery's address is stale; the identity
            // above is what the decision rests on.
            eprintln!(
                "[terminal-mesh][diag] client {device_id} connected from {remote_ip} but discovery records {} ({}); accepted on asserted identity",
                peer.ip, peer.connection_type
            );
        }
        Ok(format!("truffle:{}", peer.peer_ref))
    }
}

/// The tailnet's answer about the address a connection arrived from.
enum TailnetWhoIs {
    /// The control plane authenticated the address to this identity.
    Identity(Box<TailscalePeerIdentity>),
    /// The tailnet has no identity for the address: the caller is anonymous —
    /// absent, not fabricated.
    Anonymous,
    /// The provider has no WhoIs at all: an in-process transport, or a sidecar
    /// predating protocol v3. Distinct from a failed query — nothing was
    /// withheld, there is simply nothing to ask.
    Unsupported,
    /// The provider has WhoIs and the query failed or timed out.
    Unavailable(String),
}

/// The registry facts a connection is bound against, projected out of
/// [`Peer`] so the binding policy is exercisable without a tailnet.
struct PeerBinding {
    tailscale_id: String,
    device_id: Option<String>,
    peer_ref: String,
}

impl From<&Peer> for PeerBinding {
    fn from(peer: &Peer) -> Self {
        Self {
            tailscale_id: peer.tailscale_id.clone(),
            device_id: peer.device_id.clone(),
            peer_ref: peer.peer_ref.clone(),
        }
    }
}

/// The stable node id a WhoIs answer authenticates. `Ok(None)` means the
/// transport has no WhoIs to authenticate with — the only verdict that may
/// fall back to hello-asserted identity.
fn authenticated_node_id(whois: TailnetWhoIs) -> Result<Option<String>> {
    match whois {
        // A stable node ID is the only WhoIs field that maps to the peer
        // registry; an identity carrying none authenticates nothing, however
        // much else it says.
        TailnetWhoIs::Identity(identity) => match identity.node_id {
            Some(node_id) if !node_id.trim().is_empty() => Ok(Some(node_id)),
            _ => bail!("tailnet identity carries no stable node id"),
        },
        TailnetWhoIs::Anonymous => {
            bail!("the tailnet claims no identity for the address this connection arrived from")
        }
        TailnetWhoIs::Unsupported => Ok(None),
        TailnetWhoIs::Unavailable(cause) => bail!("tailnet identity is unavailable: {cause}"),
    }
}

/// The `client_id` an authenticated connection owns.
///
/// The identity is the peer the authenticated stable node id resolves to, so
/// the `client_id` is never derived from anything the hello asserted. The
/// asserted device id only has to agree with the durable id the registry
/// publishes for that peer. A peer whose durable id discovery has not learned
/// yet still binds: the `client_id` comes from the authenticated peer either
/// way, so an assertion has nothing left to steal.
fn bind_authenticated_peer(
    node_id: &str,
    peer: Option<&PeerBinding>,
    asserted_device_id: &str,
) -> Result<String> {
    let peer = peer.context(
        "the tailnet identity that opened this connection is not a current Truffle peer",
    )?;
    // `Node::peer` accepts several identifier forms — names and device-id
    // prefixes among them — so only an exact stable-id match may stand in for
    // the authenticated identity.
    if peer.tailscale_id != node_id {
        bail!("tailnet identity did not resolve to itself in the peer registry");
    }
    if let Some(published) = peer.device_id.as_deref()
        && published != asserted_device_id
    {
        bail!("client hello asserts a device id the tailnet identity does not own");
    }
    Ok(format!("truffle:{}", peer.peer_ref))
}

/// Say once per process that this host cannot authenticate who is connecting.
///
/// A provider without WhoIs is unremarkable in-process, but on a real tailnet
/// it means the Truffle sidecar predates `tsnet:whois` (protocol v3) and the
/// host is running with the Phase 2 identity caveat (§9.1) still open. The
/// fallback keeps those hosts working; staying silent about it would make a
/// security-relevant downgrade invisible.
fn warn_whois_unsupported(cause: &str) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "[terminal-mesh][diag] tailnet WhoIs is unavailable ({cause}); connections fall back \
             to hello-asserted identity, so a peer inside the tailnet can assert another device's \
             id. Upgrade the Truffle sidecar to protocol v3 to close this."
        );
    }
}

/// One diagnostic line per refused connection. Carries the address and the
/// reason only — never a hello payload, a token, or an owner's tailnet login.
/// Map an authority rejection onto the wire's closed code set. `ghosttea-core`
/// deliberately does not depend on the wire types, so the translation lives
/// here — and the codes the authority cannot produce (`unknown-session`,
/// `access-denied`) come from this host's own lookup and auth checks.
/// The controller frame a viewer at this minor can decode. Only a
/// reconnect-capable viewer gets `ControlState`, which is the only shape that
/// can say "no controller"; below that a clear stays unrepresentable and is
/// simply not announced, exactly as before.
fn control_state_message(snapshot: &ControlSnapshot, protocol_minor: u16) -> Option<StateMessage> {
    if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
        return Some(StateMessage::ControlState {
            controller: snapshot
                .controller
                .as_ref()
                .map(|controller| ControllerInfo {
                    controller_view_id: controller.view_id.clone(),
                    control_epoch: controller.control_epoch,
                }),
            control_revision: snapshot.control_revision,
            cols: snapshot.cols,
            rows: snapshot.rows,
            layout_epoch: snapshot.layout_epoch,
        });
    }
    snapshot
        .controller
        .as_ref()
        .map(|controller| StateMessage::ControlChanged {
            controller_view_id: controller.view_id.clone(),
            control_epoch: controller.control_epoch,
            cols: snapshot.cols,
            rows: snapshot.rows,
            layout_epoch: snapshot.layout_epoch,
        })
}

fn attach_reject_code(code: AttachRejectionCode) -> AttachRejectCode {
    match code {
        AttachRejectionCode::StaleResume => AttachRejectCode::StaleResume,
        AttachRejectionCode::ViewInvalid => AttachRejectCode::ViewInvalid,
        AttachRejectionCode::ViewLimit => AttachRejectCode::ViewLimit,
        AttachRejectionCode::SessionEpochMismatch => AttachRejectCode::SessionEpochMismatch,
    }
}

fn reject_connection(remote_ip: Option<IpAddr>, error: anyhow::Error) -> anyhow::Error {
    let source = remote_ip.map_or_else(
        || "an unaddressed connection".to_owned(),
        |ip| ip.to_string(),
    );
    eprintln!("[terminal-mesh][diag] refused connection from {source}: {error:#}");
    error
}

/// Everything the viewer needs from discovery to reach one host. Isolating it
/// from `Node` keeps the session state machine drivable without a tailnet.
#[async_trait]
trait HostTransport: Send + Sync {
    fn capability(&self) -> Option<String>;
    async fn device_name(&self, device_id: &str) -> Option<String>;
    /// Whether discovery currently sees the device. Only ever used to decline
    /// a dial, never to tear a working connection down.
    async fn peer_is_online(&self, device_id: &str) -> bool;
    /// The advertised host identity, revalidated for freshness. Doubles as the
    /// pre-dial host-restart fence.
    async fn host_instance_id(&self, device_id: &str) -> Result<String>;
    async fn dial(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>>;
}

#[derive(Clone)]
struct RemoteSession {
    device_id: String,
    remote_session_id: String,
    access_token: Option<String>,
    replica: Arc<RemoteReplica>,
    lifecycle: Arc<SessionLifecycle>,
}

/// Relay one replica's working-directory and title changes to the runtime,
/// under the local session id clients know it by.
///
/// The task holds the replica weakly, so it ends with the replica: the
/// replica's sender is the only one, and dropping it closes the channel.
fn relay_replica_metadata(
    replica: &Arc<RemoteReplica>,
    session_id: String,
    metadata_tx: broadcast::Sender<RemoteMetadataChanged>,
) {
    let mut changes = replica.subscribe_metadata();
    let replica = Arc::downgrade(replica);
    tokio::spawn(async move {
        loop {
            let metadata = match changes.recv().await {
                Ok(metadata) => metadata,
                // The event is absolute, so a lagged relay owes the current
                // state rather than the changes it missed.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let Some(replica) = replica.upgrade() else {
                        break;
                    };
                    replica.metadata()
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let _ = metadata_tx.send(RemoteMetadataChanged {
                session_id: session_id.clone(),
                cwd: metadata.cwd,
                title: metadata.title,
            });
        }
    });
}

struct RemoteView {
    session_control: tokio::sync::Mutex<ProtocolStream>,
    state_cancel: tokio::sync::watch::Sender<bool>,
    attachment_epoch: u64,
    read_write: bool,
    /// The host only ever sees `wire_view_id`; every mesh API speaks the local
    /// id. Rotation depends on the two never being conflated.
    wire_view_id: String,
    state_generation: u64,
    incarnation: u64,
    /// Whether this view's stream feeds the shared replica. Secondary streams
    /// are drained and discarded: two feeds would interleave per-stream patch
    /// sequences into one replica.
    feed: bool,
}

struct RemoteHostConnection {
    connection: Arc<dyn MeshConnection>,
    control: tokio::sync::Mutex<ProtocolStream>,
    incoming: tokio::sync::Mutex<()>,
    host_instance_id: String,
    state_codec: StateCodec,
    healthy: AtomicBool,
    incarnation: u64,
    /// The minor this connection negotiated. Every reconnect behavior reads
    /// its gate from here rather than from the advertisement: the
    /// advertisement says what the host offers, only the handshake says what
    /// this connection settled on.
    protocol_minor: u16,
}

impl RemoteHostConnection {
    /// Whether this connection can carry ordered takeover, heartbeats, and
    /// the controller-state frames. Below it the viewer keeps the rotation
    /// path, which is the whole 1.4 compatibility story.
    fn supports_reconnect(&self) -> bool {
        self.protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR
    }
}

fn connection_is_reusable(
    cached_host_instance_id: &str,
    healthy: bool,
    advertised_host_instance_id: &str,
) -> bool {
    healthy && cached_host_instance_id == advertised_host_instance_id
}

/// The wire identity for one attach attempt. The host caps view ids at 128
/// bytes, so long local ids are hashed rather than truncated. The `r:`/`h:`
/// prefixes keep the two namespaces disjoint: without them a short local id
/// equal to another id's hash would produce the same base.
fn wire_view_id(local_view_id: &str, generation: u64) -> String {
    format!("{}#g{generation}", stable_wire_view_id(local_view_id))
}

/// The rotation-free identity, for hosts that order attempts by
/// `attach_generation` instead. The namespace prefixes and the length bound
/// still apply — only the per-attempt suffix goes away, because on those hosts
/// reusing the id is the point: takeover mints a fresh epoch for it.
fn stable_wire_view_id(local_view_id: &str) -> String {
    if local_view_id.len() <= MAX_INLINE_LOCAL_VIEW_ID_BYTES {
        format!("r:{local_view_id}")
    } else {
        let digest = Sha256::digest(local_view_id.as_bytes());
        let mut hashed = String::with_capacity(32);
        for byte in &digest[..16] {
            hashed.push_str(&format!("{byte:02x}"));
        }
        format!("h:{hashed}")
    }
}

/// Best-effort inverse of [`wire_view_id`], used only for controller ids the
/// session does not own: a peer's rotated id carries no local meaning, and
/// leaving the rotation visible would make it compare unequal to itself.
fn local_view_id_from_wire(wire_view_id: &str) -> Option<String> {
    // Both encodings appear on the wire depending on the peer's minor, so the
    // rotation suffix is stripped only when it looks like one. A local id that
    // itself ends in `#g<digits>` would be mis-split here — acceptable because
    // this is the best-effort path for ids this session does not own; ids it
    // does own resolve exactly through the view map before reaching it.
    let base = match wire_view_id.rsplit_once("#g") {
        Some((base, generation))
            if !generation.is_empty() && generation.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            base
        }
        _ => wire_view_id,
    };
    base.strip_prefix("r:").map(str::to_owned)
}

#[derive(Clone)]
struct ViewRecord {
    view_state_seq: u64,
    state: RemoteViewState,
    attachment_epoch: Option<u64>,
    read_write: Option<bool>,
    error: Option<String>,
    retryable: Option<bool>,
    /// Monotonic per wire-view lineage. Advanced by every `AttachView` this
    /// viewer actually writes, initial retries included, so the host never
    /// sees a reused identity and can never mint the same epoch twice.
    generation: u64,
    wire_view_id: Option<String>,
    /// The contiguous purge range is `[oldest_unpurged, written]`: generations
    /// are consecutive integers, so two of them describe every identity this
    /// lineage stranded, however long the outage ran.
    oldest_unpurged: u64,
    /// The newest generation whose `AttachView` actually reached the wire. An
    /// attempt that never got written stranded nothing to purge.
    written: u64,
    /// The last epoch this lineage held. Unlike `attachment_epoch` it survives
    /// the view going pending, because that is exactly when a resume needs to
    /// cite what it is resuming from.
    last_attachment_epoch: Option<u64>,
}

impl ViewRecord {
    fn pending() -> Self {
        Self {
            view_state_seq: 0,
            state: RemoteViewState::Pending,
            attachment_epoch: None,
            read_write: None,
            error: None,
            retryable: None,
            generation: 0,
            wire_view_id: None,
            oldest_unpurged: 1,
            written: 0,
            last_attachment_epoch: None,
        }
    }

    fn record(&self, local_view_id: &str) -> RemoteViewRecord {
        RemoteViewRecord {
            local_view_id: local_view_id.to_owned(),
            view_state_seq: self.view_state_seq,
            view_state: self.state,
            attachment_epoch: self.attachment_epoch,
            read_write: self.read_write,
            error: self.error.clone(),
            retryable: self.retryable,
        }
    }
}

struct LifecycleState {
    state: RemoteLifecycleState,
    reason: Option<RemoteEndedReason>,
    lifecycle_seq: u64,
    attempt: u32,
    /// Current state generation. Every state-channel dispatch is dropped
    /// unless the publishing reader carries this value.
    generation: u64,
    /// The connection incarnation the current attachments belong to.
    incarnation: u64,
    last_contact: Option<Instant>,
    host_instance_id: Option<String>,
    session_epoch: Option<u64>,
    views: HashMap<String, ViewRecord>,
    /// The one view whose state stream feeds the shared replica. Every view
    /// publishing into it would interleave independent patch sequences.
    feed_view_id: Option<String>,
    /// How long until the engine's next dial, while one is scheduled.
    next_retry: Option<Duration>,
    /// The connection incarnation already torn down. Every reader on a
    /// multi-view connection reports the same death; only the first may act.
    disconnected: Option<(u64, u64)>,
}

/// The serialized owner of one open remote session's lifecycle. Every
/// transition, including those driven by a dying reader, commits through here
/// so a superseded connection can never speak for the current one.
struct SessionLifecycle {
    session_id: String,
    device_id: String,
    device_name: String,
    state: SyncMutex<LifecycleState>,
    /// Serializes attach and resume work; one attempt per session at a time.
    attempts: tokio::sync::Mutex<()>,
    /// The auto-resume engine, if one is armed for this session.
    engine: SyncMutex<Option<tokio::task::JoinHandle<()>>>,
    lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
    view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
}

impl SessionLifecycle {
    fn new(
        session_id: String,
        device_id: String,
        device_name: String,
        host_instance_id: Option<String>,
        lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
        view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
    ) -> Arc<Self> {
        let owner = Arc::new(Self {
            session_id,
            device_id,
            device_name,
            state: SyncMutex::new(LifecycleState {
                state: RemoteLifecycleState::Opening,
                reason: None,
                lifecycle_seq: 1,
                attempt: 0,
                generation: 1,
                incarnation: 0,
                last_contact: None,
                host_instance_id,
                session_epoch: None,
                views: HashMap::new(),
                feed_view_id: None,
                next_retry: None,
                disconnected: None,
            }),
            attempts: tokio::sync::Mutex::new(()),
            engine: SyncMutex::new(None),
            lifecycle_tx,
            view_state_tx,
        });
        owner.publish(&owner.state.lock().unwrap());
        owner
    }

    fn publish(&self, state: &LifecycleState) {
        let _ = self.lifecycle_tx.send(RemoteLifecycleChanged {
            session_id: self.session_id.clone(),
            lifecycle_seq: state.lifecycle_seq,
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            state: state.state,
            reason: state.reason,
            // Phase 1 has no wire message carrying exit metadata.
            exit: None,
            attempt: state.attempt,
            next_retry_ms: state.next_retry.map(|delay| delay.as_millis() as u64),
            last_contact_ms: state
                .last_contact
                .map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
        });
    }

    fn advance(
        &self,
        state: &mut LifecycleState,
        next: RemoteLifecycleState,
        reason: Option<RemoteEndedReason>,
    ) {
        state.state = next;
        state.reason = reason;
        state.lifecycle_seq = state.lifecycle_seq.saturating_add(1);
        self.publish(state);
    }

    fn publish_view(&self, local_view_id: &str, record: &ViewRecord) {
        let _ = self.view_state_tx.send(RemoteViewStateChanged {
            session_id: self.session_id.clone(),
            local_view_id: local_view_id.to_owned(),
            view_state_seq: record.view_state_seq,
            view_state: record.state,
            attachment_epoch: record.attachment_epoch,
            read_write: record.read_write,
            error: record.error.clone(),
            retryable: record.retryable,
        });
    }

    fn set_view(
        &self,
        state: &mut LifecycleState,
        local_view_id: &str,
        mutate: impl FnOnce(&mut ViewRecord),
    ) {
        let record = state
            .views
            .entry(local_view_id.to_owned())
            .or_insert_with(ViewRecord::pending);
        mutate(record);
        record.view_state_seq = record.view_state_seq.saturating_add(1);
        let published = record.clone();
        self.publish_view(local_view_id, &published);
    }

    /// Gate one state-channel dispatch and refresh contact in the same
    /// critical section. Checking currency and then refreshing separately
    /// would let a superseded connection vouch for the current one.
    fn admit_state(&self, generation: u64, incarnation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        // Both identifiers, atomically. The generation alone is not enough:
        // attaching a second view rebinds the incarnation without advancing
        // the generation, so a reader left over from a connection that has
        // been replaced still matches on generation — and would then publish
        // state and, worse, refresh the contact clock on behalf of the
        // connection that replaced it, masking a black hole indefinitely.
        if state.generation != generation || state.incarnation != incarnation {
            return false;
        }
        state.last_contact = Some(Instant::now());
        true
    }

    /// Refresh contact for a heartbeat that belongs to the current connection.
    /// The currency check and the refresh share one critical section for the
    /// same reason `admit_state` does: a superseded connection must never end
    /// up vouching for the one that replaced it.
    fn note_contact(&self, incarnation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.incarnation != incarnation {
            return false;
        }
        state.last_contact = Some(Instant::now());
        true
    }

    /// How long this session has gone without contact on `incarnation`, or
    /// `None` if it is not evidence about that connection at all: a session
    /// bound elsewhere, not yet live, or holding nothing attached has no
    /// reason to hear from the host and its silence means nothing.
    fn contact_age(&self, incarnation: u64) -> Option<Duration> {
        let state = self.state.lock().unwrap();
        if state.incarnation != incarnation || state.state != RemoteLifecycleState::Live {
            return None;
        }
        state
            .views
            .values()
            .any(|record| record.state == RemoteViewState::Attached)
            .then(|| state.last_contact.map(|at| at.elapsed()))
            .flatten()
    }

    /// A host announcing its own shutdown. The comparison is here, under this
    /// lock, and not at the caller: a shutdown from a connection that has
    /// already been replaced must not end the session its replacement serves.
    fn commit_host_shutdown(&self, incarnation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.incarnation != incarnation {
            return false;
        }
        self.end(&mut state, RemoteEndedReason::HostShutdown);
        drop(state);
        // The schedule stops after the verdict is committed rather than
        // before it, so the comparison and the end stay in one critical
        // section. An engine that outlives the commit by an instant costs
        // nothing: it returns at its next look at the state, and an abort
        // could not have recalled a dial already in flight anyway.
        self.cancel_engine();
        true
    }

    fn snapshot(&self) -> RemoteSessionLifecycle {
        let state = self.state.lock().unwrap();
        let mut views = state
            .views
            .iter()
            .map(|(local_view_id, record)| record.record(local_view_id))
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.local_view_id.cmp(&right.local_view_id));
        RemoteSessionLifecycle {
            session_id: self.session_id.clone(),
            lifecycle_seq: state.lifecycle_seq,
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            state: state.state,
            reason: state.reason,
            exit: None,
            attempt: state.attempt,
            next_retry_ms: state.next_retry.map(|delay| delay.as_millis() as u64),
            last_contact_ms: state
                .last_contact
                .map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
            views,
        }
    }

    fn current_attachment(&self, local_view_id: &str) -> Option<(u64, bool)> {
        let state = self.state.lock().unwrap();
        let record = state.views.get(local_view_id)?;
        if record.state != RemoteViewState::Attached {
            return None;
        }
        Some((record.attachment_epoch?, record.read_write?))
    }

    fn is_ended(&self) -> bool {
        self.state.lock().unwrap().state == RemoteLifecycleState::Ended
    }

    fn state_kind(&self) -> RemoteLifecycleState {
        self.state.lock().unwrap().state
    }

    fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    fn recorded_host_instance_id(&self) -> Option<String> {
        self.state.lock().unwrap().host_instance_id.clone()
    }

    /// Translate a controller identity from the wire back to a local view id.
    /// Identities this session does not own carry no local meaning; their
    /// rotation is stripped so they at least compare stably with themselves.
    fn local_view_id_for(&self, wire_view_id: &str) -> String {
        let owned = {
            let state = self.state.lock().unwrap();
            state
                .views
                .iter()
                .find(|(_, record)| record.wire_view_id.as_deref() == Some(wire_view_id))
                .map(|(local_view_id, _)| local_view_id.clone())
        };
        owned
            .or_else(|| local_view_id_from_wire(wire_view_id))
            .unwrap_or_else(|| wire_view_id.to_owned())
    }

    fn local_view_ids(&self) -> Vec<String> {
        let mut ids = self
            .state
            .lock()
            .unwrap()
            .views
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    /// Arm the auto-resume engine, replacing any engine already running. A
    /// session has at most one: overlapping engines would each burn dials on
    /// their own schedule and race each other's attempts.
    fn arm_engine(&self, engine: tokio::task::JoinHandle<()>) {
        if let Some(previous) = self.engine.lock().unwrap().replace(engine) {
            previous.abort();
        }
    }

    /// Stop dialing. Local close, a manual retry taking over, and any terminal
    /// state all end the engine; aborting drops whatever dial is in flight.
    fn cancel_engine(&self) {
        if let Some(engine) = self.engine.lock().unwrap().take() {
            engine.abort();
        }
    }

    fn has_engine(&self) -> bool {
        self.engine.lock().unwrap().is_some()
    }

    fn set_next_retry(&self, delay: Option<Duration>) {
        self.state.lock().unwrap().next_retry = delay;
    }

    /// The identities this session stranded, per view lineage: every written
    /// generation below the one currently attached.
    fn purgeable_generations(&self) -> Vec<(String, u64, u64)> {
        self.state
            .lock()
            .unwrap()
            .views
            .iter()
            .filter_map(|(local_view_id, record)| {
                let last = record.written.min(record.generation.saturating_sub(1));
                (record.oldest_unpurged <= last)
                    .then(|| (local_view_id.clone(), record.oldest_unpurged, last))
            })
            .collect()
    }

    fn note_view_written(&self, local_view_id: &str, generation: u64) {
        if let Some(record) = self.state.lock().unwrap().views.get_mut(local_view_id) {
            record.written = record.written.max(generation);
        }
    }

    fn note_purged(&self, local_view_id: &str, generation: u64) {
        if let Some(record) = self.state.lock().unwrap().views.get_mut(local_view_id) {
            record.oldest_unpurged = record.oldest_unpurged.max(generation.saturating_add(1));
        }
    }

    fn view_record(&self, local_view_id: &str) -> Option<RemoteViewRecord> {
        self.state
            .lock()
            .unwrap()
            .views
            .get(local_view_id)
            .map(|record| record.record(local_view_id))
    }

    fn feed_view_id(&self) -> Option<String> {
        self.state.lock().unwrap().feed_view_id.clone()
    }

    /// Elect the replica's feed. Election happens only at generation
    /// activation and picks the lexicographically smallest recorded view, so
    /// both ends of a resume agree on which stream owns session state without
    /// coordinating. It is sticky: a smaller id mounted later never re-elects.
    /// Elect a feed, skipping panes the host has already refused: a view whose
    /// identity was rejected cannot become the stream the whole session reads
    /// from, and re-electing it would loop on the same refusal.
    fn elect_feed(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        let elected = state
            .views
            .iter()
            .filter(|(_, record)| record.state != RemoteViewState::Failed)
            .map(|(local_view_id, _)| local_view_id)
            .min()
            .cloned();
        state.feed_view_id.clone_from(&elected);
        elected
    }

    /// Give up the feed designation if `local_view_id` held it, reporting
    /// whether a promotion is now owed.
    fn release_feed(&self, local_view_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.feed_view_id.as_deref() != Some(local_view_id) {
            return false;
        }
        state.feed_view_id = None;
        !state.views.is_empty()
    }

    fn mark_views_pending(&self) {
        let mut state = self.state.lock().unwrap();
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(&mut state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
    }

    /// Retire the current generation. Activation is early and Live is late
    /// (§4.2.2): once this returns, every in-flight reader is stale and its
    /// late publishes drop, before any replacement reads a byte.
    fn advance_generation(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.generation = state.generation.saturating_add(1);
        state.generation
    }

    fn bind_connection(&self, incarnation: u64) {
        self.state.lock().unwrap().incarnation = incarnation;
    }

    /// Register a view so it is visible to feed election and to resume,
    /// without yet claiming an attach attempt.
    fn record_view(&self, local_view_id: &str) {
        self.state
            .lock()
            .unwrap()
            .views
            .entry(local_view_id.to_owned())
            .or_insert_with(ViewRecord::pending);
    }

    /// Rotate one view's wire identity for an attach attempt that is about to
    /// be written.
    fn begin_view_attempt(&self, local_view_id: &str, rotate: bool) -> (String, u64) {
        let mut state = self.state.lock().unwrap();
        let mut wire = String::new();
        let mut generation = 0;
        self.set_view(&mut state, local_view_id, |record| {
            record.generation = record.generation.saturating_add(1);
            generation = record.generation;
            // The lineage counter advances either way — it is the
            // `attach_generation` a minor-6 host orders attempts by, and the
            // rotation suffix a legacy host is fenced by. Only the encoding
            // differs.
            wire = if rotate {
                wire_view_id(local_view_id, record.generation)
            } else {
                stable_wire_view_id(local_view_id)
            };
            record.wire_view_id = Some(wire.clone());
            record.state = RemoteViewState::Pending;
            record.attachment_epoch = None;
            record.read_write = None;
            record.error = None;
            record.retryable = None;
        });
        (wire, generation)
    }

    fn commit_view_attached(&self, local_view_id: &str, attachment_epoch: u64, read_write: bool) {
        let mut state = self.state.lock().unwrap();
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Attached;
            record.attachment_epoch = Some(attachment_epoch);
            record.last_attachment_epoch = Some(attachment_epoch);
            record.read_write = Some(read_write);
            record.error = None;
            record.retryable = None;
        });
    }

    fn commit_view_failed(&self, local_view_id: &str, error: String, retryable: bool) {
        let mut state = self.state.lock().unwrap();
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Failed;
            record.attachment_epoch = None;
            record.read_write = None;
            record.error = Some(error);
            record.retryable = Some(retryable);
        });
    }

    fn commit_view_pending(&self, local_view_id: &str) {
        let mut state = self.state.lock().unwrap();
        if state
            .views
            .get(local_view_id)
            .is_some_and(|record| record.state == RemoteViewState::Pending)
        {
            return;
        }
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Pending;
            record.attachment_epoch = None;
            record.read_write = None;
        });
    }

    fn forget_view(&self, local_view_id: &str) {
        self.state.lock().unwrap().views.remove(local_view_id);
    }

    /// Evidence for a resume: what this view last held, so the host can refuse
    /// a takeover aimed at a world that no longer exists. `None` when this
    /// lineage has never attached — there is nothing to resume.
    fn resume_hint(&self, local_view_id: &str, terminal_revision: u64) -> Option<ResumeHint> {
        let state = self.state.lock().unwrap();
        let previous_attachment_epoch = state.views.get(local_view_id)?.last_attachment_epoch?;
        Some(ResumeHint {
            previous_session_epoch: state.session_epoch?,
            previous_attachment_epoch,
            previous_terminal_revision: terminal_revision,
        })
    }

    fn record_identity(&self, host_instance_id: &str, session_epoch: u64) {
        let mut state = self.state.lock().unwrap();
        if state.host_instance_id.is_none() {
            state.host_instance_id = Some(host_instance_id.to_owned());
        }
        if state.session_epoch.is_none() {
            state.session_epoch = Some(session_epoch);
        }
    }

    /// Whether a resumed attach landed on the same host world we first
    /// attached to. A mismatch is definitive evidence of a host restart.
    fn identity_matches(&self, host_instance_id: &str, session_epoch: u64) -> bool {
        let state = self.state.lock().unwrap();
        state
            .host_instance_id
            .as_ref()
            .is_none_or(|recorded| recorded == host_instance_id)
            && state
                .session_epoch
                .is_none_or(|recorded| recorded == session_epoch)
    }

    fn commit_synchronizing(&self) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        self.advance(&mut state, RemoteLifecycleState::Synchronizing, None);
    }

    fn commit_live(&self) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.last_contact = Some(Instant::now());
        state.attempt = 0;
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Live, None);
    }

    fn commit_reconnecting(&self) {
        let mut state = self.state.lock().unwrap();
        state.attempt = state.attempt.saturating_add(1);
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
    }

    /// Announce the next scheduled dial, so a client can show an honest
    /// countdown instead of an indefinite spinner.
    fn commit_scheduled_retry(&self, attempt: u32, delay: Duration) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.attempt = attempt;
        state.next_retry = Some(delay);
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
    }

    fn commit_suspended(&self) {
        let mut state = self.state.lock().unwrap();
        if matches!(
            state.state,
            RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
        ) {
            return;
        }
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Suspended, None);
    }

    fn commit_ended(&self, reason: RemoteEndedReason) {
        self.cancel_engine();
        let mut state = self.state.lock().unwrap();
        self.end(&mut state, reason);
    }

    fn end(&self, state: &mut LifecycleState, reason: RemoteEndedReason) {
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.next_retry = None;
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
        self.advance(state, RemoteLifecycleState::Ended, Some(reason));
    }

    /// Commit a liveness-driven teardown for one connection incarnation. The
    /// currency comparison happens here, under this lock, rather than at the
    /// caller: a task can verify currency, be descheduled while the connection
    /// is replaced, and resume holding a verdict for a connection that no
    /// longer exists.
    fn commit_disconnect(&self, generation: u64, incarnation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation || state.incarnation != incarnation {
            return false;
        }
        // Every view riding a dead connection reports it. Acting more than
        // once would re-arm an engine that is already dialing and reset the
        // schedule it is partway through.
        if state.disconnected == Some((generation, incarnation)) {
            return false;
        }
        if matches!(
            state.state,
            RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
        ) {
            return false;
        }
        state.disconnected = Some((generation, incarnation));
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(&mut state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
        // Hand off to the engine: Suspended is where a session comes to rest
        // after `suspend_after` of failed dials, not where it lands the moment
        // a connection drops.
        state.attempt = 0;
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
        true
    }
}

struct AttachOutcome {
    attachment_epoch: u64,
    read_write: bool,
    /// Fires once the reader has applied a snapshot through the current
    /// generation. Resume reports Live only after this.
    synchronized: tokio::sync::watch::Receiver<bool>,
}

/// Separates "this attempt failed, try again" from "this session is over", so
/// a terminal verdict is never retried and a retryable error never ends a
/// session.
enum AttachFailure {
    Ended(RemoteEndedReason),
    Failed(anyhow::Error),
    /// The response is obsolete — a newer attempt for this lineage superseded
    /// it. It marks nothing and re-elects nothing; whatever the superseding
    /// attempt concludes is the outcome.
    Superseded,
    /// The one genuinely view-scoped rejection: this pane's identity was
    /// refused and the session is unharmed. Distinct from `Failed` because the
    /// disposition turns on it — the connection is kept, and a feed re-elects
    /// the next eligible view in place rather than tearing anything down.
    ViewInvalid(anyhow::Error),
    /// The host refused on grounds a redial cannot change. Distinct from
    /// `Failed` because `Failed` is the *ambiguous* case, and ambiguity is
    /// what earns the immediate retry on a fresh connection; re-asking a
    /// question that has been answered definitively only costs a connection.
    Rejected(anyhow::Error),
}

impl From<anyhow::Error> for AttachFailure {
    fn from(error: anyhow::Error) -> Self {
        Self::Failed(error)
    }
}

impl From<AttachFailure> for anyhow::Error {
    fn from(failure: AttachFailure) -> Self {
        match failure {
            AttachFailure::Ended(reason) => {
                anyhow::anyhow!("remote terminal session ended: {}", reason.as_str())
            }
            AttachFailure::Failed(error) => error,
            AttachFailure::Superseded => {
                anyhow::anyhow!("remote view attach was superseded by a newer attempt")
            }
            AttachFailure::ViewInvalid(error) | AttachFailure::Rejected(error) => error,
        }
    }
}

/// The §6.2 code/action table. The action turns on the code's *scope* — there
/// is no blanket "rejected means retry": most codes are not view-scoped, and
/// the table is authoritative over the advisory `retryable` flag a host sends.
fn attach_rejection_outcome(code: AttachRejectCode, feed: bool) -> AttachFailure {
    match code {
        AttachRejectCode::StaleResume => AttachFailure::Superseded,
        // View-scoped: this pane failed, the session did not.
        AttachRejectCode::ViewInvalid => {
            AttachFailure::ViewInvalid(anyhow::anyhow!("remote host rejected the view identity"))
        }
        // Session x client admission. A replacement view hits the same cap, so
        // re-electing is pointless; the feed's caller invalidates the
        // connection so the retry cannot preserve the cap that rejected it.
        AttachRejectCode::ViewLimit => AttachFailure::Rejected(anyhow::anyhow!(
            "remote host is at its view limit for this client"
        )),
        // Session verdicts, whichever attach surfaced them.
        AttachRejectCode::SessionEpochMismatch => {
            AttachFailure::Ended(RemoteEndedReason::HostRestarted)
        }
        // Without a tombstone lookup wired, absence is all the evidence there
        // is — and unavailable is the honest name for that.
        AttachRejectCode::UnknownSession => {
            AttachFailure::Ended(RemoteEndedReason::SessionUnavailable)
        }
        AttachRejectCode::AccessDenied => {
            AttachFailure::Rejected(anyhow::anyhow!("remote host denied access to this session"))
        }
        // A code this viewer predates. Treat it the way an ambiguous failure is
        // treated — the caller closes the connection and advances the
        // generation — rather than guessing at a scope.
        AttachRejectCode::Unknown => AttachFailure::Failed(anyhow::anyhow!(
            "remote host rejected the attach with an unrecognised code{}",
            if feed { " on the feed view" } else { "" }
        )),
    }
}

/// The host sends `ViewAttached` before it opens the state stream, so attach
/// completion is not recovery. Resume waits here, bounded, for the snapshot.
async fn await_first_snapshot(
    mut synchronized: tokio::sync::watch::Receiver<bool>,
    bound: Duration,
) -> Result<()> {
    if *synchronized.borrow_and_update() {
        return Ok(());
    }
    tokio::time::timeout(bound, async {
        loop {
            synchronized
                .changed()
                .await
                .context("remote terminal state stream closed before its snapshot")?;
            if *synchronized.borrow_and_update() {
                return Ok(());
            }
        }
    })
    .await
    .context("timed out waiting for the remote terminal recovery snapshot")?
}

async fn list_sessions_on(host: &RemoteHostConnection) -> Result<Vec<SharedSessionSummary>> {
    let mut control = host.control.lock().await;
    let request_id = Uuid::new_v4().to_string();
    control
        .write_message(
            &ConnectionMessage::ListSessions {
                request_id: request_id.clone(),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out waiting for remote terminal sessions")??
    .context("remote host closed before listing sessions")?
    {
        ConnectionMessage::Sessions {
            request_id: response_id,
            sessions,
        } if response_id == request_id => Ok(sessions),
        ConnectionMessage::Error { message, .. } => {
            bail!("remote host rejected request: {message}")
        }
        _ => bail!("remote host returned an invalid session list"),
    }
}

/// Ask a host what became of a session it is no longer listing. Same lockstep
/// discipline as the listing: one request under the control mutex, matched by
/// request id.
async fn session_status_on(
    host: &RemoteHostConnection,
    remote_session_id: &str,
) -> Result<SessionStatusKind> {
    let mut control = host.control.lock().await;
    let request_id = Uuid::new_v4().to_string();
    control
        .write_message(
            &ConnectionMessage::SessionStatus {
                request_id: request_id.clone(),
                session_id: remote_session_id.to_owned(),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out waiting for a session-status answer")??
    .context("remote host closed before answering session status")?
    {
        ConnectionMessage::SessionStatusResult {
            request_id: response_id,
            status,
        } if response_id == request_id => Ok(status),
        ConnectionMessage::Error { message, .. } => {
            bail!("remote host rejected the session-status request: {message}")
        }
        _ => bail!("remote host returned an invalid session-status answer"),
    }
}

/// Full jitter, AWS definition: the window doubles per attempt up to the cap
/// and the delay is sampled uniformly inside it, so viewers that lost the same
/// host do not come back in lockstep and re-flood it.
fn backoff_delay(config: &MeshReconnectConfig, attempt: u32, jitter: &JitterSource) -> Duration {
    let window = config
        .backoff_base
        .saturating_mul(2_u32.saturating_pow(attempt.min(31)))
        .min(config.backoff_cap);
    jitter(window).min(window).max(config.backoff_floor)
}

/// One heartbeat task per reconnect-capable connection, owning that
/// incarnation's nonces. Transport keep-alive proves the tunnel is up; this
/// proves the host behind it is still answering, which is the failure a
/// black-holed connection presents.
///
/// Every effect it commits names the incarnation it acted for and is compared
/// against the current one under the lifecycle's own lock, so a task that is
/// descheduled while its connection is replaced can neither vouch for the
/// replacement nor tear it down.
async fn heartbeat_loop(runtime: MeshRuntime, device_id: String, host: Arc<RemoteHostConnection>) {
    if let Err(error) = run_heartbeat(&runtime, &device_id, &host).await {
        // The stream itself failing is the same verdict a silent host gets:
        // this connection cannot be trusted to carry the session.
        eprintln!("[terminal-mesh] heartbeat stream failed: {error:#}");
        runtime.fail_connection(&device_id, &host).await;
    }
}

async fn run_heartbeat(
    runtime: &MeshRuntime,
    device_id: &str,
    host: &Arc<RemoteHostConnection>,
) -> Result<()> {
    let config = runtime.config();
    // Sample several times inside the idle window: the cadence is a bound on
    // how late a probe can be, not an interval anything is scheduled on.
    let tick = (config.heartbeat_idle / 3).max(Duration::from_millis(10));
    let mut stream = ProtocolStream::new(host.connection.open_stream().await?);
    stream
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::Heartbeat,
            session_id: None,
            view_id: None,
        })
        .await?;
    let mut outstanding: Option<u64> = None;
    let mut nonce = 0_u64;
    loop {
        if !host.healthy.load(Ordering::Acquire) {
            return Ok(());
        }
        tokio::select! {
            biased;
            message = stream.read_message::<HeartbeatMessage>(MAX_HEARTBEAT_MESSAGE_BYTES) => {
                match message? {
                    None => return Ok(()),
                    Some(HeartbeatMessage::Pong { nonce: echoed }) => {
                        // An unsolicited or replayed pong refreshes nothing,
                        // even on the current connection: only an answer to a
                        // ping this incarnation actually sent is evidence.
                        if outstanding == Some(echoed) {
                            outstanding = None;
                            runtime.note_contact(host).await;
                        }
                    }
                    Some(HeartbeatMessage::HostShutdown {}) => {
                        runtime.commit_host_shutdown(host).await;
                        return Ok(());
                    }
                    // Answering costs nothing and keeps the stream symmetric
                    // for a host that wants to probe its viewers.
                    Some(HeartbeatMessage::Ping { nonce: probed }) => {
                        stream
                            .write_message(
                                &HeartbeatMessage::Pong { nonce: probed },
                                MAX_HEARTBEAT_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                }
            }
            () = tokio::time::sleep(tick) => {
                let Some(quiet) = runtime.quietest_contact(host).await else {
                    // Nothing attached on this connection has any reason to
                    // hear from the host, so its silence is not evidence.
                    outstanding = None;
                    continue;
                };
                if quiet >= config.heartbeat_fail {
                    runtime.fail_connection(device_id, host).await;
                    return Ok(());
                }
                if quiet >= config.heartbeat_idle && outstanding.is_none() {
                    nonce = nonce.saturating_add(1);
                    stream
                        .write_message(
                            &HeartbeatMessage::Ping { nonce },
                            MAX_HEARTBEAT_MESSAGE_BYTES,
                        )
                        .await?;
                    outstanding = Some(nonce);
                }
            }
        }
    }
}

/// Wait out a scheduled backoff, cut short if the device reappears.
async fn wait_for_retry(
    wakeups: &mut broadcast::Receiver<String>,
    device_id: &str,
    delay: Duration,
    fast_path: bool,
) {
    let deadline = tokio::time::sleep(delay);
    tokio::pin!(deadline);
    if !fast_path {
        deadline.await;
        return;
    }
    loop {
        tokio::select! {
            _ = &mut deadline => return,
            event = wakeups.recv() => match event {
                Ok(woken) if woken == device_id => return,
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    deadline.await;
                    return;
                }
            },
        }
    }
}

/// Park until the device looks reachable again. Suspended costs no network:
/// the engine holds here rather than dialing on a timer.
async fn wait_for_device(wakeups: &mut broadcast::Receiver<String>, device_id: &str) -> bool {
    loop {
        match wakeups.recv().await {
            Ok(woken) if woken == device_id => return true,
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return false,
        }
    }
}

/// One auto-resume engine per open session: dial on a full-jitter schedule,
/// wake early when the device re-advertises, and come to rest in Suspended
/// once the host has been absent longer than `suspend_after` — still watching,
/// but no longer burning connects.
/// Boxed at the definition rather than the call site: the engine reaches
/// attach, and attach's reader task reaches back here to arm the engine — a
/// cycle the compiler cannot resolve through two opaque future types.
fn reconnect_engine(
    runtime: MeshRuntime,
    session_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(reconnect_engine_inner(runtime, session_id))
}

async fn reconnect_engine_inner(runtime: MeshRuntime, session_id: String) {
    let Ok(remote) = runtime.remote_session(&session_id).await else {
        return;
    };
    let lifecycle = Arc::clone(&remote.lifecycle);
    let config = runtime.config();
    let jitter = runtime.jitter();
    let mut wakeups = runtime.wakeup_tx.subscribe();
    let mut attempt = 0_u32;
    let mut absent_since = Instant::now();

    loop {
        match lifecycle.state_kind() {
            RemoteLifecycleState::Ended | RemoteLifecycleState::Live => return,
            _ => {}
        }
        if absent_since.elapsed() >= config.suspend_after {
            lifecycle.commit_suspended();
            if !wait_for_device(&mut wakeups, &remote.device_id).await {
                return;
            }
            attempt = 0;
            absent_since = Instant::now();
            continue;
        }

        attempt = attempt.saturating_add(1);
        let delay = backoff_delay(&config, attempt.saturating_sub(1), &jitter);
        lifecycle.commit_scheduled_retry(attempt, delay);
        wait_for_retry(
            &mut wakeups,
            &remote.device_id,
            delay,
            config.advertisement_fast_path,
        )
        .await;
        lifecycle.set_next_retry(None);
        if lifecycle.is_ended() {
            return;
        }
        if runtime.dial_is_pointless(&remote.device_id).await {
            continue;
        }
        match runtime.resume_attempt(&remote).await {
            Ok(()) => {
                if lifecycle.state_kind() == RemoteLifecycleState::Live {
                    return;
                }
            }
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                return;
            }
            Err(AttachFailure::Failed(error)) => {
                eprintln!("[terminal-mesh] resume attempt {attempt} failed: {error:#}");
            }
            // Another attempt is already governing this lineage; nothing to
            // conclude here, so leave the schedule as it is.
            Err(AttachFailure::Superseded) => {}
            // The feed's identity was refused and re-election inside the
            // attempt found nothing left to promote. Keep dialing: a later
            // attempt mints fresh identities.
            Err(AttachFailure::ViewInvalid(error)) => {
                eprintln!("[terminal-mesh] resume attempt {attempt} lost its view: {error:#}");
            }
            // Definitive, but not permanent: a view limit frees as watermarks
            // are collected, so the schedule stands rather than the session
            // being marked over.
            Err(AttachFailure::Rejected(error)) => {
                eprintln!("[terminal-mesh] resume attempt {attempt} refused: {error:#}");
            }
        }
    }
}

/// Best-effort acceleration, never correctness: each stranded attachment sits
/// on a connection this viewer abandoned, and the host reaps it once it
/// observes that connection died. Purging only returns the view slot, and any
/// controller it held, sooner than the transport's idle timeout would.
async fn purge_stranded_attachments(runtime: MeshRuntime, remote: RemoteSession) {
    let Some(host) = runtime.cached_connection(&remote.device_id).await else {
        return;
    };
    let summary = remote.replica.summary();
    for (local_view_id, from, to) in remote.lifecycle.purgeable_generations() {
        for generation in from..=to {
            let wire = wire_view_id(&local_view_id, generation);
            if purge_attachment(&host, &remote, &wire, summary.cols, summary.rows)
                .await
                .is_err()
            {
                // The connection is unusable for cleanup; the host's own
                // connection-death detach collects whatever is left.
                return;
            }
            remote.lifecycle.note_purged(&local_view_id, generation);
        }
    }
}

async fn purge_attachment(
    host: &RemoteHostConnection,
    remote: &RemoteSession,
    wire_view_id: &str,
    cols: u16,
    rows: u16,
) -> Result<()> {
    // The transient state stream the host opens on attach must be consumed
    // here: left in the connection-wide accept queue it would be handed to the
    // next real attach as a misrouted stream.
    let _incoming = host.incoming.lock().await;
    let mut control = ProtocolStream::new(host.connection.open_stream().await?);
    control
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::SessionControl,
            session_id: Some(remote.remote_session_id.clone()),
            view_id: Some(wire_view_id.to_owned()),
        })
        .await?;
    let request_id = Uuid::new_v4().to_string();
    control
        .write_message(
            &SessionControlMessage::AttachView {
                request_id: request_id.clone(),
                session_id: remote.remote_session_id.clone(),
                view_id: wire_view_id.to_owned(),
                access_token: remote.access_token.clone(),
                cols,
                rows,
                attach_generation: 0,
                resume: None,
                // The purge wants the host's existing attachment back so it can
                // detach it; a state stream would only have to be drained.
                wants_state: true,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let attachment_epoch = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out purging a stranded remote attachment")??
    .context("remote terminal closed before the purge attach")?
    {
        SessionControlMessage::ViewAttached {
            request_id: response_id,
            attachment_epoch,
            ..
        } if response_id == request_id => attachment_epoch,
        _ => bail!("remote terminal returned an invalid purge attach response"),
    };
    let state = tokio::time::timeout(HANDSHAKE_TIMEOUT, host.connection.accept_stream())
        .await
        .context("timed out draining a purged state stream")??
        .context("remote terminal closed before the purge state stream")?;
    drop(ProtocolStream::new(state));
    control
        .write_message(
            &SessionControlMessage::Detach {
                view_id: wire_view_id.to_owned(),
                attachment_epoch,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await
}

/// The Phase-1 end-reason evidence rules. A listing is the only evidence a 1.4
/// host can offer, and absence proves nothing beyond unavailability — so the
/// honest fallback is `session-unavailable`, never a guessed close or exit.
/// Record the latest controller state and announce it. Recording first is what
/// gives a dropped announcement a repair path through reconciliation.
fn publish_control_state(
    states: &Arc<SyncMutex<HashMap<String, RemoteControlState>>>,
    sender: &broadcast::Sender<RemoteControlState>,
    state: RemoteControlState,
) {
    states
        .lock()
        .unwrap()
        .insert(state.session_id.clone(), state.clone());
    let _ = sender.send(state);
}

fn ended_reason_from_listing(entry: Option<&SharedSessionSummary>) -> Option<RemoteEndedReason> {
    match entry {
        None => Some(RemoteEndedReason::SessionUnavailable),
        Some(summary) if summary.attachable => None,
        Some(summary) if !summary.running => Some(RemoteEndedReason::SessionExited),
        Some(_) => Some(RemoteEndedReason::SessionClosed),
    }
}

/// Devices whose liveness a discovery signal calls into question. These are
/// probe triggers only: discovery is a hint, and tearing a working connection
/// down on an expired advertisement would be the bug this guards against.
fn peer_wakeup_candidate(event: &PeerEvent) -> Option<String> {
    match event {
        PeerEvent::Joined(peer) | PeerEvent::Identity(peer) => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        PeerEvent::Updated(peer) if peer.online => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        _ => None,
    }
}

fn peer_probe_candidate(event: &PeerEvent) -> Option<String> {
    match event {
        PeerEvent::Left(peer) => peer.identity.as_ref().map(|id| id.device_id.clone()),
        PeerEvent::Updated(peer) if !peer.online => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        _ => None,
    }
}

/// A device that just republished is worth dialing immediately. Advertisements
/// refresh every 5 s, so this is what lands a resume within seconds of the
/// host returning rather than at the end of a backoff.
fn advertisement_wakeup_candidate(
    event: &StoreEvent<TerminalHostAdvertisement>,
    now: u64,
) -> Option<String> {
    match event {
        StoreEvent::PeerUpdated {
            device_id, data, ..
        } if data.expires_at_ms >= now => Some(device_id.clone()),
        _ => None,
    }
}

fn advertisement_probe_candidate(
    event: &StoreEvent<TerminalHostAdvertisement>,
    now: u64,
) -> Option<String> {
    match event {
        StoreEvent::PeerRemoved { device_id } => Some(device_id.clone()),
        StoreEvent::PeerUpdated {
            device_id, data, ..
        } if data.expires_at_ms < now => Some(device_id.clone()),
        _ => None,
    }
}

fn negotiate_state_codec(offered: Option<Vec<StateCodec>>) -> StateCodec {
    offered
        .unwrap_or_default()
        .into_iter()
        .find(|codec| *codec == StateCodec::CompactJsonV1)
        .unwrap_or(StateCodec::Json)
}

impl MeshRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        let ready = self.ready().await?;
        let local_device_id = ready.node.local_info().device_id;
        let peers = ready.node.peers().await;
        let peer_by_device: std::collections::HashMap<_, _> = peers
            .into_iter()
            .filter_map(|peer| peer.device_id.clone().map(|device_id| (device_id, peer)))
            .collect();
        let now = now_ms();
        let mut hosts = ready
            .store
            .all()
            .await
            .into_iter()
            .filter(|(device_id, slice)| {
                device_id != &local_device_id
                    && slice.data.expires_at_ms >= now
                    && slice.data.protocol_major == PROTOCOL_MAJOR
            })
            .map(|(device_id, slice)| {
                let peer = peer_by_device.get(&device_id);
                RemoteHostSummary {
                    device_name: peer
                        .map(|peer| peer.display_name.clone())
                        .unwrap_or_else(|| device_id.clone()),
                    online: peer.is_some_and(|peer| peer.online),
                    device_id,
                    protocol_major: slice.data.protocol_major,
                    protocol_minor: slice.data.protocol_minor,
                    host_instance_id: slice.data.host_instance_id,
                    sessions: slice.data.sessions,
                }
            })
            .collect::<Vec<_>>();
        hosts.sort_by(|left, right| {
            left.device_name
                .cmp(&right.device_name)
                .then(left.device_id.cmp(&right.device_id))
        });
        Ok(hosts)
    }

    pub async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        let sessions = match self.list_sessions_once(device_id).await {
            Ok(sessions) => sessions,
            Err(first_error) => {
                self.invalidate_connection(device_id, None).await;
                self.list_sessions_once(device_id).await.with_context(|| {
                    format!("remote session listing failed after reconnect: {first_error:#}")
                })?
            }
        };
        self.reconcile_evidence(device_id, &sessions).await;
        Ok(sessions)
    }

    async fn list_sessions_once(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        let remote = self.remote_connection(device_id).await?;
        match list_sessions_on(&remote).await {
            Ok(sessions) => Ok(sessions),
            Err(error) => {
                self.note_connection_failure(device_id, &remote).await;
                Err(error)
            }
        }
    }

    /// The §6.4 verdict, improved by the host's own records where the listing
    /// has nothing to say. Absence is exactly the case a tombstone exists for:
    /// without asking, every session killed during an outage reads as
    /// "unavailable", which tells a user nothing about what happened to it.
    async fn ended_reason_with_status(
        &self,
        host: &Arc<RemoteHostConnection>,
        entry: Option<&SharedSessionSummary>,
        remote_session_id: &str,
    ) -> Option<RemoteEndedReason> {
        let listed = ended_reason_from_listing(entry);
        // A listed session has already answered for itself, and a host below
        // the reconnect minor has no answer to give.
        if entry.is_some() || !host.supports_reconnect() {
            return listed;
        }
        match session_status_on(host, remote_session_id).await {
            Ok(SessionStatusKind::Ended { reason }) => Some(match reason {
                SessionEndReason::Exited { .. } => RemoteEndedReason::SessionExited,
                SessionEndReason::Closed => RemoteEndedReason::SessionClosed,
            }),
            // It holds the session after all — it appeared between the listing
            // and this question. Claim nothing: the attach that follows is
            // better evidence than either answer.
            Ok(SessionStatusKind::Live) => None,
            // An expired or never-written tombstone, or a host that cannot
            // say. `Unknown` is never upgraded, so absence stands on its own.
            Ok(SessionStatusKind::Unknown) | Err(_) => listed,
        }
    }

    /// Apply §6.4 listing evidence to sessions that are already off the air.
    /// A live session is never ended from a listing: the host lists what it
    /// serves, and our own attachment is the better evidence.
    async fn reconcile_evidence(&self, device_id: &str, sessions: &[SharedSessionSummary]) {
        let candidates = self
            .replicas
            .read()
            .await
            .values()
            .filter(|remote| {
                remote.device_id == device_id
                    && remote.lifecycle.state_kind() == RemoteLifecycleState::Suspended
            })
            .map(|remote| {
                (
                    remote.remote_session_id.clone(),
                    Arc::clone(&remote.lifecycle),
                )
            })
            .collect::<Vec<_>>();
        // Both verdict paths consult, or the two would disagree: whichever of
        // this sweep and a resume attempt ran first would decide the reason a
        // user is shown.
        let host = self.cached_connection(device_id).await;
        for (remote_session_id, lifecycle) in candidates {
            let entry = sessions
                .iter()
                .find(|summary| summary.session_id == remote_session_id);
            let reason = match host.as_ref() {
                Some(host) => {
                    self.ended_reason_with_status(host, entry, &remote_session_id)
                        .await
                }
                None => ended_reason_from_listing(entry),
            };
            if let Some(reason) = reason {
                lifecycle.commit_ended(reason);
            }
        }
    }

    pub async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary> {
        let RemoteSessionOpen {
            device_id,
            remote_session_id,
            cols,
            rows,
            owner_id,
            frames,
            text_engine,
        } = request;
        let transport = self.transport().await?;
        // Advertised sessions are discovery hints and may lag registry
        // changes. Resolve the selected session against the host's live
        // registry before creating a local replica.
        let sessions = self.list_sessions(&device_id).await?;
        let remote = sessions
            .iter()
            .find(|session| session.session_id == remote_session_id && session.attachable)
            .context("remote terminal session is no longer attachable")?;
        let replica = RemoteReplica::new(
            remote.title.clone(),
            remote.cwd_label.clone(),
            cols,
            rows,
            owner_id,
            frames,
            text_engine,
        );
        replica.set_activity(remote.activity.clone());
        let summary = replica.summary();
        relay_replica_metadata(&replica, summary.id.clone(), self.metadata_tx.clone());
        // The device name is captured here because lifecycle events must name
        // the host even once it is unreachable and absent from the peer list.
        let device_name = transport
            .device_name(&device_id)
            .await
            .unwrap_or_else(|| device_id.clone());
        let host_instance_id = self
            .connections
            .lock()
            .await
            .get(&device_id)
            .map(|connection| connection.host_instance_id.clone());
        let lifecycle = SessionLifecycle::new(
            summary.id.clone(),
            device_id.clone(),
            device_name,
            host_instance_id,
            self.lifecycle_tx.clone(),
            self.view_state_tx.clone(),
        );
        self.replicas.write().await.insert(
            summary.id.clone(),
            RemoteSession {
                device_id,
                remote_session_id,
                access_token: transport.capability(),
                replica,
                lifecycle,
            },
        );
        Ok(summary)
    }

    pub async fn summaries(&self) -> Vec<SessionSummary> {
        self.replicas
            .read()
            .await
            .values()
            .map(|session| session.replica.summary())
            .collect()
    }

    pub async fn summary(&self, session_id: &str) -> Option<SessionSummary> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .map(|session| session.replica.summary())
    }

    pub async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        let remote = self.remote_session(session_id).await?;
        let lifecycle = Arc::clone(&remote.lifecycle);
        let _attempt = lifecycle.attempts.lock().await;
        if lifecycle.is_ended() {
            bail!("remote terminal session has ended");
        }
        // A view that is not currently Live has to be re-established rather
        // than answered from cache: returning the cached attachment is what
        // let a dead epoch outlive the connection that minted it.
        let resuming = lifecycle.state_kind() != RemoteLifecycleState::Live;
        self.retire_view(session_id, view_id).await;
        if resuming && lifecycle.state_kind() != RemoteLifecycleState::Opening {
            lifecycle.advance_generation();
            lifecycle.commit_reconnecting();
        }
        // The first view to arrive owns the replica feed; later panes are
        // secondaries whose streams are drained.
        lifecycle.record_view(view_id);
        let feed = lifecycle.feed_view_id().unwrap_or_else(|| {
            lifecycle.elect_feed();
            lifecycle
                .feed_view_id()
                .unwrap_or_else(|| view_id.to_owned())
        });
        let is_feed = feed == view_id;

        let outcome = match self.attach_view_attempt(&remote, view_id, is_feed).await {
            Ok(outcome) => Ok(outcome),
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                bail!("remote terminal session ended: {}", reason.as_str());
            }
            // Discarded outright: no `failed` mark, because the superseding
            // attempt owns this view's outcome.
            Err(AttachFailure::Superseded) => {
                bail!("remote view attach was superseded by a newer attempt")
            }
            // View-scoped: this pane is refused, the session and the
            // connection are both fine, so neither is touched on the way out.
            Err(AttachFailure::ViewInvalid(error)) => Err(error),
            // Definitive. The attempt has already applied whatever connection
            // disposition the code calls for; retrying on a fresh dial would
            // re-ask a question the host has answered, and for a secondary it
            // would take down the connection its live session is using.
            Err(AttachFailure::Rejected(error)) => Err(error),
            // The initial dial can land on a connection the host has already
            // forgotten. Retrying is safe now only because the second attempt
            // rotates to a fresh wire identity.
            Err(AttachFailure::Failed(first_error)) => {
                self.invalidate_connection(&remote.device_id, None).await;
                match self.attach_view_attempt(&remote, view_id, is_feed).await {
                    Ok(outcome) => Ok(outcome),
                    Err(AttachFailure::Ended(reason)) => {
                        lifecycle.commit_ended(reason);
                        bail!("remote terminal session ended: {}", reason.as_str());
                    }
                    Err(AttachFailure::Superseded) => {
                        bail!("remote view attach was superseded by a newer attempt")
                    }
                    Err(AttachFailure::ViewInvalid(error))
                    | Err(AttachFailure::Rejected(error)) => Err(error),
                    Err(AttachFailure::Failed(error)) => Err(anyhow::anyhow!(
                        "remote view attach failed after reconnect: {first_error:#}: {error:#}"
                    )),
                }
            }
        };

        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                lifecycle.commit_view_failed(view_id, format!("{error:#}"), true);
                if lifecycle.state_kind() == RemoteLifecycleState::Reconnecting {
                    lifecycle.commit_suspended();
                }
                return Err(error);
            }
        };

        lifecycle.commit_view_attached(view_id, outcome.attachment_epoch, outcome.read_write);
        // Live means the feed is attached *and* its snapshot has been applied
        // — an initial open included. Reporting live at ViewAttached would
        // hand the renderer an epoch, and the user an input-ready pane, before
        // the authoritative screen exists.
        if is_feed && resuming {
            lifecycle.commit_synchronizing();
            if let Err(error) =
                await_first_snapshot(outcome.synchronized, self.synchronize_bound()).await
            {
                return Err(self.abandon_attempt(&remote, error).await);
            }
        }
        if is_feed && lifecycle.state_kind() != RemoteLifecycleState::Live {
            lifecycle.commit_live();
        }
        remote.replica.set_read_write(outcome.read_write);
        Ok(RemoteAttachment {
            attachment_epoch: outcome.attachment_epoch,
            read_write: outcome.read_write,
        })
    }

    /// Abandon an attempt that never synchronized. Leaving its readers alive
    /// under the current generation would let them mutate a replica the user
    /// has already been told is frozen.
    async fn abandon_attempt(&self, remote: &RemoteSession, error: anyhow::Error) -> anyhow::Error {
        let session_id = remote.replica.summary().id;
        self.retire_session_views(&session_id).await;
        remote.lifecycle.advance_generation();
        remote.lifecycle.mark_views_pending();
        remote.lifecycle.commit_suspended();
        error
    }

    /// One `AttachView` write, its response, and the state stream it opens.
    /// Every attempt rotates the wire identity, so the host treats it as a
    /// brand-new view: fresh epoch, and no zombie cleanup can collide with it.
    async fn attach_view_attempt(
        &self,
        remote: &RemoteSession,
        local_view_id: &str,
        feed: bool,
    ) -> Result<AttachOutcome, AttachFailure> {
        let summary = remote.replica.summary();
        let host = self.remote_connection(&remote.device_id).await?;
        if !remote
            .lifecycle
            .recorded_host_instance_id()
            .is_none_or(|recorded| recorded == host.host_instance_id)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        // A connection carries multiple view streams, but their LiveState
        // streams arrive on one connection-wide accept queue. Serialize the
        // attach handshake so concurrent panes cannot consume each other's
        // state stream.
        let _incoming = host.incoming.lock().await;
        // Rotate immediately before the write, never earlier: a stalled
        // attempt must not carry an old generation onto a newer connection.
        // A minor-6 host orders attempts by `attach_generation` and mints a
        // fresh epoch per takeover, so the identity is reused; below that the
        // rotation suffix is the only fence available.
        let takeover = host.supports_reconnect();
        let (wire_view_id, view_generation) = remote
            .lifecycle
            .begin_view_attempt(local_view_id, !takeover);
        let resume = takeover
            .then(|| {
                let revision = remote
                    .replica
                    .retained_snapshot()
                    .map_or(0, |snapshot| snapshot.terminal_revision);
                remote.lifecycle.resume_hint(local_view_id, revision)
            })
            .flatten();
        // A secondary's stream is drained and discarded, so a host that can
        // honour the request is told not to open one: it costs a full snapshot
        // per pane and a patch stream nobody reads. Below the reconnect minor
        // the field means nothing to the host, which opens a stream either
        // way — so there the viewer must still expect one.
        let wants_state = feed || !host.supports_reconnect();
        let state_generation = remote.lifecycle.generation();
        let connection = Arc::clone(&host.connection);
        let mut session_control = ProtocolStream::new(connection.open_stream().await?);
        session_control
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::SessionControl,
                session_id: Some(remote.remote_session_id.clone()),
                view_id: Some(wire_view_id.clone()),
            })
            .await?;
        let request_id = Uuid::new_v4().to_string();
        session_control
            .write_message(
                &SessionControlMessage::AttachView {
                    request_id: request_id.clone(),
                    session_id: remote.remote_session_id.clone(),
                    view_id: wire_view_id.clone(),
                    access_token: remote.access_token.clone(),
                    cols: summary.cols,
                    rows: summary.rows,
                    // Zero is the legacy declaration: a rotating viewer must
                    // not claim a lineage the host would order against, and a
                    // host that sees it routes to the plain attach path.
                    attach_generation: if takeover { view_generation } else { 0 },
                    resume,
                    wants_state,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        // Only a written attempt strands an identity worth purging later.
        remote
            .lifecycle
            .note_view_written(local_view_id, view_generation);
        let attach_response = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session_control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
        )
        .await
        .context("timed out attaching remote terminal view")?
        .context("read remote terminal attach response")?
        .context("remote terminal closed before attaching view")?;
        let (attachment_epoch, read_write, session_epoch) = match attach_response {
            SessionControlMessage::ViewAttached {
                request_id: response_id,
                attachment_epoch,
                read_write,
                session_epoch,
                ..
            } if response_id == request_id => (attachment_epoch, read_write, session_epoch),
            SessionControlMessage::AttachRejected {
                request_id: response_id,
                code,
                ..
            } if response_id == request_id => {
                // `retryable` is deliberately ignored: the table is
                // authoritative, and a host sending a contradictory value must
                // not change the action taken.
                let outcome = attach_rejection_outcome(code, feed);
                // Connection disposition per the §6.2 table, which turns on the
                // role as well as the code. `view-limit` is the asymmetric one:
                // the feed closes the connection before retrying, because
                // watermark GC cannot free the cap while this connection pins
                // the fence — but a secondary hitting the same cap must leave
                // the connection alone, since an already-Live session rides it
                // and losing one pane is not a reason to drop the rest.
                let retire = match code {
                    AttachRejectCode::ViewLimit => feed,
                    AttachRejectCode::UnknownSession
                    | AttachRejectCode::SessionEpochMismatch
                    | AttachRejectCode::AccessDenied
                    | AttachRejectCode::Unknown => true,
                    AttachRejectCode::StaleResume | AttachRejectCode::ViewInvalid => false,
                };
                if retire {
                    self.note_connection_failure(&remote.device_id, &host).await;
                }
                return Err(outcome);
            }
            _ => {
                return Err(AttachFailure::Failed(anyhow::anyhow!(
                    "remote terminal returned an invalid attach response"
                )));
            }
        };
        if !remote
            .lifecycle
            .identity_matches(&host.host_instance_id, session_epoch)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        remote
            .lifecycle
            .record_identity(&host.host_instance_id, session_epoch);
        // Bind before the reader exists, so the reader's eventual verdict has
        // an incarnation to be compared against.
        remote.lifecycle.bind_connection(host.incarnation);
        // Waiting for a stream this attach declined would hang here for the
        // whole handshake timeout and then fail — the one way this change can
        // break, and the reason the two decisions are read from one flag.
        let state = if wants_state {
            let state_stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_stream())
                .await
                .context("timed out waiting for remote terminal state")??
                .context("remote terminal closed before opening state stream")?;
            let mut state = ProtocolStream::new(state_stream);
            let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, state.read_preface())
                .await
                .context("timed out reading remote state preface")?
                .context("read remote terminal state preface")?;
            if preface.stream_kind != StreamKind::LiveState
                || preface.session_id.as_deref() != Some(remote.remote_session_id.as_str())
                || preface.view_id.as_deref() != Some(wire_view_id.as_str())
            {
                return Err(AttachFailure::Failed(anyhow::anyhow!(
                    "remote terminal returned a misrouted state stream"
                )));
            }
            Some(state)
        } else {
            None
        };
        let (state_cancel, mut state_cancelled) = tokio::sync::watch::channel(false);
        // A view with no stream has nothing to wait for and is as synchronized
        // as it will ever be; only the feed is ever awaited, and the feed
        // always has one.
        let (synchronized_tx, synchronized) = tokio::sync::watch::channel(state.is_none());
        let view = Arc::new(RemoteView {
            session_control: tokio::sync::Mutex::new(session_control),
            state_cancel,
            attachment_epoch,
            read_write,
            wire_view_id,
            state_generation,
            incarnation: host.incarnation,
            feed,
        });
        let key = (remote.replica.summary().id, local_view_id.to_owned());
        let local_view_key = key.clone();
        {
            // Publication is the fence. An attempt that began before a
            // promotion, refresh, or duplicate resume must not install itself
            // into the world that superseded it — and must never displace a
            // live entry without cancelling the reader behind it.
            let mut views = self.views.lock().await;
            if remote.lifecycle.generation() != state_generation {
                drop(views);
                view.state_cancel.send_replace(true);
                return Err(AttachFailure::Failed(anyhow::anyhow!(
                    "remote view attach was superseded before it could publish"
                )));
            }
            if let Some(displaced) = views.insert(key, Arc::clone(&view)) {
                displaced.state_cancel.send_replace(true);
            }
        }
        // A view that declined state has no reader to spawn. Nothing arrives on
        // its behalf — including the session-level verdicts and the disconnect
        // report, which the feed's reader raises for the whole session.
        let Some(mut state) = state else {
            return Ok(AttachOutcome {
                attachment_epoch,
                read_write,
                synchronized,
            });
        };
        let replica = Arc::clone(&remote.replica);
        let local_session_id = remote.replica.summary().id;
        let remote_device_id = remote.device_id.clone();
        let remote_view = Arc::clone(&view);
        let remote_host = Arc::clone(&host);
        let lifecycle = Arc::clone(&remote.lifecycle);
        let views = Arc::clone(&self.views);
        let connections = Arc::clone(&self.connections);
        let remote_control_tx = self.control_tx.clone();
        let remote_activity_tx = self.activity_tx.clone();
        let control_state_tx = self.control_state_tx.clone();
        let control_states = Arc::clone(&self.control_states);
        let engine_runtime = self.clone();
        let incarnation = host.incarnation;
        tokio::spawn(async move {
            let mut connection_failed = true;
            loop {
                let message = tokio::select! {
                    changed = state_cancelled.changed() => {
                        if changed.is_err() || *state_cancelled.borrow() {
                            connection_failed = false;
                            break;
                        }
                        continue;
                    }
                    message = state.read_state_message(
                        remote_host.state_codec,
                        remote_host.protocol_minor,
                    ) => message,
                };
                let message = match message {
                    Ok(Some(message)) => message,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("[terminal-mesh] remote state stream closed: {error:#}");
                        break;
                    }
                };
                // The gate covers every state-channel dispatch, not just
                // replica publication: a superseded reader that only had its
                // frames gated could still move controller or activity state
                // after recovery, or refresh the current connection's contact
                // clock on its behalf.
                if !lifecycle.admit_state(state_generation, incarnation) {
                    continue;
                }
                // Contact is refreshed above for any traffic on the current
                // incarnation, but only the feed publishes: a secondary's
                // stream is drained so its independent patch sequence can
                // never interleave with the feed's in the shared replica.
                // A session ending is a session-level fact, not replica state,
                // so it counts whichever of this session's streams reported it
                // — but only from the current generation and incarnation, which
                // the gate above has already established.
                match &message {
                    StateMessage::SessionEnded { reason } => {
                        lifecycle.commit_ended(match reason {
                            SessionEndReason::Exited { .. } => RemoteEndedReason::SessionExited,
                            SessionEndReason::Closed => RemoteEndedReason::SessionClosed,
                        });
                        // One session concluding says nothing about the
                        // transport, which is shared: retiring it here would
                        // tear down every sibling session on this device for
                        // an event that was clean and expected.
                        connection_failed = false;
                        break;
                    }
                    StateMessage::HostShutdown {} => {
                        lifecycle.commit_ended(RemoteEndedReason::HostShutdown);
                        // The host itself is going away, so the connection is
                        // genuinely finished — left to the failure path.
                        break;
                    }
                    _ => {}
                }
                if !remote_view.feed {
                    continue;
                }
                match message {
                    StateMessage::Snapshot(snapshot) => {
                        if let Err(error) = replica.publish(snapshot) {
                            eprintln!("[terminal-mesh] failed to render remote state: {error:#}");
                            break;
                        }
                        synchronized_tx.send_replace(true);
                    }
                    StateMessage::Patch(patch) => {
                        if let Err(error) = replica.publish_patch(patch) {
                            eprintln!(
                                "[terminal-mesh] failed to apply remote state patch: {error:#}"
                            );
                            break;
                        }
                    }
                    // The reconnect shape, the only one that can say "no
                    // controller". Republished as the same mesh-level state a
                    // legacy frame produces, so consumers see one vocabulary.
                    StateMessage::ControlState {
                        controller,
                        control_revision,
                        cols,
                        rows,
                        layout_epoch,
                    } => {
                        let controller = controller.map(|controller| RemoteController {
                            view_id: lifecycle.local_view_id_for(&controller.controller_view_id),
                            control_epoch: controller.control_epoch,
                        });
                        if let Some(controller) = controller.as_ref() {
                            let _ = remote_control_tx.send(RemoteControlChanged {
                                session_id: local_session_id.clone(),
                                controller_view_id: controller.view_id.clone(),
                                control_epoch: controller.control_epoch,
                                cols,
                                rows,
                                layout_epoch,
                            });
                        }
                        publish_control_state(
                            &control_states,
                            &control_state_tx,
                            RemoteControlState {
                                session_id: local_session_id.clone(),
                                controller,
                                control_revision,
                                cols,
                                rows,
                                layout_epoch,
                            },
                        );
                    }
                    StateMessage::ControlChanged {
                        controller_view_id,
                        control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    } => {
                        // Controller identities arrive as wire ids; every mesh
                        // consumer above this point speaks local ids.
                        let controller_view_id = lifecycle.local_view_id_for(&controller_view_id);
                        let _ = remote_control_tx.send(RemoteControlChanged {
                            session_id: local_session_id.clone(),
                            controller_view_id: controller_view_id.clone(),
                            control_epoch,
                            cols,
                            rows,
                            layout_epoch,
                        });
                        // Revision 0 says "legacy, unknown": this host cannot
                        // report revisions or clears, and a client must never
                        // compare-and-swap against it.
                        publish_control_state(
                            &control_states,
                            &control_state_tx,
                            RemoteControlState {
                                session_id: local_session_id.clone(),
                                controller: Some(RemoteController {
                                    view_id: controller_view_id,
                                    control_epoch,
                                }),
                                control_revision: 0,
                                cols,
                                rows,
                                layout_epoch,
                            },
                        );
                    }
                    StateMessage::ActivityChanged { activity } => {
                        replica.set_activity(activity.clone());
                        let _ = remote_activity_tx.send(RemoteActivityChanged {
                            session_id: local_session_id.clone(),
                            activity,
                        });
                    }
                    // The daemon-to-daemon replica currently keeps desktop
                    // presentation view-local. Compact Apple clients consume
                    // this projection directly; desktop per-pane presentation
                    // is a separate UI boundary.
                    StateMessage::ConfigurationChanged { .. } => {}
                    // Native desktop surfaces retain their selection locally;
                    // Apple replicas consume this through their TRF1 bridge.
                    StateMessage::SelectionChanged { .. } => {}
                    // Carrying a nullable controller through to the mesh API
                    // needs a shape that can say "no controller", which the
                    // current RemoteControlClaim cannot. No host emits this
                    // until the minor-6 host behaviors land alongside it.
                    // Handled above, before the feed check.
                    StateMessage::SessionEnded { .. } | StateMessage::HostShutdown {} => {}
                }
            }
            // A stream that ended because we asked to be detached is not a
            // failure. The host closes its side in answer to our Detach, so
            // that EOF races the cancellation flag and can win.
            if *state_cancelled.borrow() {
                connection_failed = false;
            }
            let mut current_views = views.lock().await;
            if current_views
                .get(&local_view_key)
                .is_some_and(|current| Arc::ptr_eq(current, &remote_view))
            {
                current_views.remove(&local_view_key);
            }
            drop(current_views);

            if connection_failed {
                remote_host.healthy.store(false, Ordering::Release);
                remote_host.connection.close();
                let mut current_connections = connections.lock().await;
                if current_connections
                    .get(&remote_device_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &remote_host))
                {
                    current_connections.remove(&remote_device_id);
                }
                drop(current_connections);
                // Only a genuine transport failure is a disconnect. A
                // deliberate cancellation — a detach, an unmount, a retirement
                // ahead of a resume — is the caller's intent, and suspending a
                // healthy session on it would also strand its sibling views.
                //
                // Carries the incarnation and generation it acted for; the
                // owner compares both at commit and drops a verdict from a
                // connection that has already been replaced.
                if lifecycle.commit_disconnect(state_generation, incarnation) {
                    engine_runtime.arm_reconnect_for(&local_session_id).await;
                }
            }
        });
        Ok(AttachOutcome {
            attachment_epoch,
            read_write,
            synchronized,
        })
    }

    /// Remove a view's attachment and cancel its reader before anything
    /// re-dials, so a dying reader can never delete the replacement's entry.
    async fn retire_view(&self, session_id: &str, local_view_id: &str) {
        let key = (session_id.to_owned(), local_view_id.to_owned());
        let view = self.views.lock().await.remove(&key);
        if let Some(view) = view {
            view.state_cancel.send_replace(true);
        }
    }

    async fn retire_session_views(&self, session_id: &str) {
        let mut views = self.views.lock().await;
        let retired = views
            .keys()
            .filter(|(candidate, _)| candidate == session_id)
            .cloned()
            .collect::<Vec<_>>();
        let retired = retired
            .into_iter()
            .filter_map(|key| views.remove(&key))
            .collect::<Vec<_>>();
        drop(views);
        for view in retired {
            view.state_cancel.send_replace(true);
        }
    }

    async fn remote_session(&self, session_id: &str) -> Result<RemoteSession> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .cloned()
            .context("unknown remote session")
    }

    /// Re-attach one non-feed view of a live session. The feed and the session
    /// itself are recovered through the session-level paths, which own the
    /// generation; this is the per-pane affordance for a view that failed on
    /// its own while the rest of the session kept working.
    pub async fn retry_view(&self, session_id: &str, view_id: &str) -> Result<RemoteViewRecord> {
        let remote = self.remote_session(session_id).await?;
        if remote.lifecycle.state_kind() != RemoteLifecycleState::Live {
            bail!("remote terminal session is not live");
        }
        if remote.lifecycle.feed_view_id().as_deref() == Some(view_id) {
            bail!("the feed view is retried through the session, not per view");
        }
        let record = remote
            .lifecycle
            .view_record(view_id)
            .context("unknown remote view")?;
        if record.view_state == RemoteViewState::Attached {
            return Ok(record);
        }
        let generation = remote.lifecycle.generation();
        self.attach_secondaries(&remote, vec![view_id.to_owned()], generation)
            .await;
        remote
            .lifecycle
            .view_record(view_id)
            .context("unknown remote view")
    }

    /// Liveness round-trip on a device's cached connection. Advertisement
    /// validation is deliberately skipped: the probe matters exactly when the
    /// advertisement has expired, and `remote_connection` bails on that before
    /// it ever reaches the cache.
    pub async fn probe_connection(&self, device_id: &str) -> Result<()> {
        let host = self
            .connections
            .lock()
            .await
            .get(device_id)
            .cloned()
            .context("no cached connection to probe")?;
        match list_sessions_on(&host).await {
            Ok(_) => Ok(()),
            Err(error) => {
                self.fail_connection(device_id, &host).await;
                Err(error).context("remote terminal host failed its liveness probe")
            }
        }
    }

    /// One-shot resume. Phase 1 ships manual retry only: exactly one dial, no
    /// backoff loop and no discovery fast path.
    pub async fn reconnect_session(&self, session_id: &str) -> Result<RemoteSessionLifecycle> {
        let remote = self.remote_session(session_id).await?;
        let lifecycle = Arc::clone(&remote.lifecycle);
        if lifecycle.is_ended() {
            return Ok(lifecycle.snapshot());
        }
        // Cut the engine's pending wait short rather than cancelling it, then
        // take the same single-flight lock it uses: a manual retry and an
        // automatic one can never dial at once, and a failed manual retry
        // leaves the schedule intact behind it.
        if !lifecycle.has_engine() {
            self.arm_reconnect(&remote).await;
        }
        self.note_device_available(&remote.device_id);
        let previous = lifecycle.state_kind();
        lifecycle.commit_reconnecting();
        match self.resume_attempt(&remote).await {
            Ok(()) => Ok(lifecycle.snapshot()),
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                Ok(lifecycle.snapshot())
            }
            Err(AttachFailure::Failed(error)) => {
                if previous == RemoteLifecycleState::Ended {
                    return Ok(lifecycle.snapshot());
                }
                Err(error)
            }
            // A newer attempt already owns this lineage. Reporting an error
            // would be a lie about a session someone else is busy recovering,
            // so hand back the state as it stands and let them finish.
            Err(AttachFailure::Superseded) => Ok(lifecycle.snapshot()),
            Err(AttachFailure::ViewInvalid(error)) | Err(AttachFailure::Rejected(error)) => {
                Err(error)
            }
        }
    }

    async fn resume_attempt(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let _attempt = remote.lifecycle.attempts.lock().await;
        // Whoever held this lock may already have finished the job. Running a
        // second pass would retire the views it just attached and invalidate
        // the epoch it just handed back.
        if self.session_is_established(remote).await {
            return Ok(());
        }
        self.resume_once(remote).await
    }

    /// Whether the session is live around a feed that belongs to the current
    /// generation — the condition a further resume attempt would destroy.
    async fn session_is_established(&self, remote: &RemoteSession) -> bool {
        if remote.lifecycle.state_kind() != RemoteLifecycleState::Live {
            return false;
        }
        let Some(feed_view_id) = remote.lifecycle.feed_view_id() else {
            return false;
        };
        let generation = remote.lifecycle.generation();
        let key = (remote.replica.summary().id, feed_view_id);
        self.views
            .lock()
            .await
            .get(&key)
            .is_some_and(|view| view.feed && view.state_generation == generation)
    }

    /// Arm auto-resume for a session that has lost its host.
    async fn arm_reconnect(&self, remote: &RemoteSession) {
        if remote.lifecycle.is_ended() {
            return;
        }
        let runtime = self.clone();
        let session_id = remote.replica.summary().id;
        remote
            .lifecycle
            .arm_engine(tokio::spawn(reconnect_engine(runtime, session_id)));
    }

    async fn arm_reconnect_for(&self, session_id: &str) {
        if let Ok(remote) = self.remote_session(session_id).await {
            self.arm_reconnect(&remote).await;
        }
    }

    /// Skip a scheduled dial when discovery says the device is both offline
    /// and unadvertised. The fast path covers the wake-up, so this only avoids
    /// burning connects at a host that is provably not there.
    async fn dial_is_pointless(&self, device_id: &str) -> bool {
        let Ok(transport) = self.transport().await else {
            return true;
        };
        !transport.peer_is_online(device_id).await
            && transport.host_instance_id(device_id).await.is_err()
    }

    async fn cached_connection(&self, device_id: &str) -> Option<Arc<RemoteHostConnection>> {
        self.connections.lock().await.get(device_id).cloned()
    }

    /// A generation-advanced re-attach of the feed. This is the promotion
    /// machinery: attach semantics are what guarantee a fresh stream, a full
    /// snapshot, and reset sequencing.
    async fn reestablish_feed(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let attempt = remote.lifecycle.attempts.lock().await;
        let session_id = remote.replica.summary().id;
        // Say it before doing it. The next two lines cancel every reader and
        // retire the generation, so the session stops being live and its views
        // stop being attached at this instant — announcing that only on
        // success would leave a failed handoff claiming a liveness it lost.
        remote.lifecycle.commit_synchronizing();
        remote.lifecycle.mark_views_pending();
        self.retire_session_views(&session_id).await;
        remote.lifecycle.advance_generation();
        match self.establish_feed(remote).await {
            Ok(()) => Ok(()),
            Err(AttachFailure::Ended(reason)) => {
                remote.lifecycle.commit_ended(reason);
                Err(AttachFailure::Ended(reason))
            }
            Err(AttachFailure::Failed(error)) => {
                // Nothing is attached and the cancellations were deliberate,
                // so no reader will report a disconnect. Hand to the engine
                // explicitly or the session rests where nothing recovers it.
                remote.lifecycle.commit_reconnecting();
                drop(attempt);
                self.arm_reconnect(remote).await;
                Err(AttachFailure::Failed(error))
            }
            // Deliberately none of the above: arming the engine here would put
            // a second dial loop behind an attempt that is already running,
            // and the state it would commit is not this promotion's to write.
            Err(AttachFailure::Superseded) => Err(AttachFailure::Superseded),
            // Nothing eligible was left to promote. The connection is healthy,
            // so this is a session with no usable pane rather than an outage.
            Err(AttachFailure::ViewInvalid(error)) => {
                remote.lifecycle.commit_suspended();
                Err(AttachFailure::ViewInvalid(error))
            }
            Err(AttachFailure::Rejected(error)) => {
                remote.lifecycle.commit_reconnecting();
                drop(attempt);
                self.arm_reconnect(remote).await;
                Err(AttachFailure::Rejected(error))
            }
        }
    }

    async fn resume_once(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let lifecycle = &remote.lifecycle;
        let transport = self.transport().await?;
        // Step 2 of the resume handshake: a different host instance is a new
        // world, and it is answerable from discovery alone. Do not dial.
        if let (Ok(advertised), Some(recorded)) = (
            transport.host_instance_id(&remote.device_id).await,
            lifecycle.recorded_host_instance_id(),
        ) && advertised != recorded
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }

        let session_id = remote.replica.summary().id;
        self.retire_session_views(&session_id).await;
        // Activate before publishing: the moment this returns, every in-flight
        // reader is stale, well before any replacement reads a byte.
        lifecycle.advance_generation();

        let host = self.remote_connection(&remote.device_id).await?;
        if !lifecycle
            .recorded_host_instance_id()
            .is_none_or(|recorded| recorded == host.host_instance_id)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        lifecycle.bind_connection(host.incarnation);

        // Step 4: resolve the session against the host's live registry and let
        // the listing be the evidence for any terminal verdict.
        let sessions = match list_sessions_on(&host).await {
            Ok(sessions) => sessions,
            Err(error) => {
                self.note_connection_failure(&remote.device_id, &host).await;
                return Err(AttachFailure::Failed(error));
            }
        };
        let entry = sessions
            .iter()
            .find(|summary| summary.session_id == remote.remote_session_id);
        if let Some(reason) = self
            .ended_reason_with_status(&host, entry, &remote.remote_session_id)
            .await
        {
            return Err(AttachFailure::Ended(reason));
        }

        self.establish_feed(remote).await
    }

    /// Bring a session back to Live around exactly one publishing stream: the
    /// elected feed attaches and synchronizes alone, and only once Live do the
    /// remaining views attach, in the background, so a stalled pane can never
    /// hold up recovery.
    async fn establish_feed(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let lifecycle = &remote.lifecycle;
        // §6.2 gives `view-invalid` the only in-place recovery in the table:
        // the refused pane is marked and the next eligible view takes the feed
        // on the same connection. Election skips failed panes, so each turn of
        // this loop removes one candidate and it cannot spin.
        let (feed_view_id, outcome) = loop {
            let Some(feed_view_id) = lifecycle.elect_feed() else {
                lifecycle.commit_suspended();
                return Ok(());
            };
            match self.attach_view_attempt(remote, &feed_view_id, true).await {
                Ok(outcome) => break (feed_view_id, outcome),
                Err(AttachFailure::Ended(reason)) => return Err(AttachFailure::Ended(reason)),
                Err(AttachFailure::Failed(error)) => {
                    lifecycle.commit_view_failed(&feed_view_id, format!("{error:#}"), true);
                    // The feed could not attach, which is strong evidence this
                    // connection is not usable; retire it so the next attempt
                    // dials rather than reusing it.
                    self.invalidate_connection(&remote.device_id, None).await;
                    return Err(AttachFailure::Failed(error));
                }
                // The host answered coherently — it just answered a question a
                // newer attempt has already asked again. The connection is fine
                // and the pane is not failed, so mark neither.
                Err(AttachFailure::Superseded) => return Err(AttachFailure::Superseded),
                // The identity was refused, not the session and not the
                // transport. Mark this pane and promote the next one in place.
                Err(AttachFailure::ViewInvalid(error)) => {
                    lifecycle.commit_view_failed(&feed_view_id, format!("{error:#}"), true);
                }
                // The connection disposition is already applied; the feed
                // simply has no attachment, so the session waits for the
                // engine rather than being torn down here.
                Err(AttachFailure::Rejected(error)) => {
                    lifecycle.commit_view_failed(&feed_view_id, format!("{error:#}"), true);
                    return Err(AttachFailure::Rejected(error));
                }
            }
        };
        lifecycle.commit_view_attached(&feed_view_id, outcome.attachment_epoch, outcome.read_write);
        remote.replica.set_read_write(outcome.read_write);

        lifecycle.commit_synchronizing();
        if let Err(error) =
            await_first_snapshot(outcome.synchronized, self.synchronize_bound()).await
        {
            return Err(AttachFailure::Failed(
                self.abandon_attempt(remote, error).await,
            ));
        }
        lifecycle.commit_live();
        if self.config().zombie_purge {
            let runtime = self.clone();
            let purged = remote.clone();
            tokio::spawn(async move {
                purge_stranded_attachments(runtime, purged).await;
            });
        }

        let secondaries = lifecycle
            .local_view_ids()
            .into_iter()
            .filter(|local_view_id| local_view_id != &feed_view_id)
            .collect::<Vec<_>>();
        if !secondaries.is_empty() {
            let runtime = self.clone();
            let remote = remote.clone();
            let generation = lifecycle.generation();
            tokio::spawn(async move {
                runtime
                    .attach_secondaries(&remote, secondaries, generation)
                    .await;
            });
        }
        Ok(())
    }

    /// Attach non-feed views. Each is independent: one failing marks only its
    /// own pane, leaving the rest of the session Live.
    async fn attach_secondaries(
        &self,
        remote: &RemoteSession,
        local_view_ids: Vec<String>,
        generation: u64,
    ) {
        let _attempt = remote.lifecycle.attempts.lock().await;
        for local_view_id in local_view_ids {
            // Stop the moment the activation this task belongs to is over.
            if remote.lifecycle.generation() != generation
                || remote.lifecycle.state_kind() != RemoteLifecycleState::Live
            {
                return;
            }
            match self
                .attach_view_attempt(remote, &local_view_id, false)
                .await
            {
                Ok(outcome) => remote.lifecycle.commit_view_attached(
                    &local_view_id,
                    outcome.attachment_epoch,
                    outcome.read_write,
                ),
                Err(AttachFailure::Ended(reason)) => {
                    remote.lifecycle.commit_ended(reason);
                    return;
                }
                Err(AttachFailure::Failed(error)) => {
                    remote
                        .lifecycle
                        .commit_view_failed(&local_view_id, format!("{error:#}"), true)
                }
                // Leave the pane pending rather than failed: the attempt that
                // superseded this one is the one that will resolve it.
                Err(AttachFailure::Superseded) => {}
                // The table's secondary column: the pane fails and the Live
                // session around it is untouched.
                Err(AttachFailure::ViewInvalid(error)) | Err(AttachFailure::Rejected(error)) => {
                    remote
                        .lifecycle
                        .commit_view_failed(&local_view_id, format!("{error:#}"), true)
                }
            }
        }
    }

    /// Tear down one connection and every view riding it, then tell each
    /// affected session the truth.
    async fn fail_connection(&self, device_id: &str, host: &Arc<RemoteHostConnection>) {
        self.invalidate_connection(device_id, Some(host)).await;
        let mut views = self.views.lock().await;
        let doomed = views
            .iter()
            .filter(|(_, view)| view.incarnation == host.incarnation)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let doomed = doomed
            .into_iter()
            .filter_map(|key| views.remove(&key).map(|view| (key.0, view)))
            .collect::<Vec<_>>();
        drop(views);
        let mut affected = Vec::new();
        for (session_id, view) in doomed {
            view.state_cancel.send_replace(true);
            affected.push((session_id, view.state_generation, view.incarnation));
        }
        let disconnected = {
            let replicas = self.replicas.read().await;
            affected
                .into_iter()
                .filter(|(session_id, generation, incarnation)| {
                    replicas.get(session_id).is_some_and(|remote| {
                        remote
                            .lifecycle
                            .commit_disconnect(*generation, *incarnation)
                    })
                })
                .map(|(session_id, _, _)| session_id)
                .collect::<Vec<_>>()
        };
        for session_id in disconnected {
            self.arm_reconnect_for(&session_id).await;
        }
    }

    pub async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()> {
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Input {
                    view_id: wire_view_id,
                    attachment_epoch,
                    input_sequence,
                    operation,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
    }

    pub async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim> {
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        // Session-scoped, deliberately not the view's own control watch: a
        // secondary declines its state stream, so its per-view sender is
        // dropped at attach, and awaiting it would report the channel closed —
        // an error for a claim the host may well have granted. Control is a
        // property of the session, and the feed's stream is what carries it.
        let mut states = self.subscribe_control_state();
        let previous_epoch = self
            .last_control_state(session_id)
            .and_then(|state| state.controller)
            .map_or(0, |controller| controller.control_epoch);
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::FocusAndResize {
                    view_id: wire_view_id,
                    attachment_epoch,
                    cols,
                    rows,
                    client_sequence: 0,
                    // None is legacy last-write-wins; the CAS reclaim belongs
                    // with the controller work, not here.
                    expected_control_revision: None,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                let state = states.recv().await?;
                if state.session_id != session_id {
                    continue;
                }
                let Some(controller) = state.controller else {
                    continue;
                };
                if controller.view_id == view_id && controller.control_epoch > previous_epoch {
                    return Ok(RemoteControlClaim {
                        controller_view_id: controller.view_id,
                        control_epoch: controller.control_epoch,
                        cols: state.cols,
                        rows: state.rows,
                        layout_epoch: state.layout_epoch,
                    });
                }
            }
        })
        .await
        .context("timed out claiming remote terminal control")?
    }

    pub fn subscribe_control_state(&self) -> broadcast::Receiver<RemoteControlState> {
        self.control_state_tx.subscribe()
    }

    pub fn last_control_state(&self, session_id: &str) -> Option<RemoteControlState> {
        self.control_states.lock().unwrap().get(session_id).cloned()
    }

    /// Whether a claim on `session_id` must first wait for the session's opening control frame.
    ///
    /// A streamed view's setup always ends with the controller frame at a reconnect-capable minor,
    /// controller or none (`control_state_message`), so "this client holds a streamed view and has
    /// heard no announcement yet" means that frame is still in flight. Below that minor a session
    /// with no controller announces nothing, and a session this client watches through no streamed
    /// view announces nothing to it, so neither has anything to wait for.
    async fn awaits_opening_control_frame(&self, session_id: &str) -> bool {
        if self.last_control_state(session_id).is_some() {
            return false;
        }
        let Some(device_id) = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| remote.device_id.clone())
        else {
            return false;
        };
        let reconnect = self
            .connections
            .lock()
            .await
            .get(&device_id)
            .is_some_and(|connection| connection.supports_reconnect());
        reconnect
            && self
                .views
                .lock()
                .await
                .iter()
                .any(|((view_session, _), view)| view_session == session_id && view.feed)
    }

    /// Claim control, compare-and-swapping against an observed revision when
    /// one is supplied. `None` is legacy last-write-wins.
    pub async fn claim_control_at(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        expected_control_revision: Option<u64>,
    ) -> Result<RemoteControlOutcome> {
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        // Session-scoped for the same reason as the claim above: a secondary
        // has no per-view control sender to await once it declines its stream.
        let mut states = self.subscribe_control_state();
        // 2026-10-26: the claim settles on the first announcement after its
        // request, and the request carries nothing the host echoes back. A
        // session's opening control frame still in flight would be that first
        // announcement, naming whoever held control before, and the claim would
        // read it as its own refusal. So wait for it before asking, bounded; past
        // the bound, claim as before. The window that remains is a concurrent
        // foreign claim whose announcement races this one. The exact fix is for
        // the host to echo the request's `client_sequence` in the announcement it
        // causes: a control-protocol minor, worth building only once that window
        // is measured.
        if self.awaits_opening_control_frame(session_id).await {
            let _ = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
                while self.last_control_state(session_id).is_none() {
                    if let Err(broadcast::error::RecvError::Closed) = states.recv().await {
                        break;
                    }
                }
            })
            .await;
        }
        let previous_epoch = self
            .last_control_state(session_id)
            .and_then(|state| state.controller)
            .map_or(0, |controller| controller.control_epoch);
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::FocusAndResize {
                    view_id: wire_view_id,
                    attachment_epoch,
                    cols,
                    rows,
                    client_sequence: 0,
                    expected_control_revision,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;

        // The first controller announcement for this session after the request
        // settles it: either it names this view at a newer epoch, or the swap
        // lost, to another holder or to a clear. There is nothing further to
        // wait for.
        let settled = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                let state = states.recv().await?;
                if state.session_id == session_id {
                    return Ok::<RemoteControlState, anyhow::Error>(state);
                }
            }
        })
        .await
        .context("timed out claiming remote terminal control")??;
        let claimed = settled.controller.as_ref().is_some_and(|controller| {
            controller.view_id == view_id && controller.control_epoch > previous_epoch
        });

        let announced = self.last_control_state(session_id).unwrap_or(settled);
        if claimed {
            return Ok(RemoteControlOutcome::Claimed(announced));
        }
        // Announce the losing outcome ourselves rather than leaving the retry
        // rule waiting on the host's frame to race in: a lost or oddly ordered
        // announcement would otherwise kill the reclaim silently. Duplicates at
        // one revision are expected; consumers are idempotent by revision.
        publish_control_state(
            &self.control_states,
            &self.control_state_tx,
            announced.clone(),
        );
        Ok(RemoteControlOutcome::Rejected(announced))
    }

    pub async fn resize(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteResize,
    ) -> Result<()> {
        let RemoteResize {
            attachment_epoch,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        } = request;
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Resize {
                    view_id: wire_view_id,
                    attachment_epoch,
                    control_epoch,
                    resize_sequence,
                    cols,
                    rows,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
    }

    pub async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        let view = self
            .remote_view(session_id, view_id, request.attachment_epoch)
            .await?;
        let request_id = Uuid::new_v4().to_string();
        let wire_view_id = view.wire_view_id.clone();
        let mut control = view.session_control.lock().await;
        control
            .write_message(
                &SessionControlMessage::SelectionText {
                    request_id: request_id.clone(),
                    view_id: wire_view_id,
                    attachment_epoch: request.attachment_epoch,
                    start_column: request.start_column,
                    start_row: request.start_row,
                    end_column: request.end_column,
                    end_row: request.end_row,
                    select_all: request.select_all,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        match control
            .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
            .context("remote terminal closed before returning selection text")?
        {
            SessionControlMessage::SelectionTextResult {
                request_id: response_id,
                text,
            } if response_id == request_id => Ok(text),
            _ => bail!("remote terminal returned an invalid selection response"),
        }
    }

    pub async fn refresh(&self, session_id: &str) -> Result<()> {
        let replica = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|session| Arc::clone(&session.replica))
            .context("unknown remote session")?;
        replica.refresh()
    }

    /// A true remote refresh: a generation-advanced re-attach of the feed,
    /// which is what guarantees a fresh stream, a full snapshot, and reset
    /// sequencing. `RequestSnapshot` would instead spawn a *second* persistent
    /// state stream on QUIC, leaving two feeds racing independent patch
    /// sequences into the one replica.
    pub async fn refresh_remote(&self, session_id: &str) -> Result<()> {
        let remote = self.remote_session(session_id).await?;
        if remote.lifecycle.state_kind() != RemoteLifecycleState::Live {
            bail!("remote terminal session is not live");
        }
        self.reestablish_feed(&remote)
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        let key = (session_id.to_owned(), view_id.to_owned());
        // A view whose connection already died is gone from the map but still
        // recorded on the lifecycle. The bookkeeping below has to run either
        // way, or detaching a dead pane would leave the session dialing for it
        // forever.
        if let Some(view) = self.views.lock().await.remove(&key) {
            // Retire before telling the host: it closes this view's state
            // stream in response, and that EOF must already read as deliberate.
            view.state_cancel.send_replace(true);
            if view.attachment_epoch == attachment_epoch {
                let wire_view_id = view.wire_view_id.clone();
                let _ = view
                    .session_control
                    .lock()
                    .await
                    .write_message(
                        &SessionControlMessage::Detach {
                            view_id: wire_view_id,
                            attachment_epoch,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await;
            }
        }
        let remote = self.replicas.read().await.get(session_id).cloned();
        let Some(remote) = remote else {
            return;
        };
        // An explicit detach retires the view for good: leaving a record
        // behind would have a later resume re-attach a pane the user closed.
        remote.lifecycle.commit_view_pending(view_id);
        remote.lifecycle.forget_view(view_id);
        let promote = remote.lifecycle.release_feed(view_id);
        if remote.lifecycle.local_view_ids().is_empty() {
            // Nothing is left to resume, so stop dialing for it.
            remote.lifecycle.cancel_engine();
            return;
        }
        if !promote || remote.lifecycle.is_ended() {
            return;
        }
        // The replica just lost its feed while other panes are still showing
        // this session. Promotion is a generation-advanced re-attach, not an
        // in-place stream switch: attach semantics are what guarantee the
        // survivor a fresh stream, a full snapshot, and reset sequencing.
        if let Err(failure) = self.reestablish_feed(&remote).await {
            match failure {
                AttachFailure::Ended(reason) => remote.lifecycle.commit_ended(reason),
                AttachFailure::Failed(error) => {
                    eprintln!("[terminal-mesh] feed promotion failed: {error:#}");
                    remote.lifecycle.commit_suspended();
                }
                // Suspending here would park a session another attempt is
                // actively bringing back.
                AttachFailure::Superseded => {}
                AttachFailure::ViewInvalid(error) | AttachFailure::Rejected(error) => {
                    eprintln!("[terminal-mesh] feed promotion found no usable view: {error:#}");
                }
            }
        }
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let lifecycle = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| Arc::clone(&remote.lifecycle));
        // End the session before detaching: these detaches are teardown, not
        // pane closures, and must not each promote a new feed on the way out.
        if let Some(lifecycle) = lifecycle {
            lifecycle.cancel_engine();
            lifecycle.commit_ended(RemoteEndedReason::ClosedLocally);
        }
        let views = self
            .views
            .lock()
            .await
            .iter()
            .filter(|((candidate, _), _)| candidate == session_id)
            .map(|((_, view_id), view)| (view_id.clone(), view.attachment_epoch))
            .collect::<Vec<_>>();
        for (view_id, epoch) in views {
            self.detach_view(session_id, &view_id, epoch).await;
        }
        self.replicas.write().await.remove(session_id).is_some()
    }

    pub async fn transfer_owner(
        &self,
        session_id: &str,
        expected_owner_id: &str,
        owner_id: &str,
    ) -> bool {
        let remote = self.replicas.read().await.get(session_id).cloned();
        remote.is_some_and(|remote| remote.replica.transfer_owner(expected_owner_id, owner_id))
    }

    pub async fn session_lifecycle(&self, session_id: &str) -> Option<RemoteSessionLifecycle> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| remote.lifecycle.snapshot())
    }

    /// The authoritative attachment lookup. Callers consult this at use time
    /// rather than caching an epoch, so a dead view re-dials instead of
    /// answering with an epoch its connection no longer honours.
    pub async fn current_attachment(&self, session_id: &str, view_id: &str) -> Option<(u64, bool)> {
        self.replicas
            .read()
            .await
            .get(session_id)?
            .lifecycle
            .current_attachment(view_id)
    }

    /// Answer a selection from the retained replica viewport, for use while
    /// the session is not live. Authorization is the caller's ownership
    /// record, not a live attachment epoch, so the field is ignored here.
    pub async fn offline_selection_text(
        &self,
        session_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        let remote = self.remote_session(session_id).await?;
        remote.replica.viewport_selection_text(
            request.start_column,
            request.start_row,
            request.end_column,
            request.end_row,
            request.select_all,
        )
    }

    async fn remote_view(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
    ) -> Result<Arc<RemoteView>> {
        let view = self
            .views
            .lock()
            .await
            .get(&(session_id.to_owned(), view_id.to_owned()))
            .cloned()
            .context("remote view is not attached")?;
        if view.attachment_epoch != attachment_epoch {
            bail!("stale remote view attachment");
        }
        // A view can be attached while the session is still synchronizing.
        // Rejecting here — rather than queueing — is the whole point: a
        // keystroke delivered after recovery would act on a screen the user
        // never saw.
        if let Some(remote) = self.replicas.read().await.get(session_id)
            && remote.lifecycle.state_kind() != RemoteLifecycleState::Live
        {
            bail!("remote terminal session is not live");
        }
        Ok(view)
    }

    async fn remote_connection(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>> {
        let transport = self.transport().await?;
        let advertised = transport.host_instance_id(device_id).await?;
        if let Some(reusable) = self.reusable_connection(device_id, &advertised).await {
            return Ok(reusable);
        }
        // Dial off the lock. A connect can take the full CONNECT_TIMEOUT, and
        // holding the cache across it stalls every other caller — including
        // the ones that would have been served from cache.
        let remote = transport.dial(device_id).await?;
        let mut connections = self.connections.lock().await;
        // Someone may have dialed while we were: prefer whichever connection
        // is already published so callers converge on one, and close ours.
        if let Some(existing) = connections.get(device_id)
            && connection_is_reusable(
                &existing.host_instance_id,
                existing.healthy.load(Ordering::Acquire),
                &advertised,
            )
        {
            let existing = Arc::clone(existing);
            drop(connections);
            remote.connection.close();
            return Ok(existing);
        }
        if let Some(stale) = connections.insert(device_id.to_owned(), Arc::clone(&remote)) {
            stale.healthy.store(false, Ordering::Release);
            stale.connection.close();
        }
        drop(connections);
        // Only the connection that was published gets a heartbeat: the loser
        // of a dial race is closed above, and probing it would be probing
        // something nothing is riding.
        if remote.supports_reconnect() {
            tokio::spawn(heartbeat_loop(
                self.clone(),
                device_id.to_owned(),
                Arc::clone(&remote),
            ));
        }
        Ok(remote)
    }

    async fn reusable_connection(
        &self,
        device_id: &str,
        advertised: &str,
    ) -> Option<Arc<RemoteHostConnection>> {
        let mut connections = self.connections.lock().await;
        let connection = connections.get(device_id)?;
        if connection_is_reusable(
            &connection.host_instance_id,
            connection.healthy.load(Ordering::Acquire),
            advertised,
        ) {
            return Some(Arc::clone(connection));
        }
        let stale = connections.remove(device_id)?;
        stale.connection.close();
        None
    }

    /// The freshest contact anything on this connection has had, or `None` if
    /// nothing on it is in a position to hear from the host. One live session
    /// hearing from the host vouches for the connection they share.
    async fn quietest_contact(&self, host: &Arc<RemoteHostConnection>) -> Option<Duration> {
        self.replicas
            .read()
            .await
            .values()
            .filter_map(|remote| remote.lifecycle.contact_age(host.incarnation))
            .min()
    }

    async fn note_contact(&self, host: &Arc<RemoteHostConnection>) {
        for remote in self.replicas.read().await.values() {
            remote.lifecycle.note_contact(host.incarnation);
        }
    }

    async fn commit_host_shutdown(&self, host: &Arc<RemoteHostConnection>) {
        let sessions = self
            .replicas
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for remote in sessions {
            remote.lifecycle.commit_host_shutdown(host.incarnation);
        }
    }

    /// Retire a connection the moment an operation on it fails. Without this a
    /// dial that succeeds and then breaks stays cached and healthy forever,
    /// and every later caller — including ones that should have dialed fresh —
    /// is handed the corpse.
    async fn note_connection_failure(&self, device_id: &str, host: &Arc<RemoteHostConnection>) {
        host.healthy.store(false, Ordering::Release);
        self.invalidate_connection(device_id, Some(host)).await;
    }

    async fn has_sessions_on(&self, device_id: &str) -> bool {
        self.replicas.read().await.values().any(|remote| {
            remote.device_id == device_id
                && !matches!(
                    remote.lifecycle.state_kind(),
                    RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
                )
        })
    }

    async fn devices_with_live_sessions(&self) -> Vec<String> {
        let mut devices = self
            .replicas
            .read()
            .await
            .values()
            .filter(|remote| {
                !matches!(
                    remote.lifecycle.state_kind(),
                    RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
                )
            })
            .map(|remote| remote.device_id.clone())
            .collect::<Vec<_>>();
        devices.sort();
        devices.dedup();
        devices
    }

    /// Devices carrying live sessions whose advertisement has lapsed. No
    /// discovery event reports this: a host process can stall while its device
    /// stays online, so nothing is republished and nothing is removed — the
    /// advertisement simply ages out against the wall clock.
    async fn lapsed_advertisement_devices(&self) -> Vec<String> {
        let Ok(transport) = self.transport().await else {
            return Vec::new();
        };
        let mut lapsed = Vec::new();
        for device_id in self.devices_with_live_sessions().await {
            if transport.host_instance_id(&device_id).await.is_err() {
                lapsed.push(device_id);
            }
        }
        lapsed
    }

    async fn probe_lapsed_advertisements(&self) {
        for device_id in self.lapsed_advertisement_devices().await {
            if let Err(error) = self.probe_connection(&device_id).await {
                eprintln!("[terminal-mesh] liveness probe of {device_id} failed: {error:#}");
            }
        }
    }

    async fn transport(&self) -> Result<Arc<dyn HostTransport>> {
        self.transport
            .read()
            .await
            .clone()
            .context("Truffle terminal networking is disabled or still starting")
    }

    pub fn set_reconnect_config(&self, config: MeshReconnectConfig) {
        *self.config.lock().unwrap() = config;
    }

    fn config(&self) -> MeshReconnectConfig {
        *self.config.lock().unwrap()
    }

    fn jitter(&self) -> JitterSource {
        Arc::clone(&self.jitter.lock().unwrap())
    }

    #[cfg(test)]
    fn set_jitter(&self, jitter: JitterSource) {
        *self.jitter.lock().unwrap() = jitter;
    }

    fn synchronize_bound(&self) -> Duration {
        self.config().synchronize_timeout
    }

    /// Tell any session waiting out a backoff on this device that it is worth
    /// dialing now. Discovery is a hint, so this only ever shortens a wait.
    pub fn note_device_available(&self, device_id: &str) {
        let _ = self.wakeup_tx.send(device_id.to_owned());
    }

    #[cfg(test)]
    async fn install_transport(&self, transport: Arc<dyn HostTransport>) {
        *self.transport.write().await = Some(transport);
    }

    #[cfg(test)]
    fn set_synchronize_timeout(&self, bound: Duration) {
        let mut config = self.config.lock().unwrap();
        config.synchronize_timeout = bound;
    }

    async fn invalidate_connection(
        &self,
        device_id: &str,
        expected: Option<&Arc<RemoteHostConnection>>,
    ) {
        let mut connections = self.connections.lock().await;
        let should_remove = connections
            .get(device_id)
            .is_some_and(|current| expected.is_none_or(|expected| Arc::ptr_eq(current, expected)));
        if should_remove && let Some(connection) = connections.remove(device_id) {
            connection.healthy.store(false, Ordering::Release);
            connection.connection.close();
        }
    }

    async fn ready(&self) -> Result<MeshReady> {
        self.ready
            .read()
            .await
            .clone()
            .context("Truffle terminal networking is disabled or still starting")
    }
}

struct QuicHostTransport {
    ready: MeshReady,
}

#[async_trait]
impl HostTransport for QuicHostTransport {
    fn capability(&self) -> Option<String> {
        self.ready.capability.clone()
    }

    async fn device_name(&self, device_id: &str) -> Option<String> {
        self.ready
            .node
            .peers()
            .await
            .into_iter()
            .find(|peer| peer.device_id.as_deref() == Some(device_id))
            .map(|peer| peer.display_name)
    }

    async fn peer_is_online(&self, device_id: &str) -> bool {
        self.ready
            .node
            .peers()
            .await
            .into_iter()
            .any(|peer| peer.device_id.as_deref() == Some(device_id) && peer.online)
    }

    async fn host_instance_id(&self, device_id: &str) -> Result<String> {
        Ok(validated_advertisement(&self.ready, device_id)
            .await?
            .host_instance_id)
    }

    async fn dial(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>> {
        let advertisement = validated_advertisement(&self.ready, device_id).await?;
        let connection = Arc::new(
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                self.ready
                    .node
                    .connect_quic(device_id, advertisement.quic_port),
            )
            .await
            .context("timed out connecting to remote terminal host")?
            .context("connect to remote terminal host")?,
        );
        let connection: Arc<dyn MeshConnection> = connection;
        match client_handshake(
            Arc::clone(&connection),
            &self.ready.node.local_info().device_id,
            &self.ready.host_instance_id,
            &advertisement.host_instance_id,
            PROTOCOL_MINOR,
        )
        .await
        {
            Ok(remote) => Ok(remote),
            Err(error) => {
                // Close what we opened. A handshake that times out against an
                // unresponsive host would otherwise leave a half-open
                // connection behind on every attempt, and a retry loop makes
                // that dozens of them.
                connection.close();
                Err(error)
            }
        }
    }
}

/// The viewer half of the connection handshake, up to a usable control stream.
async fn client_handshake(
    connection: Arc<dyn MeshConnection>,
    local_device_id: &str,
    local_host_instance_id: &str,
    expected_host_instance_id: &str,
    offered_minor: u16,
) -> Result<Arc<RemoteHostConnection>> {
    let mut control = ProtocolStream::new(connection.open_stream().await?);
    control
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::ConnectionControl,
            session_id: None,
            view_id: None,
        })
        .await?;
    let nonce = Uuid::new_v4().to_string();
    control
        .write_message(
            &ConnectionMessage::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: offered_minor,
                host_instance_id: local_host_instance_id.to_owned(),
                local_device_id: local_device_id.to_owned(),
                nonce: nonce.clone(),
                state_codecs: Some(vec![StateCodec::CompactJsonV1]),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let (state_codec, protocol_minor) = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out waiting for remote terminal handshake")??
    .context("remote host closed during handshake")?
    {
        ConnectionMessage::ServerHello {
            protocol_major,
            protocol_minor,
            host_instance_id,
            nonce: echoed_nonce,
            state_codec,
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor > 0
            && echoed_nonce == nonce
            && host_instance_id == expected_host_instance_id
            && state_codec.is_none_or(|codec| codec == StateCodec::CompactJsonV1) =>
        {
            (
                state_codec.unwrap_or(StateCodec::Json),
                protocol_minor.min(offered_minor),
            )
        }
        _ => bail!("remote host returned an invalid server hello"),
    };
    Ok(Arc::new(RemoteHostConnection {
        connection,
        control: tokio::sync::Mutex::new(control),
        incoming: tokio::sync::Mutex::new(()),
        host_instance_id: expected_host_instance_id.to_owned(),
        state_codec,
        healthy: AtomicBool::new(true),
        incarnation: NEXT_CONNECTION_INCARNATION.fetch_add(1, Ordering::Relaxed),
        protocol_minor,
    }))
}

async fn validated_advertisement(
    ready: &MeshReady,
    device_id: &str,
) -> Result<TerminalHostAdvertisement> {
    let advertisement = ready
        .store
        .get(device_id)
        .await
        .context("terminal host is not advertised")?
        .data;
    if advertisement.expires_at_ms < now_ms() {
        bail!("terminal host advertisement has expired");
    }
    if advertisement.protocol_major != PROTOCOL_MAJOR {
        bail!("remote terminal protocol major is incompatible");
    }
    if advertisement.protocol_minor == 0 {
        bail!("remote terminal protocol minor is invalid");
    }
    Ok(advertisement)
}

#[derive(Clone, Debug)]
/// Terminal-specific routing and authorization layered on a shared Truffle
/// node. Application identity, node state, and sidecar configuration belong to
/// the embedding host instead.
pub struct TruffleTerminalConfig {
    pub service_name: String,
    pub quic_port: u16,
    pub compact_port: u16,
    pub capability: Option<String>,
    pub allow_tailnet_write: bool,
    pub reconnect: MeshReconnectConfig,
}

impl Default for TruffleTerminalConfig {
    fn default() -> Self {
        Self {
            service_name: "terminal.v1".to_owned(),
            quic_port: DEFAULT_QUIC_PORT,
            compact_port: DEFAULT_COMPACT_PORT,
            capability: None,
            allow_tailnet_write: false,
            reconnect: MeshReconnectConfig::default(),
        }
    }
}

impl TruffleTerminalConfig {
    fn validate(&self) -> Result<()> {
        if self.service_name.trim().is_empty() {
            bail!("Truffle terminal service name must not be empty");
        }
        if self.quic_port == 0 {
            bail!("Truffle terminal QUIC port must be nonzero");
        }
        if self.compact_port == 0 {
            bail!("Truffle terminal compact-stream port must be nonzero");
        }
        if self.compact_port == self.quic_port {
            bail!("Truffle terminal QUIC and compact-stream ports must differ");
        }
        Ok(())
    }

    fn access_for(&self, supplied: Option<&str>) -> ViewAccess {
        if self.allow_tailnet_write {
            return ViewAccess::ReadWrite;
        }
        let Some(expected) = self.capability.as_deref() else {
            return ViewAccess::ReadOnly;
        };
        let Some(supplied) = supplied else {
            return ViewAccess::ReadOnly;
        };
        if expected.len() == supplied.len()
            && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
        {
            ViewAccess::ReadWrite
        } else {
            ViewAccess::ReadOnly
        }
    }

    fn advertises_write(&self) -> bool {
        self.allow_tailnet_write || self.capability.is_some()
    }
}

/// A terminal transport adapter that borrows a host-owned Truffle node by
/// `Arc`. Its discovery store and QUIC listener are scoped to this terminal
/// service, while the node and sidecar remain shared with the host.
pub struct TruffleTerminalMesh {
    node: Arc<Node<TailscaleProvider>>,
    config: TruffleTerminalConfig,
    runtime: MeshRuntime,
    connections: ConnectionLedger,
    services: HostServices,
}

impl TruffleTerminalMesh {
    pub fn new(node: Arc<Node<TailscaleProvider>>, config: TruffleTerminalConfig) -> Result<Self> {
        config.validate()?;
        let runtime = MeshRuntime::new();
        runtime.set_reconnect_config(config.reconnect);
        Ok(Self {
            node,
            config,
            runtime,
            connections: ConnectionLedger::default(),
            services: HostServices::default(),
        })
    }

    /// The lookup this host answers session-status requests from. Set before
    /// `serve`. Only the host half needs it: a resuming viewer asks the host
    /// that owns the session over the wire, never a source of its own.
    pub fn set_session_status_source(&mut self, source: Arc<dyn SessionStatusSource>) {
        self.services.session_status = Some(source);
    }

    /// Cloneable and safe to keep after `serve` has taken the mesh, which is
    /// the whole point: a drain announces long after that.
    pub fn shutdown_announcer(&self) -> HostShutdownAnnouncer {
        self.services.shutdown.clone()
    }

    pub fn runtime(&self) -> MeshRuntime {
        self.runtime.clone()
    }

    /// Every connection this host has accepted, and which of them are fully
    /// terminated. Both listeners number their connections from it.
    pub fn connections(&self) -> ConnectionLedger {
        self.connections.clone()
    }

    pub async fn serve(self, registry: Registry, host_config: HostConfigReceiver) -> Result<()> {
        let Self {
            node,
            config,
            runtime,
            connections,
            services,
        } = self;
        let host_instance_id = Uuid::new_v4().to_string();
        let listener = Arc::new(
            node.listen_quic(config.quic_port)
                .await
                .context("listen for terminal QUIC connections")?,
        );
        let compact_listener = node
            .listen_tcp(config.compact_port)
            .await
            .context("listen for Apple terminal compact-stream connections")?;
        let store_id = format!("{}.hosts", config.service_name);
        let store_namespace = format!("ss:{store_id}");
        // Profiles keep a stable Truffle device ID, so persist the local store
        // version with it. Otherwise a restarted ghosttead begins again at
        // version 1 and a still-running peer rejects its advertisements as older
        // than the previous process's slice.
        let store = node.synced_store_with_backend::<TerminalHostAdvertisement>(
            &store_id,
            Arc::new(truffle::FileBackend::new(
                node.state_dir().join("synced-store"),
            )),
        );
        let ready = MeshReady {
            node: Arc::clone(&node),
            store: Arc::clone(&store),
            host_instance_id: host_instance_id.clone(),
            capability: config.capability.clone(),
        };
        *runtime.ready.write().await = Some(ready.clone());
        *runtime.transport.write().await = Some(Arc::new(QuicHostTransport { ready }));
        let probes = tokio::spawn(probe_trigger_loop(
            runtime.clone(),
            Arc::clone(&node),
            Arc::clone(&store),
        ));
        eprintln!(
            "[terminal-mesh] ready as {} on QUIC port {} and compact-stream port {}",
            node.local_info().device_name,
            listener.port(),
            compact_listener.port
        );

        let advertise = advertise_loop(
            Arc::clone(&node),
            Arc::clone(&store),
            registry.clone(),
            config.clone(),
            host_instance_id.clone(),
            store_namespace,
        );
        let accept = accept_loop(
            Arc::clone(&node),
            Arc::clone(&listener),
            registry.clone(),
            config.clone(),
            services.clone(),
            host_instance_id.clone(),
            host_config.clone(),
            connections.clone(),
        );
        let compact_accept = compact_accept_loop(
            Arc::clone(&node),
            compact_listener,
            registry,
            config.clone(),
            services,
            host_instance_id,
            host_config,
            connections,
        );
        let result = tokio::select! {
            result = advertise => result,
            result = accept => result,
            result = compact_accept => result,
        };
        probes.abort();
        if let Err(error) = node.unlisten_tcp(config.compact_port).await {
            eprintln!("[terminal-mesh] compact-stream listener cleanup failed: {error}");
        }
        runtime.connections.lock().await.clear();
        *runtime.transport.write().await = None;
        *runtime.ready.write().await = None;
        result
    }
}

/// Discovery is a hint, never a verdict. A peer going offline or an
/// advertisement expiring only fires a liveness probe on the cached
/// connection; nothing is torn down unless that probe fails.
async fn probe_trigger_loop(
    runtime: MeshRuntime,
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
) {
    let mut peers = node.on_peer_change();
    let mut advertisements = store.subscribe();
    let mut expiry = tokio::time::interval(ADVERTISEMENT_INTERVAL);
    expiry.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let device_id = tokio::select! {
            event = peers.recv() => match event {
                Ok(event) => {
                    if let Some(device_id) = peer_wakeup_candidate(&event) {
                        runtime.note_device_available(&device_id);
                    }
                    peer_probe_candidate(&event)
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            event = advertisements.recv() => match event {
                Ok(event) => {
                    let now = now_ms();
                    if let Some(device_id) = advertisement_wakeup_candidate(&event, now) {
                        runtime.note_device_available(&device_id);
                    }
                    advertisement_probe_candidate(&event, now)
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = expiry.tick() => {
                runtime.probe_lapsed_advertisements().await;
                continue;
            },
        };
        let Some(device_id) = device_id else {
            continue;
        };
        if !runtime.has_sessions_on(&device_id).await {
            continue;
        }
        if let Err(error) = runtime.probe_connection(&device_id).await {
            eprintln!("[terminal-mesh] liveness probe of {device_id} failed: {error:#}");
        }
    }
}

async fn advertise_loop(
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    store_namespace: String,
) -> Result<()> {
    let mut interval = tokio::time::interval(ADVERTISEMENT_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let now = now_ms();
        let sessions = registry
            .read()
            .unwrap()
            .values()
            .map(|session| {
                let summary = session.summary();
                SharedSessionSummary {
                    session_id: summary.id,
                    title: summary.title.unwrap_or_else(|| summary.executable.clone()),
                    cwd_label: summary.cwd,
                    running: !summary.exited,
                    // A concluded session is gone as far as attaching goes.
                    // Exited-but-not-concluded still is: the viewer resumes it
                    // and shows the final screen, so exitedness belongs in
                    // `running`, not here.
                    attachable: !session.has_concluded(),
                    read_write: config.advertises_write(),
                    created_at_ms: session.created_at_ms(),
                    activity: summary.activity,
                }
            })
            .collect();
        store
            .set(TerminalHostAdvertisement {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                quic_port: config.quic_port,
                host_instance_id: host_instance_id.clone(),
                published_at_ms: now,
                expires_at_ms: now.saturating_add(ADVERTISEMENT_TTL.as_millis() as u64),
                sessions,
            })
            .await;

        // SyncedStore subscribes after Node startup. With durable Truffle
        // profiles, peer discovery can therefore finish before the store's
        // peer-event receiver exists, causing it to miss the one-time Joined
        // event that normally performs the initial full sync. A broadcast
        // alone cannot recover because it only targets message channels that
        // are already connected. Targeted requests both establish that
        // channel lazily and ask every known same-app peer for its latest
        // slice, making discovery converge after either side restarts.
        request_advertisements_from_online_peers(&node, &store_namespace).await;
    }
}

async fn request_advertisements_from_online_peers(
    node: &Node<TailscaleProvider>,
    store_namespace: &str,
) {
    let local_device_id = node.local_info().device_id;
    let request = truffle::SyncMessage::Request {};
    let Ok(payload) = serde_json::to_value(&request) else {
        return;
    };
    for peer in node.peers().await {
        let Some(device_id) = peer.device_id else {
            continue;
        };
        if !peer.online || device_id == local_device_id {
            continue;
        }
        if let Err(cause) = node
            .send_typed(&device_id, store_namespace, "request", &payload)
            .await
        {
            eprintln!(
                "[terminal-mesh] could not request advertisement from {}: {cause}",
                peer.display_name
            );
        }
    }
}

/// Serve the compact protocol over an already-bound TCP listener, so a client
/// in another language can be driven against the real host off a tailnet.
///
/// **What this is not.** [`handle_compact_connection`] resolves the peer through
/// Tailscale WhoIs and checks the result against the node's live peer list, and
/// that cannot run without a tailnet. This skips exactly that prologue and
/// nothing else: `client_id` stands in for the WhoIs result, and every
/// connection is attributed to it. From the client hello onward — negotiation,
/// preface routing, attach, both multiplexed channels, the session control loop
/// — a caller reaches the same code the tailnet listener reaches, by the same
/// path, over a real socket. So a run built on this proves the protocol and the
/// serve loop against a foreign client, and proves nothing about identity
/// binding, which stays covered only by the tailnet e2e.
///
/// Feature-gated: a compact endpoint that serves whoever connects, with the
/// identity check standing in rather than performed, is not something a
/// production build should be able to reach by accident.
/// `host_config` is supplied by the caller rather than made here, and that is
/// load-bearing rather than stylistic. A serve loop dropped at shutdown takes
/// everything it owns with it, and a connection handler reads a closed
/// configuration publisher as a fault and hangs up — so a publisher owned here
/// would cut every live connection the instant this future is dropped, before
/// the drain could announce itself, turning a clean goodbye into what a viewer
/// can only read as an outage. The caller keeps it alive across its own
/// shutdown path.
#[cfg(feature = "interop-fixture")]
pub async fn serve_compact_loopback(
    listener: tokio::net::TcpListener,
    registry: Registry,
    config: TruffleTerminalConfig,
    expected_device_id: String,
    client_id: String,
    shutdown: HostShutdownAnnouncer,
    host_config: tokio::sync::watch::Receiver<Arc<TerminalPresentationConfig>>,
) -> Result<()> {
    let services = HostServices {
        session_status: None,
        shutdown,
    };
    loop {
        let (stream, _) = listener.accept().await?;
        // Same invariant as both production accept loops: the id is the
        // connection's place in the accept order, so it is taken here and
        // nowhere later. Identified immediately, because off a tailnet there is
        // no hello-time resolution left to wait for.
        let scope = services_scope(&client_id);
        let registry = registry.clone();
        let config = config.clone();
        let services = services.clone();
        let expected_device_id = expected_device_id.clone();
        let client_id = client_id.clone();
        let host_config = host_config.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_compact_protocol(
                stream,
                registry,
                config,
                services,
                "compact-interop-host".to_owned(),
                Some(expected_device_id),
                client_id,
                host_config,
                scope,
            )
            .await
            {
                eprintln!("[compact-interop] connection ended: {error:#}");
            }
        });
    }
}

/// One ledger for the fixture's lifetime, so connection ids order across every
/// connection a client opens — which is what the attach fence reads.
#[cfg(feature = "interop-fixture")]
fn services_scope(client_id: &str) -> ConnectionScope {
    static LEDGER: std::sync::OnceLock<ConnectionLedger> = std::sync::OnceLock::new();
    let scope = LEDGER.get_or_init(ConnectionLedger::default).accept();
    scope.identify(client_id);
    scope
}

#[allow(clippy::too_many_arguments)]
async fn compact_accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    mut listener: truffle::transport::RawListener,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    host_config: HostConfigReceiver,
    connections: ConnectionLedger,
) -> Result<()> {
    while let Some(incoming) = listener.accept().await {
        // Same invariant as the QUIC loop: the id is the connection's place in
        // the accept order, so it is taken here and nowhere later.
        let scope = connections.accept();
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let services = services.clone();
        let host_instance_id = host_instance_id.clone();
        let host_config = host_config.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_compact_connection(
                node,
                incoming,
                registry,
                config,
                services,
                host_instance_id,
                host_config,
                scope,
            )
            .await
            {
                eprintln!("[terminal-mesh] rejected compact-stream connection: {error:#}");
            }
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_compact_connection(
    node: Arc<Node<TailscaleProvider>>,
    incoming: truffle::transport::RawIncoming,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    host_config: HostConfigReceiver,
    scope: ConnectionScope,
) -> Result<()> {
    let authenticated_node_id = incoming
        .remote_identity
        .as_ref()
        .and_then(|identity| identity.node_id.as_deref())
        .context("compact-stream source lacks a Tailscale WhoIs stable node ID")?;
    let peer = node
        .peers()
        .await
        .into_iter()
        .find(|peer| peer.tailscale_id == authenticated_node_id)
        .context("compact-stream source is not a current Truffle peer")?;
    let client_id = format!("truffle:{}", peer.peer_ref);
    scope.identify(&client_id);
    handle_compact_protocol(
        incoming.stream,
        registry,
        config,
        services,
        host_instance_id,
        peer.device_id,
        client_id,
        host_config,
        scope,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn handle_compact_protocol<S>(
    stream: S,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    expected_device_id: Option<String>,
    client_id: String,
    host_config: HostConfigReceiver,
    scope: ConnectionScope,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut control = CompactProtocolStream::new(stream);
    let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, control.read_preface())
        .await
        .context("timed out reading compact-stream preface")??;
    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading compact-stream client hello")??
    .context("compact stream closed before client hello")?;
    let (client_nonce, state_codec, protocol_minor) = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            state_codecs,
            ..
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor > 0
            && !local_device_id.trim().is_empty()
            && expected_device_id
                .as_deref()
                .is_none_or(|expected| expected == local_device_id) =>
        {
            (
                nonce,
                negotiate_state_codec(state_codecs),
                protocol_minor.min(PROTOCOL_MINOR),
            )
        }
        ConnectionMessage::ClientHello { .. } => {
            bail!("compact-stream client hello identity or protocol mismatch")
        }
        _ => bail!("expected compact-stream client hello"),
    };
    control
        .write_message(
            &ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                // What was negotiated, not what this host could manage alone:
                // a client that offered less must not be told it got more.
                protocol_minor,
                host_instance_id,
                nonce: client_nonce,
                state_codec: (state_codec != StateCodec::Json).then_some(state_codec),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    match preface.stream_kind {
        StreamKind::ConnectionControl => {
            while let Some(message) = control
                .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
                .await?
            {
                match message {
                    ConnectionMessage::ListSessions { request_id } => {
                        control
                            .write_message(
                                &ConnectionMessage::Sessions {
                                    request_id,
                                    sessions: shared_sessions(&registry, &config),
                                },
                                MAX_CONTROL_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                    ConnectionMessage::SessionStatus {
                        request_id,
                        session_id,
                    } => {
                        let status = session_status_for(&services, &session_id);
                        control
                            .write_message(
                                &ConnectionMessage::SessionStatusResult { request_id, status },
                                MAX_CONTROL_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                    _ => {
                        control
                            .write_message(
                                &ConnectionMessage::Error {
                                    request_id: None,
                                    code: "unexpected-message".into(),
                                    message:
                                        "message is not valid on the connection control stream"
                                            .into(),
                                },
                                MAX_CONTROL_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                }
            }
        }
        StreamKind::SessionControl => {
            handle_compact_session_protocol(
                &mut control,
                preface,
                IncomingSessionContext {
                    registry,
                    config,
                    services: services.clone(),
                    client_id,
                    state_codec,
                    protocol_minor,
                    host_config,
                    connection: scope,
                },
            )
            .await?;
        }
        _ => bail!("compact stream kind is not client-openable"),
    }
    Ok(())
}

async fn handle_compact_session_protocol<S>(
    control: &mut CompactProtocolStream<S>,
    preface: StreamPreface,
    context: IncomingSessionContext,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let IncomingSessionContext {
        registry,
        config,
        services,
        client_id,
        state_codec,
        protocol_minor,
        mut host_config,
        // Held for the life of the handler, as on the QUIC path: the fence may
        // not treat this connection as dead while it can still deliver an
        // attach, and this is where this attach's fence id comes from.
        connection: connection_scope,
    } = context;
    let session_id = preface
        .session_id
        .context("compact session stream lacks session id")?;
    let attach = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_compact_message::<SessionControlMessage>(
            CompactChannel::Control,
            MAX_CONTROL_MESSAGE_BYTES,
        ),
    )
    .await
    .context("timed out reading compact session attach")??
    .context("compact session stream closed before attach")?;
    let (request_id, view_id, access_token, attach_generation, resume, wants_state) = match attach {
        SessionControlMessage::AttachView {
            request_id,
            session_id: requested_session,
            view_id,
            access_token,
            attach_generation,
            resume,
            wants_state,
            ..
        } if requested_session == session_id => (
            request_id,
            view_id,
            access_token,
            attach_generation,
            resume,
            wants_state,
        ),
        _ => bail!("expected matching compact attach-view message"),
    };
    let session = registry
        .read()
        .unwrap()
        .get(&session_id)
        .cloned()
        .context("unknown shared terminal session")?;
    let access = config.access_for(access_token.as_deref());
    // The same rule the QUIC path applies, for the same reason: a zero
    // generation is a viewer that fences by rotating its wire id, so it has no
    // lineage to order and must not go through takeover — the second such
    // attach would be rejected as stale, correctly but uselessly.
    let ordered = protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR && attach_generation > 0;
    let attached = if ordered {
        // Collect before stamping, so the watermarks whose connections have all
        // finished are retired at the natural moment.
        session.gc_attach_watermarks(
            &client_id,
            connection_scope.ledger().terminated_through(&client_id),
        );
        let fence_conn_id = connection_scope.ledger().highest_for(&client_id);
        match session.take_over_view(
            &view_id,
            &client_id,
            access,
            attach_generation,
            fence_conn_id,
            resume.map(|hint| ResumeEvidence {
                previous_session_epoch: hint.previous_session_epoch,
                previous_attachment_epoch: hint.previous_attachment_epoch,
                previous_terminal_revision: hint.previous_terminal_revision,
            }),
        ) {
            Ok(taken) => taken,
            Err(rejection) => {
                // Without this the stream just closes, which a viewer cannot
                // tell from a transport failure. On compact the connection
                // carries this one view, so the close that follows *is* the
                // per-code connection disposition (§6.2).
                let _ = control
                    .write_compact_message(
                        CompactChannel::Control,
                        &SessionControlMessage::AttachRejected {
                            request_id,
                            code: attach_reject_code(rejection.code),
                            retryable: matches!(
                                rejection.code,
                                AttachRejectionCode::ViewInvalid | AttachRejectionCode::ViewLimit
                            ),
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await;
                return Err(anyhow::Error::new(rejection));
            }
        }
    } else {
        // Attaching already performs and publishes a full refresh; render the
        // state once before acknowledging the new compact view.
        let attachment_epoch = session
            .attach_view_with_access(&view_id, &client_id, access)
            .context("attach compact terminal view")?;
        let snapshot = session.control_snapshot();
        TakeOver {
            attachment_epoch,
            resumed: false,
            controller_cleared: false,
            control_revision: snapshot.control_revision,
            controller: snapshot.controller,
        }
    };
    let attachment_epoch = attached.attachment_epoch;
    // Takeover deliberately publishes nothing, so a `wants_state: false` attach
    // creates no snapshot at all — that is its entire purpose.
    if wants_state {
        session.refresh()?;
    }
    let (_, canonical_cols, canonical_rows, layout_epoch) = session.control_state();
    let presentation = (protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR)
        .then(|| host_config.borrow().as_ref().clone());
    control
        .write_compact_message(
            CompactChannel::Control,
            &SessionControlMessage::ViewAttached {
                request_id,
                session_epoch: session.session_epoch(),
                layout_epoch,
                attachment_epoch,
                cols: canonical_cols,
                rows: canonical_rows,
                read_write: access == ViewAccess::ReadWrite,
                presentation,
                resumed: attached.resumed,
                // Read under the same lock the takeover mutated, so the viewer
                // cannot observe a controller torn between two reads.
                controller: attached
                    .controller
                    .as_ref()
                    .map(|controller| ControllerInfo {
                        controller_view_id: controller.view_id.clone(),
                        control_epoch: controller.control_epoch,
                    }),
                control_revision: attached.control_revision,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await
        .context("write compact view-attached response")?;

    // What registration binds on this transport is the *connection*, not a
    // feed, which is why it is unconditional here where QUIC makes it depend on
    // wanting state. There the two are separable: a streamless secondary owns
    // no stream to cancel, and needs none cancelled, because its control stream
    // is one of many on a connection whose heartbeat lives elsewhere. Here the
    // connection is the view. A superseded handler nobody cancelled would go on
    // answering heartbeats and selection requests against an attachment the
    // authority has already replaced — telling its client a dead view is alive
    // through the very mechanism meant to detect the opposite.
    //
    // A registration that finds the epoch already superseded aborts the
    // handler, which is the half of the takeover race cancellation alone
    // cannot win.
    let (state_cancel, mut state_cancelled) = tokio::sync::watch::channel(false);
    let registration_cancel = state_cancel.clone();
    session.register_state_stream(
        &view_id,
        attachment_epoch,
        StateStreamCancel::new(move || {
            registration_cancel.send_replace(true);
        }),
    )?;

    let result = async {
        let mut controls = session.subscribe_control_state();
        let mut activities = session.subscribe_activity();
        let mut snapshots = session.subscribe_logical();
        let mut selections = session.subscribe_selection(&view_id);
        let mut concluded = session.subscribe_conclusion();
        let mut previous = session.logical_snapshot();
        let mut patch_sequence = 0_u64;
        let mut shutdown = services.shutdown.watch();
        // An attachment arriving after the announcement has already gone out
        // must not be told the host is healthy by omission. Gated with the
        // frame itself: below the reconnect minor this is undecodable, so such
        // a viewer keeps the only signal it has ever had — the stream ending.
        if *shutdown.borrow_and_update() && protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
            control
                .write_compact_state_message(
                    &StateMessage::HostShutdown {},
                    state_codec,
                    protocol_minor,
                )
                .await?;
            return Ok(());
        }
        // And a session that concluded before this view attached has to say so
        // here: the watch below only reports the transition, so a viewer
        // attaching to an already-dead session would otherwise wait for news
        // that never comes.
        if *concluded.borrow_and_update() {
            if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
                control
                    .write_compact_state_message(
                        &StateMessage::SessionEnded {
                            reason: session_end_reason(&session),
                        },
                        state_codec,
                        protocol_minor,
                    )
                    .await?;
            }
            return Ok(());
        }
        // Everything below is the state feed, which a `wants_state: false`
        // attach declined. What the State channel still carries for such a view
        // is the two lifecycle frames above and their live counterparts in the
        // loop: compact has no second stream to put them on — QUIC announces
        // shutdown on the heartbeat stream, which a streamless secondary keeps
        // — and a view told nothing would have to read a closing socket as an
        // ending, the ambiguity §6.2 exists to remove.
        if wants_state {
            if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR {
                let presentation = host_config.borrow_and_update().as_ref().clone();
                control
                    .write_compact_state_message(
                        &StateMessage::ConfigurationChanged { presentation },
                        state_codec,
                        protocol_minor,
                    )
                    .await?;
            }
            if let Some(snapshot) = previous.as_ref() {
                control
                    .write_compact_state_message(
                        &StateMessage::Snapshot(snapshot.clone()),
                        state_codec,
                        protocol_minor,
                    )
                    .await?;
            }
            if protocol_minor >= TRACKED_SELECTION_PROTOCOL_MINOR {
                let selection = *selections.borrow_and_update();
                control
                    .write_compact_state_message(
                        &StateMessage::SelectionChanged {
                            selection: selection.map(Into::into),
                        },
                        state_codec,
                        protocol_minor,
                    )
                    .await?;
            }
            // The opening state of a stream has to carry the same shape the
            // live updates below do. At minor >= 6 that means `ControlState`
            // with the revision: a stream that opens while nobody holds control
            // must still say so, and one that opens while somebody does must
            // not hand the viewer a revisionless frame it would read as the 0
            // sentinel.
            if let Some(message) =
                control_state_message(&session.control_snapshot(), protocol_minor)
            {
                control
                    .write_compact_state_message(&message, state_codec, protocol_minor)
                    .await?;
            }
            if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR {
                control
                    .write_compact_state_message(
                        &StateMessage::ActivityChanged {
                            activity: session.summary().activity,
                        },
                        state_codec,
                        protocol_minor,
                    )
                    .await?;
            }
        }

        loop {
            tokio::select! {
                biased;
                // §6.3's compact half: this transport has no heartbeat stream
                // to carry the announcement, so it travels as state.
                announced = shutdown.changed() => {
                    if announced.is_err() || !*shutdown.borrow_and_update() {
                        continue;
                    }
                    if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
                        control
                            .write_compact_state_message(
                                &StateMessage::HostShutdown {},
                                state_codec,
                                protocol_minor,
                            )
                            .await?;
                    }
                    return Ok(());
                }
                // §6.3's other half. Without it a connected viewer keeps a
                // healthy connection to a session that no longer exists, and
                // stays Live until something else tells it — which, while
                // attached and with the heartbeat answering, never comes.
                ended = concluded.changed() => {
                    if ended.is_err() {
                        break;
                    }
                    if !*concluded.borrow_and_update() {
                        continue;
                    }
                    if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
                        control
                            .write_compact_state_message(
                                &StateMessage::SessionEnded {
                                    reason: session_end_reason(&session),
                                },
                                state_codec,
                                protocol_minor,
                            )
                            .await?;
                    }
                    return Ok(());
                }
                // A takeover has replaced this attachment. On QUIC only the
                // state stream ends here and the control stream outlives it;
                // compact multiplexes both onto one socket, so the whole
                // connection ends — which is all a superseded attachment could
                // do anyway, every command on it now failing the authority's
                // epoch check.
                cancelled = state_cancelled.changed() => {
                    if cancelled.is_err() || *state_cancelled.borrow_and_update() {
                        return Ok(());
                    }
                }
                changed = host_config.changed(), if wants_state && protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR => {
                    changed.context("host configuration publisher closed")?;
                    let presentation = host_config.borrow_and_update().as_ref().clone();
                    control.write_compact_state_message(
                        &StateMessage::ConfigurationChanged { presentation },
                        state_codec,
                        protocol_minor,
                    ).await?;
                    if let Some(snapshot) = session.logical_snapshot() {
                        previous = Some(snapshot.clone());
                        patch_sequence = 0;
                        control.write_compact_state_message(
                            &StateMessage::Snapshot(snapshot),
                            state_codec,
                            protocol_minor,
                        ).await?;
                    }
                }
                incoming = control.read_compact_message::<SessionControlMessage>(
                    CompactChannel::Control,
                    MAX_CONTROL_MESSAGE_BYTES,
                ) => {
                    let Some(message) = incoming? else { break };
                    match message {
                        SessionControlMessage::FocusAndResize {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            cols,
                            rows,
                            expected_control_revision,
                            ..
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            // Same reasoning as the QUIC loop: the guard above
                            // proves only that the command names the epoch this
                            // handler was born with, and a takeover moves the
                            // authority on without telling this loop, so both
                            // sides of that comparison can be stale together.
                            // The checked call compares against the authority's
                            // current attachment under its own lock, and applies
                            // the client's swap while it is in there — `None`
                            // stays legacy last-write-wins.
                            match session.claim_control_checked(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                cols,
                                rows,
                                expected_control_revision,
                            )? {
                                ControlClaim::Granted(_) => {}
                                ControlClaim::Rejected(_) => session.announce_control(),
                            }
                        }
                        SessionControlMessage::Resize {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            control_epoch,
                            resize_sequence,
                            cols,
                            rows,
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            if session.resize_view_checked(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                control_epoch,
                                resize_sequence,
                                cols,
                                rows,
                            ).is_err() {
                                session.announce_control();
                            }
                        }
                        SessionControlMessage::Input {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            input_sequence,
                            operation,
                        } if incoming_view == view_id && epoch == attachment_epoch => match operation {
                            TunnelInput::Text(text) => session.send_text(
                                &view_id, &client_id, attachment_epoch, input_sequence, text,
                            )?,
                            TunnelInput::Paste(text) => session.paste(
                                &view_id, &client_id, attachment_epoch, input_sequence, text,
                            )?,
                            TunnelInput::Key(input) => session.key(
                                &view_id, &client_id, attachment_epoch, input_sequence, input,
                            )?,
                            TunnelInput::Mouse(input) => session.mouse(
                                &view_id, &client_id, attachment_epoch, input_sequence, input,
                            )?,
                            TunnelInput::Scroll(rows) => session.scroll(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                input_sequence,
                                isize::try_from(rows.clamp(-10_000, 10_000))?,
                            )?,
                            TunnelInput::ScrollTo(row) => session.scroll_to(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                input_sequence,
                                usize::try_from(row)?,
                            )?,
                            TunnelInput::Focus(focused) => session.focus(
                                &view_id, &client_id, attachment_epoch, input_sequence, focused,
                            )?,
                            TunnelInput::Interrupt => session.interrupt(
                                &view_id, &client_id, attachment_epoch, input_sequence,
                            )?,
                        },
                        // Answered whatever the view said at attach: an asked-for
                        // snapshot overrides a standing decline, exactly as the
                        // QUIC arm opens a stream for one. `wants_state: false`
                        // is what the host volunteers, not a mute button.
                        SessionControlMessage::RequestSnapshot => {
                            let snapshot = session
                                .logical_snapshot()
                                .context("shared terminal has no logical snapshot")?;
                            previous = Some(snapshot.clone());
                            patch_sequence = 0;
                            control.write_compact_state_message(
                                &StateMessage::Snapshot(snapshot),
                                state_codec,
                                protocol_minor,
                            ).await?;
                        }
                        SessionControlMessage::StateAck { .. } => {}
                        // §5's compact framing: this transport has no heartbeat
                        // stream, so liveness rides the control channel of the
                        // one view this connection carries. Stateless, like the
                        // QUIC responder — `Pong` is only ever an answer, and
                        // the viewer's own contact clock does the deciding.
                        SessionControlMessage::Ping { nonce }
                            if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR => {
                            control.write_compact_message(
                                CompactChannel::Control,
                                &SessionControlMessage::Pong { nonce },
                                MAX_CONTROL_MESSAGE_BYTES,
                            ).await?;
                        }
                        SessionControlMessage::SelectionText {
                            request_id,
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            start_column,
                            start_row,
                            end_column,
                            end_row,
                            select_all,
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            let text = session.selection_text(
                                &view_id,
                                start_column,
                                start_row,
                                end_column,
                                end_row,
                                select_all,
                            )?;
                            control.write_compact_message(
                                CompactChannel::Control,
                                &SessionControlMessage::SelectionTextResult { request_id, text },
                                MAX_CONTROL_MESSAGE_BYTES,
                            ).await?;
                        }
                        SessionControlMessage::Detach {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                        } if incoming_view == view_id && epoch == attachment_epoch => break,
                        _ => bail!("invalid, stale, or misrouted compact session message"),
                    }
                }
                // Selection is view-owned state. Keep it ahead of the shared
                // redraw feed in this biased loop: an animated TUI can make
                // `snapshots.recv()` continuously ready, and choosing it first
                // would leave the selected cells pinned correctly on the host
                // while the viewer never learns their new coordinates.
                changed = selections.changed(), if wants_state && protocol_minor >= TRACKED_SELECTION_PROTOCOL_MINOR => {
                    changed.context("selection publisher closed")?;
                    let selection = *selections.borrow_and_update();
                    control.write_compact_state_message(
                        &StateMessage::SelectionChanged {
                            selection: selection.map(Into::into),
                        },
                        state_codec,
                        protocol_minor,
                    ).await?;
                }
                snapshot = snapshots.recv(), if wants_state => {
                    let message = match snapshot {
                        Ok(snapshot) => {
                            let next_sequence = patch_sequence.saturating_add(1);
                            let message = previous
                                .as_ref()
                                .and_then(|previous| logical_patch(previous, &snapshot, next_sequence))
                                .map(StateMessage::Patch)
                                .unwrap_or_else(|| StateMessage::Snapshot(snapshot.clone()));
                            if matches!(message, StateMessage::Patch(_)) {
                                patch_sequence = next_sequence;
                            } else {
                                patch_sequence = 0;
                            }
                            previous = Some(snapshot);
                            message
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let snapshot = session
                                .logical_snapshot()
                                .context("shared terminal has no logical snapshot after lag")?;
                            previous = Some(snapshot.clone());
                            patch_sequence = 0;
                            StateMessage::Snapshot(snapshot)
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    control.write_compact_state_message(
                        &message,
                        state_codec,
                        protocol_minor,
                    ).await?;
                }
                changed = controls.recv(), if wants_state => {
                    let changed = match changed {
                        Ok(changed) => changed,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            session.announce_control();
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    if let Some(message) = control_state_message(&changed, protocol_minor) {
                        control
                            .write_compact_state_message(&message, state_codec, protocol_minor)
                            .await?;
                    }
                }
                changed = activities.recv(), if wants_state && protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR => {
                    let activity = match changed {
                        Ok(activity) => activity,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            session.announce_activity();
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    control.write_compact_state_message(
                        &StateMessage::ActivityChanged { activity },
                        state_codec,
                        protocol_minor,
                    ).await?;
                }
            }
        }
        Ok(())
    }
    .await;
    // Nothing further may be written for this attachment, and a takeover that
    // fires after this point must find the registration already spent.
    state_cancel.send_replace(true);
    // Epoch-conditional, because a handler outlives its attachment: once a
    // takeover has replaced this view, detaching by (view, client) alone would
    // destroy the successor's attachment — and if it lands between that
    // takeover and its state-stream registration, the successor never gets a
    // stream at all.
    session.detach_view_if_epoch(&view_id, &client_id, attachment_epoch);
    // This handler is finishing, so the fence may have just advanced past the
    // connection it was holding down. Ask again on the way out rather than
    // leaving the collection to the client's next attach, which may never come.
    session.gc_attach_watermarks(
        &client_id,
        connection_scope.ledger().terminated_through(&client_id),
    );
    result
}

/// Connection ids are handed out from one process-wide sequence. A client's
/// own connections are a subsequence of it, which is all the attach fence
/// needs: monotonic per client.
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ConnectionLedgerState {
    /// Accepted connections that are not yet fully terminated, in id order.
    /// The value is the client its hello bound, once one has.
    live: BTreeMap<u64, Option<String>>,
    /// The highest id handed out, so a ledger with nothing in flight answers
    /// "everything accepted so far is gone" rather than "nothing is".
    highest_accepted: u64,
}

/// Whether a live connection could still turn out to be this client's.
///
/// The fence and its collection must agree on this exactly. If they diverge —
/// say one counts unidentified connections and the other does not — collection
/// does not merely slow down, it stalls: the fence settles above an id
/// `terminated_through` will never pass, the watermark is never collected, and
/// the per-client cap eventually starts refusing attaches with `view-limit`.
/// Hence one function, called by both.
fn could_belong_to(owner: &Option<String>, client_id: &str) -> bool {
    owner.as_deref().is_none_or(|owner| owner == client_id)
}

/// Every accepted transport connection, from raw acceptance until it is
/// **fully terminated** — the transport closed *and* every handler it spawned
/// finished, not merely orphaned.
///
/// This is the observability the stage-2 attach fence runs on (§4.2.1). A
/// watermark stamped `fence_conn_id` for a client may be collected once that
/// client's view is detached **and** `terminated_through(client_id) >=
/// fence_conn_id`: at that point no connection able to carry a lower attach
/// generation can still deliver one.
///
/// That holds because an id leaves `live` in exactly one place — the scope's
/// `Drop`, once the transport is closed *and* the last handler holding a clone
/// has finished. Removing at transport close instead would look like a
/// harmless optimization and would silently break the fence: an orphaned
/// handler can still drain frames it already received, which is precisely the
/// weaker argument §4.2.1 rejects.
#[derive(Clone, Default)]
pub struct ConnectionLedger {
    state: Arc<SyncMutex<ConnectionLedgerState>>,
}

impl ConnectionLedger {
    /// Stamp the next connection id and begin tracking it.
    ///
    /// Called at raw transport acceptance, before any handler runs — §4.2.1
    /// invariant (a). An id minted later (at hello, say) could rank a
    /// slow-handshaking older connection *above* the fence recorded for a
    /// newer one, and the fence's soundness proof depends on it not.
    pub fn accept(&self) -> ConnectionScope {
        let id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
        {
            let mut state = self.state.lock().unwrap();
            state.live.insert(id, None);
            state.highest_accepted = state.highest_accepted.max(id);
        }
        ConnectionScope(Arc::new(ConnectionScopeInner {
            id,
            ledger: self.clone(),
        }))
    }

    /// The greatest connection id `n` for which every connection with id ≤ `n`
    /// that could belong to `client_id` is fully terminated.
    ///
    /// A connection that has not yet completed its hello belongs to no client
    /// yet, so it counts against every client: nothing may be excluded from a
    /// client's fence before it has said who it is.
    pub fn terminated_through(&self, client_id: &str) -> u64 {
        let state = self.state.lock().unwrap();
        state
            .live
            .iter()
            .find(|(_, owner)| could_belong_to(owner, client_id))
            .map_or(state.highest_accepted, |(id, _)| id - 1)
    }

    /// The highest connection id this client could still be holding.
    ///
    /// **Invariant this returns**: a value greater than or equal to the id of
    /// every live connection that could belong to `client_id`. That is the
    /// property the attach fence consumes (§4.2.1), and weakening it — most
    /// temptingly by dropping the not-yet-identified term — turns a delayed
    /// attach on an uncovered connection into an accepted one, months later,
    /// under load.
    ///
    /// Stamping the arriving connection's own id instead would under-fence
    /// whenever an attach lands on an older connection while a newer one is
    /// open.
    ///
    /// An unidentified connection holds every client's fence down, but only
    /// for a bounded window: a hello that never completes is dropped by the
    /// handshake path (~38 s worst case — three 10 s stages plus WhoIs and
    /// peer resolution), after which its scope drops and the id leaves `live`.
    /// It cannot stall collection indefinitely, so it does not need a timer.
    pub fn highest_for(&self, client_id: &str) -> u64 {
        let state = self.state.lock().unwrap();
        state
            .live
            .iter()
            .filter(|(_, owner)| could_belong_to(owner, client_id))
            .map(|(id, _)| *id)
            .next_back()
            .unwrap_or(state.highest_accepted)
    }

    /// Whether one connection is fully terminated. The per-connection form of
    /// [`terminated_through`](Self::terminated_through), for callers holding a
    /// single id rather than a fence.
    pub fn fully_terminated(&self, connection_id: u64) -> bool {
        !self.state.lock().unwrap().live.contains_key(&connection_id)
    }

    fn identify(&self, connection_id: u64, client_id: &str) {
        if let Some(owner) = self.state.lock().unwrap().live.get_mut(&connection_id) {
            *owner = Some(client_id.to_owned());
        }
    }

    fn finish(&self, connection_id: u64) {
        self.state.lock().unwrap().live.remove(&connection_id);
    }
}

/// One connection's place in the ledger. Every task that could still act for
/// the connection holds a clone; the connection is recorded as fully
/// terminated when the last clone drops. That is exactly "transport closed and
/// all spawned handlers completed" — an aborted handler drops its clone the
/// same as one that ran to the end.
#[derive(Clone)]
pub struct ConnectionScope(Arc<ConnectionScopeInner>);

struct ConnectionScopeInner {
    id: u64,
    ledger: ConnectionLedger,
}

impl ConnectionScope {
    /// This connection's id, ordered against every other accepted connection.
    pub fn id(&self) -> u64 {
        self.0.id
    }

    /// The ledger this connection is tracked in, for asking about others.
    pub fn ledger(&self) -> &ConnectionLedger {
        &self.0.ledger
    }

    /// Record which client the connection turned out to belong to, once its
    /// hello has been authenticated.
    pub fn identify(&self, client_id: &str) {
        self.0.ledger.identify(self.0.id, client_id);
    }
}

impl Drop for ConnectionScopeInner {
    fn drop(&mut self) {
        self.ledger.finish(self.id);
    }
}

#[allow(clippy::too_many_arguments)]
async fn accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    listener: Arc<truffle::transport::quic::QuicListener>,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    host_config: HostConfigReceiver,
    connections: ConnectionLedger,
) -> Result<()> {
    while let Some(connection) = listener.accept().await {
        // Stamped on the raw transport, before the handler that will
        // handshake — at whatever pace the client sets — exists.
        let scope = connections.accept();
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let services = services.clone();
        let host_instance_id = host_instance_id.clone();
        let host_config = host_config.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(
                node,
                Arc::new(connection),
                registry,
                config,
                services,
                host_instance_id,
                host_config,
                scope,
            )
            .await
            {
                eprintln!("[terminal-mesh] rejected connection: {error:#}");
            }
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_connection(
    node: Arc<Node<TailscaleProvider>>,
    connection: Arc<truffle::transport::quic::QuicConnection>,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    host_config: HostConfigReceiver,
    scope: ConnectionScope,
) -> Result<()> {
    let remote_ip = connection.remote_address().ip();
    serve_connection(
        connection,
        registry,
        config,
        services,
        host_instance_id,
        Arc::new(NodeClientResolver { node }),
        Some(remote_ip),
        host_config,
        scope,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn serve_connection(
    connection: Arc<dyn MeshConnection>,
    registry: Registry,
    config: TruffleTerminalConfig,
    services: HostServices,
    host_instance_id: String,
    resolver: Arc<dyn ClientResolver>,
    remote_ip: Option<IpAddr>,
    host_config: HostConfigReceiver,
    scope: ConnectionScope,
) -> Result<()> {
    let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_stream())
        .await
        .context("timed out accepting connection control stream")?
        .context("accept connection control stream")?
        .context("connection closed before control handshake")?;
    let mut control = ProtocolStream::new(stream);
    let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, control.read_preface())
        .await
        .context("timed out reading connection control preface")??;
    if preface.stream_kind != StreamKind::ConnectionControl {
        bail!("first stream is not connection-control");
    }
    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading client hello")??
    .context("connection closed before client hello")?;
    let (client_nonce, state_codec, protocol_minor, asserted_device_id) = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            state_codecs,
            ..
        } if protocol_major == PROTOCOL_MAJOR && protocol_minor > 0 => {
            let state_codec = negotiate_state_codec(state_codecs);
            (
                nonce,
                state_codec,
                protocol_minor.min(PROTOCOL_MINOR),
                local_device_id,
            )
        }
        ConnectionMessage::ClientHello { .. } => {
            bail!("client hello identity or protocol mismatch")
        }
        _ => bail!("expected client hello"),
    };
    let client_id = resolver.resolve(&asserted_device_id, remote_ip).await?;
    // Until this lands the connection counts against every client's fence,
    // because a connection that has not said who it is could still turn out to
    // be theirs.
    scope.identify(&client_id);
    control
        .write_message(
            &ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                // What was negotiated, not what this host could manage alone:
                // a client that offered less must not be told it got more.
                protocol_minor,
                host_instance_id,
                nonce: client_nonce,
                state_codec: (state_codec != StateCodec::Json).then_some(state_codec),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    let streams_connection = Arc::clone(&connection);
    // Every handler spawned below carries its own clone of the scope, so the
    // ledger reports this connection terminated only once the last of them has
    // finished — the difference between a handler completing and merely being
    // orphaned, which is what the fence needs to distinguish.
    let streams_context = IncomingSessionContext {
        registry: registry.clone(),
        config: config.clone(),
        services: services.clone(),
        client_id: client_id.clone(),
        state_codec,
        protocol_minor,
        host_config,
        connection: scope.clone(),
    };
    let streams = tokio::spawn(async move {
        while let Some(stream) = streams_connection.accept_stream().await? {
            let context = streams_context.clone();
            let connection = Arc::clone(&streams_connection);
            tokio::spawn(async move {
                if let Err(error) = handle_application_stream(connection, stream, context).await {
                    eprintln!("[terminal-mesh] stream closed: {error:#}");
                }
            });
        }
        Ok::<(), anyhow::Error>(())
    });

    while let Some(message) = control
        .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
        .await?
    {
        match message {
            ConnectionMessage::ListSessions { request_id } => {
                let sessions = shared_sessions(&registry, &config);
                control
                    .write_message(
                        &ConnectionMessage::Sessions {
                            request_id,
                            sessions,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
            // Why a session this viewer held is no longer listed. Answered
            // from the daemon's own evidence, so absence from the registry
            // stops being the only thing a resuming viewer can observe.
            ConnectionMessage::SessionStatus {
                request_id,
                session_id,
            } => {
                let status = session_status_for(&services, &session_id);
                control
                    .write_message(
                        &ConnectionMessage::SessionStatusResult { request_id, status },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
            _ => {
                control
                    .write_message(
                        &ConnectionMessage::Error {
                            request_id: None,
                            code: "unexpected-message".into(),
                            message: "message is not valid on the connection control stream".into(),
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
        }
    }
    streams.abort();
    connection.close();
    Ok(())
}

/// Why a concluded session ended, in the wire's vocabulary. Mirrors the
/// tombstone's own rule (`SessionTombstones::commit`): a process that was
/// observed to exit reports its code, anything else was closed.
fn session_end_reason(session: &Session) -> SessionEndReason {
    if session.has_exited() {
        SessionEndReason::Exited {
            code: session.summary().exit_code,
        }
    } else {
        SessionEndReason::Closed
    }
}

/// Answer a tombstone lookup. A host with no status source says `Unknown`,
/// which is the honest reading of "this host cannot say" — never an upgrade to
/// a specific end reason, and never a downgrade of one it does have.
fn session_status_for(services: &HostServices, session_id: &str) -> SessionStatusKind {
    services
        .session_status
        .as_ref()
        .map_or(SessionStatusKind::Unknown, |source| {
            source.session_status(session_id).into()
        })
}

/// Answer liveness probes for as long as the stream lives. A host has nothing
/// outstanding of its own here — `Pong` is only ever an answer, and the
/// shutdown announcement travels the other way.
async fn serve_heartbeat(
    mut control: ProtocolStream,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    // A stream that opens after the announcement has to see it too, which is
    // why the watch is read before waiting for a change rather than after.
    if *shutdown.borrow_and_update() {
        return announce_shutdown(&mut control).await;
    }
    loop {
        let message = tokio::select! {
            biased;
            announced = shutdown.changed() => {
                if announced.is_err() || !*shutdown.borrow_and_update() {
                    continue;
                }
                return announce_shutdown(&mut control).await;
            }
            message = control.read_message::<HeartbeatMessage>(MAX_HEARTBEAT_MESSAGE_BYTES) => message?,
        };
        let Some(message) = message else {
            return Ok(());
        };
        if let HeartbeatMessage::Ping { nonce } = message {
            control
                .write_message(
                    &HeartbeatMessage::Pong { nonce },
                    MAX_HEARTBEAT_MESSAGE_BYTES,
                )
                .await?;
        }
    }
}

/// Tell this viewer the host is going away, then stop: there is nothing
/// further to say on a connection whose host has announced its own exit.
async fn announce_shutdown(control: &mut ProtocolStream) -> Result<()> {
    control
        .write_message(
            &HeartbeatMessage::HostShutdown {},
            MAX_HEARTBEAT_MESSAGE_BYTES,
        )
        .await
}

async fn handle_application_stream(
    connection: Arc<dyn MeshConnection>,
    stream: Box<dyn MeshStream>,
    context: IncomingSessionContext,
) -> Result<()> {
    let IncomingSessionContext {
        registry,
        config,
        services,
        client_id,
        state_codec,
        protocol_minor,
        host_config,
        // Held for the life of the handler: the fence may not treat this
        // connection as dead while a stream on it can still deliver an attach.
        // Also the source of this attach's fence id and of the collection
        // bound handed to the authority.
        connection: connection_scope,
    } = context;
    let mut control = ProtocolStream::new(stream);
    let preface = control.read_preface().await?;
    match preface.stream_kind {
        StreamKind::SessionControl => {}
        // Liveness is a property of the connection, so these frames name no
        // session and this handler keeps no state: echo the nonce and let the
        // viewer's own contact clock do the deciding. The connection scope
        // stays held for as long as the stream lives, which is correct — an
        // open heartbeat stream is a connection that can still deliver work.
        StreamKind::Heartbeat => return serve_heartbeat(control, services.shutdown.watch()).await,
        _ => bail!("peer-opened stream kind is not supported"),
    }
    let session_id = preface
        .session_id
        .context("session control stream lacks session id")?;
    let attach = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading session attach")??
    .context("session stream closed before attach")?;
    let (request_id, view_id, access_token, attach_generation, resume, wants_state) = match attach {
        SessionControlMessage::AttachView {
            request_id,
            session_id: requested_session,
            view_id,
            access_token,
            attach_generation,
            resume,
            wants_state,
            ..
        } if requested_session == session_id => (
            request_id,
            view_id,
            access_token,
            attach_generation,
            resume,
            wants_state,
        ),
        _ => bail!("expected matching attach-view message"),
    };
    let session = registry
        .read()
        .unwrap()
        .get(&session_id)
        .cloned()
        .context("unknown shared terminal session")?;
    let access = config.access_for(access_token.as_deref());
    // A zero generation is a viewer that fences by rotating its wire id, so it
    // has no lineage to order and must not go through takeover — the second
    // such attach would be rejected as stale, correctly but uselessly.
    let ordered = protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR && attach_generation > 0;
    let attached = if ordered {
        // Collect before stamping. Watermarks are only reachable through calls
        // like this one, so an attach is the natural moment to retire the ones
        // whose connections have all finished.
        session.gc_attach_watermarks(
            &client_id,
            connection_scope.ledger().terminated_through(&client_id),
        );
        let fence_conn_id = connection_scope.ledger().highest_for(&client_id);
        match session.take_over_view(
            &view_id,
            &client_id,
            access,
            attach_generation,
            fence_conn_id,
            resume.map(|hint| ResumeEvidence {
                previous_session_epoch: hint.previous_session_epoch,
                previous_attachment_epoch: hint.previous_attachment_epoch,
                previous_terminal_revision: hint.previous_terminal_revision,
            }),
        ) {
            Ok(taken) => taken,
            Err(rejection) => {
                // A rejection the viewer can act on. Without it the stream just
                // closes, which is indistinguishable from a transport failure
                // and sends the viewer down the ambiguous path.
                let _ = control
                    .write_message(
                        &SessionControlMessage::AttachRejected {
                            request_id,
                            code: attach_reject_code(rejection.code),
                            retryable: matches!(
                                rejection.code,
                                AttachRejectionCode::ViewInvalid | AttachRejectionCode::ViewLimit
                            ),
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await;
                return Err(anyhow::Error::new(rejection));
            }
        }
    } else {
        let attachment_epoch = session.attach_view_with_access(&view_id, &client_id, access)?;
        let snapshot = session.control_snapshot();
        TakeOver {
            attachment_epoch,
            resumed: false,
            controller_cleared: false,
            control_revision: snapshot.control_revision,
            controller: snapshot.controller,
        }
    };
    let attachment_epoch = attached.attachment_epoch;
    // Takeover deliberately publishes nothing, so a `wants_state: false` attach
    // creates no snapshot at all — that is its entire purpose.
    if wants_state {
        session.refresh()?;
    }
    let (_, canonical_cols, canonical_rows, layout_epoch) = session.control_state();
    let presentation = (protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR)
        .then(|| host_config.borrow().as_ref().clone());
    control
        .write_message(
            &SessionControlMessage::ViewAttached {
                request_id,
                session_epoch: session.session_epoch(),
                layout_epoch,
                attachment_epoch,
                cols: canonical_cols,
                rows: canonical_rows,
                read_write: access == ViewAccess::ReadWrite,
                presentation,
                resumed: attached.resumed,
                // Read under the same lock the takeover mutated, so the viewer
                // cannot observe a controller torn between two reads.
                controller: attached
                    .controller
                    .as_ref()
                    .map(|controller| ControllerInfo {
                        controller_view_id: controller.view_id.clone(),
                        control_epoch: controller.control_epoch,
                    }),
                control_revision: attached.control_revision,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let (state_cancel, state_cancelled) = tokio::sync::watch::channel(false);
    // A view that declined state gets no stream and no snapshot; its
    // `ViewAttached` satisfies only the per-view half of the input barrier.
    if wants_state {
        // Registration is epoch-checked against the authority's *current*
        // attachment, and a handler whose registration fails aborts without
        // spawning. That is the half of the race cancellation alone cannot
        // win: either the takeover finds this handle and fires it, or this
        // registration finds the epoch already superseded and self-cancels —
        // no interleaving lets a superseded stream run.
        let registration_cancel = state_cancel.clone();
        session.register_state_stream(
            &view_id,
            attachment_epoch,
            StateStreamCancel::new(move || {
                registration_cancel.send_replace(true);
            }),
        )?;
        spawn_state_stream(
            Arc::clone(&connection),
            Arc::clone(&session),
            &view_id,
            state_cancelled.clone(),
            state_codec,
            protocol_minor,
            host_config.clone(),
        )
        .await?;
    }

    let result = session_control_loop(
        &mut control,
        Arc::clone(&connection),
        Arc::clone(&session),
        &client_id,
        &view_id,
        attachment_epoch,
        StateStreamContext {
            cancelled: state_cancelled,
            codec: state_codec,
            protocol_minor,
            host_config,
        },
    )
    .await;
    state_cancel.send_replace(true);
    // Epoch-conditional, because a handler outlives its attachment: once a
    // takeover has replaced this view, detaching by (view, client) alone would
    // destroy the successor's attachment — and if it lands between that
    // takeover and its state-stream registration, the successor never gets a
    // stream at all.
    session.detach_view_if_epoch(&view_id, &client_id, attachment_epoch);
    // This handler is finishing, so the fence may have just advanced past the
    // connection it was holding down. Ask again on the way out rather than
    // leaving the collection to the client's next attach, which may never come.
    session.gc_attach_watermarks(
        &client_id,
        connection_scope.ledger().terminated_through(&client_id),
    );
    result
}

struct StateStreamContext {
    cancelled: tokio::sync::watch::Receiver<bool>,
    codec: StateCodec,
    protocol_minor: u16,
    host_config: HostConfigReceiver,
}

async fn session_control_loop(
    control: &mut ProtocolStream,
    connection: Arc<dyn MeshConnection>,
    session: Arc<Session>,
    client_id: &str,
    attached_view_id: &str,
    attachment_epoch: u64,
    state_stream: StateStreamContext,
) -> Result<()> {
    while let Some(message) = control
        .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
        .await?
    {
        match message {
            SessionControlMessage::FocusAndResize {
                view_id,
                attachment_epoch: epoch,
                cols,
                rows,
                expected_control_revision,
                ..
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                // The guard above proves only that the command names the epoch
                // this handler was born with — and a takeover moves the
                // authority on without telling this loop, so both sides of
                // that comparison can be stale together. The checked call is
                // what compares against the *authority's* current attachment,
                // under its own lock, and applies the client's swap while it
                // is in there.
                match session.claim_control_checked(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    cols,
                    rows,
                    expected_control_revision,
                )? {
                    ControlClaim::Granted(_) => {}
                    // The swap lost. Re-announce so the loser learns the
                    // revision it would have to swap against next; saying
                    // nothing would leave it retrying against a stale one.
                    ControlClaim::Rejected(_) => session.announce_control(),
                }
            }
            SessionControlMessage::Resize {
                view_id,
                attachment_epoch: epoch,
                control_epoch,
                resize_sequence,
                cols,
                rows,
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                if session
                    .resize_view_checked(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        control_epoch,
                        resize_sequence,
                        cols,
                        rows,
                    )
                    .is_err()
                {
                    session.announce_control();
                }
            }
            SessionControlMessage::Input {
                view_id,
                attachment_epoch: epoch,
                input_sequence,
                operation,
            } if view_id == attached_view_id && epoch == attachment_epoch => match operation {
                TunnelInput::Text(text) => session.send_text(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    text,
                )?,
                TunnelInput::Paste(text) => {
                    session.paste(&view_id, client_id, attachment_epoch, input_sequence, text)?
                }
                TunnelInput::Key(input) => {
                    session.key(&view_id, client_id, attachment_epoch, input_sequence, input)?
                }
                TunnelInput::Mouse(input) => {
                    session.mouse(&view_id, client_id, attachment_epoch, input_sequence, input)?
                }
                TunnelInput::Scroll(rows) => session.scroll(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    isize::try_from(rows.clamp(-10_000, 10_000))?,
                )?,
                TunnelInput::ScrollTo(row) => session.scroll_to(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    usize::try_from(row)?,
                )?,
                TunnelInput::Focus(focused) => session.focus(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    focused,
                )?,
                TunnelInput::Interrupt => {
                    session.interrupt(&view_id, client_id, attachment_epoch, input_sequence)?
                }
            },
            SessionControlMessage::RequestSnapshot => {
                spawn_state_stream(
                    Arc::clone(&connection),
                    Arc::clone(&session),
                    attached_view_id,
                    state_stream.cancelled.clone(),
                    state_stream.codec,
                    state_stream.protocol_minor,
                    state_stream.host_config.clone(),
                )
                .await?;
            }
            SessionControlMessage::StateAck { .. } => {}
            SessionControlMessage::SelectionText {
                request_id,
                view_id,
                attachment_epoch: epoch,
                start_column,
                start_row,
                end_column,
                end_row,
                select_all,
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                let text = session.selection_text(
                    attached_view_id,
                    start_column,
                    start_row,
                    end_column,
                    end_row,
                    select_all,
                )?;
                control
                    .write_message(
                        &SessionControlMessage::SelectionTextResult { request_id, text },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
            SessionControlMessage::Detach {
                view_id,
                attachment_epoch: epoch,
            } if view_id == attached_view_id && epoch == attachment_epoch => break,
            _ => bail!("invalid, stale, or misrouted session control message"),
        }
    }
    Ok(())
}

async fn spawn_state_stream(
    connection: Arc<dyn MeshConnection>,
    session: Arc<Session>,
    view_id: &str,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
    state_codec: StateCodec,
    protocol_minor: u16,
    mut host_config: HostConfigReceiver,
) -> Result<()> {
    // Before anything is opened, let alone written: a takeover that fires
    // between registration and here has already superseded this attachment,
    // and the cheapest way to write nothing is to start nothing.
    if *cancelled.borrow_and_update() {
        return Ok(());
    }
    let stream = connection.open_stream().await?;
    let mut state = ProtocolStream::new(stream);
    state
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::LiveState,
            session_id: Some(session.id()),
            view_id: Some(view_id.to_owned()),
        })
        .await?;
    let mut controls = session.subscribe_control_state();
    let mut activities = session.subscribe_activity();
    let mut snapshots = session.subscribe_logical();
    let mut selections = session.subscribe_selection(view_id);
    let mut concluded = session.subscribe_conclusion();
    let mut previous = session.logical_snapshot();
    // Setup is not exempt from cancellation. The guarantee this stream is held
    // to is that no write *begins* after cancellation is observed, and the
    // opening burst below is writes like any other: a takeover that fires
    // mid-setup must not have the rest of it land on a superseded attachment.
    macro_rules! write_setup {
        ($message:expr) => {
            if *cancelled.borrow_and_update() {
                return Ok(());
            }
            state
                .write_state_message($message, state_codec, protocol_minor)
                .await?;
        };
    }
    if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR {
        let presentation = host_config.borrow_and_update().as_ref().clone();
        write_setup!(&StateMessage::ConfigurationChanged { presentation });
    }
    if let Some(snapshot) = previous.as_ref() {
        write_setup!(&StateMessage::Snapshot(snapshot.clone()));
    }
    if protocol_minor >= TRACKED_SELECTION_PROTOCOL_MINOR {
        let selection = *selections.borrow_and_update();
        write_setup!(&StateMessage::SelectionChanged {
            selection: selection.map(Into::into),
        });
    }
    // Same contract as the compact path: the opening frame is the live-update
    // shape, so a viewer that opens a stream after a clear learns of it and one
    // that opens with a controller present keeps the real revision.
    if let Some(message) = control_state_message(&session.control_snapshot(), protocol_minor) {
        write_setup!(&message);
    }
    if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR {
        write_setup!(&StateMessage::ActivityChanged {
            activity: session.summary().activity,
        });
    }
    // A session that concluded before this stream opened has to say so here:
    // the watch below only reports the transition, and a viewer attaching to
    // an already-dead session would otherwise wait for news that never comes.
    // Below the reconnect minor the frame is undecodable, so such a viewer
    // keeps the only signal it has ever had — the stream ending.
    if *concluded.borrow_and_update() {
        if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
            write_setup!(&StateMessage::SessionEnded {
                reason: session_end_reason(&session),
            });
        }
        return Ok(());
    }
    tokio::spawn(async move {
        let mut patch_sequence = 0_u64;
        loop {
            let message = tokio::select! {
                biased;
                changed = host_config.changed(), if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR => {
                    if changed.is_err() {
                        break;
                    }
                    let presentation = host_config.borrow_and_update().as_ref().clone();
                    if state
                        .write_state_message(
                            &StateMessage::ConfigurationChanged { presentation },
                            state_codec,
                            protocol_minor,
                        )
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if let Some(snapshot) = session.logical_snapshot() {
                        previous = Some(snapshot.clone());
                        patch_sequence = 0;
                        if state
                            .write_state_message(
                                &StateMessage::Snapshot(snapshot),
                                state_codec,
                                protocol_minor,
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    continue;
                },
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        break;
                    }
                    continue;
                },
                // §6.3: the host says why a session ended. Without this a
                // connected viewer keeps a healthy connection to a session
                // that no longer exists, and stays Live until it is told
                // something by some other means — which, while attached and
                // with the heartbeat answering, never comes.
                ended = concluded.changed() => {
                    if ended.is_err() {
                        break;
                    }
                    if !*concluded.borrow_and_update() {
                        continue;
                    }
                    if protocol_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR {
                        let _ = state
                            .write_state_message(
                                &StateMessage::SessionEnded {
                                    reason: session_end_reason(&session),
                                },
                                state_codec,
                                protocol_minor,
                            )
                            .await;
                    }
                    break;
                },
                // As on compact, a busy shared redraw feed may never outrank
                // view-owned selection state in this biased scheduler.
                changed = selections.changed(), if protocol_minor >= TRACKED_SELECTION_PROTOCOL_MINOR => {
                    if changed.is_err() {
                        break;
                    }
                    let selection = *selections.borrow_and_update();
                    Some(StateMessage::SelectionChanged {
                        selection: selection.map(Into::into),
                    })
                },
                snapshot = snapshots.recv() => match snapshot {
                    Ok(snapshot) => {
                        let next_sequence = patch_sequence.saturating_add(1);
                        let message = previous
                            .as_ref()
                            .and_then(|previous| logical_patch(previous, &snapshot, next_sequence))
                            .map(StateMessage::Patch)
                            .unwrap_or_else(|| StateMessage::Snapshot(snapshot.clone()));
                        if matches!(message, StateMessage::Patch(_)) {
                            patch_sequence = next_sequence;
                        } else {
                            patch_sequence = 0;
                        }
                        previous = Some(snapshot);
                        Some(message)
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                changed = controls.recv() => match changed {
                    Ok(changed) => control_state_message(&changed, protocol_minor),
                    // Skipping here would leave this viewer holding whatever
                    // it last heard — including a controller that has since
                    // been cleared — with nothing to correct it. Repairing is
                    // what the compact arm already does, and what the activity
                    // arm below does; this was the odd one out.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        session.announce_control();
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                changed = activities.recv(), if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR => match changed {
                    Ok(activity) => Some(StateMessage::ActivityChanged { activity }),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        session.announce_activity();
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            };
            if let Some(message) = message
                && state
                    .write_state_message(&message, state_codec, protocol_minor)
                    .await
                    .is_err()
            {
                break;
            }
        }
    });
    Ok(())
}

fn logical_patch(
    previous: &LogicalTerminalSnapshot,
    current: &LogicalTerminalSnapshot,
    patch_sequence: u64,
) -> Option<LogicalTerminalPatch> {
    if previous.session_epoch != current.session_epoch
        || previous.layout_epoch != current.layout_epoch
        || previous.cols != current.cols
        || previous.rows.len() != current.rows.len()
        || previous.title != current.title
        || previous.cwd != current.cwd
        || current.terminal_revision <= previous.terminal_revision
    {
        return None;
    }
    let row_replacements = previous
        .rows
        .iter()
        .zip(&current.rows)
        .enumerate()
        .filter_map(|(index, (old, new))| {
            if old == new {
                return None;
            }
            Some(RowReplacement {
                row_index: u16::try_from(index).ok()?,
                row_revision: current.terminal_revision,
                row: new.clone(),
            })
        })
        .collect::<Vec<_>>();
    Some(LogicalTerminalPatch {
        session_epoch: current.session_epoch,
        layout_epoch: current.layout_epoch,
        patch_sequence,
        terminal_revision: current.terminal_revision,
        row_replacements,
        cursor: (previous.cursor != current.cursor).then_some(current.cursor),
        mouse_tracking: (previous.mouse_tracking != current.mouse_tracking)
            .then_some(current.mouse_tracking),
        scrollbar: (previous.scrollbar != current.scrollbar).then_some(current.scrollbar),
    })
}

fn shared_sessions(
    registry: &Registry,
    config: &TruffleTerminalConfig,
) -> Vec<SharedSessionSummary> {
    registry
        .read()
        .unwrap()
        .values()
        .map(|session| {
            let summary = session.summary();
            SharedSessionSummary {
                session_id: summary.id,
                title: summary.title.unwrap_or_else(|| summary.executable.clone()),
                cwd_label: summary.cwd,
                running: !summary.exited,
                attachable: !session.has_concluded(),
                read_write: config.advertises_write(),
                created_at_ms: session.created_at_ms(),
                activity: summary.activity,
            }
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Default)]
struct ReadBuffer {
    bytes: Vec<u8>,
    start: usize,
}

impl ReadBuffer {
    fn available(&self) -> usize {
        self.bytes.len() - self.start
    }

    fn unread(&self, length: usize) -> &[u8] {
        &self.bytes[self.start..self.start + length]
    }

    fn consume(&mut self, length: usize) {
        self.start += length;
        if self.start == self.bytes.len() {
            self.bytes.clear();
            self.start = 0;
        }
    }

    fn compact(&mut self) {
        if self.start == 0 {
            return;
        }
        self.bytes.copy_within(self.start.., 0);
        self.bytes.truncate(self.available());
        self.start = 0;
    }

    fn append(&mut self, chunk: Vec<u8>) {
        if self.available() == 0 {
            self.bytes = chunk;
            self.start = 0;
            return;
        }
        self.compact();
        self.bytes.extend_from_slice(&chunk);
    }
}

struct CompactProtocolStream<S> {
    stream: S,
    buffered: ReadBuffer,
}

impl<S> CompactProtocolStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn new(stream: S) -> Self {
        Self {
            stream,
            buffered: ReadBuffer::default(),
        }
    }

    #[cfg(test)]
    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write_all(&encode_preface(preface)?).await?;
        Ok(())
    }

    async fn read_preface(&mut self) -> Result<StreamPreface> {
        if !self.fill(16).await? {
            bail!("EOF before compact-stream preface");
        }
        let metadata_len =
            u32::from_be_bytes(self.buffered.unread(16)[12..16].try_into().unwrap()) as usize;
        if metadata_len > ghosttea::tunnel_protocol::MAX_PREFACE_METADATA_BYTES {
            bail!("compact-stream preface metadata exceeds limit");
        }
        let total = 16 + metadata_len;
        if !self.fill(total).await? {
            bail!("EOF in compact-stream preface metadata");
        }
        let preface = decode_preface(self.buffered.unread(total))?.0;
        self.buffered.consume(total);
        Ok(preface)
    }

    async fn write_message<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_all(&encode_message(message, limit)?)
            .await?;
        Ok(())
    }

    async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > limit {
            bail!("compact-stream terminal protocol message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in compact-stream terminal protocol message");
        }
        let message = decode_message(self.buffered.unread(total), limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn write_compact_message<T: serde::Serialize>(
        &mut self,
        channel: CompactChannel,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_all(&encode_compact_message(channel, message, limit)?)
            .await?;
        Ok(())
    }

    async fn write_compact_state_message(
        &mut self,
        message: &StateMessage,
        codec: StateCodec,
        protocol_minor: u16,
    ) -> Result<()> {
        let encoded = ghosttea::tunnel_protocol::encode_state_message_for_minor(
            message,
            codec,
            protocol_minor,
            MAX_STATE_MESSAGE_BYTES,
        )?;
        let payload = &encoded[4..];
        let framed_len = payload
            .len()
            .checked_add(1)
            .context("compact state message length overflow")?;
        let mut framed = Vec::with_capacity(4 + framed_len);
        framed.extend_from_slice(&u32::try_from(framed_len)?.to_be_bytes());
        framed.push(CompactChannel::State.as_byte());
        framed.extend_from_slice(payload);
        self.stream.write_all(&framed).await?;
        Ok(())
    }

    async fn read_compact_message<T: serde::de::DeserializeOwned>(
        &mut self,
        expected_channel: CompactChannel,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let framed_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if framed_len == 0 || framed_len - 1 > limit {
            bail!("compact terminal message exceeds limit");
        }
        let total = 4 + framed_len;
        if !self.fill(total).await? {
            bail!("EOF in compact terminal protocol message");
        }
        let message =
            decode_compact_message(self.buffered.unread(total), expected_channel, limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn fill(&mut self, length: usize) -> Result<bool> {
        while self.buffered.available() < length {
            self.buffered.compact();
            self.buffered.bytes.reserve(64 * 1024);
            let read = self.stream.read_buf(&mut self.buffered.bytes).await?;
            if read == 0 {
                if self.buffered.available() == 0 {
                    return Ok(false);
                }
                bail!("truncated compact terminal stream");
            }
        }
        Ok(true)
    }
}

/// One ordered, reliable byte stream. Abstracting the transport keeps the
/// session state machine drivable in-process, where the QUIC path needs a live
/// tailnet.
#[async_trait]
trait MeshStream: Send + Sync {
    async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>>;
    async fn write_chunk(&mut self, data: &[u8]) -> Result<()>;
}

#[async_trait]
trait MeshConnection: Send + Sync {
    async fn open_stream(&self) -> Result<Box<dyn MeshStream>>;
    async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>>;
    fn close(&self);
}

#[async_trait]
impl MeshStream for QuicStream {
    async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>> {
        Ok(QuicStream::read(self, max_len).await?)
    }

    async fn write_chunk(&mut self, data: &[u8]) -> Result<()> {
        QuicStream::write(self, data).await?;
        Ok(())
    }
}

#[async_trait]
impl MeshConnection for truffle::transport::quic::QuicConnection {
    async fn open_stream(&self) -> Result<Box<dyn MeshStream>> {
        Ok(Box::new(
            truffle::transport::quic::QuicConnection::open_stream(self).await?,
        ))
    }

    async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>> {
        Ok(
            truffle::transport::quic::QuicConnection::accept_stream(self)
                .await?
                .map(|stream| Box::new(stream) as Box<dyn MeshStream>),
        )
    }

    fn close(&self) {
        truffle::transport::quic::QuicConnection::close(self);
    }
}

struct ProtocolStream {
    stream: Box<dyn MeshStream>,
    buffered: ReadBuffer,
}

impl ProtocolStream {
    fn new(stream: Box<dyn MeshStream>) -> Self {
        Self {
            stream,
            buffered: ReadBuffer::default(),
        }
    }

    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write_chunk(&encode_preface(preface)?).await?;
        Ok(())
    }

    async fn read_preface(&mut self) -> Result<StreamPreface> {
        if !self.fill(16).await? {
            bail!("EOF before stream preface");
        }
        let metadata_len =
            u32::from_be_bytes(self.buffered.unread(16)[12..16].try_into().unwrap()) as usize;
        if metadata_len > ghosttea::tunnel_protocol::MAX_PREFACE_METADATA_BYTES {
            bail!("stream preface metadata exceeds limit");
        }
        let total = 16 + metadata_len;
        if !self.fill(total).await? {
            bail!("EOF in stream preface metadata");
        }
        let preface = decode_preface(self.buffered.unread(total))?.0;
        self.buffered.consume(total);
        Ok(preface)
    }

    async fn write_message<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_chunk(&encode_message(message, limit)?)
            .await?;
        Ok(())
    }

    async fn write_state_message(
        &mut self,
        message: &StateMessage,
        codec: StateCodec,
        protocol_minor: u16,
    ) -> Result<()> {
        self.stream
            .write_chunk(&ghosttea::tunnel_protocol::encode_state_message_for_minor(
                message,
                codec,
                protocol_minor,
                MAX_STATE_MESSAGE_BYTES,
            )?)
            .await?;
        Ok(())
    }

    async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > limit {
            bail!("terminal protocol message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in terminal protocol message");
        }
        let message = decode_message(self.buffered.unread(total), limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn read_state_message(
        &mut self,
        codec: StateCodec,
        protocol_minor: u16,
    ) -> Result<Option<StateMessage>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > MAX_STATE_MESSAGE_BYTES {
            bail!("terminal protocol state message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in terminal protocol state message");
        }
        let message = ghosttea::tunnel_protocol::decode_state_message_for_minor(
            self.buffered.unread(total),
            codec,
            protocol_minor,
            MAX_STATE_MESSAGE_BYTES,
        )?
        .0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn fill(&mut self, length: usize) -> Result<bool> {
        while self.buffered.available() < length {
            match self.stream.read_chunk(64 * 1024).await? {
                Some(chunk) => self.buffered.append(chunk),
                None if self.buffered.available() == 0 => return Ok(false),
                None => bail!("truncated QUIC stream"),
            }
        }
        Ok(true)
    }
}

#[async_trait]
impl RemoteTerminalRuntime for MeshRuntime {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged> {
        self.control_tx.subscribe()
    }

    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged> {
        self.activity_tx.subscribe()
    }

    fn subscribe_metadata(&self) -> broadcast::Receiver<RemoteMetadataChanged> {
        self.metadata_tx.subscribe()
    }

    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        MeshRuntime::hosts(self).await
    }

    async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        MeshRuntime::list_sessions(self, device_id).await
    }

    async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary> {
        MeshRuntime::open_session(self, request).await
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        MeshRuntime::summaries(self).await
    }

    async fn summary(&self, session_id: &str) -> Option<SessionSummary> {
        MeshRuntime::summary(self, session_id).await
    }

    async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        MeshRuntime::attach_view(self, session_id, view_id).await
    }

    async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()> {
        MeshRuntime::send_input(
            self,
            session_id,
            view_id,
            attachment_epoch,
            input_sequence,
            operation,
        )
        .await
    }

    async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim> {
        MeshRuntime::claim_control(self, session_id, view_id, attachment_epoch, cols, rows).await
    }

    async fn resize(&self, session_id: &str, view_id: &str, request: RemoteResize) -> Result<()> {
        MeshRuntime::resize(self, session_id, view_id, request).await
    }

    async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        MeshRuntime::selection_text(self, session_id, view_id, request).await
    }

    async fn refresh(&self, session_id: &str) -> Result<()> {
        MeshRuntime::refresh(self, session_id).await
    }

    async fn refresh_remote(&self, session_id: &str) -> Result<()> {
        MeshRuntime::refresh_remote(self, session_id).await
    }

    fn subscribe_control_state(&self) -> broadcast::Receiver<RemoteControlState> {
        MeshRuntime::subscribe_control_state(self)
    }

    async fn control_state(&self, session_id: &str) -> Option<RemoteControlState> {
        MeshRuntime::last_control_state(self, session_id)
    }

    async fn claim_control_at(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        expected_control_revision: Option<u64>,
    ) -> Result<RemoteControlOutcome> {
        MeshRuntime::claim_control_at(
            self,
            session_id,
            view_id,
            attachment_epoch,
            cols,
            rows,
            expected_control_revision,
        )
        .await
    }

    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        MeshRuntime::detach_view(self, session_id, view_id, attachment_epoch).await;
    }

    async fn close_session(&self, session_id: &str) -> bool {
        MeshRuntime::close_session(self, session_id).await
    }

    async fn transfer_owner(
        &self,
        session_id: &str,
        expected_owner_id: &str,
        owner_id: &str,
    ) -> bool {
        MeshRuntime::transfer_owner(self, session_id, expected_owner_id, owner_id).await
    }

    fn subscribe_lifecycle(&self) -> broadcast::Receiver<RemoteLifecycleChanged> {
        self.lifecycle_tx.subscribe()
    }

    fn subscribe_view_state(&self) -> broadcast::Receiver<RemoteViewStateChanged> {
        self.view_state_tx.subscribe()
    }

    async fn session_lifecycle(&self, session_id: &str) -> Option<RemoteSessionLifecycle> {
        MeshRuntime::session_lifecycle(self, session_id).await
    }

    async fn current_attachment(&self, session_id: &str, view_id: &str) -> Option<(u64, bool)> {
        MeshRuntime::current_attachment(self, session_id, view_id).await
    }

    async fn reconnect_session(&self, session_id: &str) -> Result<RemoteSessionLifecycle> {
        MeshRuntime::reconnect_session(self, session_id).await
    }

    async fn probe_connection(&self, device_id: &str) -> Result<()> {
        MeshRuntime::probe_connection(self, device_id).await
    }

    async fn retry_view(&self, session_id: &str, view_id: &str) -> Result<RemoteViewRecord> {
        MeshRuntime::retry_view(self, session_id, view_id).await
    }

    async fn offline_selection_text(
        &self,
        session_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        MeshRuntime::offline_selection_text(self, session_id, request).await
    }
}

#[async_trait]
impl TerminalMesh for TruffleTerminalMesh {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime> {
        Arc::new(self.runtime())
    }

    fn set_session_status_source(&mut self, source: Arc<dyn SessionStatusSource>) {
        TruffleTerminalMesh::set_session_status_source(self, source);
    }

    fn shutdown_announcer(&self) -> HostShutdownAnnouncer {
        TruffleTerminalMesh::shutdown_announcer(self)
    }

    async fn serve(
        self: Box<Self>,
        registry: Registry,
        host_config: HostConfigReceiver,
    ) -> Result<()> {
        TruffleTerminalMesh::serve(*self, registry, host_config).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn logical_snapshot(revision: u64, text: &str) -> LogicalTerminalSnapshot {
        LogicalTerminalSnapshot {
            session_epoch: 1,
            layout_epoch: 2,
            terminal_revision: revision,
            cols: 80,
            rows: vec![ghosttea::tunnel_protocol::LogicalRow {
                text: text.into(),
                cells: vec![],
            }],
            cursor: ghosttea::tunnel_protocol::LogicalCursor::default(),
            mouse_tracking: false,
            scrollbar: ghosttea::tunnel_protocol::LogicalScrollbar::default(),
            title: Some("terminal".into()),
            cwd: Some("/tmp".into()),
        }
    }

    #[test]
    fn terminal_access_policy_requires_an_explicit_write_grant() {
        let config = TruffleTerminalConfig {
            service_name: "terminal.test".into(),
            quic_port: DEFAULT_QUIC_PORT,
            compact_port: DEFAULT_COMPACT_PORT,
            capability: Some("secret".into()),
            allow_tailnet_write: false,
            reconnect: MeshReconnectConfig::default(),
        };
        assert_eq!(config.access_for(None), ViewAccess::ReadOnly);
        assert_eq!(config.access_for(Some("wrong")), ViewAccess::ReadOnly);
        assert_eq!(config.access_for(Some("secret")), ViewAccess::ReadWrite);
    }

    #[test]
    fn terminal_service_scope_and_port_are_validated() {
        let node_free = TruffleTerminalConfig {
            service_name: " ".into(),
            ..TruffleTerminalConfig::default()
        };
        assert!(node_free.validate().is_err());
        let zero_port = TruffleTerminalConfig {
            quic_port: 0,
            ..TruffleTerminalConfig::default()
        };
        assert!(zero_port.validate().is_err());
        let same_ports = TruffleTerminalConfig {
            compact_port: DEFAULT_QUIC_PORT,
            ..TruffleTerminalConfig::default()
        };
        assert!(same_ports.validate().is_err());
    }

    #[test]
    fn compact_state_codec_is_used_only_when_the_peer_offers_it() {
        assert_eq!(negotiate_state_codec(None), StateCodec::Json);
        assert_eq!(
            negotiate_state_codec(Some(vec![StateCodec::Json])),
            StateCodec::Json
        );
        assert_eq!(
            negotiate_state_codec(Some(vec![StateCodec::Json, StateCodec::CompactJsonV1])),
            StateCodec::CompactJsonV1
        );
    }

    #[tokio::test]
    async fn compact_stream_frames_negotiated_state_payloads() {
        let (server_io, mut client_io) = tokio::io::duplex(4096);
        let mut server = CompactProtocolStream::new(server_io);
        server
            .write_compact_state_message(
                &StateMessage::ControlChanged {
                    controller_view_id: "view".into(),
                    control_epoch: 9,
                    cols: 120,
                    rows: 40,
                    layout_epoch: 3,
                },
                StateCodec::CompactJsonV1,
                PROTOCOL_MINOR,
            )
            .await
            .unwrap();

        let mut header = [0_u8; 4];
        client_io.read_exact(&mut header).await.unwrap();
        let framed_len = u32::from_be_bytes(header) as usize;
        let mut framed = vec![0_u8; framed_len];
        client_io.read_exact(&mut framed).await.unwrap();
        assert_eq!(framed[0], CompactChannel::State.as_byte());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&framed[1..]).unwrap(),
            serde_json::json!({"c": ["view", 9, 120, 40, 3]})
        );
    }

    #[tokio::test]
    async fn compact_stream_handshake_and_session_listing_match_apple_client() {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let registry = Registry::default();
        let server = tokio::spawn(handle_compact_protocol(
            server_io,
            registry,
            TruffleTerminalConfig::default(),
            HostServices::default(),
            "desktop-instance".into(),
            Some("ios-device".into()),
            "truffle:peer:1".into(),
            tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ))
            .1,
            ConnectionLedger::default().accept(),
        ));
        let mut client = CompactProtocolStream::new(client_io);
        client
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::ConnectionControl,
                session_id: None,
                view_id: None,
            })
            .await
            .unwrap();
        client
            .write_message(
                &ConnectionMessage::ClientHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id: String::new(),
                    local_device_id: "ios-device".into(),
                    nonce: "fixed-nonce".into(),
                    state_codecs: Some(vec![StateCodec::CompactJsonV1]),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        let hello = client
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await
            .unwrap()
            .unwrap();
        // The client above offered the highest minor this build knows, and the
        // compact endpoint now implements that contract, so it is answered in
        // full. `the_compact_hello_answers_the_negotiated_minimum` covers the
        // other direction, where the client offers less.
        assert!(matches!(
            hello,
            ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                ref host_instance_id,
                ref nonce,
                state_codec: Some(StateCodec::CompactJsonV1),
            } if host_instance_id == "desktop-instance" && nonce == "fixed-nonce"
        ));

        client
            .write_message(
                &ConnectionMessage::ListSessions {
                    request_id: "request-1".into(),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        let sessions = client
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            sessions,
            ConnectionMessage::Sessions {
                ref request_id,
                ref sessions,
            } if request_id == "request-1" && sessions.is_empty()
        ));
        drop(client);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn compact_stream_rejects_a_claim_that_conflicts_with_confirmed_peer_identity() {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(handle_compact_protocol(
            server_io,
            Registry::default(),
            TruffleTerminalConfig::default(),
            HostServices::default(),
            "desktop-instance".into(),
            Some("expected-device".into()),
            "truffle:peer:1".into(),
            tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ))
            .1,
            ConnectionLedger::default().accept(),
        ));
        let mut client = CompactProtocolStream::new(client_io);
        client
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::ConnectionControl,
                session_id: None,
                view_id: None,
            })
            .await
            .unwrap();
        client
            .write_message(
                &ConnectionMessage::ClientHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id: String::new(),
                    local_device_id: "claimed-device".into(),
                    nonce: "fixed-nonce".into(),
                    state_codecs: None,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        drop(client);
        assert!(server.await.unwrap().is_err());
    }

    #[test]
    fn connection_cache_requires_health_and_the_current_host_generation() {
        assert!(connection_is_reusable("host-a", true, "host-a"));
        assert!(!connection_is_reusable("host-a", false, "host-a"));
        assert!(!connection_is_reusable("host-a", true, "host-b"));
    }

    #[test]
    fn logical_state_uses_patches_only_with_a_compatible_baseline() {
        let previous = logical_snapshot(4, "before");
        let current = logical_snapshot(5, "after");
        let patch = logical_patch(&previous, &current, 1).unwrap();
        assert_eq!(patch.patch_sequence, 1);
        assert_eq!(patch.row_replacements.len(), 1);
        assert_eq!(patch.row_replacements[0].row.text, "after");

        let mut resized = current;
        resized.layout_epoch += 1;
        assert!(logical_patch(&previous, &resized, 1).is_none());
    }

    // ── Phase-1 reconnect harness ────────────────────────────────────────
    //
    // The QUIC path needs a live tailnet, so the session state machine is
    // exercised over an in-process transport that speaks the same protocol
    // against the same unmodified host code.

    const TEST_DEVICE: &str = "studio-device";

    struct LoopbackStream {
        io: tokio::io::DuplexStream,
        closed: tokio::sync::watch::Receiver<bool>,
    }

    #[async_trait]
    impl MeshStream for LoopbackStream {
        async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            let mut buffer = vec![0_u8; max_len.min(64 * 1024)];
            let read = tokio::select! {
                _ = self.closed.changed() => bail!("loopback connection closed"),
                read = self.io.read(&mut buffer) => read?,
            };
            if read == 0 {
                return Ok(None);
            }
            buffer.truncate(read);
            Ok(Some(buffer))
        }

        async fn write_chunk(&mut self, data: &[u8]) -> Result<()> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            self.io.write_all(data).await?;
            Ok(())
        }
    }

    struct LoopbackConnection {
        outgoing: tokio::sync::mpsc::UnboundedSender<tokio::io::DuplexStream>,
        incoming: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<tokio::io::DuplexStream>>,
        closed: tokio::sync::watch::Sender<bool>,
    }

    #[async_trait]
    impl MeshConnection for LoopbackConnection {
        async fn open_stream(&self) -> Result<Box<dyn MeshStream>> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            let (near, far) = tokio::io::duplex(256 * 1024);
            self.outgoing
                .send(far)
                .map_err(|_| anyhow::anyhow!("loopback peer is gone"))?;
            Ok(Box::new(LoopbackStream {
                io: near,
                closed: self.closed.subscribe(),
            }))
        }

        async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>> {
            let mut closed = self.closed.subscribe();
            if *closed.borrow() {
                return Ok(None);
            }
            let mut incoming = self.incoming.lock().await;
            let stream = tokio::select! {
                _ = closed.changed() => return Ok(None),
                stream = incoming.recv() => stream,
            };
            Ok(stream.map(|io| {
                Box::new(LoopbackStream {
                    io,
                    closed: self.closed.subscribe(),
                }) as Box<dyn MeshStream>
            }))
        }

        fn close(&self) {
            self.closed.send_replace(true);
        }
    }

    /// Each endpoint owns its close flag. Closing the server side is an
    /// orderly death the host observes; closing only the client side strands
    /// the host's handlers on streams that will never speak again, which is
    /// the black hole the zombie purge exists for.
    fn loopback_pair() -> (Arc<LoopbackConnection>, Arc<LoopbackConnection>) {
        let (client_tx, server_rx) = tokio::sync::mpsc::unbounded_channel();
        let (server_tx, client_rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(LoopbackConnection {
                outgoing: client_tx,
                incoming: tokio::sync::Mutex::new(client_rx),
                closed: tokio::sync::watch::channel(false).0,
            }),
            Arc::new(LoopbackConnection {
                outgoing: server_tx,
                incoming: tokio::sync::Mutex::new(server_rx),
                closed: tokio::sync::watch::channel(false).0,
            }),
        )
    }

    struct TestTransportState {
        /// `None` models an expired or missing advertisement.
        advertised: Option<String>,
        online: bool,
        queued: std::collections::VecDeque<Arc<RemoteHostConnection>>,
        dials: u32,
    }

    struct TestTransport {
        state: SyncMutex<TestTransportState>,
    }

    impl TestTransport {
        fn new(advertised: &str) -> Arc<Self> {
            Arc::new(Self {
                state: SyncMutex::new(TestTransportState {
                    advertised: Some(advertised.to_owned()),
                    online: true,
                    queued: std::collections::VecDeque::new(),
                    dials: 0,
                }),
            })
        }

        fn queue(&self, connection: Arc<RemoteHostConnection>) {
            self.state.lock().unwrap().queued.push_back(connection);
        }

        fn advertise(&self, host_instance_id: Option<&str>) {
            self.state.lock().unwrap().advertised = host_instance_id.map(str::to_owned);
        }

        fn set_online(&self, online: bool) {
            self.state.lock().unwrap().online = online;
        }

        fn dials(&self) -> u32 {
            self.state.lock().unwrap().dials
        }
    }

    #[async_trait]
    impl HostTransport for TestTransport {
        fn capability(&self) -> Option<String> {
            None
        }

        async fn device_name(&self, _device_id: &str) -> Option<String> {
            Some("studio-mac".into())
        }

        async fn peer_is_online(&self, _device_id: &str) -> bool {
            self.state.lock().unwrap().online
        }

        async fn host_instance_id(&self, _device_id: &str) -> Result<String> {
            self.state
                .lock()
                .unwrap()
                .advertised
                .clone()
                .context("terminal host advertisement has expired")
        }

        async fn dial(&self, _device_id: &str) -> Result<Arc<RemoteHostConnection>> {
            let mut state = self.state.lock().unwrap();
            state.dials += 1;
            state
                .queued
                .pop_front()
                .context("test transport has no connection to hand out")
        }
    }

    /// A host that completes the attach handshake but releases each view's
    /// first snapshot only on command, so tests can hold a session inside the
    /// window between `ViewAttached` and synchronization.
    #[derive(Clone, Default)]
    struct SnapshotGate {
        held: Arc<SyncMutex<std::collections::HashSet<String>>>,
        released: Arc<tokio::sync::Notify>,
    }

    impl SnapshotGate {
        fn hold(&self, local_view_id: &str) {
            self.held.lock().unwrap().insert(local_view_id.to_owned());
        }

        fn release(&self, local_view_id: &str) {
            self.held.lock().unwrap().remove(local_view_id);
            self.released.notify_waiters();
        }

        async fn wait(&self, wire_view_id: &str) {
            let Some(local) = local_view_id_from_wire(wire_view_id) else {
                return;
            };
            loop {
                let waiter = self.released.notified();
                if !self.held.lock().unwrap().contains(&local) {
                    return;
                }
                waiter.await;
            }
        }
    }

    /// What the scripted host does with the viewer's heartbeat stream.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum HeartbeatBehavior {
        /// What a healthy host does.
        Answer,
        /// Connected and chatty, but never answering the ping that was asked:
        /// a pong nobody is waiting for must refresh nothing, so this host is
        /// indistinguishable from a silent one.
        ReplayStalePongs,
        /// Announce shutdown as soon as the stream opens.
        AnnounceShutdown,
    }

    async fn scripted_heartbeat(
        mut stream: ProtocolStream,
        behavior: HeartbeatBehavior,
    ) -> Result<()> {
        while let Some(message) = stream
            .read_message::<HeartbeatMessage>(MAX_HEARTBEAT_MESSAGE_BYTES)
            .await?
        {
            let HeartbeatMessage::Ping { nonce } = message else {
                continue;
            };
            // Answering the first probe is the earliest moment a host can be
            // sure the viewer is bound to it and listening.
            let answer = match behavior {
                HeartbeatBehavior::Answer => HeartbeatMessage::Pong { nonce },
                // Never a nonce this viewer has outstanding.
                HeartbeatBehavior::ReplayStalePongs => HeartbeatMessage::Pong { nonce: u64::MAX },
                HeartbeatBehavior::AnnounceShutdown => HeartbeatMessage::HostShutdown {},
            };
            stream
                .write_message(&answer, MAX_HEARTBEAT_MESSAGE_BYTES)
                .await?;
        }
        Ok(())
    }

    async fn serve_scripted_host(
        connection: Arc<dyn MeshConnection>,
        host_instance_id: String,
        remote_session_id: String,
        gate: SnapshotGate,
        heartbeat: HeartbeatBehavior,
    ) -> Result<()> {
        let control_stream = connection
            .accept_stream()
            .await?
            .context("scripted host got no control stream")?;
        let mut control = ProtocolStream::new(control_stream);
        let preface = control.read_preface().await?;
        if preface.stream_kind != StreamKind::ConnectionControl {
            bail!("scripted host expected a connection-control stream");
        }
        let nonce = match control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
            .context("scripted host got no client hello")?
        {
            ConnectionMessage::ClientHello { nonce, .. } => nonce,
            _ => bail!("scripted host expected a client hello"),
        };
        control
            .write_message(
                &ConnectionMessage::ServerHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id,
                    nonce,
                    state_codec: Some(StateCodec::CompactJsonV1),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;

        let session = remote_session_id.clone();
        let streams_connection = Arc::clone(&connection);
        let streams = tokio::spawn(async move {
            let mut epoch = 0_u64;
            while let Some(stream) = streams_connection.accept_stream().await? {
                let mut view_control = ProtocolStream::new(stream);
                let preface = view_control.read_preface().await?;
                if preface.stream_kind == StreamKind::Heartbeat {
                    tokio::spawn(scripted_heartbeat(view_control, heartbeat));
                    continue;
                }
                if preface.stream_kind != StreamKind::SessionControl {
                    continue;
                }
                let (request_id, wire_view_id) = match view_control
                    .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                    .await?
                    .context("scripted host got no attach")?
                {
                    SessionControlMessage::AttachView {
                        request_id,
                        view_id,
                        ..
                    } => (request_id, view_id),
                    _ => bail!("scripted host expected an attach"),
                };
                epoch += 1;
                view_control
                    .write_message(
                        &SessionControlMessage::ViewAttached {
                            request_id,
                            session_epoch: 1,
                            layout_epoch: 1,
                            attachment_epoch: epoch,
                            cols: 80,
                            rows: 24,
                            read_write: true,
                            presentation: None,
                            resumed: false,
                            controller: None,
                            control_revision: 0,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
                let mut state = ProtocolStream::new(streams_connection.open_stream().await?);
                state
                    .write_preface(&StreamPreface {
                        stream_kind: StreamKind::LiveState,
                        session_id: Some(session.clone()),
                        view_id: Some(wire_view_id.clone()),
                    })
                    .await?;
                let gate = gate.clone();
                tokio::spawn(async move {
                    gate.wait(&wire_view_id).await;
                    let _ = state
                        .write_state_message(
                            &StateMessage::Snapshot(logical_snapshot(1, "scripted")),
                            StateCodec::CompactJsonV1,
                            PROTOCOL_MINOR,
                        )
                        .await;
                    // Hold the stream open; a dropped stream would read as a
                    // disconnect rather than a quiet host.
                    std::future::pending::<()>().await;
                });
                tokio::spawn(async move {
                    while view_control
                        .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                        .await
                        .is_ok_and(|message| message.is_some())
                    {}
                });
            }
            Ok::<(), anyhow::Error>(())
        });

        while let Some(message) = control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
        {
            if let ConnectionMessage::ListSessions { request_id } = message {
                control
                    .write_message(
                        &ConnectionMessage::Sessions {
                            request_id,
                            sessions: vec![SharedSessionSummary {
                                session_id: remote_session_id.clone(),
                                title: "scripted".into(),
                                cwd_label: None,
                                running: true,
                                attachable: true,
                                read_write: true,
                                created_at_ms: 0,
                                activity: ghosttea::SessionActivity::default(),
                            }],
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
        }
        streams.abort();
        Ok(())
    }

    /// A host that answers every attach with the same rejection. `retryable`
    /// is settable so a test can show the advisory flag moves nothing: the
    /// §6.2 code table is what decides the action.
    async fn serve_rejecting_host(
        connection: Arc<dyn MeshConnection>,
        host_instance_id: String,
        remote_session_id: String,
        code: AttachRejectCode,
        retryable: bool,
        accepts: usize,
    ) -> Result<()> {
        let control_stream = connection
            .accept_stream()
            .await?
            .context("rejecting host got no control stream")?;
        let mut control = ProtocolStream::new(control_stream);
        let preface = control.read_preface().await?;
        if preface.stream_kind != StreamKind::ConnectionControl {
            bail!("rejecting host expected a connection-control stream");
        }
        let nonce = match control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
            .context("rejecting host got no client hello")?
        {
            ConnectionMessage::ClientHello { nonce, .. } => nonce,
            _ => bail!("rejecting host expected a client hello"),
        };
        control
            .write_message(
                &ConnectionMessage::ServerHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id,
                    nonce,
                    state_codec: Some(StateCodec::CompactJsonV1),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;

        let streams_connection = Arc::clone(&connection);
        let session = remote_session_id.clone();
        let streams = tokio::spawn(async move {
            // Accepting the first `accepts` attaches is what lets a test reach
            // the secondary path at all: the feed has to be live before a
            // refusal can be about one pane rather than the whole session.
            let mut accepted = 0_usize;
            let mut epoch = 0_u64;
            while let Some(stream) = streams_connection.accept_stream().await? {
                let mut view_control = ProtocolStream::new(stream);
                let preface = view_control.read_preface().await?;
                if preface.stream_kind != StreamKind::SessionControl {
                    continue;
                }
                let (request_id, wire_view_id) = match view_control
                    .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                    .await?
                    .context("rejecting host got no attach")?
                {
                    SessionControlMessage::AttachView {
                        request_id,
                        view_id,
                        ..
                    } => (request_id, view_id),
                    _ => bail!("rejecting host expected an attach"),
                };
                if accepted >= accepts {
                    view_control
                        .write_message(
                            &SessionControlMessage::AttachRejected {
                                request_id,
                                code,
                                retryable,
                            },
                            MAX_CONTROL_MESSAGE_BYTES,
                        )
                        .await?;
                    continue;
                }
                accepted += 1;
                epoch += 1;
                view_control
                    .write_message(
                        &SessionControlMessage::ViewAttached {
                            request_id,
                            session_epoch: 1,
                            layout_epoch: 1,
                            attachment_epoch: epoch,
                            cols: 80,
                            rows: 24,
                            read_write: true,
                            presentation: None,
                            resumed: false,
                            controller: None,
                            control_revision: 1,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
                let mut state = ProtocolStream::new(streams_connection.open_stream().await?);
                state
                    .write_preface(&StreamPreface {
                        stream_kind: StreamKind::LiveState,
                        session_id: Some(session.clone()),
                        view_id: Some(wire_view_id),
                    })
                    .await?;
                tokio::spawn(async move {
                    let _ = state
                        .write_state_message(
                            &StateMessage::Snapshot(logical_snapshot(1, "rejecting")),
                            StateCodec::CompactJsonV1,
                            PROTOCOL_MINOR,
                        )
                        .await;
                    std::future::pending::<()>().await;
                });
                tokio::spawn(async move {
                    while view_control
                        .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                        .await
                        .is_ok_and(|message| message.is_some())
                    {}
                });
            }
            Ok::<(), anyhow::Error>(())
        });

        while let Some(message) = control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
        {
            if let ConnectionMessage::ListSessions { request_id } = message {
                control
                    .write_message(
                        &ConnectionMessage::Sessions {
                            request_id,
                            sessions: vec![SharedSessionSummary {
                                session_id: remote_session_id.clone(),
                                title: "rejecting".into(),
                                cwd_label: None,
                                running: true,
                                attachable: true,
                                read_write: true,
                                created_at_ms: 0,
                                activity: ghosttea::SessionActivity::default(),
                            }],
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
        }
        streams.abort();
        Ok(())
    }

    /// The loopback transport carries no tailnet identity, so tests assert the
    /// client id directly.
    struct StaticClientResolver(&'static str);

    #[async_trait]
    impl ClientResolver for StaticClientResolver {
        async fn resolve(&self, _device_id: &str, _remote_ip: Option<IpAddr>) -> Result<String> {
            Ok(self.0.to_owned())
        }
    }

    struct LoopbackHost {
        server: Arc<LoopbackConnection>,
        task: tokio::task::JoinHandle<Result<()>>,
        _presentation: tokio::sync::watch::Sender<Arc<TerminalPresentationConfig>>,
        /// The host's view of its own connections, so a test can ask whether
        /// this one is fully terminated.
        connections: ConnectionLedger,
        connection_id: u64,
    }

    impl LoopbackHost {
        /// Sever the transport the way a host disappearance does: existing
        /// streams break, and nothing new can be sent.
        fn kill(&self) {
            self.server.close();
            self.task.abort();
        }
    }

    /// A viewer-side connection wired to the real host protocol handler over
    /// the in-process transport.
    async fn connect_loopback(
        registry: &Registry,
        host_instance_id: &str,
    ) -> Result<(Arc<RemoteHostConnection>, LoopbackHost)> {
        connect_loopback_at(
            registry,
            host_instance_id,
            PROTOCOL_MINOR,
            HostServices::default(),
        )
        .await
    }

    /// `offered_minor` is what the viewer asks for; the host answers with the
    /// negotiated minimum, so passing < REMOTE_RECONNECT_PROTOCOL_MINOR gives
    /// a genuine legacy pair rather than a simulated one.
    async fn connect_loopback_at(
        registry: &Registry,
        host_instance_id: &str,
        offered_minor: u16,
        services: HostServices,
    ) -> Result<(Arc<RemoteHostConnection>, LoopbackHost)> {
        let (client, server) = loopback_pair();
        let (presentation, presentation_rx) = tokio::sync::watch::channel(Arc::new(
            ghosttea::ConfigSnapshot::default().terminal_presentation(),
        ));
        let connections = ConnectionLedger::default();
        let scope = connections.accept();
        let connection_id = scope.id();
        let task = tokio::spawn(serve_connection(
            Arc::clone(&server) as Arc<dyn MeshConnection>,
            registry.clone(),
            TruffleTerminalConfig {
                allow_tailnet_write: true,
                ..TruffleTerminalConfig::default()
            },
            services,
            host_instance_id.to_owned(),
            Arc::new(StaticClientResolver("truffle:peer:1")) as Arc<dyn ClientResolver>,
            None,
            presentation_rx,
            scope,
        ));
        let connection = client_handshake(
            client as Arc<dyn MeshConnection>,
            "viewer-device",
            "viewer-instance",
            host_instance_id,
            offered_minor,
        )
        .await?;
        Ok((
            connection,
            LoopbackHost {
                server,
                task,
                _presentation: presentation,
                connections,
                connection_id,
            },
        ))
    }

    /// A quiet, long-lived PTY child for the harness to attach to. `cat` idles
    /// reading stdin on Unix; the Windows integration fixtures already prove
    /// the command shell is spawnable there, and it idles the same way.
    fn idle_child_executable() -> String {
        #[cfg(unix)]
        {
            "/bin/cat".to_owned()
        }
        #[cfg(windows)]
        {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
        }
    }

    fn spawn_host_session(registry: &Registry) -> Result<String> {
        let session = Session::spawn(
            ghosttea::session::SpawnOptions {
                executable: idle_child_executable(),
                args: Vec::new(),
                cwd: None,
                env: std::collections::HashMap::new(),
                environment: None,
                cols: 80,
                rows: 24,
                persistence: ghosttea::session::Persistence::TerminateWithApp,
                program_kind: ghosttea::SessionProgramKind::default(),
                owner_id: None,
                scrollback_bytes: None,
            },
            ghosttea::FrameHub::new(8),
            Arc::new(std::sync::Mutex::new(
                ghosttea::TextEngine::discover().context("discover text engine")?,
            )),
            Arc::new(|_, _| {}),
        )?;
        let id = session.id();
        registry.write().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Auto-resume parked immediately, so tests that are not about the engine
    /// see a deterministic resting state instead of a background dial loop.
    fn quiet_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            suspend_after: Duration::ZERO,
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        }
    }

    struct Fixture {
        runtime: MeshRuntime,
        transport: Arc<TestTransport>,
        registry: Registry,
        services: HostServices,
        remote_session_id: String,
        session_id: String,
        hosts: Vec<LoopbackHost>,
        offered_minor: u16,
    }

    impl Fixture {
        /// An open remote session with one attached view, live.
        async fn attached() -> Result<Self> {
            Self::attached_with(quiet_reconnect()).await
        }

        /// A pair that negotiated below the reconnect minor, so the viewer is
        /// on the rotation path — the compatibility half of every behavior.
        async fn attached_legacy() -> Result<Self> {
            Self::attached_at(quiet_reconnect(), REMOTE_RECONNECT_PROTOCOL_MINOR - 1).await
        }

        async fn attached_with(config: MeshReconnectConfig) -> Result<Self> {
            Self::attached_at(config, PROTOCOL_MINOR).await
        }

        async fn attached_at(config: MeshReconnectConfig, offered_minor: u16) -> Result<Self> {
            Self::attached_serving(config, offered_minor, HostServices::default()).await
        }

        /// The full form: the daemon-side services the host serves with are
        /// what a test drives when it is the seam under test.
        async fn attached_serving(
            config: MeshReconnectConfig,
            offered_minor: u16,
            services: HostServices,
        ) -> Result<Self> {
            let registry = Registry::default();
            let remote_session_id = spawn_host_session(&registry)?;
            let transport = TestTransport::new("host-1");
            let runtime = MeshRuntime::new();
            runtime.set_reconnect_config(config);
            runtime
                .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
                .await;
            let (connection, host) =
                connect_loopback_at(&registry, "host-1", offered_minor, services.clone()).await?;
            transport.queue(connection);

            let summary = runtime
                .open_session(RemoteSessionOpen {
                    device_id: TEST_DEVICE.into(),
                    remote_session_id: remote_session_id.clone(),
                    cols: 80,
                    rows: 24,
                    owner_id: None,
                    frames: ghosttea::FrameHub::new(8),
                    text_engine: Arc::new(std::sync::Mutex::new(
                        ghosttea::TextEngine::discover().context("discover text engine")?,
                    )),
                })
                .await?;
            let fixture = Self {
                runtime,
                transport,
                registry,
                services,
                remote_session_id,
                session_id: summary.id,
                hosts: vec![host],
                offered_minor,
            };
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-1")
                .await?;
            Ok(fixture)
        }

        /// An open remote session whose host withholds snapshots until told.
        /// Returns before the first view has attached.
        async fn scripted(gate: SnapshotGate) -> Result<Self> {
            Self::scripted_at(gate, quiet_reconnect(), HeartbeatBehavior::Answer).await
        }

        async fn scripted_at(
            gate: SnapshotGate,
            config: MeshReconnectConfig,
            heartbeat: HeartbeatBehavior,
        ) -> Result<Self> {
            let registry = Registry::default();
            let remote_session_id = "scripted-session".to_owned();
            let transport = TestTransport::new("host-1");
            let runtime = MeshRuntime::new();
            runtime.set_reconnect_config(config);
            runtime
                .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
                .await;

            let (client, server) = loopback_pair();
            let (presentation, _presentation_rx) = tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ));
            let task = tokio::spawn(serve_scripted_host(
                Arc::clone(&server) as Arc<dyn MeshConnection>,
                "host-1".into(),
                remote_session_id.clone(),
                gate,
                heartbeat,
            ));
            let connection = client_handshake(
                client as Arc<dyn MeshConnection>,
                "viewer-device",
                "viewer-instance",
                "host-1",
                PROTOCOL_MINOR,
            )
            .await?;
            transport.queue(connection);

            let summary = runtime
                .open_session(RemoteSessionOpen {
                    device_id: TEST_DEVICE.into(),
                    remote_session_id: remote_session_id.clone(),
                    cols: 80,
                    rows: 24,
                    owner_id: None,
                    frames: ghosttea::FrameHub::new(8),
                    text_engine: Arc::new(std::sync::Mutex::new(
                        ghosttea::TextEngine::discover().context("discover text engine")?,
                    )),
                })
                .await?;
            Ok(Self {
                runtime,
                transport,
                registry,
                services: HostServices::default(),
                remote_session_id,
                session_id: summary.id,
                hosts: vec![LoopbackHost {
                    server,
                    task,
                    _presentation: presentation,
                    // The scripted host speaks the protocol itself instead of
                    // going through `serve_connection`, so it keeps no ledger.
                    connections: ConnectionLedger::default(),
                    connection_id: 0,
                }],
                offered_minor: PROTOCOL_MINOR,
            })
        }

        /// An open session whose host refuses every attach with `code`.
        async fn rejecting(code: AttachRejectCode, retryable: bool) -> Result<Self> {
            Self::rejecting_after(code, retryable, 0).await
        }

        /// The same, after accepting `accepts` attaches — enough to get a feed
        /// live so a refusal can land on a secondary.
        async fn rejecting_after(
            code: AttachRejectCode,
            retryable: bool,
            accepts: usize,
        ) -> Result<Self> {
            let registry = Registry::default();
            let remote_session_id = "rejected-session".to_owned();
            let transport = TestTransport::new("host-1");
            let runtime = MeshRuntime::new();
            runtime.set_reconnect_config(quiet_reconnect());
            runtime
                .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
                .await;

            let (client, server) = loopback_pair();
            let (presentation, _presentation_rx) = tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ));
            let task = tokio::spawn(serve_rejecting_host(
                Arc::clone(&server) as Arc<dyn MeshConnection>,
                "host-1".into(),
                remote_session_id.clone(),
                code,
                retryable,
                accepts,
            ));
            let connection = client_handshake(
                client as Arc<dyn MeshConnection>,
                "viewer-device",
                "viewer-instance",
                "host-1",
                PROTOCOL_MINOR,
            )
            .await?;
            transport.queue(connection);

            let summary = runtime
                .open_session(RemoteSessionOpen {
                    device_id: TEST_DEVICE.into(),
                    remote_session_id: remote_session_id.clone(),
                    cols: 80,
                    rows: 24,
                    owner_id: None,
                    frames: ghosttea::FrameHub::new(8),
                    text_engine: Arc::new(std::sync::Mutex::new(
                        ghosttea::TextEngine::discover().context("discover text engine")?,
                    )),
                })
                .await?;
            Ok(Self {
                runtime,
                transport,
                registry,
                services: HostServices::default(),
                remote_session_id,
                session_id: summary.id,
                hosts: vec![LoopbackHost {
                    server,
                    task,
                    _presentation: presentation,
                    connections: ConnectionLedger::default(),
                    connection_id: 0,
                }],
                offered_minor: PROTOCOL_MINOR,
            })
        }

        async fn feed_view_id(&self) -> Option<String> {
            self.runtime
                .replicas
                .read()
                .await
                .get(&self.session_id)?
                .lifecycle
                .feed_view_id()
        }

        /// How many of this session's live readers publish into the replica.
        async fn feed_reader_count(&self) -> usize {
            self.runtime
                .views
                .lock()
                .await
                .iter()
                .filter(|((session, _), view)| session == &self.session_id && view.feed)
                .count()
        }

        async fn view_state(&self, local_view_id: &str) -> Option<RemoteViewState> {
            self.lifecycle()
                .await
                .views
                .into_iter()
                .find(|view| view.local_view_id == local_view_id)
                .map(|view| view.view_state)
        }

        async fn wait_for_view(&self, local_view_id: &str, state: RemoteViewState) -> Result<()> {
            for _ in 0..200 {
                if self.view_state(local_view_id).await == Some(state) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!("view {local_view_id} never reached {state:?}")
        }

        /// Queue a fresh host connection for the next dial.
        async fn arm_host(&mut self, host_instance_id: &str) -> Result<()> {
            let (connection, host) = connect_loopback_at(
                &self.registry,
                host_instance_id,
                self.offered_minor,
                self.services.clone(),
            )
            .await?;
            self.transport.queue(connection);
            self.hosts.push(host);
            Ok(())
        }

        fn kill_host(&self) {
            for host in &self.hosts {
                host.kill();
            }
        }

        /// Sever the viewer's end without telling the host, so its handlers
        /// keep every attachment they hold.
        async fn black_hole(&self) {
            if let Some(host) = self.runtime.cached_connection(TEST_DEVICE).await {
                host.connection.close();
            }
        }

        async fn lifecycle(&self) -> RemoteSessionLifecycle {
            self.runtime
                .session_lifecycle(&self.session_id)
                .await
                .expect("session lifecycle")
        }

        async fn retained_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
            self.runtime
                .replicas
                .read()
                .await
                .get(&self.session_id)
                .and_then(|remote| remote.replica.retained_snapshot())
        }

        async fn await_first_snapshot(&self) -> Result<LogicalTerminalSnapshot> {
            for _ in 0..200 {
                if let Some(snapshot) = self.retained_snapshot().await {
                    return Ok(snapshot);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!("replica never received a snapshot")
        }

        async fn wait_for_state(&self, state: RemoteLifecycleState) -> Result<()> {
            for _ in 0..200 {
                if self.lifecycle().await.state == state {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!(
                "session never reached {state:?}; it is {:?}",
                self.lifecycle().await.state
            )
        }
    }

    #[test]
    fn rotated_wire_ids_stay_inside_the_host_view_id_cap() {
        let short = "pane-1";
        let first = wire_view_id(short, 1);
        let second = wire_view_id(short, 2);
        assert_eq!(first, "r:pane-1#g1");
        assert_ne!(first, second);

        let long = "p".repeat(128);
        let hashed = wire_view_id(&long, 7);
        assert!(hashed.starts_with("h:"));
        assert!(hashed.len() <= 128);
        assert_ne!(hashed, wire_view_id(&long, 8));
        assert_ne!(wire_view_id(&long, 7), wire_view_id(&"q".repeat(128), 7));

        // The widest possible inline id still fits once the prefix and a
        // u64-sized generation suffix are added.
        let widest = wire_view_id(&"p".repeat(MAX_INLINE_LOCAL_VIEW_ID_BYTES), u64::MAX);
        assert!(widest.starts_with("r:"));
        assert!(widest.len() <= 128);
    }

    #[test]
    fn raw_and_hashed_wire_namespaces_cannot_collide() {
        // A short local id literally equal to another id's hash would share a
        // base without the namespace prefixes.
        let long = "z".repeat(200);
        let hashed = wire_view_id(&long, 3);
        let impostor = hashed
            .strip_prefix("h:")
            .and_then(|rest| rest.split_once("#g"))
            .map(|(base, _)| base.to_owned())
            .expect("hashed wire id shape");
        assert_ne!(wire_view_id(&impostor, 3), hashed);
        assert_eq!(local_view_id_from_wire(&hashed), None);
        assert_eq!(
            local_view_id_from_wire("r:pane-1#g4").as_deref(),
            Some("pane-1")
        );
    }

    #[test]
    fn end_reasons_are_claimed_only_on_listing_evidence() {
        let listed = |attachable, running| SharedSessionSummary {
            session_id: "s".into(),
            title: "t".into(),
            cwd_label: None,
            running,
            attachable,
            read_write: true,
            created_at_ms: 0,
            activity: ghosttea::SessionActivity::default(),
        };
        assert_eq!(ended_reason_from_listing(Some(&listed(true, true))), None);
        // Exited but still attachable resumes normally; exitedness is process
        // metadata, not a lifecycle verdict.
        assert_eq!(ended_reason_from_listing(Some(&listed(true, false))), None);
        assert_eq!(
            ended_reason_from_listing(Some(&listed(false, false))),
            Some(RemoteEndedReason::SessionExited)
        );
        assert_eq!(
            ended_reason_from_listing(Some(&listed(false, true))),
            Some(RemoteEndedReason::SessionClosed)
        );
        assert_eq!(
            ended_reason_from_listing(None),
            Some(RemoteEndedReason::SessionUnavailable)
        );
    }

    #[test]
    fn advertisement_expiry_is_a_probe_trigger() {
        let advertisement = |expires_at_ms| TerminalHostAdvertisement {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            quic_port: DEFAULT_QUIC_PORT,
            host_instance_id: "host-1".into(),
            published_at_ms: 0,
            expires_at_ms,
            sessions: Vec::new(),
        };
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerRemoved {
                    device_id: TEST_DEVICE.into()
                },
                1_000
            )
            .as_deref(),
            Some(TEST_DEVICE)
        );
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerUpdated {
                    device_id: TEST_DEVICE.into(),
                    data: advertisement(500),
                    version: 1,
                },
                1_000
            )
            .as_deref(),
            Some(TEST_DEVICE)
        );
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerUpdated {
                    device_id: TEST_DEVICE.into(),
                    data: advertisement(5_000),
                    version: 1,
                },
                1_000
            ),
            None
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_legacy_pair_rotates_the_wire_identity_per_attempt() -> Result<()> {
        let fixture = Fixture::attached_legacy().await?;
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Live);
        assert_eq!(lifecycle.device_name, "studio-mac");
        assert_eq!(lifecycle.views.len(), 1);
        let view = &lifecycle.views[0];
        assert_eq!(view.local_view_id, "pane-1");
        assert_eq!(view.view_state, RemoteViewState::Attached);
        assert!(view.attachment_epoch.is_some());
        assert_eq!(view.read_write, Some(true));

        // The host only ever saw the rotated identity.
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("attached view");
        assert_eq!(wire, "r:pane-1#g1");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_capable_pair_keeps_one_identity_and_advances_the_lineage() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        let wire = |fixture: &Fixture| {
            let session_id = fixture.session_id.clone();
            let views = Arc::clone(&fixture.runtime.views);
            async move {
                views
                    .lock()
                    .await
                    .get(&(session_id, "pane-1".to_owned()))
                    .map(|view| view.wire_view_id.clone())
            }
        };
        // Reused, not rotated: on this path the host mints a fresh epoch for
        // the same identity, so a new id per attempt would defeat the fence
        // rather than provide one.
        assert_eq!(wire(&fixture).await.as_deref(), Some("r:pane-1"));
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached")
            .0;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        assert_eq!(wire(&fixture).await.as_deref(), Some("r:pane-1"));
        // The lineage counter still advances — it is what a minor-6 host
        // orders attempts by, it just stopped riding in the identity.
        let remote = fixture.remote().await;
        let generation = remote
            .lifecycle
            .state
            .lock()
            .unwrap()
            .views
            .get("pane-1")
            .map(|record| record.generation);
        assert_eq!(generation, Some(2));
        assert_ne!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .expect("resumed")
                .0,
            before
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_capable_host_announces_the_controller_with_a_real_revision() -> Result<()>
    {
        let fixture = Fixture::attached().await?;
        let mut states = fixture.runtime.subscribe_control_state();
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");

        session.claim_control("r:pane-1", "truffle:peer:1", 100, 30)?;
        // The stream's opening frame announces the absence of a controller and
        // can still be in flight here; the claim is the one being asserted.
        let claimed = next_control_state(&mut states, |state| state.controller.is_some()).await?;
        let controller = claimed
            .controller
            .clone()
            .expect("a controller was announced");
        // Translated back to the local id before it crosses the mesh boundary.
        assert_eq!(controller.view_id, "pane-1");
        // A reconnect-capable authority starts at 1, so 0 survives only as the
        // legacy sentinel a client must never compare-and-swap against.
        assert!(claimed.control_revision >= 1);
        assert_eq!(
            fixture
                .runtime
                .last_control_state(&fixture.session_id)
                .and_then(|state| state.controller)
                .map(|controller| controller.view_id),
            Some("pane-1".to_owned()),
            "reconciliation did not retain the announced controller"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_legacy_host_reports_the_unknown_revision_sentinel() -> Result<()> {
        let fixture = Fixture::attached_legacy().await?;
        let mut states = fixture.runtime.subscribe_control_state();
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");

        session.claim_control("r:pane-1#g1", "truffle:peer:1", 100, 30)?;
        let state = tokio::time::timeout(Duration::from_secs(5), states.recv()).await??;
        assert_eq!(
            state.controller.map(|controller| controller.view_id),
            Some("pane-1".to_owned())
        );
        // This host cannot report revisions, and a client must never CAS
        // against the value that says so.
        assert_eq!(state.control_revision, 0);
        Ok(())
    }

    /// Reconnecting is published by the reader that saw the disconnect, and
    /// arming follows it; a test polling for the state can land inside that
    /// gap. The claim is that recovery gets armed — not that it is armed in
    /// the same instant the state is announced.
    async fn wait_for_engine(lifecycle: &SessionLifecycle) -> Result<()> {
        for _ in 0..200 {
            if lifecycle.has_engine() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        bail!("a disconnected session never armed recovery")
    }

    /// The next announced control state the predicate accepts, or an error
    /// rather than a hang.
    async fn next_control_state(
        states: &mut broadcast::Receiver<RemoteControlState>,
        accept: impl Fn(&RemoteControlState) -> bool,
    ) -> Result<RemoteControlState> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = states.recv().await?;
                if accept(&state) {
                    return Ok(state);
                }
            }
        })
        .await
        .context("no matching control-state announcement arrived")?
    }

    /// The opening frame of a state stream has to be able to say "nobody holds
    /// control, at revision N". A viewer that only ever learns control by
    /// watching it change starts blind, with no revision to claim against.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stream_that_opens_with_no_controller_still_reports_the_revision() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let mut announced = None;
        for _ in 0..200 {
            announced = fixture.runtime.last_control_state(&fixture.session_id);
            if announced.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let announced = announced.context("the opening frame announced no control state")?;
        assert!(
            announced.controller.is_none(),
            "nobody has claimed control on this session"
        );
        assert!(
            announced.control_revision >= 1,
            "an absent controller was reported at the un-CAS-able sentinel"
        );
        Ok(())
    }

    /// A re-attached feed opening its stream must not tell the viewer less
    /// than it already knows. The legacy frame carries no revision at all, so
    /// sending that shape to a reconnect-capable viewer retracts the revision
    /// the resume path compare-and-swaps against — and it retracts it on the
    /// resume itself, which is the one path §4.2.3 exists to protect.
    ///
    /// The feed is the subject because only the feed's reader publishes
    /// control state; a secondary's stream is drained without being read into
    /// mesh state, so it can neither carry this bug nor prove its absence.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_re_attached_feed_does_not_retract_the_revision() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let mut states = fixture.runtime.subscribe_control_state();

        // Control belongs to a second viewer, which is what makes it outlive
        // this viewer's re-attach: the feed's fresh stream then opens with a
        // controller present, the case the legacy frame cannot describe.
        session.attach_view("peer:pane", "truffle:peer:2")?;
        session.claim_control("peer:pane", "truffle:peer:2", 100, 30)?;
        let claimed = next_control_state(&mut states, |state| state.controller.is_some()).await?;
        assert!(claimed.control_revision >= 1);

        fixture.runtime.refresh_remote(&fixture.session_id).await?;
        let reopened = next_control_state(&mut states, |_| true).await?;
        assert!(
            reopened.controller.is_some(),
            "the opening frame lost the controller"
        );
        assert!(
            reopened.control_revision >= 1,
            "re-attaching the feed downgraded the session to the legacy sentinel"
        );
        Ok(())
    }

    /// A secondary tells a reconnect-capable host not to open a state stream,
    /// and must then not wait for one. Waiting would cost the whole handshake
    /// timeout and end in a failure that names the wrong thing, so the bound
    /// here is far below it: this test is about the hang, not the attach.
    ///
    /// The third view is the proof the host opened nothing. Every state stream
    /// for a connection arrives on one accept queue, so an unclaimed stream
    /// would be handed to the next attach and fail its preface check.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_secondary_declines_its_state_stream_and_does_not_wait_for_one() -> Result<()> {
        let fixture = Fixture::attached().await?;
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture.runtime.attach_view(&fixture.session_id, "pane-2"),
        )
        .await
        .context("a secondary attach waited for a stream its host was told not to open")??;
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture.runtime.attach_view(&fixture.session_id, "pane-3"),
        )
        .await
        .context("the attach after a secondary stalled")??;
        assert_eq!(
            fixture.feed_reader_count().await,
            1,
            "more than one reader is publishing into the replica"
        );
        assert_eq!(
            fixture.view_state("pane-2").await,
            Some(RemoteViewState::Attached)
        );
        assert_eq!(
            fixture.view_state("pane-3").await,
            Some(RemoteViewState::Attached)
        );
        Ok(())
    }

    /// The compatibility half: secondaries still attach on a pair that
    /// negotiated below the reconnect minor.
    ///
    /// Scope: this cannot exercise the `!supports_reconnect()` guard on the
    /// request itself. That guard exists for hosts old enough to predate the
    /// field and open a stream regardless; the host here is this same
    /// implementation negotiated down, and it honours the field at any minor,
    /// so it behaves identically with the guard removed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_secondary_still_attaches_against_a_legacy_host() -> Result<()> {
        let fixture = Fixture::attached_legacy().await?;
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture.runtime.attach_view(&fixture.session_id, "pane-2"),
        )
        .await
        .context("a secondary attach against a legacy host stalled")??;
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture.runtime.attach_view(&fixture.session_id, "pane-3"),
        )
        .await
        .context("the attach after a legacy secondary stalled")??;
        assert_eq!(
            fixture.view_state("pane-2").await,
            Some(RemoteViewState::Attached)
        );
        Ok(())
    }

    /// A lifecycle with no runtime behind it, for the rules that must hold
    /// under the lock regardless of who is calling.
    fn test_lifecycle() -> Arc<SessionLifecycle> {
        SessionLifecycle::new(
            "session".to_owned(),
            "device".to_owned(),
            "device".to_owned(),
            None,
            broadcast::channel(8).0,
            broadcast::channel(8).0,
        )
    }

    /// A daemon that always gives the same answer. The real one reads its
    /// registry and its tombstones; what crosses the seam is only the verdict.
    struct StaticSessionStatus(ghosttea::SessionStatus);

    impl SessionStatusSource for StaticSessionStatus {
        fn session_status(&self, _session_id: &str) -> ghosttea::SessionStatus {
            self.0
        }
    }

    fn serving_status(status: ghosttea::SessionStatus) -> HostServices {
        HostServices {
            session_status: Some(Arc::new(StaticSessionStatus(status))),
            shutdown: HostShutdownAnnouncer::new(),
        }
    }

    /// The kill-during-outage story: a session that ends while the viewer is
    /// away is gone from the listing when it comes back, and absence alone
    /// cannot say why. Without the consult every such session reads as
    /// "unavailable", which tells a user nothing about what happened to it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_session_killed_during_an_outage_reports_why_not_just_absence() -> Result<()> {
        let mut fixture = Fixture::attached_serving(
            quiet_reconnect(),
            PROTOCOL_MINOR,
            serving_status(ghosttea::SessionStatus::Ended {
                cause: ghosttea::SessionEndCause::Exited { code: Some(0) },
            }),
        )
        .await?;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        // The host outlives the session: it comes back as the same instance,
        // so nothing here can be mistaken for a restart.
        fixture
            .registry
            .write()
            .unwrap()
            .remove(&fixture.remote_session_id);
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Ended);
        assert_eq!(
            lifecycle.reason,
            Some(RemoteEndedReason::SessionExited),
            "absence was reported without the host's own account of it"
        );
        Ok(())
    }

    /// `Unknown` is the honest answer for a tombstone that expired or was
    /// never written, and it must never be sharpened into a specific end.
    ///
    /// Scope: this pins the no-upgrade rule, not the consult — it passes with
    /// the consult disabled too, because falling back to the listing's own
    /// verdict is the same answer arrived at without asking.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_unknown_answer_leaves_absence_where_it_was() -> Result<()> {
        let mut fixture = Fixture::attached_serving(
            quiet_reconnect(),
            PROTOCOL_MINOR,
            serving_status(ghosttea::SessionStatus::Unknown),
        )
        .await?;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture
            .registry
            .write()
            .unwrap()
            .remove(&fixture.remote_session_id);
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        assert_eq!(
            fixture.lifecycle().await.reason,
            Some(RemoteEndedReason::SessionUnavailable),
            "an unknown fate was upgraded to a specific one"
        );
        Ok(())
    }

    /// The drain's first act, seen from the other end. A viewer that is told
    /// the host is going away stops waiting for it, instead of spending the
    /// probe window discovering the same thing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_announced_shutdown_reaches_a_connected_viewer() -> Result<()> {
        let fixture = Fixture::attached_serving(
            quiet_reconnect(),
            PROTOCOL_MINOR,
            serving_status(ghosttea::SessionStatus::Live),
        )
        .await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;

        fixture.services.shutdown.announce();

        fixture.wait_for_state(RemoteLifecycleState::Ended).await?;
        assert_eq!(
            fixture.lifecycle().await.reason,
            Some(RemoteEndedReason::HostShutdown)
        );
        Ok(())
    }

    /// Heartbeat timings small enough to test, in the same proportion as the
    /// shipped 3 s / 6 s: probe at one unit of silence, give up at two.
    fn probing_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            heartbeat_idle: Duration::from_millis(60),
            heartbeat_fail: Duration::from_millis(120),
            // Long enough that a failed probe lands in Reconnecting and stays
            // there to be observed, rather than resting immediately.
            suspend_after: Duration::from_secs(60),
            ..quiet_reconnect()
        }
    }

    /// The same probe cadence as [`probing_reconnect`], with the give-up
    /// window widened far past it.
    ///
    /// A test that asserts a session *dies* is safe at any margin, because a
    /// stalled runner only kills it sooner. A test that asserts a healthy
    /// session *survives* is the opposite: its margin is not the shipped
    /// proportion but the gap between a stalled runner and `heartbeat_fail`,
    /// and at 120 ms that gap is smaller than a scheduler hiccup. A runner
    /// that deschedules the exchange for longer than the whole window starves
    /// a probe the host would have answered, and the viewer correctly kills a
    /// session that was never sick — which is the flake, not the behavior.
    ///
    /// Two seconds is far past any stall this suite has produced, while the
    /// unchanged probe cadence still drives a dozen exchanges through the
    /// window under test.
    fn patient_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            heartbeat_idle: Duration::from_millis(150),
            heartbeat_fail: Duration::from_secs(2),
            // As in `probing_reconnect`: if the probe does fail, the session
            // stays in Reconnecting to be observed rather than resting.
            suspend_after: Duration::from_secs(60),
            ..quiet_reconnect()
        }
    }

    /// The failure the heartbeat exists for: a connection that is up, and a
    /// host that talks, but no answer to what was actually asked. Without
    /// this the session sits Live behind a dead host until the transport's
    /// own idle timeout notices, half a minute later.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_unanswered_probe_declares_the_connection_dead() -> Result<()> {
        let gate = SnapshotGate::default();
        let fixture = Fixture::scripted_at(
            gate.clone(),
            probing_reconnect(),
            HeartbeatBehavior::ReplayStalePongs,
        )
        .await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;

        // The scripted host sends nothing more after its snapshot, so contact
        // goes quiet, the probe goes out, and the pong that comes back
        // answers a nonce nobody is holding.
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        assert!(
            fixture
                .runtime
                .cached_connection(TEST_DEVICE)
                .await
                .is_none(),
            "the connection that failed its probe stayed in the cache"
        );
        Ok(())
    }

    /// The false-positive guard. A real host sends nothing unsolicited, so
    /// every idle session is exactly the quiet a black-holed one presents —
    /// the only difference is the answer, and answering has to be enough.
    ///
    /// The legacy pair is here for symmetry: below the reconnect minor no
    /// heartbeat is opened at all, so nothing can declare it dead. That half
    /// cannot fail while the host under test is this implementation, which
    /// answers probes at any minor.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_answered_probe_leaves_a_quiet_session_alone() -> Result<()> {
        let capable = Fixture::attached_with(patient_reconnect()).await?;
        let legacy =
            Fixture::attached_at(patient_reconnect(), REMOTE_RECONNECT_PROTOCOL_MINOR - 1).await?;
        // Past the window that declares an unanswered session dead, with
        // nothing to break the silence but the heartbeat's own exchange — so
        // the exchange is what these assertions are reading. Held for one
        // window rather than several: crossing the same threshold repeatedly
        // adds no claim, and every extra window is more exposure to the
        // runner stall that made this test flake.
        tokio::time::sleep(Duration::from_millis(2_500)).await;
        assert_eq!(
            capable.lifecycle().await.state,
            RemoteLifecycleState::Live,
            "an answering host lost its session to its own liveness check"
        );
        assert_eq!(
            legacy.lifecycle().await.state,
            RemoteLifecycleState::Live,
            "a pair that carries no heartbeat was declared dead by one"
        );
        Ok(())
    }

    /// A host that says it is going away is believed on the spot: waiting for
    /// the probe to time out would spend six seconds pretending otherwise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_host_shutdown_on_the_heartbeat_stream_ends_the_session() -> Result<()> {
        let gate = SnapshotGate::default();
        let fixture = Fixture::scripted_at(
            gate.clone(),
            probing_reconnect(),
            HeartbeatBehavior::AnnounceShutdown,
        )
        .await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await?;
        fixture.wait_for_state(RemoteLifecycleState::Ended).await?;
        assert_eq!(
            fixture.lifecycle().await.reason,
            Some(RemoteEndedReason::HostShutdown)
        );
        Ok(())
    }

    /// §5's commit-time rule, at the only layer that can enforce it: a task
    /// holding a verdict for a connection that has since been replaced must
    /// neither vouch for the replacement nor tear it down. Checking currency
    /// and acting in two steps is what lets a descheduled task do both.
    #[test]
    fn a_superseded_connection_can_neither_vouch_nor_terminate() {
        let lifecycle = test_lifecycle();
        lifecycle.record_view("pane-1");
        lifecycle.commit_view_attached("pane-1", 1, true);
        lifecycle.bind_connection(2);
        lifecycle.commit_live();

        assert!(
            !lifecycle.note_contact(1),
            "a superseded connection refreshed the current one's contact clock"
        );
        assert!(lifecycle.note_contact(2));
        assert!(
            !lifecycle.commit_host_shutdown(1),
            "a superseded connection ended a session it no longer serves"
        );
        assert_ne!(lifecycle.state_kind(), RemoteLifecycleState::Ended);
        assert!(lifecycle.commit_host_shutdown(2));
        assert_eq!(lifecycle.state_kind(), RemoteLifecycleState::Ended);
    }

    /// Silence is only evidence where the host had a reason to speak. A
    /// session bound elsewhere, or holding nothing attached, must not be able
    /// to condemn a connection it is not using.
    #[test]
    fn only_an_attached_session_on_this_connection_is_evidence_about_it() {
        let lifecycle = test_lifecycle();
        lifecycle.bind_connection(2);
        lifecycle.commit_live();
        assert_eq!(
            lifecycle.contact_age(2),
            None,
            "a session with nothing attached vouched for a connection"
        );

        lifecycle.record_view("pane-1");
        lifecycle.commit_view_attached("pane-1", 1, true);
        lifecycle.commit_live();
        assert!(lifecycle.contact_age(2).is_some());
        assert_eq!(
            lifecycle.contact_age(1),
            None,
            "a session reported on a connection it is not bound to"
        );
    }

    /// The §6.2 table in one place. Each code's action turns on its scope, and
    /// a code this viewer predates is treated as ambiguous rather than guessed
    /// at — an unrecognised code must never be read as "just this pane".
    #[test]
    fn every_rejection_code_maps_to_its_table_action() {
        // Session verdicts: terminal, whichever attach surfaced them.
        assert!(matches!(
            attach_rejection_outcome(AttachRejectCode::UnknownSession, false),
            AttachFailure::Ended(RemoteEndedReason::SessionUnavailable)
        ));
        assert!(matches!(
            attach_rejection_outcome(AttachRejectCode::SessionEpochMismatch, false),
            AttachFailure::Ended(RemoteEndedReason::HostRestarted)
        ));
        // Discarded outright: it marks nothing and re-elects nothing.
        assert!(matches!(
            attach_rejection_outcome(AttachRejectCode::StaleResume, true),
            AttachFailure::Superseded
        ));
        // The only view-scoped code, and the only one that keeps its own
        // variant: the disposition around it differs from a plain failure.
        assert!(matches!(
            attach_rejection_outcome(AttachRejectCode::ViewInvalid, true),
            AttachFailure::ViewInvalid(_)
        ));
        // Definitive refusals: the host has answered, so no redial re-asks.
        for code in [AttachRejectCode::ViewLimit, AttachRejectCode::AccessDenied] {
            assert!(
                matches!(
                    attach_rejection_outcome(code, false),
                    AttachFailure::Rejected(_)
                ),
                "{} should refuse the attempt without ending the session",
                code.as_str()
            );
        }
        // A code this viewer predates is the one that stays ambiguous, which
        // is what earns it the retry the definitive refusals do not get.
        assert!(matches!(
            attach_rejection_outcome(AttachRejectCode::Unknown, false),
            AttachFailure::Failed(_)
        ));
    }

    /// `retryable` is advisory telemetry. A host that sets it on a code the
    /// table says to give up on must not talk the viewer into a retry loop,
    /// and the session behind it is not ended by a per-attach refusal.
    ///
    /// Scope: this pins the *outcome* end to end, not the connection
    /// disposition — every caller of a failed attach already retires the
    /// connection itself, so the table's disposition is only separable on the
    /// secondary path, which no harness here can reach.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_view_limit_rejection_fails_the_attach_without_ending_the_session() -> Result<()> {
        let fixture = Fixture::rejecting(AttachRejectCode::ViewLimit, true).await?;
        let error = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await
            .err()
            .context("the host refused this attach")?;
        assert!(
            format!("{error:#}").contains("view limit"),
            "the failure lost the reason: {error:#}"
        );
        assert_ne!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Ended,
            "a view-scoped refusal ended the whole session"
        );
        Ok(())
    }

    /// The guarantee the takeover path is written against: no write *begins*
    /// after cancellation is observed. The opening burst is writes like any
    /// other, so a stream cancelled before it starts must produce nothing —
    /// otherwise a superseded attachment still receives a snapshot and a
    /// control frame, which is precisely what the epoch fence exists to stop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cancelled_state_stream_writes_no_setup_frames() -> Result<()> {
        let registry = Registry::default();
        let remote_session_id = spawn_host_session(&registry)?;
        let session = registry
            .read()
            .unwrap()
            .get(&remote_session_id)
            .cloned()
            .expect("host session");
        session.attach_view("r:pane-1", "truffle:peer:1")?;

        let (client, server) = loopback_pair();
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        // Cancelled before the stream is asked for anything at all.
        cancel.send_replace(true);
        let (_presentation, presentation_rx) = tokio::sync::watch::channel(Arc::new(
            ghosttea::ConfigSnapshot::default().terminal_presentation(),
        ));
        spawn_state_stream(
            Arc::clone(&server) as Arc<dyn MeshConnection>,
            session,
            "r:pane-1",
            cancelled,
            StateCodec::Json,
            PROTOCOL_MINOR,
            presentation_rx,
        )
        .await?;

        // The stream itself may be opened — that is not a write — but nothing
        // may be written on it.
        let stream = tokio::time::timeout(Duration::from_millis(200), client.accept_stream()).await;
        let Ok(Ok(Some(stream))) = stream else {
            return Ok(());
        };
        let mut state = ProtocolStream::new(stream);
        let framed = tokio::time::timeout(Duration::from_millis(200), state.read_preface()).await;
        assert!(
            framed.is_err() || framed.unwrap().is_err(),
            "a cancelled stream still wrote its opening frames"
        );
        Ok(())
    }

    /// A session that ends while a viewer is watching has to say so. The
    /// tombstone path only covers sessions that died during an outage; with a
    /// live connection and the heartbeat answering, nothing else would ever
    /// tell this viewer, and it would sit Live on a session that is gone.
    ///
    /// The connection is the second half: one session concluding is not a
    /// transport fault, and retiring the connection here would take every
    /// sibling session on the same device down with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_session_that_ends_while_watched_reports_it_and_keeps_the_connection() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");

        session.terminate(ghosttea::TerminationSource::User)?;

        fixture.wait_for_state(RemoteLifecycleState::Ended).await?;
        assert_eq!(
            fixture.lifecycle().await.reason,
            Some(RemoteEndedReason::SessionExited),
            "the viewer never learned why the session it was watching ended"
        );
        assert!(
            fixture
                .runtime
                .cached_connection(TEST_DEVICE)
                .await
                .is_some(),
            "a session ending cleanly retired the connection its siblings ride"
        );
        Ok(())
    }

    /// A secondary declines its state stream, so it has no control channel of
    /// its own to hear the outcome on. Claiming from one must still work:
    /// control is a property of the session, not of the pane that asked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_streamless_secondary_can_still_claim_control() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let attachment = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            fixture.runtime.claim_control_at(
                &fixture.session_id,
                "pane-2",
                attachment.attachment_epoch,
                100,
                30,
                None,
            ),
        )
        .await
        .context("claiming from a secondary hung")??;

        let RemoteControlOutcome::Claimed(state) = outcome else {
            bail!("a secondary's claim was rejected");
        };
        assert_eq!(
            state.controller.map(|controller| controller.view_id),
            Some("pane-2".to_owned())
        );
        Ok(())
    }

    /// Waits until the client has heard the session's opening control frame and returns it.
    async fn opening_control_frame(fixture: &Fixture) -> Result<RemoteControlState> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(state) = fixture.runtime.last_control_state(&fixture.session_id) {
                    return state;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .context("the session's opening control frame never arrived")
    }

    /// The race the claim used to lose (a Windows CI red on the 0.13.5 release
    /// PR): a secondary claims before the primary's stream has delivered the
    /// session's opening control frame. The claim settles on the first
    /// announcement after its request, so that frame, landing late, read as a
    /// refusal. Here the client is put exactly where a slow stream leaves it, and
    /// the claim must not ask until the frame lands.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_claim_waits_for_the_opening_control_frame_before_asking() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let attachment = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        let opening = opening_control_frame(&fixture).await?;
        fixture
            .runtime
            .control_states
            .lock()
            .unwrap()
            .remove(&fixture.session_id);
        let host = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .context("the host session is registered")?;
        let revision = host.control_snapshot().control_revision;

        let claim = fixture.runtime.claim_control_at(
            &fixture.session_id,
            "pane-2",
            attachment.attachment_epoch,
            100,
            30,
            None,
        );
        tokio::pin!(claim);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut claim)
                .await
                .is_err(),
            "the claim settled before the session's opening control frame arrived"
        );
        assert_eq!(
            host.control_snapshot().control_revision,
            revision,
            "the claim asked before the session's opening control frame arrived"
        );

        publish_control_state(
            &fixture.runtime.control_states,
            &fixture.runtime.control_state_tx,
            opening,
        );
        let outcome = tokio::time::timeout(Duration::from_secs(5), claim)
            .await
            .context("the claim hung after the opening control frame arrived")??;
        let RemoteControlOutcome::Claimed(state) = outcome else {
            bail!("the late opening control frame was read as the claim's refusal");
        };
        assert_eq!(
            state.controller.map(|controller| controller.view_id),
            Some("pane-2".to_owned())
        );
        Ok(())
    }

    /// The wait applies only where an opening frame is actually owed: a streamed
    /// view whose frame has not arrived. Once the frame is heard, or when this
    /// client holds no streamed view of the session, a claim asks at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn only_a_pending_streamed_view_makes_a_claim_wait() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let attachment = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        opening_control_frame(&fixture).await?;
        assert!(
            !fixture
                .runtime
                .awaits_opening_control_frame(&fixture.session_id)
                .await,
            "a claim waited for an opening frame the client had already heard"
        );

        fixture
            .runtime
            .control_states
            .lock()
            .unwrap()
            .remove(&fixture.session_id);
        assert!(
            fixture
                .runtime
                .awaits_opening_control_frame(&fixture.session_id)
                .await,
            "a streamed view with no frame heard yet did not make the claim wait"
        );

        // With no streamed view of the session, there is no frame to wait for.
        fixture
            .runtime
            .views
            .lock()
            .await
            .retain(|(session, _), view| !(session == &fixture.session_id && view.feed));
        assert!(
            !fixture
                .runtime
                .awaits_opening_control_frame(&fixture.session_id)
                .await,
            "a claim waited although no streamed view owes an opening frame"
        );
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            fixture.runtime.claim_control_at(
                &fixture.session_id,
                "pane-2",
                attachment.attachment_epoch,
                100,
                30,
                None,
            ),
        )
        .await
        .context("a claim with no streamed view waited out the handshake")??;
        assert!(matches!(outcome, RemoteControlOutcome::Claimed(_)));
        Ok(())
    }

    /// The compare-and-swap the whole reclaim path rests on: a claim naming a
    /// revision the host has moved past must lose. Discarding the expectation
    /// host-side would silently turn every reclaim back into last-write-wins.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_claim_against_a_stale_revision_is_refused() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let attachment = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        // Subscribe first, then move the revision on and wait for the viewer
        // to have seen it: otherwise the announcement below could still be in
        // flight and settle the swap by arriving, which would let this test
        // pass on a race rather than on the comparison it is about.
        let mut states = fixture.runtime.subscribe_control_state();
        session.claim_control("r:pane-1", "truffle:peer:1", 100, 30)?;
        let observed = next_control_state(&mut states, |state| {
            state
                .controller
                .as_ref()
                .is_some_and(|controller| controller.view_id == "pane-1")
        })
        .await?;
        let stale = observed
            .control_revision
            .checked_sub(1)
            .context("the host must be past its first revision for this to be a swap")?;

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            fixture.runtime.claim_control_at(
                &fixture.session_id,
                "pane-2",
                attachment.attachment_epoch,
                100,
                30,
                Some(stale),
            ),
        )
        .await
        .context("the swap never settled")??;

        assert!(
            matches!(outcome, RemoteControlOutcome::Rejected(_)),
            "a claim against a superseded revision was granted"
        );
        Ok(())
    }

    /// §5's admission rule, at the layer that enforces it: a reader belongs to
    /// one connection incarnation as well as one generation. Attaching another
    /// view rebinds the incarnation without advancing the generation, so
    /// generation alone would still admit a reader from the replaced
    /// connection — and let it refresh the contact clock on the new one's
    /// behalf, which is exactly the black hole the heartbeat exists to catch.
    #[test]
    fn state_admission_is_scoped_to_the_connection_as_well_as_the_generation() {
        let lifecycle = test_lifecycle();
        lifecycle.bind_connection(7);
        let generation = lifecycle.generation();

        assert!(lifecycle.admit_state(generation, 7));
        assert!(
            !lifecycle.admit_state(generation, 6),
            "a reader from a replaced connection was admitted on generation alone"
        );

        lifecycle.bind_connection(8);
        assert!(
            !lifecycle.admit_state(generation, 7),
            "rebinding the connection left the old incarnation admitted"
        );
        assert!(lifecycle.admit_state(generation, 8));
    }

    /// The disposition the §6.2 table makes asymmetric: a secondary that hits
    /// the client's view cap loses that pane and nothing else. Retiring the
    /// connection here would take down a Live session — and every sibling
    /// session riding the same transport — over one refused pane.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_secondary_view_limit_leaves_the_live_session_and_its_connection() -> Result<()> {
        let fixture = Fixture::rejecting_after(AttachRejectCode::ViewLimit, true, 1).await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;

        assert!(
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-2")
                .await
                .is_err(),
            "the host refused this pane"
        );
        assert!(
            fixture
                .runtime
                .cached_connection(TEST_DEVICE)
                .await
                .is_some(),
            "a refused secondary retired the connection its live session rides"
        );
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Live,
            "a refused secondary took down the session around it"
        );
        Ok(())
    }

    /// `view-invalid` is the one code with an in-place recovery: the refused
    /// pane is marked and the next eligible view takes the feed on the same
    /// connection, rather than the session falling out of Live.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_refused_feed_identity_promotes_the_next_view_in_place() -> Result<()> {
        let fixture = Fixture::rejecting_after(AttachRejectCode::ViewInvalid, true, 0).await?;
        // pane-1 is refused; the session keeps no usable feed yet.
        assert!(
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-1")
                .await
                .is_err()
        );
        assert!(
            fixture
                .runtime
                .cached_connection(TEST_DEVICE)
                .await
                .is_some(),
            "a refused identity retired a connection that never failed"
        );
        assert_eq!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Failed)
        );
        // Election must not hand the feed back to the pane the host refused.
        let remote = fixture.remote().await;
        remote.lifecycle.record_view("pane-2");
        assert_eq!(
            remote.lifecycle.elect_feed().as_deref(),
            Some("pane-2"),
            "election re-picked the pane the host had already refused"
        );
        Ok(())
    }

    /// A stale resume is the one rejection that decides nothing: a newer
    /// attempt is already governing the lineage. It must not retire the
    /// connection that answered it — that connection is working.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stale_resume_rejection_keeps_the_connection() -> Result<()> {
        let fixture = Fixture::rejecting(AttachRejectCode::StaleResume, false).await?;
        let error = fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await
            .err()
            .context("the host refused this attach")?;
        assert!(
            format!("{error:#}").contains("superseded"),
            "a stale resume was reported as something else: {error:#}"
        );
        assert!(
            fixture
                .runtime
                .cached_connection(TEST_DEVICE)
                .await
                .is_some(),
            "a superseded attempt retired a connection that never failed"
        );
        // Pending is the honest record: the pane is waiting on the attempt
        // that superseded this one. Failed would be this attempt claiming a
        // verdict it does not have.
        assert_ne!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Failed),
            "a superseded attempt marked the pane it decided nothing about"
        );
        Ok(())
    }

    /// The clear half: a controller that goes away is announced to the views
    /// that stayed. Only `ControlState` can carry the absence, so this is the
    /// end-to-end proof that the reconnect shape survives the whole path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_clear_reaches_a_view_whose_stream_was_already_open() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let mut states = fixture.runtime.subscribe_control_state();

        // Control goes to the secondary, so releasing it detaches nothing the
        // feed depends on and pane-1's stream is the one left listening.
        session.claim_control("r:pane-2", "truffle:peer:1", 100, 30)?;
        let claimed = next_control_state(&mut states, |state| state.controller.is_some()).await?;

        let (attachment_epoch, _) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-2")
            .await
            .context("pane-2 is attached")?;
        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-2", attachment_epoch)
            .await;

        let cleared = next_control_state(&mut states, |state| state.controller.is_none()).await?;
        assert!(
            cleared.control_revision > claimed.control_revision,
            "the clear did not advance the revision"
        );
        assert!(
            fixture
                .runtime
                .last_control_state(&fixture.session_id)
                .is_some_and(|state| state.controller.is_none()),
            "reconciliation kept a controller that is gone"
        );
        Ok(())
    }

    #[test]
    fn the_attach_fence_covers_connections_not_yet_bound_to_a_client() {
        let ledger = ConnectionLedger::default();
        let mine = ledger.accept();
        mine.identify("truffle:peer:1");
        // Accepted after mine and still pre-hello: it may yet turn out to be
        // this client's, and may already carry a delayed attach.
        let unidentified = ledger.accept();

        assert!(
            ledger.highest_for("truffle:peer:1") >= unidentified.id(),
            "the fence did not cover a connection that could still be this client's"
        );
        // The two must agree, or collection stalls rather than slows: the
        // fence would sit above an id the collector refuses to pass.
        assert!(ledger.terminated_through("truffle:peer:1") < unidentified.id());

        // Another client's *identified* connection blocks neither.
        let theirs = ledger.accept();
        theirs.identify("truffle:peer:2");
        assert!(ledger.highest_for("truffle:peer:1") < theirs.id());

        drop(unidentified);
        drop(mine);
        assert!(ledger.terminated_through("truffle:peer:1") >= 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_superseded_handler_does_not_detach_its_successor() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        let first = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-2")
            .await
            .expect("secondary attached")
            .0;

        // Strand the host's handler: the viewer drops the view without ever
        // sending Detach, so that handler keeps running against an attachment
        // a takeover is about to replace.
        fixture
            .runtime
            .retire_view(&fixture.session_id, "pane-2")
            .await;
        fixture
            .remote()
            .await
            .lifecycle
            .commit_view_failed("pane-2", "stranded".into(), true);

        let record = fixture
            .runtime
            .retry_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(
            record.view_state,
            RemoteViewState::Attached,
            "the successor never attached: {record:?}"
        );
        let second = record.attachment_epoch.expect("successor epoch");
        assert_ne!(second, first);

        // The stranded handler exits here. Detaching by (view, client) alone
        // would take the successor's attachment with it — and, landing between
        // the takeover and its stream registration, would leave the successor
        // with no state stream at all.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-2")
                .await
                .map(|(epoch, _)| epoch),
            Some(second),
            "a superseded handler detached its successor"
        );
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_dead_connection_suspends_the_session_and_rejects_input() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        let epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Suspended {
                break event;
            }
        };
        assert_eq!(event.session_id, fixture.session_id);
        assert_eq!(event.device_id, TEST_DEVICE);
        assert_eq!(event.device_name, "studio-mac");
        assert_eq!(event.reason, None);
        assert_eq!(event.exit, None);
        // Phase 1 schedules nothing: Suspended is a resting state, not a
        // countdown.
        assert_eq!(event.next_retry_ms, None);
        assert!(event.last_contact_ms.is_some());

        // The view is no longer attached, so there is no epoch to speak with
        // and input fails cleanly rather than being queued or panicking.
        assert!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .is_none()
        );
        let rejected = fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                1,
                TunnelInput::Text("rm -rf tmp\n".into()),
            )
            .await;
        assert!(rejected.is_err());
        assert_eq!(
            fixture.lifecycle().await.views[0].view_state,
            RemoteViewState::Pending
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_shot_resume_reattaches_under_a_fresh_epoch_and_generation() -> Result<()> {
        let mut fixture = Fixture::attached_legacy().await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;
        let before_seq = fixture.lifecycle().await.lifecycle_seq;
        let dials_before = fixture.transport.dials();

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        assert!(resumed.lifecycle_seq > before_seq);
        // Exactly one dial: Phase 1 is a one-shot resume, not an engine.
        assert_eq!(fixture.transport.dials(), dials_before + 1);
        // Live is reported only after the recovery snapshot has applied.
        assert!(fixture.retained_snapshot().await.is_some());

        let (after, read_write) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch");
        assert!(read_write);
        assert_ne!(after, before);

        // Rotation means the host minted a new identity, so the epoch is new
        // and the old one is dead.
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("resumed view");
        assert_eq!(wire, "r:pane-1#g2");

        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                after,
                1,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        assert!(
            fixture
                .runtime
                .send_input(
                    &fixture.session_id,
                    "pane-1",
                    before,
                    2,
                    TunnelInput::Text("stale".into()),
                )
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_host_ends_the_session_without_dialing() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let dials = fixture.transport.dials();
        fixture.transport.advertise(Some("host-2"));
        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Ended);
        assert_eq!(resumed.reason, Some(RemoteEndedReason::HostRestarted));
        assert_eq!(fixture.transport.dials(), dials);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_session_absent_from_the_listing_ends_as_unavailable() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        fixture
            .registry
            .write()
            .unwrap()
            .remove(&fixture.remote_session_id);
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Ended);
        assert_eq!(resumed.reason, Some(RemoteEndedReason::SessionUnavailable));
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_listing_showing_an_exited_unattachable_session_ends_as_exited() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        fixture
            .runtime
            .reconcile_evidence(
                TEST_DEVICE,
                &[SharedSessionSummary {
                    session_id: fixture.remote_session_id.clone(),
                    title: "cat".into(),
                    cwd_label: None,
                    running: false,
                    attachable: false,
                    read_write: true,
                    created_at_ms: 0,
                    activity: ghosttea::SessionActivity::default(),
                }],
            )
            .await;
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Ended);
        assert_eq!(lifecycle.reason, Some(RemoteEndedReason::SessionExited));
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn input_is_rejected_while_a_view_is_attached_but_the_session_is_not_live() -> Result<()>
    {
        let fixture = Fixture::attached().await?;
        let (epoch, _) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch");
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        // The host sends ViewAttached before it opens the state stream, so a
        // view can be attached while recovery is still in flight.
        lifecycle.commit_synchronizing();
        let typed = fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                1,
                TunnelInput::Text("rm -rf tmp\n".into()),
            )
            .await;
        assert!(typed.is_err());
        assert!(
            fixture
                .runtime
                .resize(
                    &fixture.session_id,
                    "pane-1",
                    RemoteResize {
                        attachment_epoch: epoch,
                        control_epoch: 1,
                        resize_sequence: 1,
                        cols: 90,
                        rows: 30,
                    },
                )
                .await
                .is_err()
        );

        lifecycle.commit_live();
        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                2,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_initial_open_stays_synchronizing_until_its_first_snapshot() -> Result<()> {
        let gate = SnapshotGate::default();
        gate.hold("pane-1");
        let fixture = Fixture::scripted(gate.clone()).await?;

        let session_id = fixture.session_id.clone();
        let runtime = fixture.runtime.clone();
        let attaching =
            tokio::spawn(async move { runtime.attach_view(&session_id, "pane-1").await });

        // The host answered ViewAttached, but the authoritative screen does not
        // exist yet — the session must not claim to be live.
        fixture
            .wait_for_state(RemoteLifecycleState::Synchronizing)
            .await?;
        assert!(
            fixture
                .runtime
                .send_input(
                    &fixture.session_id,
                    "pane-1",
                    1,
                    1,
                    TunnelInput::Text("rm -rf tmp\n".into()),
                )
                .await
                .is_err(),
            "input was accepted before the first snapshot"
        );

        gate.release("pane-1");
        let attachment = attaching.await??;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        assert!(fixture.retained_snapshot().await.is_some());
        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                attachment.attachment_epoch,
                1,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_feed_that_never_synchronizes_leaves_nothing_attached() -> Result<()> {
        let gate = SnapshotGate::default();
        gate.hold("pane-1");
        let fixture = Fixture::scripted(gate.clone()).await?;
        fixture
            .runtime
            .set_synchronize_timeout(Duration::from_millis(150));

        assert!(
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-1")
                .await
                .is_err()
        );
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        // The abandoned attempt must leave no attachment behind and no reader
        // able to touch the replica the user has been told is frozen.
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await,
            None
        );
        assert_eq!(fixture.feed_reader_count().await, 0);

        gate.release("pane-1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            fixture.retained_snapshot().await.is_none(),
            "a late snapshot mutated the frozen replica"
        );
        assert_eq!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Pending)
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_a_secondary_leaves_the_session_and_its_feed_alone() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        let feed_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("feed attachment");
        let secondary_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-2")
            .await
            .expect("secondary attachment")
            .0;

        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-2", secondary_epoch)
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        // A deliberate detach is the caller's intent, not a disconnect.
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await,
            Some(feed_epoch)
        );
        assert_eq!(fixture.feed_reader_count().await, 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resumed_multi_view_session_publishes_from_exactly_one_stream() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        fixture.await_first_snapshot().await?;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        // Live is gated on the feed alone; secondaries attach behind it.
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        assert_eq!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Attached)
        );
        fixture
            .wait_for_view("pane-2", RemoteViewState::Attached)
            .await?;

        // Two publishing readers would interleave independent patch sequences
        // into the one replica.
        assert_eq!(fixture.feed_reader_count().await, 1);

        // The surviving feed still tracks the host, and nothing corrupted it.
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let feed_wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("feed view");
        session.claim_control(&feed_wire, "truffle:peer:1", 100, 30)?;
        for _ in 0..200 {
            let summary = fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .map(|remote| remote.replica.summary())
                .expect("session");
            if (summary.cols, summary.rows) == (100, 30) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        bail!("the resumed feed never applied the host's resize")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_secondary_never_gates_the_session() -> Result<()> {
        let gate = SnapshotGate::default();
        let fixture = Fixture::scripted(gate.clone()).await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;

        // This pane's stream will never produce a snapshot.
        gate.hold("pane-2");
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;

        // A secondary is not the feed, so it neither waits for a snapshot nor
        // pulls the session back through Synchronizing.
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture.view_state("pane-2").await,
            Some(RemoteViewState::Attached)
        );
        assert_eq!(fixture.feed_reader_count().await, 1);
        while let Ok(event) = lifecycles.try_recv() {
            assert_ne!(
                event.state,
                RemoteLifecycleState::Synchronizing,
                "a secondary pulled the session back into synchronizing"
            );
        }
        gate.release("pane-2");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_the_feed_promotes_a_survivor_and_resynchronizes() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        let feed_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("feed attachment")
            .0;

        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-1", feed_epoch)
            .await;

        // Promotion is a generation-advanced re-attach, so the survivor gets a
        // fresh stream and a full snapshot rather than an in-place switch.
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-2"));
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-2")
                .await
                .is_some()
        );
        assert!(fixture.retained_snapshot().await.is_some());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lapsed_advertisement_probes_without_any_discovery_event() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // A fresh advertisement is not a probe trigger.
        fixture.runtime.probe_lapsed_advertisements().await;
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert!(
            fixture
                .runtime
                .lapsed_advertisement_devices()
                .await
                .is_empty()
        );

        // A host process can stall while its device stays online: no store
        // event ever fires, the advertisement just ages out.
        fixture.transport.advertise(None);
        assert_eq!(
            fixture.runtime.lapsed_advertisement_devices().await,
            vec![TEST_DEVICE.to_owned()]
        );
        fixture.kill_host();
        fixture.runtime.probe_lapsed_advertisements().await;
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        Ok(())
    }

    /// An engine that retries fast enough for a test to watch it work.
    fn eager_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            backoff_base: Duration::from_millis(10),
            backoff_cap: Duration::from_millis(40),
            backoff_floor: Duration::from_millis(5),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        }
    }

    #[test]
    fn full_jitter_backoff_stays_inside_its_doubling_window() {
        let config = MeshReconnectConfig::default();
        // The window doubles per attempt and is then capped; every sample
        // lands inside it, floored so a hot loop cannot form.
        for attempt in 0..12_u32 {
            let window = config
                .backoff_base
                .saturating_mul(2_u32.saturating_pow(attempt))
                .min(config.backoff_cap);
            for _ in 0..64 {
                let delay = backoff_delay(&config, attempt, &uniform_jitter());
                assert!(
                    delay >= config.backoff_floor,
                    "attempt {attempt}: {delay:?}"
                );
                assert!(
                    delay <= window.max(config.backoff_floor),
                    "attempt {attempt}: {delay:?} exceeds {window:?}"
                );
            }
        }
        // Full jitter, not equal jitter: the samples must actually spread.
        let late = (0..256)
            .map(|_| backoff_delay(&config, 8, &uniform_jitter()))
            .collect::<Vec<_>>();
        let spread = late
            .iter()
            .max()
            .unwrap()
            .saturating_sub(*late.iter().min().unwrap());
        assert!(
            spread > Duration::from_secs(1),
            "samples barely varied: {spread:?}"
        );
    }

    /// A runtime wired to a test transport, with no session opened yet.
    async fn bare_runtime() -> (MeshRuntime, Arc<TestTransport>) {
        let transport = TestTransport::new("host-1");
        let runtime = MeshRuntime::new();
        runtime.set_reconnect_config(quiet_reconnect());
        runtime
            .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
            .await;
        (runtime, transport)
    }

    struct RefusingClientResolver;

    #[async_trait]
    impl ClientResolver for RefusingClientResolver {
        async fn resolve(&self, _device_id: &str, _remote_ip: Option<IpAddr>) -> Result<String> {
            bail!("client hello asserts a device that is not a current Truffle peer")
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_client_whose_identity_does_not_resolve_gets_no_server_hello() -> Result<()> {
        let (client, server) = loopback_pair();
        let (_presentation, presentation_rx) = tokio::sync::watch::channel(Arc::new(
            ghosttea::ConfigSnapshot::default().terminal_presentation(),
        ));
        let host = tokio::spawn(serve_connection(
            Arc::clone(&server) as Arc<dyn MeshConnection>,
            Registry::default(),
            TruffleTerminalConfig::default(),
            HostServices::default(),
            "host-1".into(),
            Arc::new(RefusingClientResolver) as Arc<dyn ClientResolver>,
            None,
            presentation_rx,
            ConnectionLedger::default().accept(),
        ));
        // Identity now rides the hello, so an unresolvable device must be
        // refused there rather than being handed a session surface.
        assert!(
            client_handshake(
                client as Arc<dyn MeshConnection>,
                "viewer-device",
                "viewer-instance",
                "host-1",
                PROTOCOL_MINOR,
            )
            .await
            .is_err()
        );
        assert!(host.await?.is_err());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_connection_that_breaks_after_dialing_is_evicted() -> Result<()> {
        let registry = Registry::default();
        spawn_host_session(&registry)?;
        let (runtime, transport) = bare_runtime().await;

        // A connection that completes its handshake and only then dies —
        // exactly what a dial at a host that is about to stop responding
        // produces.
        let (dead, dead_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(dead);
        dead_host.kill();

        assert!(runtime.list_sessions_once(TEST_DEVICE).await.is_err());
        // Nothing may keep it: cached and still flagged healthy, it would be
        // handed to every later caller, including ones that must dial fresh.
        assert!(
            runtime.cached_connection(TEST_DEVICE).await.is_none(),
            "a broken connection stayed in the cache"
        );

        let (live, _live_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(live);
        assert_eq!(runtime.list_sessions_once(TEST_DEVICE).await?.len(), 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_dials_converge_on_one_connection() -> Result<()> {
        let registry = Registry::default();
        spawn_host_session(&registry)?;
        let (runtime, transport) = bare_runtime().await;
        let (first, _first_host) = connect_loopback(&registry, "host-1").await?;
        let (second, _second_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(first);
        transport.queue(second);

        // Dialing happens off the cache lock, so two callers can be in flight
        // at once; they must still end up sharing one published connection
        // rather than clobbering each other.
        let left = runtime.clone();
        let right = runtime.clone();
        let (left, right) = tokio::join!(
            async move { left.remote_connection(TEST_DEVICE).await },
            async move { right.remote_connection(TEST_DEVICE).await },
        );
        let (left, right) = (left?, right?);
        let cached = runtime
            .cached_connection(TEST_DEVICE)
            .await
            .expect("a connection is published");
        assert!(
            Arc::ptr_eq(&left, &right),
            "callers got different connections"
        );
        assert!(
            Arc::ptr_eq(&left, &cached),
            "the cache holds a third connection"
        );
        Ok(())
    }

    impl Fixture {
        async fn remote(&self) -> RemoteSession {
            self.runtime
                .replicas
                .read()
                .await
                .get(&self.session_id)
                .cloned()
                .expect("open remote session")
        }

        async fn has_view(&self, local_view_id: &str) -> bool {
            self.runtime
                .views
                .lock()
                .await
                .contains_key(&(self.session_id.clone(), local_view_id.to_owned()))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_handoff_lands_in_reconnecting_with_the_engine_armed() -> Result<()> {
        // A real suspend_after, so the armed engine stays in Reconnecting
        // instead of parking before the assertions below can read it.
        let fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(200),
            backoff_cap: Duration::from_millis(200),
            backoff_floor: Duration::from_millis(200),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.await_first_snapshot().await?;
        let remote = fixture.remote().await;

        // Make the replacement unattainable without closing anything: with no
        // advertisement the dial is refused before the cache is touched, so
        // the only thing that can move the lifecycle is the handoff itself.
        fixture.transport.advertise(None);
        assert!(fixture.runtime.reestablish_feed(&remote).await.is_err());

        // The handoff cancelled every reader deliberately, so no reader will
        // report a disconnect. If this path did not transition, the session
        // would sit claiming a liveness it no longer has.
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Reconnecting);
        // The view that failed keeps `failed` so it can carry why; what must
        // never survive is a claimed attachment.
        assert!(
            lifecycle.views.iter().all(|view| {
                view.view_state != RemoteViewState::Attached
                    && view.attachment_epoch.is_none()
                    && view.read_write.is_none()
            }),
            "a view still claimed an attachment: {:?}",
            lifecycle.views
        );
        assert_eq!(fixture.feed_reader_count().await, 0);
        assert!(
            remote.lifecycle.has_engine(),
            "nothing was left to recover the session"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_manual_retries_run_exactly_one_attempt() -> Result<()> {
        let mut fixture = Fixture::attached_legacy().await?;
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;

        let dials = fixture.transport.dials();
        let left = fixture.runtime.clone();
        let right = fixture.runtime.clone();
        let session = fixture.session_id.clone();
        let other = fixture.session_id.clone();
        let (left, right) = tokio::join!(
            async move { left.reconnect_session(&session).await },
            async move { right.reconnect_session(&other).await },
        );
        assert_eq!(left?.state, RemoteLifecycleState::Live);
        assert_eq!(right?.state, RemoteLifecycleState::Live);

        // The loser must recognise the job is done. A second full pass would
        // retire the views the winner just attached and invalidate the epoch
        // it just handed back — and every pass rotates the wire identity, so
        // the generation is what gives a duplicate away. (The dial count does
        // not: a second resume reuses the connection the first established.)
        assert_eq!(fixture.transport.dials(), dials + 1);
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("resumed view");
        assert_eq!(
            wire, "r:pane-1#g2",
            "a second resume rotated the view again"
        );
        let epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed attachment")
            .0;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .map(|(epoch, _)| epoch),
            Some(epoch),
            "the epoch moved after the retries settled"
        );
        assert_eq!(fixture.feed_reader_count().await, 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_secondary_task_from_a_retired_activation_publishes_nothing() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let remote = fixture.remote().await;
        let generation = remote.lifecycle.generation();
        remote.lifecycle.record_view("pane-2");

        // The activation this task belongs to is over — a promotion, refresh,
        // or duplicate resume moved on without it.
        remote.lifecycle.advance_generation();
        fixture
            .runtime
            .attach_secondaries(&remote, vec!["pane-2".to_owned()], generation)
            .await;

        assert!(
            !fixture.has_view("pane-2").await,
            "a stale task installed a view into the current generation"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn only_the_first_reader_of_a_dead_connection_arms_recovery() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let remote = fixture.remote().await;
        let view = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .cloned()
            .expect("attached view");

        // Every view riding one connection reports the same death.
        assert!(
            remote
                .lifecycle
                .commit_disconnect(view.state_generation, view.incarnation)
        );
        assert!(
            !remote
                .lifecycle
                .commit_disconnect(view.state_generation, view.incarnation),
            "a second reader re-armed an engine that was already dialing"
        );
        assert!(
            !remote
                .lifecycle
                .commit_disconnect(view.state_generation, view.incarnation)
        );
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Reconnecting
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn retry_view_reattaches_a_secondary_and_refuses_the_feed() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));

        // Strand the secondary the way a failed pane is stranded: no
        // attachment, session otherwise untouched.
        fixture
            .runtime
            .retire_view(&fixture.session_id, "pane-2")
            .await;
        fixture
            .remote()
            .await
            .lifecycle
            .commit_view_failed("pane-2", "view-invalid".into(), true);

        let record = fixture
            .runtime
            .retry_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(
            record.view_state,
            RemoteViewState::Attached,
            "retry left the view unattached: {record:?}"
        );
        assert!(record.attachment_epoch.is_some());
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        // Still exactly one publishing stream.
        assert_eq!(fixture.feed_reader_count().await, 1);

        // The feed and the session itself belong to the session-level paths.
        assert!(
            fixture
                .runtime
                .retry_view(&fixture.session_id, "pane-1")
                .await
                .is_err()
        );
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        assert!(
            fixture
                .runtime
                .retry_view(&fixture.session_id, "pane-2")
                .await
                .is_err()
        );
        Ok(())
    }

    /// Always takes the whole window, so a schedule is exactly predictable.
    fn full_window_jitter() -> JitterSource {
        Arc::new(|window| window)
    }

    #[test]
    fn an_injected_sampler_makes_the_schedule_exact() {
        let config = MeshReconnectConfig {
            backoff_base: Duration::from_millis(100),
            backoff_cap: Duration::from_millis(400),
            backoff_floor: Duration::from_millis(50),
            ..MeshReconnectConfig::default()
        };
        let jitter = full_window_jitter();
        let schedule = (0..5)
            .map(|attempt| backoff_delay(&config, attempt, &jitter).as_millis())
            .collect::<Vec<_>>();
        // Doubling until the cap, then held there.
        assert_eq!(schedule, vec![100, 200, 400, 400, 400]);

        // The floor wins over a sampler that returns nothing, so no schedule
        // can degenerate into a hot loop.
        let zero: JitterSource = Arc::new(|_| Duration::ZERO);
        assert_eq!(backoff_delay(&config, 0, &zero), Duration::from_millis(50));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_engine_follows_the_scheduled_delays_it_announces() -> Result<()> {
        let fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(60),
            backoff_cap: Duration::from_millis(240),
            backoff_floor: Duration::from_millis(10),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.runtime.set_jitter(full_window_jitter());
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        fixture.kill_host();
        let mut schedule = Vec::new();
        while schedule.len() < 4 {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Reconnecting
                && let Some(delay) = event.next_retry_ms
            {
                schedule.push((event.attempt, delay));
            }
        }
        // Exactly the doubling-then-capped sequence, announced with a real
        // attempt counter rather than a placeholder.
        assert_eq!(schedule, vec![(1, 60), (2, 120), (3, 240), (4, 240)]);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_manual_retry_joins_the_engine_instead_of_replacing_it() -> Result<()> {
        // A backoff long enough that only the manual retry can drive an attempt.
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_secs(30),
            backoff_cap: Duration::from_secs(30),
            backoff_floor: Duration::from_secs(30),
            suspend_after: Duration::from_secs(600),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let dials = fixture.transport.dials();

        // No host queued, so this attempt fails — but it must happen now
        // rather than in 30 s, and it must not disarm the engine behind it.
        assert!(
            fixture
                .runtime
                .reconnect_session(&fixture.session_id)
                .await
                .is_err()
        );
        assert!(
            fixture.transport.dials() > dials,
            "manual retry never dialed"
        );
        assert!(
            lifecycle.has_engine(),
            "a manual retry cancelled the auto-resume engine"
        );

        // The engine is still the thing that finishes the job.
        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        assert_eq!(fixture.feed_reader_count().await, 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_the_last_view_stops_the_engine() -> Result<()> {
        let fixture = Fixture::attached_with(eager_reconnect()).await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        wait_for_engine(&lifecycle).await?;

        // The pane is gone, so there is nothing left to resume. The view is
        // already out of the map here, which is exactly the case that used to
        // slip past the bookkeeping.
        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-1", 0)
            .await;
        assert!(!lifecycle.has_engine(), "the engine outlived its last view");
        tokio::time::sleep(Duration::from_millis(150)).await;
        let settled = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            fixture.transport.dials(),
            settled,
            "kept dialing for no views"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_purge_evicts_every_stranded_generation() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        // Strand several identities. A rotation on a *live* connection is
        // reaped by the host the moment the old control stream closes, so the
        // only way to accumulate zombies is the way a real outage does it:
        // connections that die before the host notices.
        for _ in 0..3 {
            fixture.black_hole().await;
            fixture
                .wait_for_state(RemoteLifecycleState::Suspended)
                .await?;
            fixture.arm_host("host-1").await?;
            fixture
                .runtime
                .reconnect_session(&fixture.session_id)
                .await?;
        }
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");
        let stranded = lifecycle.purgeable_generations();
        assert_eq!(stranded, vec![("pane-1".to_owned(), 1, 3)]);

        // Now let a resume run with the purge armed.
        fixture.runtime.set_reconnect_config(MeshReconnectConfig {
            zombie_purge: true,
            ..quiet_reconnect()
        });
        fixture.black_hole().await;
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        for _ in 0..300 {
            if lifecycle.purgeable_generations().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // An empty range means every one of those generations completed a real
        // attach / drain / detach round-trip against the host: a rejected or
        // hung purge leaves `oldest_unpurged` where it was.
        assert!(
            lifecycle.purgeable_generations().is_empty(),
            "stranded generations survived the purge: {:?}",
            lifecycle.purgeable_generations()
        );
        // Draining each transient state stream matters: left in the accept
        // queue one would be handed to the next attach as a misrouted feed.
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lifecycle_sequences_stay_monotonic_across_repeated_outages() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        for _ in 0..3 {
            fixture.kill_host();
            fixture
                .wait_for_state(RemoteLifecycleState::Reconnecting)
                .await?;
            fixture.arm_host("host-1").await?;
            fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        }

        let mut last = 0;
        let mut seen = 0;
        while let Ok(event) = lifecycles.try_recv() {
            assert!(
                event.lifecycle_seq > last,
                "sequence regressed across an engine restart: {event:?}"
            );
            last = event.lifecycle_seq;
            seen += 1;
        }
        assert!(seen >= 6, "expected several transitions, saw {seen}");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lost_host_is_resumed_without_anyone_asking() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.kill_host();
        // Teardown hands off to the engine rather than resting: Phase 2's
        // whole point is that nobody has to press anything.
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        fixture.arm_host("host-1").await?;

        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        let after = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch")
            .0;
        assert_ne!(after, before);
        assert!(fixture.retained_snapshot().await.is_some());
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.next_retry_ms, None);
        assert_eq!(lifecycle.attempt, 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_returning_advertisement_short_circuits_the_backoff() -> Result<()> {
        // A backoff long enough that only the fast path can rescue the test.
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_secs(30),
            backoff_cap: Duration::from_secs(30),
            backoff_floor: Duration::from_secs(30),
            suspend_after: Duration::from_secs(600),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let scheduled = fixture.lifecycle().await.next_retry_ms;
        assert!(
            scheduled.is_some_and(|delay| delay >= 30_000),
            "expected a long scheduled retry, got {scheduled:?}"
        );

        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_provably_absent_device_is_not_dialed() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        fixture.transport.set_online(false);
        fixture.transport.advertise(None);
        assert!(fixture.runtime.dial_is_pointless(TEST_DEVICE).await);

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let dials = fixture.transport.dials();
        // Arm a host the engine must not reach for: discovery says the device
        // is gone, so the scheduled dials are declined until it reappears.
        fixture.arm_host("host-1").await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fixture.transport.dials(), dials, "dialed an absent device");
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Reconnecting
        );

        // Discovery says it is back; the same schedule now dials.
        fixture.transport.set_online(true);
        fixture.transport.advertise(Some("host-1"));
        assert!(!fixture.runtime.dial_is_pointless(TEST_DEVICE).await);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_long_absence_rests_in_suspended_and_wakes_on_return() -> Result<()> {
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(10),
            backoff_cap: Duration::from_millis(20),
            backoff_floor: Duration::from_millis(5),
            suspend_after: Duration::from_millis(80),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.kill_host();

        // The engine burns dials for suspend_after, then stops: Suspended
        // costs zero network, but the watcher stays.
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        assert_eq!(fixture.lifecycle().await.next_retry_ms, None);
        let resting = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            fixture.transport.dials(),
            resting,
            "a suspended session kept dialing"
        );

        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reconnecting_events_carry_a_real_attempt_and_countdown() -> Result<()> {
        let fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(40),
            backoff_cap: Duration::from_millis(80),
            backoff_floor: Duration::from_millis(20),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        fixture.kill_host();
        let mut attempts = Vec::new();
        while attempts.len() < 3 {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Reconnecting
                && let Some(delay) = event.next_retry_ms
            {
                attempts.push((event.attempt, delay));
            }
        }
        // The counter is real, and each wait is a genuine sampled delay
        // rather than the Phase-1 placeholder null.
        assert_eq!(
            attempts
                .iter()
                .map(|(attempt, _)| *attempt)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        for (attempt, delay) in &attempts {
            assert!(*delay >= 20, "attempt {attempt} scheduled {delay}ms");
            assert!(*delay <= 80, "attempt {attempt} scheduled {delay}ms");
        }
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_purges_the_identity_it_stranded() -> Result<()> {
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            zombie_purge: true,
            suspend_after: Duration::ZERO,
            advertisement_fast_path: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");
        // g1 was stranded by the resume; the purge attaches it, drains the
        // transient state stream, and detaches it.
        for _ in 0..200 {
            if lifecycle.purgeable_generations().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            lifecycle.purgeable_generations().is_empty(),
            "stranded generations were never purged"
        );

        // Draining that stream matters: left in the accept queue it would be
        // handed to the next attach as a misrouted feed.
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let feed_wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("feed view");
        session.claim_control(&feed_wire, "truffle:peer:1", 100, 30)?;
        for _ in 0..200 {
            let summary = fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .map(|remote| remote.replica.summary())
                .expect("session");
            if (summary.cols, summary.rows) == (100, 30) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        bail!("the feed stopped tracking the host after the purge")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn refreshing_a_live_session_re_attaches_the_feed() -> Result<()> {
        let fixture = Fixture::attached_legacy().await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.runtime.refresh_remote(&fixture.session_id).await?;

        // A true remote refresh, not a local re-render: the feed is re-attached
        // under an advanced generation, which is what guarantees a fresh stream
        // and reset patch sequencing.
        let (after, _) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("refreshed epoch");
        assert_ne!(after, before);
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("refreshed view");
        assert_eq!(wire, "r:pane-1#g2");
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert!(fixture.retained_snapshot().await.is_some());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn refreshing_a_frozen_session_is_refused_and_never_dials() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let dials = fixture.transport.dials();
        // There is no host to ask, so the remote refresh is refused outright
        // rather than burning a connect.
        assert!(
            fixture
                .runtime
                .refresh_remote(&fixture.session_id)
                .await
                .is_err()
        );
        // The local re-render still works on the retained viewport.
        fixture.runtime.refresh(&fixture.session_id).await?;
        assert_eq!(fixture.transport.dials(), dials);
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Suspended
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn closing_a_session_stops_its_engine() -> Result<()> {
        let fixture = Fixture::attached_with(eager_reconnect()).await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        wait_for_engine(&lifecycle).await?;

        assert!(fixture.runtime.close_session(&fixture.session_id).await);
        assert!(lifecycle.is_ended());
        assert!(!lifecycle.has_engine(), "the engine outlived its session");

        // An abort cannot recall a dial already in flight, so let the last
        // attempt land; what must stop is the schedule behind it.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let settled = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            fixture.transport.dials(),
            settled,
            "a closed session kept dialing"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_zombie_reader_moves_no_state_after_its_generation_is_retired() -> Result<()> {
        let fixture = Fixture::attached_legacy().await?;
        fixture.await_first_snapshot().await?;
        let remote = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .cloned()
            .expect("open remote session");
        let lifecycle = Arc::clone(&remote.lifecycle);
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");

        // Orphan the reader without cancelling it: this is exactly a reader
        // stranded by a resume, still holding a live stream.
        fixture
            .runtime
            .views
            .lock()
            .await
            .remove(&(fixture.session_id.clone(), "pane-1".to_owned()));
        lifecycle.advance_generation();

        let mut controls = fixture.runtime.subscribe_control();
        let mut activities = fixture.runtime.subscribe_activity();
        let contact_before = lifecycle
            .state
            .lock()
            .unwrap()
            .last_contact
            .expect("contact recorded while live");

        // Drive all three dispatch kinds from the host. Claiming control at a
        // new size produces a ControlChanged and a resized snapshot; the
        // activity announcement produces an ActivityChanged.
        session.claim_control("r:pane-1#g1", "truffle:peer:1", 100, 30)?;
        session.announce_activity();
        session.refresh()?;
        tokio::time::sleep(Duration::from_millis(100)).await;

        // A zombie that only had its frames gated could still overwrite
        // controller or activity state after recovery.
        assert!(
            controls.try_recv().is_err(),
            "zombie moved controller state"
        );
        assert!(
            activities.try_recv().is_err(),
            "zombie moved activity state"
        );
        let summary = remote.replica.summary();
        assert_eq!(
            (summary.cols, summary.rows),
            (80, 24),
            "zombie published a snapshot into the replica"
        );
        // Late traffic must not vouch for the current connection's liveness.
        assert_eq!(
            lifecycle.state.lock().unwrap().last_contact,
            Some(contact_before),
            "zombie refreshed the current connection's contact clock"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_delayed_old_reader_cannot_retire_the_resumed_view() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        let original = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .cloned()
            .expect("attached view");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        let epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch")
            .0;

        // The old connection's cleanup lands late. It must not remove the
        // replacement's entry, nor push the session back to Suspended.
        original.state_cancel.send_replace(true);
        assert!(
            !fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .expect("session")
                .lifecycle
                .commit_disconnect(original.state_generation, original.incarnation)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .map(|(epoch, _)| epoch),
            Some(epoch)
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_probe_reaches_the_cached_connection_with_an_expired_advertisement() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // The probe matters exactly when discovery has gone quiet, so it must
        // not route through advertisement validation.
        fixture.transport.advertise(None);
        assert!(
            fixture
                .runtime
                .remote_connection(TEST_DEVICE)
                .await
                .is_err()
        );
        fixture.runtime.probe_connection(TEST_DEVICE).await?;
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);

        fixture.kill_host();
        assert!(fixture.runtime.probe_connection(TEST_DEVICE).await.is_err());
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lifecycle_and_view_sequences_are_monotonic_across_a_resume() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        let mut view_states = fixture.runtime.subscribe_view_state();

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        let mut last_lifecycle = 0;
        while let Ok(event) = lifecycles.try_recv() {
            assert!(
                event.lifecycle_seq > last_lifecycle,
                "lifecycle sequence regressed at {event:?}"
            );
            last_lifecycle = event.lifecycle_seq;
        }
        assert!(last_lifecycle > 0);

        let mut last_view = 0;
        while let Ok(event) = view_states.try_recv() {
            assert!(
                event.view_state_seq > last_view,
                "view sequence regressed at {event:?}"
            );
            last_view = event.view_state_seq;
            if event.view_state != RemoteViewState::Attached {
                assert_eq!(event.attachment_epoch, None);
                assert_eq!(event.read_write, None);
            }
        }
        assert!(last_view > 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn selection_text_is_answered_locally_while_frozen() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // Let the host's post-attach refresh land in the replica.
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        // The frozen viewport stays readable with no host to ask.
        let text = fixture
            .runtime
            .offline_selection_text(
                &fixture.session_id,
                RemoteSelection {
                    attachment_epoch: 0,
                    start_column: 0,
                    start_row: 0,
                    end_column: 0,
                    end_row: 0,
                    select_all: true,
                },
            )
            .await?;
        assert!(text.lines().count() >= 1);
        Ok(())
    }

    // ── Phase-4 compact serve loop (§6.2's compact rules) ────────────
    //
    // The compact endpoint speaks plain framed TCP on `DEFAULT_COMPACT_PORT` in
    // production; an in-process duplex carries byte-identical framing, so this
    // drives the real `handle_compact_protocol` — hello negotiation, attach,
    // both multiplexed channels, and connection close — with nothing stubbed
    // but the socket.
    //
    // What it *can* falsify that the QUIC loopback harness could not: the peer
    // here is scripted test code rather than this same implementation
    // negotiated down, so a connection can offer minor 5 and then send a
    // minor-6 frame, and the host's own compatibility guard is what decides the
    // outcome. Tests that turn on a minor gate say so at the test.
    //
    // What it cannot reach: `compact_accept_loop` and
    // `handle_compact_connection` — raw TCP acceptance, the WhoIs identity
    // resolution and the peer lookup — need a live tailnet. This picks up at
    // the same seam the two older compact tests do, and mints its ledger ids
    // the way the accept loop does, but that the *production* listener does so
    // is not proven here.

    const COMPACT_DEVICE: &str = "ios-device";
    const COMPACT_CLIENT: &str = "truffle:peer:compact";

    /// One frame off a compact connection, tagged with the channel it arrived
    /// on. Which channel carried a frame is half the contract the Swift client
    /// implements, so tests assert on it rather than on the message alone.
    #[derive(Debug)]
    enum CompactFrame {
        Control(SessionControlMessage),
        State(StateMessage),
        /// The host closed. An ordinary outcome here: on compact a refused
        /// attach, a concluded session and a superseded view all end with one.
        Closed,
    }

    /// The viewer half of a compact connection, with its own reader and writer
    /// for the wire format — the host's codec is not the thing vouching for the
    /// host's framing.
    struct CompactPeer {
        io: tokio::io::DuplexStream,
        negotiated_minor: u16,
        state_codec: StateCodec,
        /// This connection's place in the host's ledger, so a test can order
        /// attaches against it and ask when it has fully terminated.
        connection_id: u64,
    }

    impl CompactPeer {
        async fn write_raw<T: serde::Serialize>(&mut self, message: &T) -> Result<()> {
            self.io
                .write_all(&encode_message(message, MAX_CONTROL_MESSAGE_BYTES)?)
                .await?;
            Ok(())
        }

        async fn read_raw<T: serde::de::DeserializeOwned>(&mut self) -> Result<T> {
            let mut header = [0_u8; 4];
            self.io.read_exact(&mut header).await?;
            let mut payload = vec![0_u8; u32::from_be_bytes(header) as usize];
            self.io.read_exact(&mut payload).await?;
            Ok(serde_json::from_slice(&payload)?)
        }

        async fn write_control(&mut self, message: &SessionControlMessage) -> Result<()> {
            self.io
                .write_all(&encode_compact_message(
                    CompactChannel::Control,
                    message,
                    MAX_CONTROL_MESSAGE_BYTES,
                )?)
                .await?;
            Ok(())
        }

        async fn read_frame(&mut self) -> Result<CompactFrame> {
            let mut header = [0_u8; 4];
            match self.io.read_exact(&mut header).await {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(CompactFrame::Closed);
                }
                Err(error) => return Err(error.into()),
            }
            let mut framed = vec![0_u8; u32::from_be_bytes(header) as usize];
            self.io.read_exact(&mut framed).await?;
            let payload = &framed[1..];
            Ok(match CompactChannel::from_byte(framed[0])? {
                CompactChannel::Control => CompactFrame::Control(serde_json::from_slice(payload)?),
                // `write_compact_state_message` strips the state codec's own
                // length prefix before framing, so put it back to decode.
                CompactChannel::State => {
                    let mut prefixed = Vec::with_capacity(4 + payload.len());
                    prefixed.extend_from_slice(&u32::try_from(payload.len())?.to_be_bytes());
                    prefixed.extend_from_slice(payload);
                    CompactFrame::State(
                        ghosttea::tunnel_protocol::decode_state_message_for_minor(
                            &prefixed,
                            self.state_codec,
                            self.negotiated_minor,
                            MAX_STATE_MESSAGE_BYTES,
                        )?
                        .0,
                    )
                }
            })
        }

        /// The next frame, on whichever channel. Bounded, so no assertion in
        /// this file can hang the suite waiting for a frame that never comes.
        async fn next_frame(&mut self) -> Result<CompactFrame> {
            tokio::time::timeout(Duration::from_secs(5), self.read_frame())
                .await
                .context("timed out waiting for a compact frame")?
        }

        /// The next frame if one arrives inside `window`, `None` if the host
        /// stayed silent. Absence is the whole assertion for a view that
        /// declined state, so it gets a bounded wait rather than a read that
        /// would hang.
        async fn frame_within(&mut self, window: Duration) -> Result<Option<CompactFrame>> {
            match tokio::time::timeout(window, self.read_frame()).await {
                Err(_) => Ok(None),
                Ok(frame) => frame.map(Some),
            }
        }

        async fn next_control(&mut self) -> Result<SessionControlMessage> {
            match self.next_frame().await? {
                CompactFrame::Control(message) => Ok(message),
                other => bail!("expected a control frame, got {other:?}"),
            }
        }

        async fn next_state(&mut self) -> Result<StateMessage> {
            match self.next_frame().await? {
                CompactFrame::State(message) => Ok(message),
                other => bail!("expected a state frame, got {other:?}"),
            }
        }

        /// The next control frame, letting the state feed flow past it. The
        /// control channel carries no unsolicited host traffic of its own, so
        /// an answer is identifiable wherever in the interleaving it lands.
        async fn next_control_amid_state(&mut self) -> Result<SessionControlMessage> {
            loop {
                match self.next_frame().await? {
                    CompactFrame::Control(message) => return Ok(message),
                    CompactFrame::State(_) => continue,
                    CompactFrame::Closed => bail!("the host closed before answering"),
                }
            }
        }

        /// Read past the opening state burst up to and including the frame
        /// `stop` accepts, returning everything seen. Tests assert on the whole
        /// run, so a frame arriving in the wrong place cannot be skipped into
        /// looking right.
        async fn frames_until(
            &mut self,
            stop: impl Fn(&CompactFrame) -> bool,
        ) -> Result<Vec<CompactFrame>> {
            let mut seen = Vec::new();
            loop {
                let frame = self.next_frame().await?;
                let done = stop(&frame) || matches!(frame, CompactFrame::Closed);
                seen.push(frame);
                if done {
                    return Ok(seen);
                }
            }
        }

        async fn attach(
            &mut self,
            session_id: &str,
            view_id: &str,
            attach_generation: u64,
            resume: Option<ResumeHint>,
            wants_state: bool,
        ) -> Result<SessionControlMessage> {
            self.write_control(&SessionControlMessage::AttachView {
                request_id: "attach-1".into(),
                session_id: session_id.to_owned(),
                view_id: view_id.to_owned(),
                access_token: None,
                cols: 80,
                rows: 24,
                attach_generation,
                resume,
                wants_state,
            })
            .await?;
            self.next_control().await
        }
    }

    /// A compact host: one real session in a real registry, served by the
    /// production protocol handler over the production framing.
    struct CompactHost {
        registry: Registry,
        services: HostServices,
        connections: ConnectionLedger,
        presentation: tokio::sync::watch::Sender<Arc<TerminalPresentationConfig>>,
        session_id: String,
        served: Vec<tokio::task::JoinHandle<Result<()>>>,
    }

    impl CompactHost {
        fn new() -> Result<Self> {
            Self::serving(HostServices::default())
        }

        fn serving(services: HostServices) -> Result<Self> {
            let registry = Registry::default();
            let session_id = spawn_host_session(&registry)?;
            Ok(Self {
                registry,
                services,
                connections: ConnectionLedger::default(),
                presentation: tokio::sync::watch::channel(Arc::new(
                    ghosttea::ConfigSnapshot::default().terminal_presentation(),
                ))
                .0,
                session_id,
                served: Vec::new(),
            })
        }

        fn session(&self) -> Arc<Session> {
            self.registry
                .read()
                .unwrap()
                .get(&self.session_id)
                .cloned()
                .expect("host session")
        }

        async fn attached(&mut self, view_id: &str, generation: u64) -> Result<CompactPeer> {
            let mut peer = self
                .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
                .await?;
            let session_id = self.session_id.clone();
            let attached = peer
                .attach(&session_id, view_id, generation, None, true)
                .await?;
            if !matches!(attached, SessionControlMessage::ViewAttached { .. }) {
                bail!("compact host refused the harness attach: {attached:?}");
            }
            Ok(peer)
        }

        /// Dial the way the accept loop does: a ledger id minted on the raw
        /// connection and identified with the client the WhoIs lookup ahead of
        /// it would have resolved, then the real handler.
        async fn connect(&mut self, kind: StreamKind, offered_minor: u16) -> Result<CompactPeer> {
            self.connect_prefacing(kind, offered_minor, None).await
        }

        /// As [`CompactHost::connect`], with control over what the preface
        /// announces as its view. Real clients write the preface *before* the
        /// hello, so what goes in there is their local view id — settled before
        /// the negotiated minor that decides the wire id is known.
        async fn connect_prefacing(
            &mut self,
            kind: StreamKind,
            offered_minor: u16,
            preface_view_id: Option<&str>,
        ) -> Result<CompactPeer> {
            let (server_io, client_io) = tokio::io::duplex(256 * 1024);
            let scope = self.connections.accept();
            scope.identify(COMPACT_CLIENT);
            let connection_id = scope.id();
            self.served.push(tokio::spawn(handle_compact_protocol(
                server_io,
                self.registry.clone(),
                TruffleTerminalConfig {
                    allow_tailnet_write: true,
                    ..TruffleTerminalConfig::default()
                },
                self.services.clone(),
                "compact-host".into(),
                Some(COMPACT_DEVICE.into()),
                COMPACT_CLIENT.to_owned(),
                self.presentation.subscribe(),
                scope,
            )));
            let mut peer = CompactPeer {
                io: client_io,
                negotiated_minor: 0,
                state_codec: StateCodec::Json,
                connection_id,
            };
            peer.io
                .write_all(&encode_preface(&StreamPreface {
                    stream_kind: kind,
                    session_id: (kind == StreamKind::SessionControl)
                        .then(|| self.session_id.clone()),
                    view_id: preface_view_id.map(str::to_owned),
                })?)
                .await?;
            peer.write_raw(&ConnectionMessage::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: offered_minor,
                host_instance_id: String::new(),
                local_device_id: COMPACT_DEVICE.into(),
                nonce: "compact-nonce".into(),
                state_codecs: Some(vec![StateCodec::CompactJsonV1]),
            })
            .await?;
            let ConnectionMessage::ServerHello {
                protocol_minor,
                state_codec,
                ..
            } = peer.read_raw::<ConnectionMessage>().await?
            else {
                bail!("compact host did not answer with a server hello");
            };
            peer.negotiated_minor = protocol_minor;
            peer.state_codec = state_codec.unwrap_or(StateCodec::Json);
            Ok(peer)
        }
    }

    /// The cap is gone, so the compact endpoint answers what the pair actually
    /// has in common. Both halves matter: answering the host's own minor to a
    /// client that offered less is the bug Phase 3 found on the QUIC side, and
    /// answering less than the pair share is the cap this phase removed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_compact_hello_answers_the_negotiated_minimum() -> Result<()> {
        let mut host = CompactHost::new()?;
        let full = host
            .connect(StreamKind::ConnectionControl, PROTOCOL_MINOR)
            .await?;
        assert_eq!(
            full.negotiated_minor, PROTOCOL_MINOR,
            "a compact client offering everything this host has was answered less"
        );
        assert!(
            full.negotiated_minor >= REMOTE_RECONNECT_PROTOCOL_MINOR,
            "the compact endpoint still negotiates below the reconnect minor"
        );

        let legacy = host
            .connect(
                StreamKind::ConnectionControl,
                REMOTE_RECONNECT_PROTOCOL_MINOR - 1,
            )
            .await?;
        assert_eq!(
            legacy.negotiated_minor,
            REMOTE_RECONNECT_PROTOCOL_MINOR - 1,
            "a compact client that offered less was told it got more"
        );
        Ok(())
    }

    /// §4.2.1 on compact: an attach that carries a lineage goes through the
    /// authority's takeover, which mints a *fresh* epoch for the same view and
    /// says so. The pre-takeover path returns the epoch the view already had,
    /// which is what a resuming viewer cannot distinguish a stale attachment by.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_generational_compact_attach_routes_through_takeover() -> Result<()> {
        let mut host = CompactHost::new()?;
        let first = host.attached("r:pane-1#g1", 1).await?;
        let session = host.session();
        let opening = session
            .view_attachment_epoch("r:pane-1#g1")
            .context("the first attach left no attachment")?;

        let mut second = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let attached = second
            .attach(&session_id, "r:pane-1#g1", 2, None, true)
            .await?;

        let SessionControlMessage::ViewAttached {
            attachment_epoch,
            resumed,
            ..
        } = attached
        else {
            bail!("the second compact attach was not accepted: {attached:?}");
        };
        assert!(
            attachment_epoch > opening,
            "the takeover reused epoch {opening} instead of minting a fresh one"
        );
        assert!(
            resumed,
            "the host did not report that it had taken the view over"
        );
        assert_eq!(
            session.attach_watermark_count(COMPACT_CLIENT),
            1,
            "the compact takeover left no watermark for the fence to order by"
        );
        drop(first.io);
        drop(second.io);
        Ok(())
    }

    /// The compatibility half. A zero generation has no lineage to order, so it
    /// must keep the pre-takeover path — the second such attach would otherwise
    /// be refused as stale, correctly and uselessly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_attach_without_a_lineage_keeps_the_legacy_path() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let attached = peer.attach(&session_id, "r:pane-1", 0, None, true).await?;
        assert!(
            matches!(
                attached,
                SessionControlMessage::ViewAttached { resumed: false, .. }
            ),
            "a generation-0 attach was reported as a resume: {attached:?}"
        );
        assert_eq!(
            host.session().attach_watermark_count(COMPACT_CLIENT),
            0,
            "a viewer with no lineage was given a watermark it can never advance"
        );
        drop(peer.io);
        Ok(())
    }

    /// §6.2: a refusal has to be *named* before the connection goes. Closing
    /// alone is what a transport fault looks like, and it sends the viewer down
    /// the ambiguous path instead of the terminal one this code demands.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_compact_attach_is_named_before_the_close() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let refused = peer
            .attach(
                &session_id,
                "r:pane-1",
                1,
                Some(ResumeHint {
                    // A resume against a host that has restarted since.
                    previous_session_epoch: host.session().session_epoch() + 1,
                    previous_attachment_epoch: 1,
                    previous_terminal_revision: 1,
                }),
                true,
            )
            .await?;
        assert!(
            matches!(
                refused,
                SessionControlMessage::AttachRejected {
                    code: AttachRejectCode::SessionEpochMismatch,
                    retryable: false,
                    ref request_id,
                } if request_id == "attach-1"
            ),
            "the host did not name the refusal: {refused:?}"
        );
        assert!(
            matches!(peer.next_frame().await?, CompactFrame::Closed),
            "a terminal refusal left the compact connection open"
        );
        Ok(())
    }

    /// The ordering fence, seen from the wire: once a generation has been
    /// accepted, a lower one is a delayed attempt from a connection that has
    /// already been superseded, and the host refuses it by name.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_compact_generation_is_refused_by_name() -> Result<()> {
        let mut host = CompactHost::new()?;
        let current = host.attached("r:pane-1#g5", 5).await?;

        let mut delayed = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let refused = delayed
            .attach(&session_id, "r:pane-1#g5", 3, None, true)
            .await?;
        assert!(
            matches!(
                refused,
                SessionControlMessage::AttachRejected {
                    code: AttachRejectCode::StaleResume,
                    ..
                }
            ),
            "a generation below the watermark was accepted: {refused:?}"
        );
        drop(current.io);
        Ok(())
    }

    /// The view id comes from `AttachView` and from nowhere else — the preface
    /// contributes the session id only, and the two view ids are *expected* to
    /// differ.
    ///
    /// This is a real client's ordering, not a hypothetical: the compact client
    /// writes its preface before the hello, so the preface carries the id it
    /// had at the time — the **local** one — while the attach that follows
    /// carries the **wire** id chosen from the minor the hello went on to
    /// negotiate (`r:pane-1` at >= 6, `r:pane-1#g{n}` rotated below it). So on
    /// every minor-6 attach the preface and the attach disagree, by design.
    ///
    /// Pinned because the seam looks like a missing validation and reads as an
    /// invitation to "harden" it. A cross-check here would break every iOS
    /// minor-6 attach, and — the reason this test has to exist rather than
    /// relying on the others — it would break *nothing else in this suite*:
    /// every other compact test leaves the preface's view id absent, which any
    /// plausible comparison would wave through.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_attach_takes_its_view_id_from_the_attach_not_the_preface() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host
            .connect_prefacing(StreamKind::SessionControl, PROTOCOL_MINOR, Some("pane-1"))
            .await?;
        let session_id = host.session_id.clone();
        let attached = peer.attach(&session_id, "r:pane-1", 1, None, true).await?;
        assert!(
            matches!(attached, SessionControlMessage::ViewAttached { .. }),
            "an attach whose wire id differs from its preface was refused: {attached:?}"
        );
        // Accepted is not enough — the state feed has to follow, or the client
        // is attached to something it will never hear from.
        assert!(
            matches!(
                peer.next_state().await?,
                StateMessage::ConfigurationChanged { .. }
            ),
            "the attach was accepted but its state channel stayed shut"
        );
        // And the authority holds the wire id, which is the one every later
        // epoch check, takeover and detach will name.
        assert!(
            host.session().view_attachment_epoch("r:pane-1").is_some(),
            "the host attached something other than the id the attach named"
        );
        assert!(
            host.session().view_attachment_epoch("pane-1").is_none(),
            "the host attached the preface's local id, which no later message will ever name"
        );
        drop(peer.io);
        Ok(())
    }

    /// §4.2.1's stage-2 fence, on the transport whose accept path mints the
    /// ids. An attach is stamped with the highest connection this client could
    /// still be holding — **not** the one it arrived on — so a watermark set
    /// from an older connection survives that connection's death for as long as
    /// a newer one is open. Stamping the arriving connection's own id (or
    /// nothing) collects the watermark early, and the delayed low-generation
    /// attach it exists to refuse is accepted instead.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_attach_is_fenced_at_the_clients_newest_connection() -> Result<()> {
        let mut host = CompactHost::new()?;
        // Older connection, newer connection, attach on the older one.
        let mut older = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let newer = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        assert!(newer.connection_id > older.connection_id);
        let session_id = host.session_id.clone();
        older
            .attach(&session_id, "r:pane-1#g5", 5, None, true)
            .await?;

        // The connection that set the watermark is gone, and fully terminated —
        // but the one that outranks it is not, so nothing may be collected yet.
        let retired = older.connection_id;
        drop(older);
        while !host.connections.fully_terminated(retired) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let mut delayed = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let refused = delayed
            .attach(&session_id, "r:pane-1#g5", 3, None, true)
            .await?;
        assert!(
            matches!(
                refused,
                SessionControlMessage::AttachRejected {
                    code: AttachRejectCode::StaleResume,
                    ..
                }
            ),
            "the watermark was collected while a connection that outranks its \
             fence was still open, so a delayed attach was accepted: {refused:?}"
        );
        drop(newer);
        Ok(())
    }

    /// §4.5 on compact. The channel is the stream here, so declining state
    /// means the State channel never carries session state for this view — no
    /// opening snapshot, no controller frame, no activity, no patches — while
    /// the control channel keeps working. The positive half is asserted
    /// alongside so the absence is evidence rather than a quiet timeout.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_view_that_declines_state_gets_none() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut feed = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        feed.attach(&session_id, "r:pane-1", 1, None, true).await?;
        assert!(
            matches!(
                feed.next_state().await?,
                StateMessage::ConfigurationChanged { .. }
            ),
            "a view that wanted state did not get the opening burst"
        );

        let mut secondary = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let attached = secondary
            .attach(&session_id, "r:pane-2", 1, None, false)
            .await?;
        assert!(
            matches!(attached, SessionControlMessage::ViewAttached { .. }),
            "the secondary was not attached: {attached:?}"
        );
        assert!(
            secondary
                .frame_within(Duration::from_millis(300))
                .await?
                .is_none(),
            "a view that declined state was sent some anyway"
        );

        // The control channel is untouched by the decline: this is a view with
        // no feed, not a view with no connection.
        secondary
            .write_control(&SessionControlMessage::Ping { nonce: 41 })
            .await?;
        assert!(
            matches!(
                secondary.next_control().await?,
                SessionControlMessage::Pong { nonce: 41 }
            ),
            "a streamless compact view lost its control channel too"
        );
        drop(feed.io);
        drop(secondary.io);
        Ok(())
    }

    /// §5's compact framing: no heartbeat stream on this transport, so liveness
    /// rides the control channel of the one view the connection carries.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_ping_is_answered_on_the_control_channel() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host.attached("r:pane-1", 1).await?;
        peer.write_control(&SessionControlMessage::Ping { nonce: 7 })
            .await?;
        assert!(
            matches!(
                peer.next_control_amid_state().await?,
                SessionControlMessage::Pong { nonce: 7 }
            ),
            "the compact host did not answer the probe with its own nonce"
        );

        // Stateless, like the QUIC responder: a second probe is answered on its
        // own terms, not on the first one's.
        peer.write_control(&SessionControlMessage::Ping { nonce: 8 })
            .await?;
        assert!(matches!(
            peer.next_control_amid_state().await?,
            SessionControlMessage::Pong { nonce: 8 }
        ));
        drop(peer.io);
        Ok(())
    }

    /// The same legacy path from the other direction: a minor-5 connection that
    /// simply goes quiet. The host must neither speak first nor hang up.
    ///
    /// This is where a real client bug lived. A viewer that probes a legacy host
    /// gets the connection closed (the test below), redials, and closes again —
    /// a self-inflicted reconnect loop that reads as a flaky network. The host's
    /// half of not having that happen is this: silence is a legacy viewer's
    /// normal resting state, because it has no heartbeat to fill it with. A host
    /// that sent something unsolicited would be sending a frame the viewer may
    /// not be able to decode, and one that closed on idle would manufacture the
    /// very disconnect the gate exists to prevent.
    ///
    /// "Quiet" is deliberately host→client only. The shipped client acks every
    /// frame it applies, on every negotiated minor, so a resting legacy
    /// connection still carries `StateAck` in the other direction — and the
    /// silence asserted here has to hold *while* that traffic arrives, which is
    /// why the window below is not an empty one.
    ///
    /// Both halves are falsifiable, which is why the assertions are split:
    /// deleting the `RequestSnapshot` arm fails the liveness check at the end,
    /// and emitting one unsolicited frame into the quiet window — a future
    /// host-initiated keepalive, in miniature — fails the silence check before
    /// it. The second is the one worth having: no code path can break it today,
    /// so it exists to make sure none is added quietly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_quiet_legacy_compact_connection_is_left_alone() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host
            .connect(
                StreamKind::SessionControl,
                REMOTE_RECONNECT_PROTOCOL_MINOR - 1,
            )
            .await?;
        let session_id = host.session_id.clone();
        let attached = peer.attach(&session_id, "r:pane-1", 0, None, true).await?;
        let SessionControlMessage::ViewAttached {
            session_epoch,
            layout_epoch,
            ..
        } = attached
        else {
            bail!("the legacy attach was refused: {attached:?}");
        };

        // Drain the opening burst without asserting its shape — what this test
        // is about starts once the host has said everything it volunteers.
        while peer
            .frame_within(Duration::from_millis(200))
            .await?
            .is_some()
        {}

        // What a real client does in this window rather than nothing at all:
        // acknowledge what it applied. An ack must move the host to neither
        // answer nor act — it is bookkeeping the host does not keep.
        for terminal_revision in 1..=3 {
            peer.write_control(&SessionControlMessage::StateAck {
                session_epoch,
                layout_epoch,
                patch_sequence: 0,
                terminal_revision,
            })
            .await?;
        }

        // Now the resting state a legacy viewer sits in indefinitely.
        assert!(
            peer.frame_within(Duration::from_millis(700))
                .await?
                .is_none(),
            "the host spoke unprompted to a legacy view that cannot be expected \
             to decode anything new, or hung up on it for being idle"
        );

        // Quiet is not the same as dead: the connection has to still be there.
        peer.write_control(&SessionControlMessage::RequestSnapshot)
            .await?;
        assert!(
            matches!(peer.next_state().await?, StateMessage::Snapshot(_)),
            "a legacy connection stopped being served after going quiet"
        );
        assert!(
            host.session().view_attachment_epoch("r:pane-1").is_some(),
            "the view was detached while its connection sat idle"
        );
        drop(peer.io);
        Ok(())
    }

    /// The gate, falsified: `Ping` is not part of the contract a minor-5 pair
    /// negotiated, and a host that answered it there would be telling a viewer
    /// its liveness story works when the rest of the contract behind it does
    /// not. This is the claim the QUIC harness could not test — its "legacy"
    /// peer was this same implementation negotiated down, and would never send
    /// the frame.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_ping_below_the_reconnect_minor_is_not_a_message() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host
            .connect(
                StreamKind::SessionControl,
                REMOTE_RECONNECT_PROTOCOL_MINOR - 1,
            )
            .await?;
        let session_id = host.session_id.clone();
        peer.attach(&session_id, "r:pane-1", 0, None, true).await?;
        peer.write_control(&SessionControlMessage::Ping { nonce: 7 })
            .await?;

        let frames = peer
            .frames_until(|frame| matches!(frame, CompactFrame::Control(_)))
            .await?;
        assert!(
            matches!(frames.last(), Some(CompactFrame::Closed)),
            "a legacy compact pair got an answer to a frame it never agreed on: {frames:?}"
        );
        Ok(())
    }

    /// §6.3 on the state channel. Without this a viewer holds a healthy
    /// connection to a session that no longer exists and stays Live — with the
    /// heartbeat answering, nothing else would ever tell it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_session_that_ends_says_so_before_the_close() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host.attached("r:pane-1", 1).await?;

        host.session()
            .terminate(ghosttea::TerminationSource::User)?;

        let frames = peer
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::SessionEnded { .. })
                )
            })
            .await?;
        assert!(
            matches!(
                frames.last(),
                Some(CompactFrame::State(StateMessage::SessionEnded {
                    reason: SessionEndReason::Exited { .. }
                }))
            ),
            "the session ended without the host accounting for it: {frames:?}"
        );
        assert!(
            matches!(peer.next_frame().await?, CompactFrame::Closed),
            "the compact connection outlived the session it carried"
        );
        Ok(())
    }

    /// The same news for a view that arrives after the fact. The watch reports
    /// only the transition, so a viewer attaching to an already-dead session
    /// would otherwise wait for an account that never comes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_view_attaching_to_a_dead_session_is_told_at_once() -> Result<()> {
        let mut host = CompactHost::new()?;
        let session = host.session();
        session.terminate(ghosttea::TerminationSource::User)?;
        while !session.has_concluded() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let mut peer = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        peer.attach(&session_id, "r:pane-1", 1, None, true).await?;
        assert!(
            matches!(
                peer.next_state().await?,
                StateMessage::SessionEnded {
                    reason: SessionEndReason::Exited { .. }
                }
            ),
            "a view attached to a concluded session was handed the live opening burst"
        );
        Ok(())
    }

    /// §6.3's compact goodbye. The drain announces once and every attached
    /// compact view has to hear it on the only channel it has.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_announced_shutdown_reaches_an_attached_compact_view() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host.attached("r:pane-1", 1).await?;

        host.services.shutdown.announce();

        let frames = peer
            .frames_until(|frame| {
                matches!(frame, CompactFrame::State(StateMessage::HostShutdown {}))
            })
            .await?;
        assert!(
            matches!(
                frames.last(),
                Some(CompactFrame::State(StateMessage::HostShutdown {}))
            ),
            "the host drained without telling its compact viewers: {frames:?}"
        );
        Ok(())
    }

    /// And an attachment that lands after the announcement has gone out must
    /// not be told the host is healthy by omission.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_view_attaching_during_a_drain_is_told_at_once() -> Result<()> {
        let mut host = CompactHost::new()?;
        host.services.shutdown.announce();

        let mut peer = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        peer.attach(&session_id, "r:pane-1", 1, None, true).await?;
        assert!(
            matches!(peer.next_state().await?, StateMessage::HostShutdown {}),
            "a view attaching into a drain was handed the live opening burst"
        );
        Ok(())
    }

    /// §4.2.3 on compact: the opening frame has to carry the shape the live
    /// updates carry. At minor 6 that is `ControlState` with the real revision;
    /// below it the revisionless `ControlChanged` is all the viewer can decode,
    /// and a clear stays unrepresentable — which is the gate, falsified here by
    /// a client that asks for less.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_state_channel_opens_with_the_revisioned_controller() -> Result<()> {
        let mut host = CompactHost::new()?;
        let session = host.session();
        session.attach_view("r:owner", "truffle:peer:owner")?;
        session.claim_control("r:owner", "truffle:peer:owner", 90, 30)?;
        let revision = session.control_snapshot().control_revision;
        assert!(revision > 0, "the fixture never established a controller");

        let mut current = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let attached = current
            .attach(&session_id, "r:pane-1", 1, None, true)
            .await?;
        // §4.2.3's attach-time half: the response itself reports who holds
        // control and at which revision, so a resuming view knows what to
        // compare-and-swap against before any state frame arrives.
        assert!(
            matches!(
                attached,
                SessionControlMessage::ViewAttached {
                    control_revision,
                    controller: Some(ref controller),
                    ..
                } if control_revision == revision && controller.controller_view_id == "r:owner"
            ),
            "the attach response hid the controller behind the unknown sentinel: {attached:?}"
        );
        let frames = current
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::ControlState { .. })
                        | CompactFrame::State(StateMessage::ControlChanged { .. })
                )
            })
            .await?;
        assert!(
            matches!(
                frames.last(),
                Some(CompactFrame::State(StateMessage::ControlState {
                    control_revision,
                    controller: Some(_),
                    ..
                })) if *control_revision == revision
            ),
            "a minor-6 compact view did not open on the revisioned frame: {frames:?}"
        );

        let mut legacy = host
            .connect(
                StreamKind::SessionControl,
                REMOTE_RECONNECT_PROTOCOL_MINOR - 1,
            )
            .await?;
        legacy
            .attach(&session_id, "r:pane-2", 0, None, true)
            .await?;
        let frames = legacy
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::ControlState { .. })
                        | CompactFrame::State(StateMessage::ControlChanged { .. })
                )
            })
            .await?;
        assert!(
            matches!(
                frames.last(),
                Some(CompactFrame::State(StateMessage::ControlChanged { .. }))
            ),
            "a legacy compact view was sent a frame it cannot decode: {frames:?}"
        );
        drop(current.io);
        drop(legacy.io);
        Ok(())
    }

    /// A terminal can redraw continuously while an animated TUI is idle. The
    /// compact loop is deliberately biased, so this stages a redraw and a
    /// tracked-selection change without yielding: both receivers are ready on
    /// the next poll and the view-owned selection must win. Putting the shared
    /// snapshot first reproduces the iOS failure where the highlight remains
    /// at fixed screen coordinates while the selected cells move underneath.
    #[tokio::test(flavor = "current_thread")]
    async fn a_compact_selection_cannot_be_starved_by_a_ready_redraw() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut peer = host.attached("r:pane-selection", 1).await?;
        let opening = peer
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::ActivityChanged { .. })
                )
            })
            .await?;
        assert!(
            opening.iter().any(|frame| matches!(
                frame,
                CompactFrame::State(StateMessage::SelectionChanged { selection: None })
            )),
            "the current protocol did not seed the view-owned selection: {opening:?}"
        );

        // The harness child is a quiet `cat`; give Ghostty one real cell to
        // retain before asking it to select all. Terminal input is processed
        // on the session worker, so wait on the model's own published state
        // rather than on an arbitrary sleep.
        let session = host.session();
        let attachment_epoch = session
            .view_attachment_epoch("r:pane-selection")
            .context("the selection fixture view was not attached")?;
        session.claim_control("r:pane-selection", COMPACT_CLIENT, 80, 24)?;
        session.send_text(
            "r:pane-selection",
            COMPACT_CLIENT,
            attachment_epoch,
            1,
            "selected\r".into(),
        )?;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if session.logical_snapshot().is_some_and(|snapshot| {
                    snapshot
                        .rows
                        .iter()
                        .any(|row| row.text.contains("selected"))
                }) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .context("the compact selection fixture never produced terminal text")?;
        while peer
            .frame_within(Duration::from_millis(50))
            .await?
            .is_some()
        {}

        // No await between these operations: the server's next biased select
        // sees both receivers ready at once, which makes their source ordering
        // observable and keeps the regression deterministic.
        let _ = session.selection_text("r:pane-selection", 0, 0, 0, 0, true)?;
        session.refresh()?;

        assert!(
            matches!(
                peer.next_state().await?,
                StateMessage::SelectionChanged { selection: Some(_) }
            ),
            "a ready terminal redraw overtook the view's tracked selection"
        );
        drop(peer.io);
        Ok(())
    }

    /// §4.2.3's compare-and-swap, now that a compact pair can negotiate the
    /// minor that carries it. A claim against a revision that has moved must
    /// lose, and the loser has to be *told* the revision it lost to — saying
    /// nothing would leave it retrying against the same stale number forever.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_compact_claim_is_refused_and_answered_with_the_revision() -> Result<()> {
        let mut host = CompactHost::new()?;
        let session = host.session();
        session.attach_view("r:owner", "truffle:peer:owner")?;
        session.claim_control("r:owner", "truffle:peer:owner", 90, 30)?;
        let current = session.control_snapshot().control_revision;

        let mut peer = host.attached("r:pane-1", 1).await?;
        // Drain the opening burst first. Its own `ControlState` says the same
        // thing the answer will, so a scan that started here would match the
        // greeting and never observe the claim at all.
        let opening = peer
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::ControlState { .. })
                )
            })
            .await?;
        assert!(
            matches!(
                opening.last(),
                Some(CompactFrame::State(StateMessage::ControlState {
                    control_revision,
                    ..
                })) if *control_revision == current
            ),
            "the opening burst did not carry the live revision: {opening:?}"
        );

        peer.write_control(&SessionControlMessage::FocusAndResize {
            view_id: "r:pane-1".into(),
            attachment_epoch: session
                .view_attachment_epoch("r:pane-1")
                .context("the harness view is not attached")?,
            cols: 100,
            rows: 40,
            client_sequence: 1,
            // A revision this viewer could only be holding from before the
            // claim above.
            expected_control_revision: Some(current.saturating_sub(1)),
        })
        .await?;

        // Anything from here is the answer to that claim. A host that granted
        // it would name the claimant at a revision that had moved; one that
        // stayed silent leaves this waiting, which is the failure.
        let answer = peer
            .frames_until(|frame| {
                matches!(
                    frame,
                    CompactFrame::State(StateMessage::ControlState { .. })
                )
            })
            .await?;
        assert!(
            matches!(
                answer.last(),
                Some(CompactFrame::State(StateMessage::ControlState {
                    control_revision,
                    controller: Some(controller),
                    ..
                })) if *control_revision == current
                    && controller.controller_view_id == "r:owner"
            ),
            "the losing claim was answered with something other than the live \
             controller and revision: {answer:?}"
        );
        assert_eq!(
            session.control_snapshot().controller.map(|c| c.view_id),
            Some("r:owner".to_owned()),
            "a claim against a stale revision took control anyway"
        );
        drop(peer.io);
        Ok(())
    }

    /// A takeover cancels the superseded attachment's state registration. On
    /// QUIC that ends one stream; compact multiplexes both channels onto one
    /// socket, so it ends the connection — which is all a superseded
    /// attachment could still do anyway.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_superseded_compact_connection_is_retired_by_the_takeover() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut superseded = host.attached("r:pane-1#g1", 1).await?;
        let mut successor = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        successor
            .attach(&session_id, "r:pane-1#g1", 2, None, true)
            .await?;

        let frames = superseded
            .frames_until(|frame| matches!(frame, CompactFrame::Closed))
            .await?;
        assert!(
            matches!(frames.last(), Some(CompactFrame::Closed)),
            "the superseded compact connection was left running: {frames:?}"
        );
        // The successor keeps its attachment: the loser's exit is
        // epoch-conditional, so it cannot detach the view that replaced it.
        assert!(
            host.session()
                .view_attachment_epoch("r:pane-1#g1")
                .is_some(),
            "the superseded handler took its successor's attachment with it"
        );
        drop(successor.io);
        Ok(())
    }

    /// And a view that declined state has to be retired by the takeover too.
    ///
    /// This is where compact and QUIC genuinely differ rather than merely being
    /// shaped differently. On QUIC a streamless secondary owns no state stream,
    /// so there is nothing for a takeover to cancel — and nothing is lost,
    /// because its session-control stream is one of many on a connection whose
    /// heartbeat lives elsewhere. On compact the connection *is* the view: a
    /// superseded handler nobody cancelled keeps answering heartbeats and
    /// selection requests on an attachment the authority has already replaced,
    /// so its client is told a dead view is alive by the very mechanism that
    /// exists to detect the opposite.
    ///
    /// Registration therefore cannot be conditional on wanting state. What it
    /// binds on this transport is the connection, not a feed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_superseded_streamless_compact_connection_is_retired_too() -> Result<()> {
        let mut host = CompactHost::new()?;
        let mut superseded = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        let session_id = host.session_id.clone();
        let attached = superseded
            .attach(&session_id, "r:pane-1#g1", 1, None, false)
            .await?;
        assert!(
            matches!(attached, SessionControlMessage::ViewAttached { .. }),
            "the streamless attach was refused: {attached:?}"
        );
        // It answers while it is current. The assertion below is that it stops,
        // not that it never could — without this the test would pass against a
        // host that had simply broken streamless attach outright.
        superseded
            .write_control(&SessionControlMessage::Ping { nonce: 1 })
            .await?;
        assert!(
            matches!(
                superseded.next_control().await?,
                SessionControlMessage::Pong { nonce: 1 }
            ),
            "a streamless view could not answer a probe even while current"
        );

        let mut successor = host
            .connect(StreamKind::SessionControl, PROTOCOL_MINOR)
            .await?;
        successor
            .attach(&session_id, "r:pane-1#g1", 2, None, false)
            .await?;

        // Probe the loser. A Pong here is the bug in its most direct form: the
        // superseded connection vouching for an attachment it no longer holds.
        // The write may lose a race with the close, which is why its failure is
        // tolerated and only the answer is asserted on.
        let _ = superseded
            .write_control(&SessionControlMessage::Ping { nonce: 2 })
            .await;
        let frames = superseded
            .frames_until(|frame| matches!(frame, CompactFrame::Closed))
            .await?;
        assert!(
            !frames.iter().any(|frame| matches!(
                frame,
                CompactFrame::Control(SessionControlMessage::Pong { .. })
            )),
            "a superseded streamless connection answered a heartbeat: {frames:?}"
        );
        assert!(
            matches!(frames.last(), Some(CompactFrame::Closed)),
            "the superseded streamless connection was left running: {frames:?}"
        );
        assert!(
            host.session()
                .view_attachment_epoch("r:pane-1#g1")
                .is_some(),
            "the superseded handler took its successor's attachment with it"
        );
        drop(successor.io);
        Ok(())
    }

    /// §6.4's consult, on the transport that has no second stream to ask on.
    /// Verified rather than built: the arm landed in the Phase 3 review.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_compact_connection_answers_the_tombstone_consult() -> Result<()> {
        let mut host = CompactHost::serving(serving_status(ghosttea::SessionStatus::Ended {
            cause: ghosttea::SessionEndCause::Exited { code: Some(3) },
        }))?;
        let mut peer = host
            .connect(StreamKind::ConnectionControl, PROTOCOL_MINOR)
            .await?;
        peer.write_raw(&ConnectionMessage::SessionStatus {
            request_id: "status-1".into(),
            session_id: "a-session-that-is-gone".into(),
        })
        .await?;
        let answer = peer.read_raw::<ConnectionMessage>().await?;
        assert!(
            matches!(
                answer,
                ConnectionMessage::SessionStatusResult {
                    ref request_id,
                    status: SessionStatusKind::Ended {
                        reason: SessionEndReason::Exited { code: Some(3) },
                    },
                } if request_id == "status-1"
            ),
            "the compact host could not account for a session it had buried: {answer:?}"
        );
        Ok(())
    }

    // ── Cross-language constants lockstep ────────────────────────────

    /// The Swift half of the reconnect timings, read at compile time.
    ///
    /// Reading the real file rather than a copy is the point: a Swift edit that
    /// drifts from Rust cannot be made without this crate rebuilding and the
    /// test below failing.
    const SWIFT_RECONNECT_CONSTANTS: &str = include_str!(
        "../../../../../apple/GhostteaKit/Sources/GhostteaTruffle/GhostteaReconnectConstants.swift"
    );

    /// The `public static let <name>: UInt64 = <digits>` declarations inside
    /// `GhostteaReconnectDefaults`, in file order.
    ///
    /// Scoped to that enum deliberately. The same file declares defaults
    /// elsewhere — `bannerGraceMs` among them — and those are not pinned: it is
    /// how long the UI waits before showing a banner, and the daemon renders
    /// nothing, so there is no Rust counterpart for it to drift from.
    fn swift_reconnect_defaults() -> Vec<(String, u64)> {
        let body = SWIFT_RECONNECT_CONSTANTS
            .split_once("public enum GhostteaReconnectDefaults {")
            .expect("the Swift constants enum was renamed or removed")
            .1
            .split_once("\n}")
            .expect("the Swift constants enum is unterminated")
            .0;
        body.lines()
            .filter_map(|line| {
                let (name, value) = line
                    .trim()
                    .strip_prefix("public static let ")?
                    .split_once(": UInt64 = ")?;
                Some((
                    name.to_owned(),
                    value
                        .trim()
                        .replace('_', "")
                        .parse::<u64>()
                        .unwrap_or_else(|_| panic!("{name} is no longer a plain integer literal")),
                ))
            })
            .collect()
    }

    /// Every reconnect timing the two languages share, pinned to one value.
    ///
    /// The clients enforce these locally — a viewer decides for itself when a
    /// connection has gone quiet — so nothing on the wire forces agreement and
    /// a drift would not fail an interop test. It would ship as one platform
    /// giving up on a host seconds before the other, which reads as a flaky
    /// network rather than as the edit that caused it.
    #[test]
    fn the_swift_reconnect_constants_match_their_rust_counterparts() {
        let rust = MeshReconnectConfig::default();
        let pinned: [(&str, u64); 9] = [
            ("heartbeatIdleMs", rust.heartbeat_idle.as_millis() as u64),
            ("heartbeatFailMs", rust.heartbeat_fail.as_millis() as u64),
            ("backoffBaseMs", rust.backoff_base.as_millis() as u64),
            ("backoffCapMs", rust.backoff_cap.as_millis() as u64),
            ("backoffFloorMs", rust.backoff_floor.as_millis() as u64),
            ("suspendAfterMs", rust.suspend_after.as_millis() as u64),
            (
                "synchronizeTimeoutMs",
                rust.synchronize_timeout.as_millis() as u64,
            ),
            (
                "remoteReconnectProtocolMinor",
                u64::from(REMOTE_RECONNECT_PROTOCOL_MINOR),
            ),
            // The one row whose Rust side is a host constant rather than a
            // viewer default, pinned because the Swift declaration says it
            // mirrors this one. The binding is worth keeping even though the
            // two are enforced in different processes: a client whose whole
            // attempt budget is shorter than the host's handshake budget gives
            // up while the host is still mid-handshake, so raising one without
            // considering the other is the mistake this catches.
            ("attemptTimeoutMs", HANDSHAKE_TIMEOUT.as_millis() as u64),
        ];
        let swift = swift_reconnect_defaults();

        // Exhaustiveness before equality. A constant added on the Swift side
        // with no row here would otherwise sail through — an unpinned constant
        // is exactly the drift this test exists to catch, and it is invisible
        // to a test that only checks the rows it already knows about.
        let mut found: Vec<&str> = swift.iter().map(|(name, _)| name.as_str()).collect();
        let mut expected: Vec<&str> = pinned.iter().map(|(name, _)| *name).collect();
        found.sort_unstable();
        expected.sort_unstable();
        assert_eq!(
            found, expected,
            "GhostteaReconnectDefaults and this test have drifted apart: every \
             constant in that enum needs a Rust counterpart pinned here, and a \
             name dropped on one side has to be dropped on both"
        );

        for (name, want) in pinned {
            let (_, got) = swift
                .iter()
                .find(|(found, _)| found == name)
                .expect("checked exhaustively above");
            assert_eq!(
                *got, want,
                "GhostteaReconnectDefaults.{name} is {got} in Swift but {want} in Rust"
            );
        }
    }

    // ── Tailnet identity binding (§9.1) ──────────────────────────────

    /// A WhoIs answer as the sidecar produces one: an owner, a name, and the
    /// stable node id that is the only part the peer registry can be matched
    /// against.
    fn tailnet_identity(node_id: Option<&str>) -> TailnetWhoIs {
        TailnetWhoIs::Identity(Box::new(TailscalePeerIdentity {
            dns_name: Some("viewer.tailnet.ts.net".into()),
            login_name: Some("owner@example.com".into()),
            display_name: Some("Owner".into()),
            node_id: node_id.map(str::to_owned),
            ..TailscalePeerIdentity::default()
        }))
    }

    fn registry_peer(tailscale_id: &str, device_id: Option<&str>) -> PeerBinding {
        PeerBinding {
            tailscale_id: tailscale_id.into(),
            device_id: device_id.map(str::to_owned),
            peer_ref: format!("{tailscale_id}:3"),
        }
    }

    /// The client id is derived from the peer the tailnet authenticated, so a
    /// peer whose durable id discovery has not published yet still binds:
    /// there was never anything in the hello for an assertion to steal.
    #[test]
    fn a_tailnet_identity_binds_the_client_to_the_peer_it_authenticates() -> Result<()> {
        let node_id = authenticated_node_id(tailnet_identity(Some("nodeAAAA")))?
            .context("a WhoIs identity authenticates a node id")?;
        assert_eq!(node_id, "nodeAAAA");
        assert_eq!(
            bind_authenticated_peer(
                &node_id,
                Some(&registry_peer("nodeAAAA", Some("device-1"))),
                "device-1",
            )?,
            "truffle:nodeAAAA:3"
        );
        assert_eq!(
            bind_authenticated_peer(&node_id, Some(&registry_peer("nodeAAAA", None)), "device-1")?,
            "truffle:nodeAAAA:3"
        );
        Ok(())
    }

    /// The Phase 2 caveat, closed: a peer inside the tailnet that asserts
    /// another device's id is refused instead of inheriting its client id.
    #[test]
    fn a_hello_asserting_another_devices_id_is_refused() {
        assert!(
            bind_authenticated_peer(
                "nodeAAAA",
                Some(&registry_peer("nodeAAAA", Some("device-1"))),
                "device-2",
            )
            .is_err()
        );
    }

    #[test]
    fn an_unauthenticated_source_is_refused_rather_than_admitted() {
        // The tailnet claims no identity for the address at all.
        assert!(authenticated_node_id(TailnetWhoIs::Anonymous).is_err());
        // An identity with no stable node id matches no peer, however much
        // else it carries.
        assert!(authenticated_node_id(tailnet_identity(None)).is_err());
        assert!(authenticated_node_id(tailnet_identity(Some("   "))).is_err());
        // A WhoIs that exists and did not answer is an outage, not licence to
        // trust the hello.
        assert!(
            authenticated_node_id(TailnetWhoIs::Unavailable("sidecar is wedged".into())).is_err()
        );
    }

    /// Only a provider with no WhoIs at all — the in-process transports these
    /// tests run on — falls back to hello-asserted identity.
    #[test]
    fn only_a_provider_without_whois_falls_back_to_the_hello() -> Result<()> {
        assert!(authenticated_node_id(TailnetWhoIs::Unsupported)?.is_none());
        Ok(())
    }

    #[test]
    fn an_authenticated_identity_the_registry_cannot_place_is_refused() {
        assert!(bind_authenticated_peer("nodeAAAA", None, "device-1").is_err());
        // `Node::peer` resolves names and device-id prefixes too, so the
        // resolved peer has to answer to the authenticated stable id itself.
        assert!(
            bind_authenticated_peer(
                "nodeAAAA",
                Some(&registry_peer("nodeBBBB", Some("device-1"))),
                "device-1",
            )
            .is_err()
        );
    }

    // ── Connection ids and termination (§4.2.1) ──────────────────────

    #[test]
    fn connection_ids_are_stamped_in_acceptance_order() {
        let ledger = ConnectionLedger::default();
        let first = ledger.accept();
        let second = ledger.accept();
        assert!(second.id() > first.id());
    }

    /// A fence may only advance past connections that can no longer deliver an
    /// attach — and a connection that has not yet said whose it is could still
    /// turn out to be anyone's.
    #[test]
    fn a_fence_waits_for_every_connection_that_could_still_attach() {
        let ledger = ConnectionLedger::default();
        let older = ledger.accept();
        older.identify("client-a");
        let newer = ledger.accept();
        newer.identify("client-b");
        let unidentified = ledger.accept();
        // Ids come from one process-wide sequence, so nothing here may assume
        // they are consecutive — only that they ascend.
        let (older_id, newer_id, unidentified_id) = (older.id(), newer.id(), unidentified.id());

        assert_eq!(ledger.terminated_through("client-a"), older_id - 1);
        assert_eq!(ledger.terminated_through("client-b"), newer_id - 1);

        drop(older);
        // A's own connection is gone, but the unidentified one might be A's.
        assert_eq!(ledger.terminated_through("client-a"), unidentified_id - 1);
        assert_eq!(ledger.terminated_through("client-b"), newer_id - 1);

        drop(newer);
        assert_eq!(ledger.terminated_through("client-b"), unidentified_id - 1);

        drop(unidentified);
        // Nothing is in flight, so everything accepted so far is provably gone.
        assert_eq!(ledger.terminated_through("client-a"), unidentified_id);
        assert_eq!(ledger.terminated_through("client-b"), unidentified_id);
    }

    /// "Fully terminated" is transport closed **and** every handler finished:
    /// an orphaned handler keeps the connection live.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connection_terminates_only_after_its_last_handler_finishes() {
        let ledger = ConnectionLedger::default();
        let scope = ledger.accept();
        let id = scope.id();
        scope.identify("client-a");
        let handler = scope.clone();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _handler = handler;
            let _ = released.await;
        });
        // The transport is gone; its handler is not.
        drop(scope);
        assert!(!ledger.fully_terminated(id));
        assert_eq!(ledger.terminated_through("client-a"), id - 1);

        let _ = release.send(());
        task.await.unwrap();
        assert!(ledger.fully_terminated(id));
        assert_eq!(ledger.terminated_through("client-a"), id);
    }

    /// The same over the real host accept path, and the case the fence turns
    /// on: the task that owns the transport dies while the view handler it
    /// spawned keeps running. An orphaned handler can still act on the
    /// session, so the connection is not terminated until it too unwinds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_served_connection_terminates_only_after_its_view_handler_unwinds() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let host = &fixture.hosts[0];
        let id = host.connection_id;
        assert!(!host.connections.fully_terminated(id));
        assert_eq!(
            host.connections.terminated_through("truffle:peer:1"),
            id - 1
        );

        // The connection's own task is gone; the handlers it spawned are not.
        host.task.abort();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !host.connections.fully_terminated(id),
            "an orphaned handler was counted as a terminated connection"
        );

        // Now the transport dies too, and everything reading it unwinds.
        host.server.close();
        for _ in 0..400 {
            if host.connections.fully_terminated(id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            host.connections.fully_terminated(id),
            "a dead connection never reported its handlers finished"
        );
        assert_eq!(host.connections.terminated_through("truffle:peer:1"), id);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires TRUFFLE_TEST_AUTHKEY and a reachable Tailscale control plane"]
    async fn latest_truffle_quic_round_trip() -> Result<()> {
        let _ = dotenvy::dotenv();
        let auth_key = env::var("TRUFFLE_TEST_AUTHKEY")
            .context("TRUFFLE_TEST_AUTHKEY is required for this ignored test")?;
        let sidecar_path = env::var("TRUFFLE_SIDECAR_PATH")
            .context("TRUFFLE_SIDECAR_PATH is required for this ignored test")?;
        let a_state = tempfile::tempdir()?;
        let b_state = tempfile::tempdir()?;
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let build_a = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("terminal-a-{suffix}"))
            .state_dir(a_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let build_b = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("terminal-b-{suffix}"))
            .state_dir(b_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let (node_a, node_b) = tokio::time::timeout(Duration::from_secs(60), async {
            tokio::try_join!(build_a, build_b)
        })
        .await
        .context("timed out starting the two Truffle nodes")??;
        let node_a = Arc::new(node_a);
        let node_b = Arc::new(node_b);
        let b_id = node_b.local_info().device_id;
        tokio::time::timeout(Duration::from_secs(35), node_a.peer(&b_id, Some(30_000)))
            .await
            .context("timed out discovering the second Truffle node")??
            .context("node B did not appear in node A's peer registry")?;

        let listener = node_b.listen_quic(19_420).await?;
        let accept = listener.accept();
        let connect = node_a.connect_quic(&b_id, 19_420);
        let (accepted, client) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(accept, connect)
        })
        .await
        .context("timed out establishing the Truffle QUIC connection")?;
        let server = accepted.context("QUIC listener closed")?;
        let client = client?;
        let mut client_stream = client.open_stream().await?;
        client_stream.write(b"truffle-0.7.1").await?;
        client_stream.finish();
        let mut server_stream =
            tokio::time::timeout(Duration::from_secs(10), server.accept_stream())
                .await
                .context("timed out accepting the Truffle QUIC stream")??
                .context("client stream was not accepted")?;
        assert_eq!(
            server_stream.read(64).await?.as_deref(),
            Some(b"truffle-0.7.1".as_slice())
        );
        client.close();
        server.close();
        listener.close();
        tokio::time::timeout(Duration::from_secs(10), node_a.stop())
            .await
            .context("timed out stopping Truffle node A")?;
        tokio::time::timeout(Duration::from_secs(10), node_b.stop())
            .await
            .context("timed out stopping Truffle node B")?;
        Ok(())
    }

    /// The identity binding on a real tailnet, which is the only place it can
    /// be proven: WhoIs on the accepted connection's address resolves to the
    /// dialing node, the resolver derives that peer's client id, and a hello
    /// asserting a different device id is refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires TRUFFLE_TEST_AUTHKEY and a reachable Tailscale control plane"]
    async fn whois_binds_a_real_quic_connection_to_the_peer_that_dialed_it() -> Result<()> {
        let _ = dotenvy::dotenv();
        let auth_key = env::var("TRUFFLE_TEST_AUTHKEY")
            .context("TRUFFLE_TEST_AUTHKEY is required for this ignored test")?;
        let sidecar_path = env::var("TRUFFLE_SIDECAR_PATH")
            .context("TRUFFLE_SIDECAR_PATH is required for this ignored test")?;
        let a_state = tempfile::tempdir()?;
        let b_state = tempfile::tempdir()?;
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let build_a = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("identity-a-{suffix}"))
            .state_dir(a_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let build_b = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("identity-b-{suffix}"))
            .state_dir(b_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let (node_a, node_b) = tokio::time::timeout(Duration::from_secs(60), async {
            tokio::try_join!(build_a, build_b)
        })
        .await
        .context("timed out starting the two Truffle nodes")??;
        let node_a = Arc::new(node_a);
        let node_b = Arc::new(node_b);
        let a_device_id = node_a.local_info().device_id;
        let b_device_id = node_b.local_info().device_id;
        tokio::time::timeout(
            Duration::from_secs(35),
            node_b.peer(&a_device_id, Some(30_000)),
        )
        .await
        .context("timed out discovering node A from node B")??
        .context("node A did not appear in node B's peer registry")?;

        let listener = node_b.listen_quic(19_421).await?;
        let accept = listener.accept();
        let connect = node_a.connect_quic(&b_device_id, 19_421);
        let (accepted, client) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(accept, connect)
        })
        .await
        .context("timed out establishing the Truffle QUIC connection")?;
        let server = accepted.context("QUIC listener closed")?;
        let client = client?;

        // The address the connection actually arrived from — whatever path the
        // tailnet chose, direct or DERP-relayed.
        let remote = server.remote_address();
        let identity = tokio::time::timeout(WHOIS_TIMEOUT, node_b.whois(&remote.to_string()))
            .await
            .context("timed out asking the tailnet who opened the connection")??
            .context("the tailnet claimed no identity for the connection's address")?;
        let node_id = identity
            .node_id
            .clone()
            .context("WhoIs answered without a stable node id")?;
        let peer = node_b
            .peer(&a_device_id, Some(PEER_RESOLVE_WAIT_MS))
            .await?
            .context("node A left node B's registry")?;
        assert_eq!(
            node_id, peer.tailscale_id,
            "WhoIs authenticated a different node than the one that dialed"
        );

        // The production resolver, on the production inputs.
        let resolver = NodeClientResolver {
            node: Arc::clone(&node_b),
        };
        assert_eq!(
            resolver.resolve(&a_device_id, Some(remote.ip())).await?,
            format!("truffle:{}", peer.peer_ref)
        );
        // §9.1, closed on a real tailnet: node B's own id asserted by node A
        // no longer buys node B's client id.
        assert!(
            resolver
                .resolve(&b_device_id, Some(remote.ip()))
                .await
                .is_err(),
            "a hello asserting another device's id was accepted"
        );

        client.close();
        server.close();
        listener.close();
        tokio::time::timeout(Duration::from_secs(10), node_a.stop())
            .await
            .context("timed out stopping Truffle node A")?;
        tokio::time::timeout(Duration::from_secs(10), node_b.stop())
            .await
            .context("timed out stopping Truffle node B")?;
        Ok(())
    }
}
