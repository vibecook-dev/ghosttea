import { describe, expect, it } from "vitest";
import {
  bindingKeyDisposition,
  resolveKeyEvent,
  routeBindingAction,
  routeConsumesInput,
  type RoutedAction,
} from "./action-route";
import {
  configuredBindingsForPlatform,
  GHOSTTY_MACOS_DEFAULT_BINDINGS,
  keyboardDefaultBindings,
  matchGhostteaBinding,
  matchGhosttyBinding,
  matchGhosttyBindingEntry,
  synthesizeEventForBinding,
} from "./ghostty-bindings";
import { parseGhosttyTrigger, synthesizeKeyEvent } from "./ghostty-triggers";
import defaultKeybindsJson from "./fixtures/keybinds-macos-default.json";

const ROUTE_KINDS = new Set(["workspace", "terminal", "platform", "unhandled"]);

function kindOf(route: RoutedAction | null): string | null {
  return route?.kind ?? null;
}

describe("routeBindingAction classification", () => {
  it("classifies every default macOS keyboard binding", () => {
    const failures: string[] = [];
    for (const entry of keyboardDefaultBindings()) {
      const routed = routeBindingAction(entry.action, entry.flags);
      if (!ROUTE_KINDS.has(routed.kind)) {
        failures.push(`${entry.triggerRaw}=${entry.actionRaw}: bad kind`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(keyboardDefaultBindings().length).toBeGreaterThan(80);
  });

  it("classifies via synthetic events end-to-end (match → route)", () => {
    const failures: string[] = [];
    for (const entry of keyboardDefaultBindings()) {
      const event = synthesizeEventForBinding(entry);
      if (!event) {
        failures.push(`${entry.triggerRaw}: no synthetic event`);
        continue;
      }
      const matched = matchGhosttyBindingEntry(event);
      if (!matched) {
        failures.push(`${entry.triggerRaw}: match failed`);
        continue;
      }
      const routed = routeBindingAction(matched.action, matched.flags);
      if (!ROUTE_KINDS.has(routed.kind)) {
        failures.push(`${entry.triggerRaw}: unrouted`);
      }
      // performable unhandled is not consumed via resolveKeyEvent (acts absent)
      if (routed.kind === "unhandled" && !routed.flags.performable && !routeConsumesInput(routed)) {
        failures.push(`${entry.triggerRaw}: non-performable unhandled must consume`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("loads ground-truth count and performable flags", () => {
    expect(GHOSTTY_MACOS_DEFAULT_BINDINGS).toHaveLength(defaultKeybindsJson.count);
    const escape = GHOSTTY_MACOS_DEFAULT_BINDINGS.find((b) => b.triggerRaw === "escape");
    expect(escape?.flags.performable).toBe(true);
    expect(escape?.action).toEqual({ type: "end_search" });
  });
});

describe("performable policy (Ghostty Binding.Flags.performable)", () => {
  const key = (trigger: string) => synthesizeKeyEvent(parseGhosttyTrigger(trigger))!;

  it("lets Escape pass through until search is implemented", () => {
    // Ghostty: escape=end_search is performable — absent when search is closed.
    expect(resolveKeyEvent(key("escape"))).toBeNull();
  });

  it("lets performable search/undo binds pass through when unhandled", () => {
    expect(resolveKeyEvent(key("super+f"))).toBeNull(); // start_search performable
    expect(resolveKeyEvent(key("super+z"))).toBeNull(); // undo performable
    expect(resolveKeyEvent(key("super+shift+z"))).toBeNull(); // redo performable
    expect(resolveKeyEvent(key("super+j"))).not.toBeNull(); // scroll_to_selection is terminal+performable
  });

  it("still consumes non-performable unimplemented app binds", () => {
    // jump_to_prompt is not performable in defaults — consume
    expect(resolveKeyEvent(key("super+arrow_up"))?.kind).toBe("unhandled");
    // font size not performable — consume
    expect(resolveKeyEvent(key("super+="))?.kind).toBe("unhandled");
  });

  it("routes open/reload config as platform (host implements)", () => {
    expect(resolveKeyEvent(key("super+,"))?.kind).toBe("platform");
    expect(resolveKeyEvent(key("super+shift+,"))?.kind).toBe("platform");
  });
});

describe("bindingKeyDisposition (Ghostty Surface.maybeHandleBinding)", () => {
  const key = (trigger: string) => synthesizeKeyEvent(parseGhosttyTrigger(trigger))!;

  it("consumes a plain bind's key, performed or not", () => {
    expect(bindingKeyDisposition({ performable: false }, true)).toBe("consume");
    expect(bindingKeyDisposition({ performable: false }, false)).toBe("consume");
  });

  it("encodes an unconsumed bind's key after its action, performed or not", () => {
    expect(bindingKeyDisposition({ performable: false, unconsumed: true }, true)).toBe("encode");
    expect(bindingKeyDisposition({ performable: false, unconsumed: true }, false)).toBe("encode");
  });

  it("encodes a performable bind's key only when its action was not performed", () => {
    expect(bindingKeyDisposition({ performable: true }, false)).toBe("encode");
    expect(bindingKeyDisposition({ performable: true }, true)).toBe("consume");
    expect(bindingKeyDisposition({ performable: true, unconsumed: true }, true)).toBe("encode");
  });

  it("always consumes all: and global: binds, which Ghostty counts performed", () => {
    for (const flags of [{ all: true }, { global: true }]) {
      expect(bindingKeyDisposition({ performable: false, unconsumed: true, ...flags }, true)).toBe("consume");
      expect(bindingKeyDisposition({ performable: true, ...flags }, false)).toBe("consume");
    }
  });

  it("does not treat a performable all: or global: bind on an unhandled action as absent", () => {
    // Ghostty performs every all:/global: bind (Surface.zig:2986-2993), so it never falls through.
    for (const prefix of ["performable:global:", "performable:all:"]) {
      const bindings = configuredBindingsForPlatform(
        { clearKeybindings: false, keybindings: [{ trigger: `${prefix}ctrl+x`, action: "increase_font_size:1" }] },
        "darwin",
      );
      const routed = resolveKeyEvent(key("ctrl+x"), { bindings });
      expect(routed?.kind, prefix).toBe("unhandled");
      expect(routeConsumesInput(routed!), prefix).toBe(true);
    }
  });

  it("drops an ignore bind's key whatever its flags, as Ghostty does before it looks at them", () => {
    for (const prefix of ["", "unconsumed:", "performable:", "performable:unconsumed:"]) {
      const bindings = configuredBindingsForPlatform(
        { clearKeybindings: false, keybindings: [{ trigger: `${prefix}ctrl+x`, action: "ignore" }] },
        "darwin",
      );
      const routed = resolveKeyEvent(key("ctrl+x"), { bindings });
      expect(routed?.kind, prefix).toBe("unhandled");
      expect(routeConsumesInput(routed!), prefix).toBe(true);
      expect(routeConsumesInput(routed!, false), prefix).toBe(true);
    }
  });

  it("lets a workspace route's key through when a performable action was not performed", () => {
    // Linux defaults: alt+1=goto_tab:1 and ctrl+alt+arrow_left=goto_split:left are performable.
    for (const trigger of ["alt+1", "ctrl+alt+arrow_left", "ctrl+page_up"]) {
      const routed = resolveKeyEvent(key(trigger), { platform: "linux" })!;
      expect(routed.kind, trigger).toBe("workspace");
      expect(routeConsumesInput(routed, false), trigger).toBe(false);
      expect(routeConsumesInput(routed, true), trigger).toBe(true);
      expect(routeConsumesInput(routed), trigger).toBe(true);
    }
    // super+t=new_tab is not performable: a missing hook still consumes it.
    expect(routeConsumesInput(resolveKeyEvent(key("super+t"))!, false)).toBe(true);
    // An unhandled action is never performed, and a plain one still consumes.
    expect(routeConsumesInput(resolveKeyEvent(key("super+="))!)).toBe(true);
  });
});

describe("resolveKeyEvent scopes", () => {
  const key = (trigger: string) => synthesizeKeyEvent(parseGhosttyTrigger(trigger))!;

  it("routes ⌘⇧O remote sessions as workspace (Ghosttea extension)", () => {
    const routed = resolveKeyEvent(key("super+shift+o"));
    expect(routed?.kind).toBe("workspace");
    if (routed?.kind === "workspace") {
      expect(routed.command).toEqual({ type: "remote-sessions" });
    }
    expect(matchGhosttyBinding(key("super+shift+o"))).toBeNull();
    expect(matchGhostteaBinding(key("super+shift+o"))).toEqual({ type: "ghosttea.remote_sessions" });
  });

  it("routes workspace chrome binds", () => {
    expect(kindOf(resolveKeyEvent(key("super+t")))).toBe("workspace");
    expect(kindOf(resolveKeyEvent(key("super+d")))).toBe("workspace");
    expect(kindOf(resolveKeyEvent(key("super+w")))).toBe("workspace");
    expect(kindOf(resolveKeyEvent(key("super+9")))).toBe("workspace");
    const last = resolveKeyEvent(key("super+9"));
    if (last?.kind === "workspace") {
      expect(last.command).toEqual({ type: "select-tab", target: "last" });
    }
  });

  it("routes terminal effects (paste, natural editing, copy, select, clear)", () => {
    expect(kindOf(resolveKeyEvent(key("super+v")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+arrow_left")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("alt+arrow_right")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+c")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+a")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+k")))).toBe("terminal");
  });

  it("routes platform binds including new_window and quit", () => {
    expect(kindOf(resolveKeyEvent(key("super+enter")))).toBe("platform");
    expect(kindOf(resolveKeyEvent(key("super+ctrl+f")))).toBe("platform");
    expect(kindOf(resolveKeyEvent(key("super+shift+w")))).toBe("platform");
    expect(kindOf(resolveKeyEvent(key("super+n")))).toBe("platform");
    expect(kindOf(resolveKeyEvent(key("super+q")))).toBe("platform");
    const nw = resolveKeyEvent(key("super+n"));
    if (nw?.kind === "platform") expect(nw.effect).toEqual({ type: "new_window" });
  });

  it("routes scroll and selection-adjust binds as terminal effects", () => {
    expect(kindOf(resolveKeyEvent(key("super+home")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+end")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+page_up")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("super+j")))).toBe("terminal");
    expect(kindOf(resolveKeyEvent(key("shift+arrow_left")))).toBe("terminal");
  });

  it("returns null for non-binding keys (PTY fallthrough)", () => {
    expect(
      resolveKeyEvent({
        key: "x",
        code: "KeyX",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it("filters by executor scope", () => {
    const workspaceScopes = ["workspace", "platform", "unhandled"] as const;
    expect(resolveKeyEvent(key("super+v"), { scopes: [...workspaceScopes] })).toBeNull();
    expect(resolveKeyEvent(key("super+t"), { scopes: [...workspaceScopes] })?.kind).toBe("workspace");
    expect(resolveKeyEvent(key("super+enter"), { scopes: [...workspaceScopes] })?.kind).toBe("platform");
    // performable search is absent, not unhandled
    expect(resolveKeyEvent(key("super+f"), { scopes: [...workspaceScopes] })).toBeNull();

    expect(resolveKeyEvent(key("super+v"), { scopes: ["terminal"] })?.kind).toBe("terminal");
    expect(resolveKeyEvent(key("super+t"), { scopes: ["terminal"] })).toBeNull();
  });
});

describe("route kind summary (smoke)", () => {
  it("assigns expected kinds to representative defaults", () => {
    const samples: Array<[string, RoutedAction["kind"] | null]> = [
      ["super+t", "workspace"],
      ["super+shift+d", "workspace"],
      ["super+v", "terminal"],
      ["super+c", "terminal"],
      ["super+arrow_right", "terminal"],
      ["super+home", "terminal"],
      ["shift+arrow_up", "terminal"],
      ["super+enter", "platform"],
      ["super+shift+w", "platform"],
      ["super+n", "platform"],
      ["super+q", "platform"],
      ["super+f", null], // performable unhandled → pass through
      ["escape", null], // performable end_search → pass through
      ["super+z", null], // performable undo
      ["super+=", "unhandled"], // font size, non-performable
    ];
    for (const [trigger, kind] of samples) {
      const event = synthesizeKeyEvent(parseGhosttyTrigger(trigger))!;
      expect(kindOf(resolveKeyEvent(event)), trigger).toBe(kind);
    }
  });
});
