import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Native window preferences belong to the desktop profile, not the terminal daemon. */
export function loadBackdropBlur(path: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && "enabled" in value && typeof value.enabled === "boolean") {
      return value.enabled;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

export function saveBackdropBlur(path: string, enabled: unknown): boolean {
  if (typeof enabled !== "boolean") throw new Error("Background blur must be on or off");
  // Synchronous replacement keeps simultaneous window updates ordered and never
  // exposes a partially written preference when the app restarts.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return enabled;
}
