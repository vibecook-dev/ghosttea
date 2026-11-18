# `@vibecook/ghosttea-client`

Electron-free Node control client for a Ghosttea terminal service. It connects
to the authenticated local control socket and exposes typed session lifecycle
and human-input-epoch-guarded automation operations. It never opens the frame
socket, attaches a renderer view, or claims terminal layout authority.

```ts
import { GhostteaAutomationClient } from "@vibecook/ghosttea-client";

const client = new GhostteaAutomationClient({
  controlSocket: "/private/runtime/ghosttea-control.sock",
  authToken: process.env.GHOSTTEA_CLIENT_TOKEN!,
});

const session = await client.createSession({
  executable: "/bin/zsh",
  args: [],
  environment: { mode: "clean", variables: { PATH: "/usr/bin:/bin" } },
  cols: 120,
  rows: 40,
  persistence: "terminate-with-app",
});
const exited = client.waitForExit(session.id);
await client.pasteAndSubmit(session.id, "exit 0");
await exited;

const document = await client.getConfigDocument();
const candidate = `${document.contents}\n# opt in to Ghosttea's shader\ncustom-shader = ghosttea:better-crt\n`;
const validation = await client.validateConfigDocument(candidate);
if (!validation.config.diagnostics.some(({ severity }) => severity === "error")) {
  await client.replaceConfigDocument(document.revision, candidate);
}
client.dispose();
```

`@vibecook/ghosttea` is the separate browser `MessagePort` client used by
renderers. This package is Node-specific and speaks the local length-prefixed
control-socket protocol directly. Raw configuration document methods require
protocol 1.11 and are intentionally privileged: they can edit only the
daemon-designated final overlay, use an expected revision to prevent stale
writes, and are not suitable for direct renderer exposure.

`setColors(sessionId, colors)` tells a session its foreground, background and
cursor, which the daemon answers a program's color queries from, and
`createSession` takes the same `colors` so a session starts in them. Protocol
1.20 adds the sparse `palette` and `colors` at creation, and keeps a session's
told colors across a configuration reload. The client refuses a palette or
create-time colors against an older daemon rather than let them drop; a
palette-less `setColors` works against any daemon.
