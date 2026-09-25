import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBackdropBlur, saveBackdropBlur } from "./backdrop-blur";

const directories: string[] = [];
function preferencePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-backdrop-"));
  directories.push(directory);
  return join(directory, "backdrop-blur.json");
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("desktop backdrop blur preference", () => {
  it("defaults to blur and survives restarts and repeated changes", () => {
    const path = preferencePath();
    expect(loadBackdropBlur(path)).toBe(true);
    saveBackdropBlur(path, false);
    expect(loadBackdropBlur(path)).toBe(false);
    saveBackdropBlur(path, true);
    expect(loadBackdropBlur(path)).toBe(true);
  });

  it("recovers from malformed preferences and validates IPC values before writing", () => {
    const path = preferencePath();
    writeFileSync(path, "invalid json");
    expect(loadBackdropBlur(path)).toBe(true);
    saveBackdropBlur(path, false);
    const saved = readFileSync(path, "utf8");
    for (const value of ["false", null, 0, {}, undefined]) {
      expect(() => saveBackdropBlur(path, value)).toThrow("on or off");
      expect(readFileSync(path, "utf8")).toBe(saved);
    }
  });

  it("keeps profile preferences isolated", () => {
    const first = preferencePath();
    const second = preferencePath();
    saveBackdropBlur(first, false);
    expect(loadBackdropBlur(second)).toBe(true);
  });
});
