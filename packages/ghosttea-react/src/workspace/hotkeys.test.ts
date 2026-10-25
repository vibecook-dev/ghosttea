import { describe, expect, it } from "vitest";
import fixtureJSON from "../../../../apple/GhostteaKit/Tests/GhostteaWorkspaceTests/Fixtures/workspace-command-conformance-v1.json";
import { resolveKeyEvent } from "../bindings/action-route";
import { configuredBindingsForPlatform } from "../bindings/ghostty-bindings";
import { parseGhosttyTrigger, synthesizeKeyEvent } from "../bindings/ghostty-triggers";
import {
  ghosttyHotkey,
  platformEffectPerformable,
  runWorkspaceBinding,
  workspaceCommandId,
  workspaceCommandPerformable,
  type GhosttyHotkey,
  type WorkspaceBindingState,
} from "./hotkeys";

interface CommandFixture {
  vectors: Array<{
    key: string;
    meta?: boolean;
    shift?: boolean;
    alt?: boolean;
    control?: boolean;
    expected: GhosttyHotkey | null;
    commandId: string | null;
  }>;
}

describe("workspace command shortcuts", () => {
  it("matches every shared desktop/iOS command vector", () => {
    for (const vector of (fixtureJSON as CommandFixture).vectors) {
      const command = ghosttyHotkey({
        key: vector.key,
        metaKey: vector.meta ?? false,
        shiftKey: vector.shift ?? false,
        altKey: vector.alt ?? false,
        ctrlKey: vector.control ?? false,
      });
      expect(command, vector.key).toEqual(vector.expected);
      expect(command ? workspaceCommandId(command) : null, vector.key).toBe(vector.commandId);
    }
  });
});

/** Two panes, one active, every host hook given. */
const READY: WorkspaceBindingState = {
  panes: 2,
  activePane: true,
  remoteSessions: true,
  hooks: { newTab: true, selectTab: true, closeTab: true, newWindow: true, openConfig: true },
};

describe("workspaceCommandPerformable (Ghostty GTK apprt)", () => {
  it("needs a split, two or more panes with one active, to go to, resize or zoom one", () => {
    for (const command of [
      { type: "focus-relative", offset: 1 },
      { type: "focus-direction", direction: "left" },
      { type: "resize", axis: "vertical", delta: -0.05 },
      { type: "toggle-zoom" },
    ] as const) {
      expect(workspaceCommandPerformable(command, READY), command.type).toBe(true);
      expect(workspaceCommandPerformable(command, { ...READY, panes: 3 }), command.type).toBe(true);
      expect(workspaceCommandPerformable(command, { ...READY, panes: 1 }), command.type).toBe(false);
      expect(workspaceCommandPerformable(command, { ...READY, panes: 0 }), command.type).toBe(false);
      expect(workspaceCommandPerformable(command, { ...READY, activePane: false }), command.type).toBe(false);
    }
  });

  it("needs the host hook for a tab command, and remote sessions offered for their palette", () => {
    const none = {
      ...READY,
      hooks: { newTab: false, selectTab: false, closeTab: false, newWindow: false, openConfig: false },
    };
    for (const command of [{ type: "new-tab" }, { type: "select-tab", target: 1 }, { type: "close-tab" }] as const) {
      expect(workspaceCommandPerformable(command, READY), command.type).toBe(true);
      expect(workspaceCommandPerformable(command, none), command.type).toBe(false);
    }
    expect(
      workspaceCommandPerformable({ type: "new-tab" }, { ...READY, hooks: { ...READY.hooks, newTab: false } }),
    ).toBe(false);
    expect(workspaceCommandPerformable({ type: "remote-sessions" }, READY)).toBe(true);
    expect(workspaceCommandPerformable({ type: "remote-sessions" }, { ...READY, remoteSessions: false })).toBe(false);
  });

  it("can always split, equalize or close a pane", () => {
    const bare = {
      panes: 1,
      activePane: true,
      remoteSessions: false,
      hooks: { newTab: false, selectTab: false, closeTab: false, newWindow: false, openConfig: false },
    };
    for (const command of [
      { type: "split", axis: "horizontal" },
      { type: "equalize" },
      { type: "close-pane" },
    ] as const) {
      expect(workspaceCommandPerformable(command, bare), command.type).toBe(true);
    }
  });

  it("needs a window or tab hook to open a window, and openConfig to open the config", () => {
    const hooks = (overrides: Partial<WorkspaceBindingState["hooks"]>) => ({
      ...READY,
      hooks: { ...READY.hooks, newWindow: false, newTab: false, openConfig: false, ...overrides },
    });
    expect(platformEffectPerformable({ type: "new_window" }, hooks({}))).toBe(false);
    expect(platformEffectPerformable({ type: "new_window" }, hooks({ newWindow: true }))).toBe(true);
    expect(platformEffectPerformable({ type: "new_window" }, hooks({ newTab: true }))).toBe(true);
    expect(platformEffectPerformable({ type: "open_config" }, hooks({}))).toBe(false);
    expect(platformEffectPerformable({ type: "open_config" }, hooks({ openConfig: true }))).toBe(true);
    for (const type of ["toggle_fullscreen", "close_window", "close_all_windows", "quit", "reload_config"] as const) {
      expect(platformEffectPerformable({ type }, hooks({})), type).toBe(true);
    }
  });
});

describe("runWorkspaceBinding", () => {
  /**
   * Resolves a trigger as the workspace does and runs it over a recording
   * host in `state`, whose selectTab answers `selected`.
   */
  function run(
    trigger: string,
    options: {
      platform?: string;
      bindings?: ReturnType<typeof configuredBindingsForPlatform>;
      state?: Partial<WorkspaceBindingState>;
      selected?: boolean;
    } = {},
  ) {
    const routed = resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger(trigger))!, {
      extensions: true,
      platform: options.platform ?? "darwin",
      ...(options.bindings ? { bindings: options.bindings } : {}),
      scopes: ["workspace", "platform", "unhandled"],
    });
    if (!routed || routed.kind === "terminal") throw new Error(`${trigger} is not the workspace's`);
    const ran: string[] = [];
    const consumed = runWorkspaceBinding(routed, {
      state: { ...READY, ...options.state },
      workspace: (command) => {
        ran.push(command.type);
        return command.type === "select-tab" ? options.selected : undefined;
      },
      platform: (effect) => {
        ran.push(effect.type);
      },
    });
    return { consumed, ran };
  }

  it("leaves the key of a performable tab bind to the surface when the host reports the tab did not change (Linux defaults)", () => {
    for (const trigger of ["alt+1", "alt+9", "ctrl+page_down", "ctrl+shift+arrow_left"]) {
      for (const platform of ["linux", "win32"]) {
        const label = `${platform} ${trigger}`;
        expect(run(trigger, { platform, selected: false }), label).toEqual({ consumed: false, ran: ["select-tab"] });
        expect(run(trigger, { platform, selected: true }), label).toEqual({ consumed: true, ran: ["select-tab"] });
        // A host whose selectTab answers nothing has switched.
        expect(run(trigger, { platform }), label).toEqual({ consumed: true, ran: ["select-tab"] });
        const noHook = { hooks: { ...READY.hooks, selectTab: false } };
        expect(run(trigger, { platform, state: noHook }), label).toEqual({ consumed: false, ran: [] });
      }
    }
  });

  it("leaves the key of a performable split bind to the surface with a single pane, and runs it with a split", () => {
    for (const [trigger, command] of [
      ["ctrl+alt+arrow_right", "focus-direction"],
      ["ctrl+super+]", "focus-relative"],
      ["super+ctrl+shift+arrow_up", "resize"],
    ] as const) {
      for (const platform of ["linux", "win32"]) {
        const label = `${platform} ${trigger}`;
        expect(run(trigger, { platform, state: { panes: 1 } }), label).toEqual({ consumed: false, ran: [] });
        expect(run(trigger, { platform }), label).toEqual({ consumed: true, ran: [command] });
      }
    }
  });

  it("consumes the key of a bind that is not performable, even when it cannot be performed", () => {
    expect(run("super+t", { state: { hooks: { ...READY.hooks, newTab: false } } })).toEqual({
      consumed: true,
      ran: [],
    });
    // macOS super+shift+enter=toggle_split_zoom is not performable.
    expect(run("super+shift+enter", { state: { panes: 1 } })).toEqual({ consumed: true, ran: [] });
    expect(run("super+d")).toEqual({ consumed: true, ran: ["split"] });
    expect(run("super+enter")).toEqual({ consumed: true, ran: ["toggle_fullscreen"] });
    // font size is not implemented and not performable: consumed, never run.
    expect(run("super+=")).toEqual({ consumed: true, ran: [] });
  });

  it("runs an unconsumed bind and leaves its key to the surface", () => {
    const bindings = configuredBindingsForPlatform(
      { clearKeybindings: false, keybindings: [{ trigger: "unconsumed:ctrl+shift+n", action: "new_window" }] },
      "darwin",
    );
    expect(run("ctrl+shift+n", { bindings })).toEqual({ consumed: false, ran: ["new_window"] });
  });

  it("leaves a performable platform bind's key to the surface when its host hook is missing", () => {
    const bindings = configuredBindingsForPlatform(
      { clearKeybindings: false, keybindings: [{ trigger: "performable:super+,", action: "open_config" }] },
      "darwin",
    );
    const noHook = { hooks: { ...READY.hooks, openConfig: false } };
    expect(run("super+,", { bindings, state: noHook })).toEqual({ consumed: false, ran: [] });
    expect(run("super+,", { bindings })).toEqual({ consumed: true, ran: ["open_config"] });
  });

  it("consumes an ignore bind's key whatever its flags", () => {
    for (const prefix of ["", "unconsumed:", "performable:"]) {
      const bindings = configuredBindingsForPlatform(
        { clearKeybindings: false, keybindings: [{ trigger: `${prefix}ctrl+x`, action: "ignore" }] },
        "darwin",
      );
      expect(run("ctrl+x", { bindings }), prefix).toEqual({ consumed: true, ran: [] });
    }
  });
});
