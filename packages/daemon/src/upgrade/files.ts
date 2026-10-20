/**
 * On-disk layout of an upgrade, shared by the daemon (this module) and the
 * detached updater (./updater.mjs, which hardcodes the SAME names —
 * updater.test.ts drives it through these constants so they cannot drift):
 *
 *   <dataDir>/upgrade-result.json          last outcome (read by status)
 *   <dataDir>/upgrades/<version>/…         verified release cache
 *   <dataDir>/upgrades/updater.mjs         the copied updater
 *   <dataDir>/upgrades/upgrade-state.json  the updater's only input
 *   <dataDir>/upgrades/upgrade.lock        one upgrade at a time
 *   <dataDir>/upgrades/updater.log         the updater's own log
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const UPGRADES_DIRNAME = "upgrades";
export const STATE_FILE = "upgrade-state.json";
export const LOCK_FILE = "upgrade.lock";
export const RESULT_FILE = "upgrade-result.json";
export const UPDATER_FILE = "updater.mjs";
export const UPDATER_LOG = "updater.log";
export const STALE_LOCK_MS = 10 * 60_000;

export function upgradesDir(dataDir: string): string {
  return path.join(dataDir, UPGRADES_DIRNAME);
}

export interface UpgradeState {
  from: string;
  to: string;
  tarballPath: string;
  /** The verified tarball of `from`; absent when it could not be cached. */
  rollbackTarballPath?: string;
  /** The daemon being replaced; the updater waits for it to exit. */
  daemonPid: number;
  /** Relaunch = `nodePath ...argv` (argv[0] is the daemon entry script). */
  nodePath: string;
  argv: string[];
  controlHost: string;
  controlPort: number;
  /** e.g. `["npm.cmd", "i", "-g"]`; the tarball path is appended. */
  installCommand: string[];
  dataDir: string;
  exitTimeoutMs: number;
  healthTimeoutMs: number;
}

export type UpgradeOutcome = "succeeded" | "rolled-back" | "failed";

export interface UpgradeResult {
  from: string;
  to: string;
  outcome: UpgradeOutcome;
  reason?: string;
  /** Epoch ms when the updater finished. */
  at: number;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive create; takes over only a corrupt lock or an old one whose pid is dead. */
export async function acquireLock(
  dir: string,
  holder: { pid: number; now: number },
): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const body = JSON.stringify({ pid: holder.pid, at: holder.now });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, body, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    let held: { pid: number; at: number } | undefined;
    try {
      held = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid: number;
        at: number;
      };
    } catch {
      held = undefined;
    }
    const stale =
      held === undefined ||
      typeof held.pid !== "number" ||
      typeof held.at !== "number" ||
      (holder.now - held.at > STALE_LOCK_MS && !isPidAlive(held.pid));
    if (!stale) {
      return false;
    }
    await rm(lockPath, { force: true });
  }
  return false;
}

export async function releaseLock(dir: string): Promise<void> {
  await rm(path.join(dir, LOCK_FILE), { force: true });
}

/** Writes the updater's input; returns its path. */
export async function writeUpgradeState(
  dir: string,
  state: UpgradeState,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const statePath = path.join(dir, STATE_FILE);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

/** Sync on purpose: read from the synchronous control `status()`. Absent/corrupt → undefined. */
export function readUpgradeResultSync(
  dataDir: string,
): UpgradeResult | undefined {
  try {
    const json = JSON.parse(
      readFileSync(path.join(dataDir, RESULT_FILE), "utf8"),
    ) as Record<string, unknown>;
    if (
      typeof json.from !== "string" ||
      typeof json.to !== "string" ||
      typeof json.at !== "number" ||
      !["succeeded", "rolled-back", "failed"].includes(json.outcome as string)
    ) {
      return undefined;
    }
    return {
      from: json.from,
      to: json.to,
      outcome: json.outcome as UpgradeOutcome,
      ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
      at: json.at,
    };
  } catch {
    return undefined;
  }
}
