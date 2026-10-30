import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

// A checkout's target/ symlink does not override Cargo's user/workspace config.
// Ask Cargo so producers and archive consumers use the same directory, including
// when build caches live on an external drive.
export function cargoTargetDirectory(root, env = process.env) {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline", "--locked"], {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  if (typeof metadata.target_directory !== "string" || !isAbsolute(metadata.target_directory)) {
    throw new Error("Cargo metadata did not report an absolute target directory.");
  }
  return metadata.target_directory;
}
