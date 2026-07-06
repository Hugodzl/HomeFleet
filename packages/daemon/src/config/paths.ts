/**
 * Data-directory resolution for homefleetd.
 *
 * The daemon keeps its identity (cert + key), trust store, and other state in
 * a single per-machine directory. `HOMEFLEET_DATA_DIR` overrides the default
 * — required for tests and for running multiple daemons on one machine.
 */
import os from "node:os";
import path from "node:path";

/**
 * Resolves the daemon data directory.
 *
 * Order of precedence:
 * 1. `HOMEFLEET_DATA_DIR` (when set and non-empty)
 * 2. Per-platform default:
 *    - win32: `%LOCALAPPDATA%\homefleet`
 *    - darwin: `~/Library/Application Support/homefleet`
 *    - linux (and everything else): `~/.local/share/homefleet`
 *
 * @param env Environment to read overrides from (defaults to `process.env`).
 * @param platform Platform to resolve defaults for (defaults to
 *   `process.platform`); injectable so each branch is unit-testable.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.HOMEFLEET_DATA_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  switch (platform) {
    case "win32": {
      const localAppData = env.LOCALAPPDATA;
      const base =
        localAppData !== undefined && localAppData !== ""
          ? localAppData
          : path.join(os.homedir(), "AppData", "Local");
      return path.join(base, "homefleet");
    }
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "homefleet",
      );
    default:
      return path.join(os.homedir(), ".local", "share", "homefleet");
  }
}
