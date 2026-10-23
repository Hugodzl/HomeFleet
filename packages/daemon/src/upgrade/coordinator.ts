/**
 * The daemon-side owner of the upgrade flow (fleet-upgrade spec, Phase 2).
 *
 * `upgradeSelf` does everything that can fail WITHOUT disturbing the node —
 * resolve the target, download + verify, run the guards, cache a rollback
 * copy, take the lock — and only then writes the updater's state, starts
 * the detached updater and asks the daemon to shut down gracefully. From
 * that point ./updater.mjs owns the node until the new daemon answers.
 *
 * Phase 3 (fleet push over HFP) and Phase 4 (dashboard) call the same
 * method; they add peers, not a second code path.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { UpgradeRequest as HfpUpgradeRequest } from "@homefleet/protocol";
import type { HfpClient, HfpTarget } from "../transport/client.js";
import { UpgradeError } from "./errors.js";
import {
  acquireLock,
  isLockHeld,
  releaseLock,
  UPDATER_FILE,
  upgradesDir,
  writeUpgradeResult,
  writeUpgradeState,
} from "./files.js";
import { checkNewer, checkUpgradeGuards } from "./guards.js";
import { verifyManifestSignature } from "./manifest.js";
import { PeerReleaseSource } from "./peer-release-source.js";
import { type PreparedRelease, prepareRelease } from "./prepare.js";
import { FallbackReleaseSource, type ReleaseSource } from "./release-source.js";
import { compareSemver } from "./semver.js";
import UPDATER_SOURCE from "./updater.mjs?raw";

export interface UpgradeCheck {
  current: string;
  latest: string;
  available: boolean;
}

export interface UpgradeStarted {
  from: string;
  to: string;
}

export interface UpgradeSelfInput {
  version?: string;
  force?: boolean;
  /** Overrides the coordinator's source for this call (target AND rollback copy). */
  source?: ReleaseSource;
}

export interface UpgradeRuntime {
  pid: number;
  execPath: string;
  argv: readonly string[];
  platform: NodeJS.Platform;
}

export interface UpgradeCoordinatorOptions {
  dataDir: string;
  currentVersion: string;
  localHfpVersion: string;
  source: ReleaseSource;
  activeJobs: () => number;
  /** The control API's bound host/port — what the updater health-checks. */
  controlEndpoint: () => { host: string; port: number };
  /**
   * Graceful shutdown (homefleetd's signal path). Absent when the daemon
   * was not started by the homefleetd bin (tests, embedders) — upgrades
   * are then refused, since nothing would restart it.
   */
  requestShutdown?: (reason: string) => void;
  /** Test seam; the default spawns `node updater.mjs state.json` detached. */
  spawnUpdater?: (updaterPath: string, statePath: string) => void;
  /** Test seam; defaults to the live `process`. */
  runtime?: UpgradeRuntime;
  /** Test seam; defaults to the pinned RELEASE_PUBLIC_KEYS. */
  publicKeys?: readonly string[];
  /** Delay before shutdown so the 202 reaches the caller. Default 250 ms. */
  shutdownDelayMs?: number;
  /** `upgrade.allowRemote`: whether a paired peer may push an upgrade. Default false (fail closed). */
  allowRemote?: boolean;
  /** Maps a paired peer's device id to where to reach it; undefined when unknown. */
  resolvePeer?: (deviceId: string) => HfpTarget | undefined;
}

const EXIT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 60_000;

export function defaultInstallCommand(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["npm.cmd", "i", "-g"] : ["npm", "i", "-g"];
}

export class UpgradeCoordinator {
  private inProgress = false;
  /** A remote push was accepted and its background run has not finished starting. */
  private pendingRemote = false;

  constructor(private readonly options: UpgradeCoordinatorOptions) {}

  async check(): Promise<UpgradeCheck> {
    const current = this.options.currentVersion;
    const latest = await this.resolveTarget(undefined);
    return { current, latest, available: compareSemver(latest, current) > 0 };
  }

  async upgradeSelf(input: UpgradeSelfInput): Promise<UpgradeStarted> {
    if (this.pendingRemote) {
      throw new UpgradeError("locked", "an upgrade is already in progress");
    }
    return this.runUpgrade(input);
  }

  private async runUpgrade(input: UpgradeSelfInput): Promise<UpgradeStarted> {
    const { requestShutdown } = this.options;
    if (requestShutdown === undefined) {
      throw new UpgradeError(
        "unsupported",
        "this daemon was not started by homefleetd, so it cannot restart itself",
      );
    }
    if (this.inProgress) {
      throw new UpgradeError("locked", "an upgrade is already in progress");
    }
    const runtime = this.runtime();
    const source = input.source ?? this.options.source;
    const from = this.options.currentVersion;
    const to = await this.resolveTarget(input.version, source);
    const notNewer = checkNewer(from, to);
    if (notNewer !== undefined) {
      throw notNewer; // before downloading anything
    }

    const dir = upgradesDir(this.options.dataDir);
    const prepared = await prepareRelease(this.prepareOptions(dir, to, source));
    const refusal = checkUpgradeGuards({
      current: from,
      target: to,
      targetHfpVersion: prepared.manifest.hfpVersion,
      localHfpVersion: this.options.localHfpVersion,
      activeJobs: this.options.activeJobs(),
      force: input.force ?? false,
      entryPath: runtime.argv[1] ?? "",
    });
    if (refusal !== undefined) {
      throw refusal;
    }
    // Best effort: pre-0.5 releases are unsigned, and GitHub may be down.
    const rollback: PreparedRelease | undefined = await prepareRelease(
      this.prepareOptions(dir, from, source),
    ).catch(() => undefined);

    if (!(await acquireLock(dir, { pid: runtime.pid, now: Date.now() }))) {
      throw new UpgradeError(
        "locked",
        "another upgrade holds upgrades/upgrade.lock",
      );
    }
    try {
      const updaterPath = path.join(dir, UPDATER_FILE);
      await writeFile(updaterPath, UPDATER_SOURCE);
      const { host, port } = this.options.controlEndpoint();
      const statePath = await writeUpgradeState(dir, {
        from,
        to,
        tarballPath: prepared.tarballPath,
        ...(rollback !== undefined
          ? { rollbackTarballPath: rollback.tarballPath }
          : {}),
        daemonPid: runtime.pid,
        nodePath: runtime.execPath,
        argv: runtime.argv.slice(1),
        controlHost: host,
        controlPort: port,
        installCommand: defaultInstallCommand(runtime.platform),
        dataDir: this.options.dataDir,
        exitTimeoutMs: EXIT_TIMEOUT_MS,
        healthTimeoutMs: HEALTH_TIMEOUT_MS,
      });
      const spawnUpdater =
        this.options.spawnUpdater ??
        ((updater: string, state: string) => {
          spawn(runtime.execPath, [updater, state], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
        });
      spawnUpdater(updaterPath, statePath);
    } catch (error) {
      await releaseLock(dir);
      throw error;
    }
    this.inProgress = true;
    setTimeout(
      () => requestShutdown(`upgrading to ${to}`),
      this.options.shutdownDelayMs ?? 250,
    );
    return { from, to };
  }

  /**
   * A paired peer pushed a signed upgrade. Everything that can be decided
   * from the push alone is decided here, before replying, in a fixed order:
   * disabled, locked, signature, guards. Only then does the (slow) download
   * + upgrade run in the background - requester first, then our own source.
   * A background failure is recorded as `lastUpgrade` failed, which is how
   * the requester learns about it.
   */
  async acceptRemote(input: {
    request: HfpUpgradeRequest;
    requesterDeviceId: string;
    client: Pick<HfpClient, "fetchUpgradeTarball">;
  }): Promise<{ version: string }> {
    const { request, requesterDeviceId, client } = input;
    if (this.options.allowRemote !== true) {
      throw new UpgradeError(
        "disabled",
        "remote upgrades are disabled on this node (upgrade.allowRemote)",
      );
    }
    if (this.options.requestShutdown === undefined) {
      throw new UpgradeError(
        "unsupported",
        "this daemon was not started by homefleetd, so it cannot restart itself",
      );
    }
    const busy = () =>
      new UpgradeError("locked", "an upgrade is already in progress");
    if (this.inProgress || this.pendingRemote) {
      throw busy();
    }
    if (await isLockHeld(upgradesDir(this.options.dataDir), Date.now())) {
      throw new UpgradeError(
        "locked",
        "another upgrade holds upgrades/upgrade.lock",
      );
    }
    // Re-check: another push may have been accepted while we read the lock.
    // Nothing below awaits until pendingRemote is set.
    if (this.inProgress || this.pendingRemote) {
      throw busy();
    }
    const manifestBytes = Buffer.from(request.manifest, "base64");
    const verified = verifyManifestSignature({
      manifestBytes,
      signature: request.signature,
      expectedVersion: request.version,
      ...(this.options.publicKeys !== undefined
        ? { publicKeys: this.options.publicKeys }
        : {}),
    });
    if (!verified.ok) {
      throw new UpgradeError(
        "verify-failed",
        `the pushed manifest was rejected (${verified.reason}): ${verified.detail}`,
      );
    }
    const from = this.options.currentVersion;
    const version = request.version;
    const notNewer = checkNewer(from, version);
    if (notNewer !== undefined) {
      throw notNewer;
    }
    const refusal = checkUpgradeGuards({
      current: from,
      target: version,
      targetHfpVersion: verified.manifest.hfpVersion,
      localHfpVersion: this.options.localHfpVersion,
      activeJobs: this.options.activeJobs(),
      force: false,
      entryPath: this.runtime().argv[1] ?? "",
    });
    if (refusal !== undefined) {
      throw refusal;
    }

    const target = this.options.resolvePeer?.(requesterDeviceId);
    const peer =
      target !== undefined
        ? new PeerReleaseSource({
            client,
            target,
            manifestBytes,
            signature: request.signature,
          })
        : undefined;
    const source = new FallbackReleaseSource(
      peer !== undefined ? [peer, this.options.source] : [this.options.source],
    );
    this.pendingRemote = true;
    void this.runUpgrade({ version, source })
      .catch(async (error: unknown) => {
        await writeUpgradeResult(this.options.dataDir, {
          from,
          to: version,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        }).catch(() => undefined);
      })
      .finally(() => {
        // Success: inProgress now holds the node. Failure: free again.
        this.pendingRemote = false;
      });
    return { version };
  }

  private runtime(): UpgradeRuntime {
    return (
      this.options.runtime ?? {
        pid: process.pid,
        execPath: process.execPath,
        argv: process.argv,
        platform: process.platform,
      }
    );
  }

  private prepareOptions(dir: string, version: string, source: ReleaseSource) {
    return {
      source,
      upgradesDir: dir,
      version,
      ...(this.options.publicKeys !== undefined
        ? { publicKeys: this.options.publicKeys }
        : {}),
    };
  }

  private async resolveTarget(
    version: string | undefined,
    source: ReleaseSource = this.options.source,
  ): Promise<string> {
    if (version !== undefined) {
      return version;
    }
    try {
      return await source.latestVersion();
    } catch (error) {
      throw new UpgradeError(
        "fetch-failed",
        `could not look up the latest release: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
