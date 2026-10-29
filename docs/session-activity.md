# Terminal session activity

Ghosttea exposes PTY foreground activity separately from process liveness. An
alive session can now be distinguished as:

- `shell-idle`: an interactive shell is ready to accept another command.
- `foreground-job`: a foreground command, pipeline, or TUI owns the terminal.
- `unknown`: the platform or launch shape does not support a sound inference.

Exit remains represented by `SessionSummary.exited` and the existing exit
fields. It is not an activity kind.

## API

`SessionSummary.activity` and `SharedSessionSummary.activity` use this shape:

```ts
interface SessionActivity {
  kind: "shell-idle" | "foreground-job" | "unknown";
  source: "shell-integration" | "process-group" | "unsupported";
  confidence: "authoritative" | "heuristic";
  rootProcessGroupId: number | null;
  foregroundProcessGroupId: number | null;
  observedAtMs: number;
}
```

The native observations remain available so applications can apply a policy
different from Ghosttea's classification. A missing activity field from an
older local or remote peer is normalized to `unknown`.

The local control protocol also emits:

```json
{
  "requestId": 0,
  "type": "session-activity-changed",
  "sessionId": "…",
  "activity": { "kind": "foreground-job" }
}
```

The full activity object is present on the wire. The renderer updates its
cached session metadata and dispatches both `session-activity` and
`session-metadata`; all panes attached to the same session therefore observe
the same state.

## Unix process-group inference

While a session is alive, ghosttead samples the PTY foreground process group
every 200 ms using `tcgetpgrp` through `portable-pty`. It separately observes
the root child's process group with `getpgid`.

For a session declared as an interactive shell:

- foreground PGID equals root shell PGID → `shell-idle`
- foreground PGID differs from root shell PGID → `foreground-job`

For a directly launched application with an observable process group, activity
is `foreground-job`, including when that application is waiting for input.
Unrecognized auto-detected programs report `unknown` when the foreground and
root process groups match; a distinct foreground group is still reported as a
foreground job.

Callers can set `CreateSessionOptions.programKind` to
`interactive-shell`, `application`, or `auto`. The desktop workspace marks its
normal shell sessions explicitly, while benchmark workloads are marked as
applications. Auto mode recognizes common interactive shells, except command
launch forms such as `sh -c …`.

Activity observations are deduplicated without using `observedAtMs` as part of
the identity. Silent foreground jobs are detected by the independent sampler;
the mechanism does not depend on output silence or screen-text parsing.

## Working directory and title

`session-metadata-changed` (local terminal protocol minor 1.17) reports a
session's `cwd` and `title` when either changes:

```ts
{ requestId: 0; type: "session-metadata-changed"; sessionId: string; cwd: string | null; title: string | null }
```

- Both fields arrive every time, as absolute state, so a reader replaces what
  it holds rather than merging partial updates.
- It fires only when one of them differs from the session's summary. A resize
  does not fire it, and neither does the identical OSC 7 most prompts send
  each time they draw. The service does not otherwise coalesce, so a burst of
  title changes arrives as a burst; readers coalesce as they need.
- `cwd` is what the terminal reports: a `file://` URL once the shell sends
  OSC 7, and the spawn directory before that.
- Remote replicas send the same event when a snapshot changes their directory
  or title.
- Clients that negotiated a minor below 1.17 never receive it. It is a hint:
  `list-sessions` stays the reconciliation path, as it is after `events-lost`.

## Remote compatibility

Activity arrived with local terminal protocol minor 1.6 and Truffle terminal
protocol minor 1.4. (Corrected 2026-10-26: this sentence used to read as the
current versions. They are the minors that introduced activity; the local
protocol's current minor is `CONTROL_PROTOCOL_MINOR` in `service.rs`, 1.17 at
this writing.) Activity is included in advertisements,
session-list responses, and attached live-state streams. Remote replicas update
their cached `SessionSummary` and relay the same local activity event.

New peers accept older nonzero minor versions and treat missing activity as
unknown. New servers negotiate the peer's minor version and do not send the new
unsolicited activity variant to older clients. Local protocol 1.5 clients are
likewise not sent `session-activity-changed`, avoiding disconnects in clients
that reject unknown event types.

## Limitations and shell integration

Process-group classification is intentionally marked `heuristic`.

- Long-running shell built-ins can share the shell process group and look idle.
- SSH exposes the local `ssh` process, not remote prompt state.
- tmux and similar multiplexers may continuously own the foreground.
- Commands shorter than the sample interval can complete between observations.
- Windows currently reports `unknown` with source `unsupported`.
- Auto detection cannot prove that every shell-looking process is interactive;
  callers should use `programKind` when they know the launch intent.

OSC 133 shell markers are the planned authoritative source. Once shell
integration is available, completed prompts can report `shell-idle`, command
execution can report `foreground-job`, and the source/confidence can become
`shell-integration`/`authoritative`. Process-group observation remains the
fallback.
