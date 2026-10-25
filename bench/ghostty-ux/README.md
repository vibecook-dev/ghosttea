# Ghostty UX ground truth

Pinned behavioral source of truth for Ghosttea’s Ghostty-parity work.

We do **not** reverse-engineer UX from memory or from our current Electron
implementation. Every binding, action, and UX behavior we claim to match is
extracted from Ghostty itself and checked into this directory.

## Why this exists

libghostty owns VT, key encoding, and terminal state. Application UX lives
above it: keybinds, actions, mouse selection, clipboard policy, tabs/splits,
search, command palette, config reload, etc.

Ghosttea currently implements a **subset** of that application layer by hand
(`ghosttyHotkey`, `ghosttyTerminalBinding`, workspace model). Without a full
catalog we cannot know what is missing, what is wrong, or when we are done.

This bench is the first step of TDD:

1. **Extract** ground truth from Ghostty (source + CLI dumps).
2. **Catalog** actions, default keybinds, and non-key UX surfaces.
3. **Fixture** them as machine-readable golden files.
4. **Test** Ghosttea’s binding/action layer against those goldens.
5. **Implement** missing behavior until the suite is green, layer by layer.

## Sources of truth (priority order)

| Priority | Source                          | Location / command                                   |
| -------- | ------------------------------- | ---------------------------------------------------- |
| 1        | Vendored Ghostty source at lock | `native/vendor/ghostty` @ `native/ghostty.lock.json` |
| 2        | Default keybinds in source      | `src/config/Config.zig` → `Keybinds.init`            |
| 3        | Action enum + docs              | `src/input/Binding.zig` → `Action`                   |
| 4        | Installed Ghostty CLI dump      | `ghostty +list-keybinds --default --plain`           |
| 5        | Default config dump             | `ghostty +show-config --default`                     |
| 6        | Action list dump                | `ghostty +list-actions` / `--docs`                   |

CLI dumps are convenient snapshots. When they disagree with the locked
vendor commit, **the locked source wins**.

## Current dump

Captured under [`ground-truth/`](./ground-truth/):

| File                          | Contents                                       |
| ----------------------------- | ---------------------------------------------- |
| `vendor-commit.txt`           | Pinned Ghostty git commit used for builds      |
| `ghostty-version.txt`         | Installed app version that produced CLI dumps  |
| `keybinds-macos-default.txt`  | Raw `+list-keybinds --default --plain`         |
| `keybinds-macos-default.json` | Structured trigger → action pairs              |
| `actions.txt`                 | Full action names (`+list-actions`)            |
| `actions-docs.txt`            | Actions with documentation                     |
| `actions-from-source.json`    | Actions parsed from `Binding.zig`              |
| `config-macos-default.txt`    | Full default config (`+show-config --default`) |

**Scale (macOS defaults):**

- **85** bindable actions
- **93** default keybind entries (includes digit_N physical + unicode aliases)
- **200** non-keybind config keys with defaults

## Refresh procedure

```sh
npm run extract:ghostty-ux
```

Or with an explicit binary:

```sh
GHOSTTY=/Applications/Ghostty.app/Contents/MacOS/ghostty npm run extract:ghostty-ux
```

This rewrites `bench/ghostty-ux/ground-truth/*` and copies keybind fixtures into
`packages/ghosttea-react/src/bindings/fixtures/` for the golden suite.
`extensions.json` (⌘⇧O remote sessions) is always re-emitted as intentional.

## UX surface map (full picture)

Keybinds are only one plane. Parity work should track all of these:

### A. Binding / action system

- Trigger grammar: `mods+key`, sequences (`a>b`), tables, flags
  (`global:`, `all:`, `unconsumed:`, `performable:`)
- 85 actions in `Binding.Action` (windowing, tabs, splits, font, scroll,
  selection, search, clipboard, inspector, quick terminal, undo/redo, …)
- Platform-default sets: **macOS super** vs **Linux ctrl+shift**
- Chained actions (`chain=…`)
- Command palette entries (default set in `Config.zig`)

### B. Terminal input encoding (mostly libghostty)

- Legacy / fixterms / Kitty keyboard protocol
- Application cursor keys, modifyOtherKeys
- Natural text editing defaults (macOS: ⌘←/→, ⌥←/→, ⌘⌫)
- Layout-aware unmodified key resolution

### C. Mouse / selection

- Click, double-click word, triple-click line
- Drag selection, shift-adjust, scroll-extend
- Right-click / context menu policy
- Link detect + open (`link-url`, hover mods)
- Mouse reporting toggle vs UI capture
- Scroll multipliers (precision vs discrete)
- Focus-follows-mouse, hide-while-typing

### D. Clipboard

- OSC 52 read/write policy
- Paste protection / bracketed paste
- Selection vs system clipboard
- Copy formats: plain / vt / html / mixed
- Trailing-space trim

### E. Workspace chrome

- Windows, tabs, splits, zoom, equalize, resize
- Close confirmation semantics (`close_surface` vs `close_tab` vs `close_window`)
- Undo/redo of close/new (macOS)
- Titles (surface + tab override)
- Fullscreen / float-on-top / secure input (platform-specific)

### F. Search, scrollback, fonts

- Start / selection / navigate / end search
- Scroll to top/bottom/selection/prompt
- Font size ± / reset
- Write screen/scrollback/selection to temp file

### G. Config lifecycle

- Open config, reload config
- Runtime-applicable vs restart-required options

## Ghosttea coverage snapshot (today)

| Layer                    | Location                                | Status                                                        |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| Match + flags            | `packages/ghosttea-react/src/bindings/` | macOS + Linux tables, performable overlay                     |
| Route                    | `bindings/action-route.ts`              | workspace / terminal / platform / unhandled                   |
| Workspace execute        | `workspace/Workspace.tsx`               | tabs/splits/zoom + platform hooks; consume as Ghostty decides |
| Terminal execute         | `TerminalSurface.tsx`                   | paste/text/copy/select/clear/scroll/adjust_selection          |
| Shared config            | `ghosttea-config` + protocol/Swift FFI  | versioned schema, exact source/include rules, honest support  |
| Product extension        | `extensions.json`                       | **⌘⇧O** remote sessions — **keep**                            |
| Open / deferred features | **[OPEN-ITEMS.md](./OPEN-ITEMS.md)**    | font-size protocol, search, undo, jump_to_prompt, …           |

**Intentional Ghosttea-only bind (keep):**

- `super+shift+o` (`⌘⇧O`) → remote sessions palette (`ghosttea.remote_sessions`)

**Known intentional mismatches (documented, not bugs to “forget”):**

- `resize_split`: Ghostty px → fractional pane ratios (`amount/10 × 0.05`)
- `clear_screen`: currently form-feed to PTY, not full Ghostty clear semantics
- Linux table is **derived** from `Config.zig`, not a live Linux CLI dump

## Proposed TDD layers (implementation order)

1. **Catalog + fixtures** (this directory) — done as dumps; next: JSON schema + refresh script
2. **Action registry** — TypeScript enum/union mirroring Ghostty `Action` names + params
3. **Default binding table tests** — every macOS default keybind resolves to the same action
4. **Dispatch tests** — binding match → workspace/command effect (pure reducers first)
5. **Terminal binding tests** — natural text editing + paste path before PTY write
6. **Mouse/selection goldens** — event → selection model (from Ghostty behavior notes + fixtures)
7. **Integration** — Electron/desktop harness only after pure layers are green

Do **not** start with full E2E UI automation. Prefer pure function tests against
fixtures; add harness tests only for wiring.

## Out of scope for “UX parity”

- Ghostty’s native Metal/GTK renderer pixel identity
- App runtime specifics that Electron cannot host (quick terminal layer-shell,
  macOS secure input API, GTK inspector)
- Shipping Ghostty’s full config surface on day one — **actions used by default
  keybinds first**, then optional config parity

Platform-specific actions should be tagged `macos | linux | unsupported` so the
suite can skip or soft-fail intentionally.

## Status

- [x] Extract script (`npm run extract:ghostty-ux`)
- [x] Full action parse/format registry (`bindings/ghostty-actions.ts`)
- [x] Table-driven matcher (`bindings/ghostty-bindings.ts`) + golden suite
- [x] Pure router (`bindings/action-route.ts`): workspace | terminal | platform | unhandled
- [x] Workspace executor: chrome + platform + **consume unhandled** (no PTY leak)
- [x] TerminalSurface executor: terminal effects only (no hand-rolled metaKey tree)
- [x] ⌘⇧O remote sessions kept as Ghosttea extension
- [x] Terminal scroll family + adjust_selection via router
- [x] Platform `close_window` (⌘⇧W)
- [x] Electron main edit claims documented against Ghostty action names
- [x] `performable` flags: Escape/search/undo pass through until implementable
- [x] Workspace consumes after match unless `unconsumed:`, or `performable:` and not performed (the key reaches
      the surface); a missing hook still consumes a non-performable bind (no fail-open PTY leak)
- [x] Platform `new_window` / `quit` / `close_window` / fullscreen
- [x] `goto_tab` clamps high indexes to last tab (Ghostty semantics)
- [x] Linux default binding table + platform-aware match (`darwin` vs `linux`/`win32`)
- [x] Platform open_config / reload_config / close_all_windows
- [x] Shared Ghostty-syntax config schema, standard-file import, diagnostics, and live reload
- [x] Imported single-stroke keybind mutations + config-driven colors, scrollback, and opt-in CRT
- [ ] Remaining features — tracked in **[OPEN-ITEMS.md](./OPEN-ITEMS.md)** (font-size protocol deferred)
- [ ] Mouse / selection / clipboard policy goldens
