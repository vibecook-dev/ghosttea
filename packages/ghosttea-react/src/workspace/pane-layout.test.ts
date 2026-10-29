import { describe, expect, it } from "vitest";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import {
  collectDeadPanes,
  insertPane,
  leaves,
  mountSessionInPane,
  pane,
  persistedWorkspace,
  restoreNode,
  removePane,
  replaceSessionInPanes,
  resizeForPane,
  updateSplit,
  type PaneNode,
  type SplitAxis,
} from "./pane-layout";

function session(id: string): SessionSummary {
  return {
    id,
    handle: id,
    executable: "/bin/zsh",
    cols: 80,
    rows: 24,
    exited: false,
    readWrite: true,
    title: null,
    cwd: null,
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: null,
    activity: unknownSessionActivity(),
  };
}

function paneSizes(node: PaneNode, width = 1, height = 1): { id: string; width: number; height: number }[] {
  if (node.kind === "pane") return [{ id: node.id, width, height }];
  return node.axis === "horizontal"
    ? [
        ...paneSizes(node.first, width * node.ratio, height),
        ...paneSizes(node.second, width * (1 - node.ratio), height),
      ]
    : [
        ...paneSizes(node.first, width, height * node.ratio),
        ...paneSizes(node.second, width, height * (1 - node.ratio)),
      ];
}

describe("equal split sizing", () => {
  it("keeps halving the focused pane by default", () => {
    const two = insertPane(pane("one", session("one")), pane("two", session("two")), "one", "horizontal", "split-1");
    const three = insertPane(two, pane("three", session("three")), "two", "horizontal", "split-2");
    expect(paneSizes(three).map(({ width }) => width)).toEqual([0.5, 0.25, 0.25]);
  });

  it.each<SplitAxis>(["horizontal", "vertical"])("makes repeated %s splits equal from any focused pane", (axis) => {
    for (const target of ["one", "two"]) {
      const two = insertPane(pane("one", session("one")), pane("two", session("two")), "one", axis, "split-1", "equal");
      const three = insertPane(two, pane("three", session("three")), target, axis, "split-2", "equal");
      const dimension = axis === "horizontal" ? "width" : "height";
      for (const size of paneSizes(three)) expect(size[dimension]).toBeCloseTo(1 / 3);
      expect(leaves(three).map(({ id }) => id)).toEqual(
        target === "one" ? ["one", "three", "two"] : ["one", "two", "three"],
      );
      for (const fourthTarget of ["one", "two", "three"]) {
        const four = insertPane(three, pane("four", session("four")), fourthTarget, axis, "split-3", "equal");
        for (const size of paneSizes(four)) expect(size[dimension]).toBeCloseTo(1 / 4);
      }
    }
  });

  it("redistributes a manually resized row when a pane is added", () => {
    const two = insertPane(pane("one", session("one")), pane("two", session("two")), "one", "horizontal", "split-1");
    const resized = updateSplit(two, "split-1", (split) => ({ ...split, ratio: 0.7 }));
    const three = insertPane(resized, pane("three", session("three")), "two", "horizontal", "split-2", "equal");
    for (const { width } of paneSizes(three)) expect(width).toBeCloseTo(1 / 3);
  });

  it("keeps perpendicular groups together and leaves other rows unchanged", () => {
    const stack = insertPane(pane("one", session("one")), pane("two", session("two")), "one", "vertical", "stack");
    const topRow = insertPane(stack, pane("three", session("three")), "one", "horizontal", "row");
    const topStack = insertPane(topRow, pane("four", session("four")), "one", "vertical", "inner-stack");
    const resized = updateSplit(
      updateSplit(topStack, "stack", (split) => ({ ...split, ratio: 0.6 })),
      "inner-stack",
      (split) => ({ ...split, ratio: 0.7 }),
    );
    const result = insertPane(resized, pane("five", session("five")), "three", "horizontal", "new-split", "equal");
    const sizes = new Map(paneSizes(result).map((size) => [size.id, size]));
    for (const id of ["one", "three", "four", "five"]) expect(sizes.get(id)?.width).toBeCloseTo(1 / 3);
    expect(sizes.get("one")?.height).toBeCloseTo(0.6 * 0.7);
    expect(sizes.get("four")?.height).toBeCloseTo(0.6 * 0.3);
    expect(sizes.get("three")?.height).toBeCloseTo(0.6);
    expect(sizes.get("five")?.height).toBeCloseTo(0.6);
    expect(sizes.get("two")).toEqual({ id: "two", width: 1, height: 0.4 });
  });

  it("preserves equal widths through workspace persistence and restoration", () => {
    const two = insertPane(
      pane("one", session("one")),
      pane("two", session("two")),
      "one",
      "horizontal",
      "split-1",
      "equal",
    );
    const three = insertPane(two, pane("three", session("three")), "two", "horizontal", "split-2", "equal");
    const saved = persistedWorkspace(three, "three", null);
    const restored = restoreNode(saved.root, new Map(leaves(three).map(({ session }) => [session.id, session])));
    expect(restored).toEqual(three);
    for (const { width } of paneSizes(restored!)) expect(width).toBeCloseTo(1 / 3);
  });
});

describe("insertPane", () => {
  it("composes synchronous session additions without losing either pane", () => {
    const first = pane("pane-1", session("one"));
    const second = insertPane(first, pane("pane-2", session("two")), first.id, "horizontal", "split-1");
    const third = insertPane(second, pane("pane-3", session("three")), "pane-2", "vertical", "split-2");
    expect(leaves(third).map((leaf) => leaf.session.id)).toEqual(["one", "two", "three"]);
  });

  it("allows multiple panes to mirror the same session", () => {
    const first = pane("pane-1", session("one"));
    const mirrored = insertPane(first, pane("pane-2", session("one")), first.id, "horizontal", "split-1");
    expect(leaves(mirrored).map((leaf) => leaf.session.id)).toEqual(["one", "one"]);
  });

  it("persists only opaque layout and session identities", () => {
    const sensitive = {
      ...session("one"),
      executable: "/secret/bin/zsh",
      cwd: "/Users/example/private",
      title: "production@example.internal",
      ownerId: "live-owner-claim",
    };
    const first = pane("pane-1", sensitive);
    const document = persistedWorkspace(first, first.id, null);
    expect(document).toEqual({
      version: 1,
      root: { kind: "pane", id: "pane-1", sessionId: "one" },
      activePaneId: "pane-1",
      zoomedPaneId: null,
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("live-owner-claim");
    expect(restoreNode(document.root, new Map([[sensitive.id, sensitive]]))).toEqual(first);
  });
});

describe("mountSessionInPane", () => {
  it("mounts an existing session without changing another pane that already shows it", () => {
    const first = pane("pane-1", session("one"));
    const layout = insertPane(first, pane("pane-2", session("two")), first.id, "horizontal", "split-1");
    const placed = mountSessionInPane(layout, "pane-1", session("two"));
    expect(leaves(placed).map((leaf) => [leaf.id, leaf.session.id])).toEqual([
      ["pane-1", "two"],
      ["pane-2", "two"],
    ]);
  });

  it("replaces the target when the session is not already visible", () => {
    const layout = pane("pane-1", session("one"));
    expect(leaves(mountSessionInPane(layout, "pane-1", session("three")))[0]?.session.id).toBe("three");
  });
});

describe("pane meta and rehydration", () => {
  it("persists paneMeta verbatim and omits the key when unset or undefined", () => {
    const first = pane("pane-1", session("one"));
    const layout = insertPane(first, pane("pane-2", session("two")), first.id, "vertical", "split-1");
    const withMeta = persistedWorkspace(layout, "pane-1", null, (candidate, paneId) =>
      candidate.id === "one" ? { cwd: "/repo/api", paneId } : undefined,
    );
    expect(withMeta.root).toEqual({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "pane", id: "pane-1", sessionId: "one", meta: { cwd: "/repo/api", paneId: "pane-1" } },
      second: { kind: "pane", id: "pane-2", sessionId: "two" },
    });
    expect(JSON.stringify(persistedWorkspace(layout, "pane-1", null))).not.toContain("meta");
  });

  it("collects dead panes with their meta in tree order and skips live ones", () => {
    const layout = insertPane(
      insertPane(pane("pane-1", session("one")), pane("pane-2", session("two")), "pane-1", "horizontal", "split-1"),
      pane("pane-3", session("three")),
      "pane-2",
      "vertical",
      "split-2",
    );
    const document = persistedWorkspace(layout, "pane-1", null, (candidate) => ({ from: candidate.id }));
    const live = new Map([["two", session("two")]]);
    expect(collectDeadPanes(document.root, live)).toEqual([
      { paneId: "pane-1", sessionId: "one", meta: { from: "one" } },
      { paneId: "pane-3", sessionId: "three", meta: { from: "three" } },
    ]);
  });

  it("collects dead panes from legacy documents that stored whole sessions", () => {
    const legacy = { kind: "pane", id: "pane-1", session: { id: "old" } };
    expect(collectDeadPanes(legacy, new Map())).toEqual([{ paneId: "pane-1", sessionId: "old", meta: undefined }]);
  });

  it("revives dead panes by pane id, preserving split shape and saved ratio", () => {
    const savedRoot = {
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.3,
      first: { kind: "pane", id: "pane-1", sessionId: "one" },
      second: { kind: "pane", id: "pane-2", sessionId: "gone", meta: { cwd: "/repo" } },
    };
    const live = new Map([["one", session("one")]]);
    const revived = session("fresh");
    expect(restoreNode(savedRoot, live, new Map([["pane-2", revived]]))).toEqual({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.3,
      first: pane("pane-1", session("one")),
      second: pane("pane-2", revived),
    });
    expect(restoreNode(savedRoot, live)).toEqual(pane("pane-1", session("one")));
  });
});

describe("removing equally sized panes", () => {
  it.each<SplitAxis>(["horizontal", "vertical"])("rebalances %s siblings regardless of which pane closes", (axis) => {
    let root: PaneNode = pane("one", session("one"));
    root = insertPane(root, pane("two", session("two")), "one", axis, "s1", "equal");
    root = insertPane(root, pane("three", session("three")), "two", axis, "s2", "equal");
    for (const id of ["one", "two", "three"]) {
      const remaining = removePane(root, id, "equal")!;
      expect(leaves(remaining)).toHaveLength(2);
      for (const size of paneSizes(remaining))
        expect(size[axis === "horizontal" ? "width" : "height"]).toBeCloseTo(0.5);
    }
    expect(removePane(root, "absent", "equal")).toBe(root);
  });

  it("preserves perpendicular groups and manually sized unrelated columns", () => {
    let root: PaneNode = insertPane(
      pane("a", session("a")),
      pane("b", session("b")),
      "a",
      "horizontal",
      "columns",
      "equal",
    );
    root = insertPane(root, pane("c", session("c")), "b", "vertical", "rows", "equal");
    root = insertPane(root, pane("d", session("d")), "c", "vertical", "rows2", "equal");
    root = updateSplit(root, "columns", (split) => ({ ...split, ratio: 0.3 }));
    const remaining = removePane(root, "c", "equal")!;
    expect(paneSizes(remaining)).toEqual([
      { id: "a", width: 0.3, height: 1 },
      { id: "b", width: 0.7, height: 0.5 },
      { id: "d", width: 0.7, height: 0.5 },
    ]);
  });

  it("retains the existing close behavior for halves sizing", () => {
    let root: PaneNode = insertPane(pane("a", session("a")), pane("b", session("b")), "a", "horizontal", "s1", "equal");
    root = insertPane(root, pane("c", session("c")), "b", "horizontal", "s2", "equal");
    const remaining = removePane(root, "c")!;
    expect(paneSizes(remaining)[0]!.width).toBeCloseTo(1 / 3);
  });
});

describe("conditional session replacement", () => {
  it("replaces mirrored attachments without changing pane ids, split ratios, or siblings", () => {
    const old = session("ended");
    const other = pane("other", session("working"));
    const root = {
      kind: "split" as const,
      id: "outer",
      axis: "horizontal" as const,
      ratio: 0.3,
      first: pane("one", old),
      second: {
        kind: "split" as const,
        id: "inner",
        axis: "vertical" as const,
        ratio: 0.7,
        first: other,
        second: pane("mirror", old),
      },
    };
    const shell = session("fresh");
    const next = replaceSessionInPanes(root, "ended", shell);
    expect(next).toEqual({
      ...root,
      first: pane("one", shell),
      second: { ...root.second, second: pane("mirror", shell) },
    });
    if (next.kind !== "split" || next.second.kind !== "split") throw new Error("lost layout");
    expect(next.second.first).toBe(other);
    expect(replaceSessionInPanes(next, "ended", session("too-late"))).toBe(next);
  });

  it("does not overwrite a pane reassigned while the replacement was being born", () => {
    const root = pane("same-pane", session("newly-selected-agent"));
    expect(replaceSessionInPanes(root, "ended", session("fresh"))).toBe(root);
  });
});

describe("resizeForPane", () => {
  it("moves the nearest split on the axis that holds the pane, and changes nothing without one", () => {
    const layout = insertPane(pane("a", session("a")), pane("b", session("b")), "a", "horizontal", "split-1");
    const [wider, moved] = resizeForPane(layout, "a", "horizontal", 0.05);
    expect(moved).toBe(true);
    if (wider.kind !== "split") throw new Error("lost the split");
    expect(wider.ratio).toBeCloseTo(0.55);
    expect(resizeForPane(layout, "a", "vertical", 0.05)).toEqual([layout, false]);
    expect(resizeForPane(pane("a", session("a")), "a", "horizontal", 0.05)[1]).toBe(false);
  });
});
