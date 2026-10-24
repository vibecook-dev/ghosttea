# ghosttea

Transport-neutral Rust service for Ghosttea terminal sessions. The embedding
application owns process lifecycle and may inject a separate remote transport
adapter through the `TerminalMesh` interface.

The sibling `ghosttea-core` crate owns terminal mutation, logical and replica
state, shaping, render caching, TRF1 production, ordered effects, and interaction
ordering policy. This service executes those effects and remains the desktop
host responsible for PTY processes, session summaries, frame broadcasts,
sockets, persistence, and remote mesh adapters. Its operation gate preserves
the core's effect order across concurrent PTY output, view actions, and input.

## Embedded service mode

`TerminalService::run()` is the standalone convenience path used by
`ghosttead`: it removes stale endpoints, binds both configured endpoints, and
serves them. An application that owns its runtime directory, endpoint
permissions, and startup ordering can instead create the listeners and pass
them to `serve()`:

```rust,ignore
use ghosttea::{
    ipc, TerminalService, TerminalServiceConfig, TerminalServiceListeners,
};

// A Unix socket outlives the process that bound it, so a host that restarts
// replaces its own endpoints. Windows has nothing to remove and this is a
// no-op there.
ipc::remove_stale_endpoint(&control_path)?;
ipc::remove_stale_endpoint(&frame_path)?;

let control = ipc::Listener::bind(&control_path)?;
let frames = ipc::Listener::bind(&frame_path)?;
set_private_socket_permissions(&control_path)?;
set_private_socket_permissions(&frame_path)?;

let service = TerminalService::new(TerminalServiceConfig {
    // `serve` uses the supplied listeners; these paths remain the fallback
    // endpoints used if the same service is started through `run`.
    control_socket: control_path.clone(),
    frame_socket: frame_path.clone(),
    auth_token: stable_random_token.clone(),
})
.with_private_env_prefixes(["FIELD_"])?
.with_text_engine(application_text_engine)
.with_terminal_mesh(application_terminal_mesh);

service
    .serve(TerminalServiceListeners::new(control, frames))
    .await?;
```

The host owns listener creation, replacement, permissions, and unlinking when
it supplies listeners. On Unix an endpoint is a socket path and
`ipc::Listener` also accepts a `tokio::net::UnixListener` through `From`, so a
host that binds its own socket can pass it straight in. Dropping or cancelling
the `serve()` future stops accepting traffic and aborts the terminal mesh task,
but it is not a graceful session-drain API. A host that needs classified
shutdown events should terminate its sessions before cancellation.

### In-process session access

An embedding host that serves an additional transport beside Ghosttea's local
sockets can use `serve_managed` to reach the exact same registry and frame hub:

```rust,ignore
let (service_handle, serving) = service.serve_managed(listeners);
let serving = tokio::spawn(serving);

// The serving future must be polled before readiness can complete.
let sessions = service_handle.sessions().await?;
let mut lifecycle = sessions.subscribe_lifecycle();

let session = sessions.spawn(spawn_options).await?;
let same_session = sessions.session(&session.id()).expect("registered session");
assert!(std::sync::Arc::ptr_eq(&session, &same_session));

let (mut frames, baseline_ordinal) = sessions.frames().subscribe();
session.attach_view("door-view", "door-client")?;
let packet = frames.recv().await?;
assert!(packet.ordinal > baseline_ordinal);

service_handle.shutdown(shutdown_timeout).await?;
serving.await??;
```

`ServiceSessions::spawn` is the service policy path, not a parallel registry:
it applies configured private-environment stripping, scrollback and appearance,
shutdown and owner fencing, persistence, tombstones, socket-visible events, and
typed lifecycle events. `Created`, `Exited`, and `Removed` are independent
facts and may arrive in either exit/removal order. A lagged lifecycle receiver
should reconcile with `sessions()`; `snapshot_and_subscribe()` provides the
subscribe-before-snapshot pattern for that fold.

Use public `Session::spawn_with_private_env_prefixes` only when the embedder
deliberately owns those service policies itself.

## Local endpoints by platform

| Platform     | Control            | Frames                    |
| ------------ | ------------------ | ------------------------- |
| macOS, Linux | Unix-domain socket | second Unix-domain socket |
| Windows      | named pipe         | second named pipe         |

Windows pipe names share one flat, machine-wide namespace instead of sitting
under a private directory, so each name carries an instance suffix and the
listener refuses to bind a name that already exists. That refusal is what stops
another process from publishing the pipe first and collecting connections meant
for the service.

A named pipe created without an explicit security descriptor gets a permissive
default DACL — read access for Everyone and for Anonymous. The listener instead
builds `D:P(A;;FA;;;<current user SID>)`, a protected DACL granting full access
to the account running the service and nothing to anyone else, and applies it to
every instance it creates. On Unix the runtime directory's permissions provide
the same boundary. `ipc::Listener` asserts the resulting DACL against a live
pipe handle in its tests, because passing a descriptor that never reaches the
object fails silently.

A pipe can only offer one instance at a time, so a client that dials while the
listener is between instances, or while another client is being accepted, gets
`ERROR_PIPE_BUSY`. Windows expects clients to wait and retry; `openEndpoint` in
`@vibecook/ghosttea-client` implements that, and any other client must do the
same. Unix sockets queue in the kernel and never take this path.

## Known Windows session cost

A Windows session retains one kernel handle after it ends. The lifecycle soak
measures this and holds it to a documented rate rather than ignoring it.

It is not the job object each session owns: disabling adoption entirely leaves
the growth unchanged at exactly one handle per session, and 256 sessions retain
256 handles whether or not a job is ever created. The registry is empty at that
point and thread count falls, so no session object is being held either. It is
the ConPTY session path itself, and it was only measured once this soak began
running on Windows. macOS and Linux retain nothing.

At roughly one handle per terminal pane opened over a process lifetime this is
slow rather than dangerous, but it is unbounded and worth tracing to the
specific handle.

### Open, recorded 2026-10-23: trace the handle

These are the facts the lane that closes this starts from.

- The rate is one handle per ended session, steady across rounds. On GitHub's
  `windows-2022` runners the service's handle count read 175 → 431 over 256
  sessions: the pull-request soak on 2026-10-22, runs 39707780624
  and 39869516049. It read 175 → 1198 → 2222 over two rounds of 1024: the
  weekly schedule, identical on every run from 2026-08-03 to 2026-10-19, for
  example 36459699631 and 39285710430. At every reading the registry was empty
  and the service had three threads fewer than at the baseline.
- Until 2026-10-23 the soak divided the growth over all rounds by one round's
  sessions. So the schedule read its second round as 2.00 and failed against
  the 1.25 allowance every week. The rate is now per session churned since the
  baseline. That makes 1.00 the expected floor on Windows, and 1.25 still
  catches a regression past it.
- Ruled out: the job object (disabling adoption leaves the rate unchanged), and
  a held session object (the registry is empty).

To close it, find which handle type grows across a churn by counting the
service's handles by type before and after. Trace that handle to its owner on
the ConPTY session path and release it there. Then lower
`GHOSTTEA_SOAK_MAX_HANDLES_PER_SESSION` on Windows so the soak holds the fix.

The bearer token authenticates both local endpoints. Keep the runtime directory
private to the host user and do not place the token in a child environment.
The built-in Ghosttea, legacy terminald, external-connection, and Truffle
variables are removed from inherited PTY environments. Embedding applications
should register every additional private prefix with
`with_private_env_prefixes`; empty prefixes are rejected. Explicit clean-mode
variables and inherited-mode overrides are intentional caller input and may
reintroduce a value.

Electron external mode reads its socket paths and token when the backend is
constructed. Those values must remain valid while that backend is recovering
from an embedded-service restart. Rotating them requires constructing a new
backend and transferring fresh renderer ports.

## Shared Truffle ownership

`TerminalService` accepts a `TerminalMesh` by value and never creates or stops
the application's Truffle node. `TruffleTerminalMesh` retains a clone of the
host-owned `Arc<Node<TailscaleProvider>>`, so the application can share one
identity, peer registry, state directory, and sidecar across terminal and
non-terminal services.

The default terminal adapter claims QUIC port `9420`, compact Apple-client port
`9421`, store `terminal.v1.hosts`, and SyncedStore namespace
`ss:terminal.v1.hosts`. The host owns the Truffle app ID, state directory,
sidecar lifecycle, and collision-free allocation of ports and service names.
Every crate that shares the `Arc<Node>` must resolve the same `truffle-core`
version and source so the Rust type is identical.

Local authentication currently uses one bearer token rather than scoped
credentials. Hosts requiring per-client authorization should put a policy
boundary in front of this service or extend the protocol deliberately; socket
permissions and constant-time token verification do not provide command-level
scopes.

See <https://github.com/vibecook-dev/ghosttea> for the complete repository.
