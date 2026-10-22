# Terminal Mirroring and Truffle Networking Addendum

Implementation target: Truffle 0.7.19, pinned exactly to the registry release
(`truffle-core = "=0.7.19"` in the workspace `Cargo.toml`), not the older 0.4.6
API. The Rust dependency and live transport test resolve from crates.io; the
sibling `p008/truffle` checkout this addendum was first written against is no
longer used, and the Swift side consumes Truffle's published repository.

## 1. Simplified model

```text
One authoritative terminal session
├── one PTY
├── one libghostty-vt state
├── one canonical terminal size
├── one globally ordered input stream
├── zero or more local views
└── zero or more remote replicated views
```

There is no driver election, lease timeout, presenter role, collaborative cursor model, or CRDT.

The only shared-control rule is:

> The most recently focused interactive view controls the canonical PTY size.

All writable views may continue sending input. The session authority serializes input in arrival order.

---

# 2. Resize control: authority-ordered LWW

Although this resembles last-write-wins, it must not use client timestamps.

Different machines have:

- unsynchronized clocks;
- variable network latency;
- suspended tabs;
- delayed packets;
- reconnects.

Instead, the terminal session authority assigns a monotonically increasing control epoch.

```rust
struct ResizeController {
    view_id: ViewId,
    client_id: ClientId,
    control_epoch: u64,
}
```

The session owns:

```rust
struct TerminalSession {
    session_id: SessionId,

    pty: PtyHandle,
    terminal: GhosttyTerminal,

    canonical_size: TerminalSize,
    layout_epoch: u64,

    controller: Option<ResizeController>,
    next_control_epoch: u64,

    views: HashMap<ViewId, AttachedView>,
}
```

## 2.1 Focus and control claim

A view sends one atomic message when it gains interactive focus:

```rust
struct FocusAndResize {
    session_id: SessionId,
    view_id: ViewId,

    cols: u16,
    rows: u16,

    client_sequence: u64,
}
```

The authority processes it as:

```rust
fn handle_focus_and_resize(
    session: &mut TerminalSession,
    command: FocusAndResize,
) {
    session.next_control_epoch += 1;

    let control_epoch = session.next_control_epoch;

    session.controller = Some(ResizeController {
        view_id: command.view_id,
        client_id: lookup_client(command.view_id),
        control_epoch,
    });

    if session.canonical_size != (command.cols, command.rows) {
        session.resize_pty(command.cols, command.rows);
        session.layout_epoch += 1;
    }

    session.broadcast(ControlChanged {
        controller_view_id: command.view_id,
        control_epoch,
        canonical_size: session.canonical_size,
        layout_epoch: session.layout_epoch,
    });
}
```

The last focus claim **processed by the authority** wins.

That gives deterministic behavior regardless of whether the winning view is:

- another pane in the same Electron window;
- another local Electron window;
- another process on the same machine;
- a replicated view on a remote device.

## 2.2 Subsequent resize messages

After receiving `ControlChanged`, the focused view may send:

```rust
struct Resize {
    session_id: SessionId,
    view_id: ViewId,
    control_epoch: u64,
    cols: u16,
    rows: u16,
    resize_sequence: u64,
}
```

The authority accepts it only when:

```rust
fn resize_is_authorized(
    session: &TerminalSession,
    command: &Resize,
) -> bool {
    matches!(
        &session.controller,
        Some(controller)
            if controller.view_id == command.view_id
            && controller.control_epoch == command.control_epoch
    )
}
```

A delayed resize from the previous controller is rejected:

```rust
ResizeRejected {
    current_controller_view_id,
    current_control_epoch,
    canonical_size,
}
```

This handles the race:

```text
View A focuses
View A sends resize

View B focuses
View B becomes controller

Delayed View A resize arrives
→ rejected because A's control epoch is stale
```

## 2.3 What counts as focus

Do not claim control on arbitrary programmatic DOM focus.

Claim it after meaningful user interaction:

- pointer down inside the terminal;
- keyboard input directed to the terminal;
- explicit “focus terminal” command;
- explicit activation of a terminal pane.

Recommended browser-side logic:

```ts
function activateTerminalView(view: TerminalView): void {
  view.claimControl({
    cols: view.currentCols,
    rows: view.currentRows,
  });

  inputRouter.setActiveView(view.id);
}
```

A plain `focusin` caused by restoring browser state should not necessarily claim control unless it also activates the terminal in the application model.

## 2.4 Controller disconnect

When the current controller detaches:

```text
controller = none
canonical PTY size stays unchanged
```

Do not automatically choose another view.

The next local or remote view that receives meaningful focus sends `FocusAndResize` and becomes controller.

This avoids hidden panes unexpectedly resizing the PTY.

---

# 3. Mirrored views with different dimensions

The PTY still has one canonical grid:

```text
canonical terminal: 140 × 42
```

A non-controlling view must not resize it.

It can present that grid through:

- clipping;
- letterboxing;
- scaling;
- scrolling;
- thumbnail rendering.

Example:

```text
Controller view
available grid: 140 × 42
PTY grid:       140 × 42

Small mirrored view
available grid: 90 × 24
renders a scaled or clipped representation of 140 × 42

Large mirrored view
available grid: 180 × 55
renders 140 × 42 with padding
```

The view may have a different:

- font;
- DPI;
- zoom;
- theme;
- refresh rate;
- scrollback position;
- selection.

But it renders the same logical terminal grid.

---

# 4. Input remains simple

Resize control does not need to become input ownership.

Every attached view has a basic permission:

```rust
enum ViewAccess {
    ReadOnly,
    ReadWrite,
}
```

Any `ReadWrite` view may send:

- keyboard events;
- committed IME text;
- paste;
- mouse input;
- interrupt requests.

The authority serializes them:

```rust
struct InputCommand {
    view_id: ViewId,
    view_sequence: u64,
    payload: InputPayload,
}
```

```text
Local view A input ──┐
Remote view B input ─┼→ authority input queue → libghostty encoder → PTY
Local view C input ──┘
```

No collaborative input CRDT is needed. Terminal input is an ordered byte stream.

The UI may display which view generated input for diagnostics, but this is not part of terminal correctness.

---

# 5. Truffle integration boundary

The terminal system should not implement:

- Tailscale discovery;
- tailnet authentication;
- peer lookup;
- NAT traversal;
- direct-versus-relay routing;
- raw QUIC setup;
- reconnecting to peer addresses.

Truffle owns those concerns.

The terminal layer owns:

- terminal session identity;
- attach authorization;
- terminal protocol negotiation;
- snapshots and patches;
- input;
- focus and resize control;
- scrollback retrieval;
- session lifecycle.

```text
Terminal Session Protocol
          ↓
Truffle QUIC / Truffle discovery
          ↓
Tailscale / tsnet
```

Truffle’s current API already exposes `Peer` handles with live process-local identity plus durable `deviceId`, and raw transport APIs accept `Peer | string`. A durable `deviceId` should be persisted for reconnect, while live networking should use a resolved `Peer` handle. citeturn534891view0

---

# 6. Process topology

The consuming application's Rust service owns the Truffle node. The terminal
service receives a clone of that host-owned `Arc` and owns only its terminal
listener, discovery store, and protocol tasks.

```text
Electron
   │ local UDS / named pipe
   ▼
application Rust service
├── shared Arc<TruffleNode>
├── application-specific Truffle services
└── terminal service library
├── terminal session authority
├── local view connections
├── remote view replicas
├── terminal-protocol
├── terminal-transport-local
└── terminal-transport-truffle
        │
        ▼
Truffle Rust runtime
        │
        ▼
Truffle Go tsnet sidecar
        │
        ▼
Tailscale tailnet
```

Do not run the terminal network protocol through:

- the Electron renderer;
- Electron main;
- the Node Truffle binding;
- a browser WebSocket.

The terminal library must not construct a second Truffle node, select the
application identity, open the host's state directory independently, resolve
`sidecar-slim`, or stop the shared node. Those are composition-root concerns.
The standalone `ghosttead` binary is only an example composition root for the
demo desktop application.

Truffle currently provides a Rust API in addition to its Node and Tauri integrations, with the Go sidecar responsible for Tailscale integration. citeturn415142view0

## 6.1 One Truffle node per application profile

Use one Truffle node for all Rust services in an application profile:

```rust
struct TruffleTerminalTransport {
    node: Arc<TruffleNode>,
    listener: QuicListener,
    host_store: SyncedStore<TerminalHostAdvertisement>,
}
```

```rust
let node = Arc::new(build_host_owned_truffle_node().await?);
let application_sync = ApplicationSync::new(Arc::clone(&node));
let terminal = TruffleTerminalTransport::new(
    Arc::clone(&node),
    "terminal.v1",
);
```

The host application chooses the Truffle application identity:

```text
appId = "<product>"
```

Every participating application profile uses the same app ID, while terminal
traffic is isolated under a host-assigned `terminal.v1` service scope.

Truffle scopes peer visibility by `appId`, so unrelated Truffle applications do not enter this terminal network. citeturn534891view0

---

# 7. Use Truffle SyncedStore only for discovery

Use a device-owned synced store to advertise terminal hosts and shareable sessions:

```rust
struct TerminalHostAdvertisement {
    protocol_major: u16,
    protocol_minor: u16,

    quic_port: u16,
    host_instance_id: HostInstanceId,

    sessions: Vec<SharedSessionSummary>,
}
```

```rust
struct SharedSessionSummary {
    session_id: SessionId,
    title: String,
    cwd_label: Option<String>,

    running: bool,
    attachable: bool,
    access: AdvertisedAccess,

    created_at: u64,
}
```

Scoped store name:

```text
<terminal-service>.hosts
```

Conceptually:

```rust
let hosts =
    truffle.synced_store::<TerminalHostAdvertisement>("terminal.v1.hosts");

hosts.set(local_advertisement).await;
```

Truffle’s synced stores use device-owned slices: each device updates only its own slice, while peers observe the collection. That is a good match for “which terminal sessions does each device currently expose?” citeturn534891view0turn574593view0

Do not put these into the synced store:

- terminal rows;
- scrollback;
- raw PTY output;
- render frames;
- input events;
- control ownership.

The store is discovery metadata only.

---

# 8. Use Truffle QUIC for attached sessions

Truffle’s QUIC API exposes a connection carrying multiple bidirectional streams, with independently opened and accepted streams. That maps directly to the terminal protocol. citeturn534891view0

Use one Truffle QUIC connection per pair of terminal hosts:

```text
Device A ghosttead
       │
       │ one Truffle QUIC connection
       ▼
Device B ghosttead
```

Multiple terminal sessions can share that connection.

## 8.1 Stream layout

```text
Truffle QUIC connection
├── connection control stream
├── session control stream: session A
├── live state stream: session A
├── session control stream: session B
├── live state stream: session B
├── scrollback stream: opened on demand
└── image/asset stream: opened on demand
```

Every stream begins with a small preface:

```rust
struct StreamPreface {
    magic: [u8; 4],            // "TSP1"
    protocol_major: u16,
    protocol_minor: u16,

    stream_kind: StreamKind,
    session_id: Option<SessionId>,
    view_id: Option<ViewId>,
}
```

```rust
enum StreamKind {
    ConnectionControl,
    SessionControl,
    LiveState,
    Scrollback,
    Asset,
}
```

The explicit stream type avoids relying on stream-open order.

## 8.2 Why separate control and state streams

The control stream carries latency-sensitive messages:

- input;
- focus claims;
- resize;
- interrupt;
- detach;
- acknowledgements.

The state stream carries:

- snapshots;
- row replacements;
- cursor updates;
- palette changes;
- image placements.

A large terminal redraw must not delay Ctrl+C or a focus claim.

QUIC’s multiplexed streams are the right Truffle primitive here; Truffle exposes each stream as a duplex byte stream. citeturn534891view0turn747143view0

---

# 9. Do not use Truffle messaging for terminal frames

Truffle’s namespaced message bus is useful for ordinary application messages and lazily establishes internal peer sessions. citeturn534891view0

It is suitable for:

- an optional “please refresh your host advertisement” message;
- debug notifications;
- invite notifications;
- low-rate service events.

It should not carry:

- live terminal row patches;
- large snapshots;
- scrollback;
- glyphs;
- terminal images.

Those belong on raw QUIC streams, where the terminal protocol controls:

- framing;
- backpressure;
- packet size;
- coalescing;
- acknowledgement;
- stream priority separation.

---

# 10. Do not use Truffle UDP initially

Truffle exposes unreliable unordered datagrams and recommends payloads around 1,200 bytes or smaller to avoid tailnet MTU fragmentation. citeturn534891view0

Terminal patches frequently exceed 1,200 bytes:

```text
row graphemes
+ style information
+ row IDs
+ revisions
+ cursor state
```

Using UDP would require:

- fragmentation;
- reassembly;
- expiry;
- loss recovery;
- snapshot fallback;
- duplicate detection.

That complexity is not justified initially.

Use reliable QUIC streams, but coalesce stale state before writing:

```text
terminal changes rapidly
→ replace pending unsent state with newest state
→ write latest absolute row replacements
```

Reliable delivery does not mean every intermediate frame must be generated or queued.

Truffle UDP can later be evaluated for tiny optional signals such as:

- cursor-only state;
- heartbeat hints;
- latency probes.

It should not be required for terminal correctness.

---

# 11. Network terminal protocol

## 11.1 Connection handshake

After opening the connection-control stream:

```rust
struct ClientHello {
    protocol_major: u16,
    protocol_minor: u16,

    host_instance_id: HostInstanceId,
    local_device_id: String,

    supported_features: FeatureBits,
}
```

The receiver obtains the authenticated peer identity from Truffle and does not trust `local_device_id` as the networking identity.

Response:

```rust
struct ServerHello {
    protocol_major: u16,
    protocol_minor: u16,

    host_instance_id: HostInstanceId,
    features: FeatureBits,
}
```

## 11.2 Attach view

```rust
struct AttachView {
    request_id: RequestId,

    session_id: SessionId,
    view_id: ViewId,

    access_token: Option<SessionCapabilityToken>,

    viewport: ViewportRequest,
    render_capabilities: LogicalRenderCapabilities,
}
```

Response:

```rust
struct ViewAttached {
    request_id: RequestId,

    session_epoch: u64,
    layout_epoch: u64,

    canonical_size: TerminalSize,

    controller: Option<ControllerState>,
    access: ViewAccess,
}
```

The host then sends a full terminal snapshot on the live-state stream.

## 11.3 Focus and resize

Remote and local views use exactly the same logical message:

```rust
enum SessionControlMessage {
    FocusAndResize(FocusAndResize),
    Resize(Resize),

    Input(InputCommand),
    SetViewport(SetViewport),
    RequestSnapshot(RequestSnapshot),
    StateAck(StateAck),

    Interrupt(Interrupt),
    Detach(DetachView),
}
```

Local transport:

```text
Electron → UDS/named pipe → ghosttead authority
```

Remote transport:

```text
Electron → local ghosttead replica
         → Truffle QUIC
         → remote ghosttead authority
```

The session actor does not care which transport delivered the message.

---

# 12. Local and remote view identity

Use globally unique view IDs:

```rust
struct ViewId(Ulid);
```

A view ID identifies one mounted interactive view, not a device.

```text
Device A
├── window 1 / terminal pane → view 01...
└── window 2 / monitor card  → view 02...

Device B
└── remote terminal pane     → view 03...
```

The authority stores:

```rust
struct AttachedView {
    view_id: ViewId,

    source: ViewSource,
    access: ViewAccess,

    connected: bool,
    last_input_sequence: u64,
    last_state_ack: u64,
}
```

```rust
enum ViewSource {
    Local {
        connection_id: LocalConnectionId,
    },
    Remote {
        peer_device_id: String,
        connection_id: RemoteConnectionId,
    },
}
```

The resize controller stores the `ViewId`, not merely the peer device.

Therefore, two windows on the same remote machine still compete under the same LWW focus rule.

---

# 13. Logical state replication

The network does not carry WebGPU display lists or glyph bitmaps.

```text
Authoritative ghosttead
├── PTY
├── libghostty-vt
└── logical terminal rows
          │
          │ Truffle QUIC
          ▼
Replicating ghosttead
├── logical terminal replica
├── local font shaping
├── local glyph rasterization
└── local WebGPU display list
```

Network snapshot:

```rust
struct TerminalSnapshot {
    session_epoch: u64,
    layout_epoch: u64,
    terminal_revision: u64,

    canonical_size: TerminalSize,

    rows: Vec<LogicalRow>,
    cursor: CursorState,
    modes: TerminalModes,
    palette: TerminalPalette,
}
```

Incremental patch:

```rust
struct TerminalPatch {
    session_epoch: u64,
    layout_epoch: u64,
    patch_sequence: u64,
    terminal_revision: u64,

    row_replacements: Vec<RowReplacement>,

    cursor: Option<CursorState>,
    modes: Option<TerminalModes>,
    palette: Option<TerminalPalette>,
}
```

Rows remain absolute replacements:

```rust
struct RowReplacement {
    row_index: u16,
    row_revision: u64,
    cells: Vec<LogicalCell>,
}
```

This allows pending patches to be combined safely.

---

# 14. Backpressure and patch coalescing

Each remote view gets a state sender:

```rust
struct RemoteViewSender {
    acknowledged_revision: u64,
    queued_snapshot: Option<TerminalSnapshot>,
    queued_rows: HashMap<u16, RowReplacement>,
    queued_metadata: PendingMetadata,
}
```

When a row changes repeatedly before transmission:

```text
revision 42
revision 43
revision 44
```

only revision 44 needs to remain queued.

Control messages are never placed in this queue.

Recommended limits:

```text
maximum unsent live-state memory per view: 2–8 MiB
maximum unacknowledged patches: 2
lag threshold: force full viewport snapshot
```

State acknowledgement:

```rust
struct StateAck {
    session_epoch: u64,
    layout_epoch: u64,
    terminal_revision: u64,
}
```

---

# 15. Reconnection

Persist:

```text
peer.deviceId
sessionId
```

Do not persist Truffle’s process-local `PeerRef`. Truffle explicitly distinguishes durable device IDs from live peer handles and process-local references. citeturn534891view0

Reconnect flow:

```text
1. Truffle peer reappears
2. Resolve durable deviceId to a current Peer
3. Reconnect QUIC
4. Reopen connection-control stream
5. Attach the existing session
6. Create or resume the ViewId
7. Receive a full current snapshot
8. User focuses the terminal
9. FocusAndResize assigns a fresh control epoch
```

A disconnected remote controller immediately loses resize authority:

```text
controller = none
canonical size stays unchanged
```

A reconnect never reuses its old control epoch.

---

# 16. Session authorization

Truffle and Tailscale establish device connectivity and peer identity, but terminal attachment still needs application-level authorization.

Raw Truffle listeners are tailnet-reachable, while the application must decide what a particular peer may do. Truffle’s raw-transport RFC describes this distinction and exposes peer identity to application code. citeturn747143view0

Use:

```rust
struct SessionCapabilityToken {
    session_id: SessionId,
    grantee_device_id: Option<String>,

    can_view: bool,
    can_write: bool,

    expires_at: u64,
    nonce: [u8; 16],
    signature: [u8; 64],
}
```

For personal same-tailnet usage, the first implementation may also support:

```rust
enum SharePolicy {
    LocalOnly,
    AllowedDevices(HashSet<String>),
    TailnetReadOnly,
    TailnetReadWrite,
}
```

The session authority remains the final authorization point.

---

# 17. Code organization

```text
native/ghosttea/crates/
├── terminal-session/
│   ├── session_actor.rs
│   ├── resize_controller.rs
│   ├── views.rs
│   └── input.rs
│
├── terminal-protocol/
│   ├── control.rs
│   ├── state.rs
│   ├── framing.rs
│   └── version.rs
│
├── terminal-transport/
│   ├── traits.rs
│   └── connection.rs
│
├── terminal-transport-local/
│   ├── uds.rs
│   └── named_pipe.rs
│
├── terminal-transport-truffle/
│   ├── node.rs
│   ├── discovery.rs
│   ├── quic_listener.rs
│   ├── quic_connection.rs
│   └── peer_identity.rs
│
└── terminal-replica/
    ├── replica.rs
    ├── patch_apply.rs
    └── reconnect.rs
```

Transport-neutral interface:

```rust
#[async_trait]
trait TerminalConnection: Send + Sync {
    fn peer_identity(&self) -> ConnectionIdentity;

    async fn open_stream(
        &self,
        kind: StreamKind,
        session_id: Option<SessionId>,
        view_id: Option<ViewId>,
    ) -> Result<Box<dyn TerminalStream>>;

    async fn accept_stream(
        &self,
    ) -> Result<Option<AcceptedTerminalStream>>;

    async fn close(&self);
}
```

Truffle adapter:

```rust
struct TruffleTerminalConnection {
    peer: TrufflePeerIdentity,
    connection: TruffleQuicConnection,
}
```

The terminal crates never depend on:

- Tailscale addresses;
- tsnet;
- Truffle bridge headers;
- Electron;
- Node streams.

Only `terminal-transport-truffle` imports Truffle.

---

# 18. Final integrated topology

```text
DEVICE A — session authority
┌──────────────────────────────────────────────┐
│ Electron                                     │
│ └── local WebGPU terminal view A             │
│               │                              │
│               ▼                              │
│ application Rust service                     │
│ ├── shared host-owned Truffle node           │
│ ├── terminal library: PTY                    │
│ ├── authoritative libghostty-vt state        │
│ ├── canonical size                           │
│ ├── LWW resize controller                    │
│ ├── local attached view A                    │
│ ├── Truffle SyncedStore advertisement        │
│ └── Truffle QUIC session server              │
└──────────────────────┬───────────────────────┘
                       │ tailnet
                       │ Truffle QUIC
                       ▼
DEVICE B — replicated view
┌──────────────────────────────────────────────┐
│ application Rust service                     │
│ ├── shared host-owned Truffle node           │
│ ├── terminal library: peer connection        │
│ ├── logical terminal replica                 │
│ ├── local font shaping                       │
│ └── local render-display generation          │
│               │                              │
│               ▼                              │
│ Electron                                     │
│ └── local WebGPU terminal view B             │
└──────────────────────────────────────────────┘
```

When view B receives focus:

```text
View B
→ FocusAndResize(160 × 48)
→ local ghosttead
→ Truffle QUIC control stream
→ Device A session authority
→ assigns new control_epoch
→ resizes PTY to 160 × 48
→ increments layout_epoch
→ broadcasts ControlChanged
→ broadcasts full current terminal layout
→ both views render 160 × 48
```

When view A subsequently receives focus:

```text
View A
→ FocusAndResize(120 × 36)
→ authority assigns newer control_epoch
→ PTY becomes 120 × 36
→ delayed resize from view B is rejected
```

The resulting invariants are:

```text
Exactly one PTY
Exactly one authoritative terminal state
Exactly one canonical size
Exactly one current resize controller
Last authority-processed focus claim wins
Any number of local or remote mirrored views
Truffle owns peer networking
Terminal protocol owns session semantics
```
