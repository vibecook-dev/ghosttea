# Ghostty UX parity — open items

Living backlog for work **not** done yet (or deliberately deferred).  
Implemented spine: ground-truth fixtures → pure match → pure route → scoped executors.  
See [README.md](./README.md) for architecture and refresh procedure.

**Last updated:** 2026-07-30 (shared Ghostty config schema/import)

---

## Deferred (explicit)

### Font size (`⌘±` / `⌘0`)

|                                     |                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ghostty**                         | `increase_font_size` / `decrease_font_size` / `reset_font_size` → surface `setFontSize`                                                                            |
| **Today**                           | Matched; **unhandled + consumed** (no effect)                                                                                                                      |
| **Why deferred**                    | Needs a **control-plane font/metrics protocol**, not just a keybind map                                                                                            |
| **What “font-size protocol” means** | New daemon↔renderer messages to change live `font_size_px` / cell W×H, reshape glyphs, recompute cols×rows, PTY resize. **Not** VT OSC and **not** CSS zoom alone. |
| **Touches**                         | `terminal-protocol`, `ghosttead` text-engine, session grid, React cell metrics (`CELL_WIDTH` / `LINE_HEIGHT` today fixed)                                          |
| **Interim policy**                  | Keep unhandled consume so shell doesn’t see `=` / `-` / `0` with super                                                                                             |

Do **not** implement as canvas CSS zoom without grid/PTY update — that is not Ghostty parity.

### Search UI + bindings

| Bind (macOS)  | Action             | Today                          |
| ------------- | ------------------ | ------------------------------ |
| `⌘F`          | `start_search`     | performable → **pass-through** |
| `⌘E`          | `search_selection` | pass-through                   |
| `⌘⇧F` / `Esc` | `end_search`       | pass-through                   |
| `⌘G` / `⌘⇧G`  | `navigate_search`  | pass-through                   |

Needs search UI, scrollback search in core, and performable “search is open” state before consuming Escape again.

### Undo / redo (macOS)

| Bind         | Action | Today        |
| ------------ | ------ | ------------ |
| `⌘Z` / `⌘⇧T` | `undo` | pass-through |
| `⌘⇧Z`        | `redo` | pass-through |

Ghostty undo is limited (close/new tab/window/split) with timeout. Needs host stack of reverse ops — not just a keybind.

### Jump to prompt

| Bind (macOS)  | Action              | Today                 |
| ------------- | ------------------- | --------------------- |
| `⌘↑` / `⌘↓`   | `jump_to_prompt:±1` | unhandled **consume** |
| `⌘⇧↑` / `⌘⇧↓` | same                | consume               |

Requires **shell integration** marks in ghosttead and a scroll-to-prompt API. No control message today.

### Write screen / scrollback / selection to file

| Bind (macOS) | Action                    |
| ------------ | ------------------------- |
| `⌘⇧⌃J`       | `write_screen_file:copy`  |
| `⌘⇧J`        | `write_screen_file:paste` |
| `⌘⌥⇧J`       | `write_screen_file:open`  |

Needs temp-file export + clipboard/open-in-editor host actions.

### Inspector / command palette (product)

| Bind  | Action                   | Notes                                               |
| ----- | ------------------------ | --------------------------------------------------- |
| `⌘⌥I` | `inspector:toggle`       | Ghostty terminal inspector; Electron equivalent TBD |
| `⌘⇧P` | `toggle_command_palette` | Could map to Ghosttea palette later                 |

### Quick terminal, secure input, float-on-top, etc.

Platform-native Ghostty features Electron cannot host 1:1. Track as **n/a** unless we invent product substitutes.

---

## Open (implementable without new daemon protocols)

These are smaller or host-only; still incomplete:

| Item                                      | Notes                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coverage matrix automation**            | `coverage-matrix.json` drifts; should be generated from router + fixtures                                                                                                     |
| **Linux table fidelity**                  | `keybinds-linux-default.json` is **derived** from `Config.zig`, not CLI dump (no Linux Ghostty binary in CI). Re-validate against `ghostty +list-keybinds --default` on Linux |
| **Win32**                                 | Currently reuses Linux table; confirm vs Ghostty Windows defaults if/when supported                                                                                           |
| **`clear_screen`**                        | Still `\f` to PTY; may not match Ghostty clear/scrollback semantics                                                                                                           |
| **`copy_to_clipboard` formats**           | `plain` / `vt` / `html` / `mixed` ignored → plain text only                                                                                                                   |
| **`paste_from_selection`**                | Collapsed to system paste on Electron                                                                                                                                         |
| **`resize_split` units**                  | Ghostty px steps → fractional pane ratios (scaled by amount/10)                                                                                                               |
| **Main-process edit claims**              | Documented allowlist only; not generated from fixtures                                                                                                                        |
| **Swift chord table**                     | Still hand-rolled; TS is table-driven. Conformance fixture shared for workspace subset only                                                                                   |
| **Experiment app platform hooks**         | Desktop has `openConfig` / `reloadConfig` / `closeAllWindows`; experiment app may lag                                                                                         |
| **Integration tests**                     | No React/Electron harness for capture vs surface scope partition                                                                                                              |
| **Mouse / selection / clipboard goldens** | No Ghostty-aligned fixture suite yet (click/word/line, OSC 52, paste protection)                                                                                              |

---

## Implemented spine (do not regress)

| Area                                                                        | Status                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| Ground truth extract + fixtures                                             | macOS dump + Linux derived + extensions          |
| Action parse/format (85 actions)                                            | done                                             |
| Trigger match + synthesize                                                  | done                                             |
| Router: workspace / terminal / platform / unhandled                         | done                                             |
| **Performable** pass-through for unhandled                                  | Escape, search, undo, …                          |
| Terminal consume only if applied when performable                           | copy, adjust_selection, …                        |
| Workspace consume after match, except unconsumed or unperformed performable | missing hook still consumes; no fail-open leak   |
| Tabs / splits / zoom / equalize / close pane                                | done                                             |
| Scroll family + adjust_selection + scroll-into-view                         | done                                             |
| Natural text editing + paste                                                | done                                             |
| Platform: fullscreen, new/close window, quit, open/reload config, close all | done (desktop)                                   |
| `last_tab` + `goto_tab` clamp to last                                       | done (TS + Swift + Electron)                     |
| Platform-aware macOS vs Linux tables                                        | done                                             |
| ⌘⇧O remote sessions extension                                               | **keep** (product)                               |
| Versioned Rust config schema + daemon/Electron/Swift APIs                   | done; see `docs/ghostty-config-compatibility.md` |
| Existing Ghostty config import + live desktop reload                        | colors, scrollback, simple keybinds, opt-in CRT  |

---

## Suggested priority when resuming

1. **Coverage matrix generator** from fixtures + `routeBindingAction` (cheap truth).
2. **Linux CLI dump validation** on a Linux host.
3. **Font-size protocol** (if product needs ⌘±).
4. **Search** (if product needs ⌘F; re-enable Escape consume only when search open).
5. **jump_to_prompt** after shell-integration marks.
6. **Mouse/selection goldens**.
7. **Swift table-driven chords** or shared fixture generation.

---

## Non-goals (parity)

- Pixel-identical Metal/GTK rendering
- Quick terminal / layer-shell / macOS secure input API parity
- Full Ghostty config surface on day one
