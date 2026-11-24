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
 *
 * Only one run may be in flight per process: the download alone can take
 * tens of seconds, and two runs would race on upgrades/<v>/ (prepareRelease
 * clears it per attempt) before either reaches the lock file. So every run —
 * local or pushed — claims `pending` synchronously before its first await,
 * and on success hands over to `inProgress` before letting go of it.
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
import { checkCandidate, checkNewer, checkUpgradeGuards } from "./guards.js";
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
  /**
   * sha256 of the tarball being installed. Always set by this coordinator;
   * optional because a pre-0.8 daemon's control API does not send it.
   */
  sha256?: string;
  /** Present for a release-candidate install. */
  candidate?: true;
}

export interface UpgradeSelfInput {
  version?: string;
  force?: boolean;
  /** Overrides the coordinator's source for this call (target AND rollback copy). */
  source?: ReleaseSource;
  /**
   * A release-candidate install: the same version may be reinstalled when
   * its bytes differ from the running ones. `tag` is a candidate or final
   * tag (`vX.Y.Z-rc.N` / `vX.Y.Z`) and gives the version; `sha256` asks for
   * exact bytes (a rollout's self step) and needs `version` too.
   */
  candidate?: { tag?: string; sha256?: string };
}

/** What a run needs beyond the public input (pushes only). */
interface RunInput extends UpgradeSelfInput {
  /** Where the rollback copy of the running version comes from. */
  rollbackSource?: ReleaseSource;
  /** Exact bytes for the target (a push names its manifest's hash). */
  sha256?: string;
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-rc\.[1-9]\d*)?$/;

export interface UpgradeRuntime {
  pid: number;
  execPath: string;
  argv: readonly string[];
  platform: NodeJS.Platform;
}

export interface UpgradeCoordinatorOptions {
  dataDir: string;
  currentVersion: string;
  /**
   * sha256 of the release tarball this daemon runs (installed-release.json);
   * undefined when unknown. Candidate installs compare against it.
   */
  currentSha256?: string;
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
  /**
   * True once this daemon is shutting down (a `homefleet daemon stop`, a
   * signal). Upgrades are then refused `locked`: one started now would turn
   * the stop into an upgrade-restart. Default: never.
   */
  isShuttingDown?: () => boolean;
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
  /** A run succeeded: the updater owns the node and this daemon is exiting. */
  private inProgress = false;
  /** A run (local or pushed) has claimed the node and has not finished starting. */
  private pending = false;

  constructor(private readonly options: UpgradeCoordinatorOptions) {}

  /** A self upgrade is starting or has handed the node to the updater. */
  get busy(): boolean {
    return this.inProgress || this.pending;
  }

  async check(): Promise<UpgradeCheck> {
    const current = this.options.currentVersion;
    const latest = await this.resolveTarget(undefined);
    return { current, latest, available: compareSemver(latest, current) > 0 };
  }

  async upgradeSelf(input: UpgradeSelfInput): Promise<UpgradeStarted> {
    this.claim(); // synchronous: before the first await
    try {
      return await this.runUpgrade(input);
    } finally {
      // Success: runUpgrade already set inProgress, so there is no gap.
      this.pending = false;
    }
  }

  /** Marks a run as started, or refuses if one already is. Never awaits. */
  private claim(): void {
    this.refuseIfShuttingDown();
    if (this.inProgress || this.pending) {
      throw new UpgradeError("locked", "an upgrade is already in progress");
    }
    this.pending = true;
  }

  private refuseIfShuttingDown(): void {
    if (this.options.isShuttingDown?.() === true) {
      throw new UpgradeError("locked", "this daemon is shutting down");
    }
  }

  /** The upgrade itself; the caller must hold the {@link claim}. */
  private async runUpgrade(input: RunInput): Promise<UpgradeStarted> {
    const { requestShutdown } = this.options;
    if (requestShutdown === undefined) {
      throw new UpgradeError(
        "unsupported",
        "this daemon was not started by homefleetd, so it cannot restart itself",
      );
    }
    const runtime = this.runtime();
    const source = input.source ?? this.options.source;
    const rollbackSource = input.rollbackSource ?? source;
    const candidate = input.candidate;
    const from = this.options.currentVersion;
    const currentSha256 = this.options.currentSha256;
    const to = await this.resolveTarget(
      input.version ?? versionOfTag(candidate?.tag),
      source,
    );
    if (candidate?.tag !== undefined && versionOfTag(candidate.tag) !== to) {
      throw new UpgradeError(
        "not-newer",
        `tag ${candidate.tag} does not carry version ${to}`,
      );
    }
    const wanted = candidate?.sha256 ?? input.sha256;
    // Before downloading anything. A candidate's own hash is only known
    // here when the caller named the bytes (a rollout's self step).
    const early =
      candidate === undefined
        ? checkNewer(from, to)
        : wanted !== undefined
          ? checkCandidate({
              current: from,
              ...(currentSha256 !== undefined ? { currentSha256 } : {}),
              target: to,
              targetSha256: wanted,
            })
          : compareSemver(to, from) < 0
            ? checkNewer(from, to)
            : undefined;
    if (early !== undefined) {
      throw early;
    }

    const dir = upgradesDir(this.options.dataDir);
    const prepared = await prepareRelease({
      ...this.prepareOptions(dir, to, source),
      ...(candidate?.tag !== undefined ? { tag: candidate.tag } : {}),
      ...(wanted !== undefined ? { sha256: wanted } : {}),
    });
    const refusal = checkUpgradeGuards({
      current: from,
      target: to,
      targetHfpVersion: prepared.manifest.hfpVersion,
      localHfpVersion: this.options.localHfpVersion,
      activeJobs: this.options.activeJobs(),
      force: input.force ?? false,
      entryPath: runtime.argv[1] ?? "",
      ...(candidate !== undefined
        ? {
            candidate: {
              ...(currentSha256 !== undefined ? { currentSha256 } : {}),
              targetSha256: prepared.sha256,
            },
          }
        : {}),
    });
    if (refusal !== undefined) {
      throw refusal;
    }
    const rollback = await this.prepareRollback(dir, from, to, rollbackSource);

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
        toSha256: prepared.sha256,
        ...(currentSha256 !== undefined ? { fromSha256: currentSha256 } : {}),
        ...(candidate !== undefined ? { candidate: true } : {}),
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
    return {
      from,
      to,
      sha256: prepared.sha256,
      ...(candidate !== undefined ? { candidate: true as const } : {}),
    };
  }

  /**
   * A copy of the running release to roll back to; best effort (pre-0.5
   * releases are unsigned, and GitHub may be down). When the running hash is
   * known only those bytes will do: from the cache, or - for an older
   * version - from the source by version. The same version (a candidate
   * reinstall) can only come from the cache: GitHub's copy under that
   * version is some other build.
   */
  private async prepareRollback(
    dir: string,
    from: string,
    to: string,
    source: ReleaseSource,
  ): Promise<PreparedRelease | undefined> {
    const currentSha256 = this.options.currentSha256;
    if (from === to && currentSha256 === undefined) {
      return undefined;
    }
    return prepareRelease({
      ...this.prepareOptions(dir, from, source),
      ...(currentSha256 !== undefined ? { sha256: currentSha256 } : {}),
      ...(from === to ? { cacheOnly: true } : {}),
    }).catch(() => undefined);
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
    this.refuseIfShuttingDown();
    const busy = () =>
      new UpgradeError("locked", "an upgrade is already in progress");
    if (this.inProgress || this.pending) {
      throw busy();
    }
    if (await isLockHeld(upgradesDir(this.options.dataDir), Date.now())) {
      throw new UpgradeError(
        "locked",
        "another upgrade holds upgrades/upgrade.lock",
      );
    }
    // Re-check: another run may have started while we read the lock.
    // Nothing below awaits until the claim is taken.
    if (this.inProgress || this.pending) {
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
    const isCandidate = request.candidate === true;
    const pushedSha256 = verified.manifest.sha256;
    const currentSha256 = this.options.currentSha256;
    const candidateGuard = isCandidate
      ? {
          ...(currentSha256 !== undefined ? { currentSha256 } : {}),
          targetSha256: pushedSha256,
        }
      : undefined;
    const notNewer =
      candidateGuard !== undefined
        ? checkCandidate({ current: from, target: version, ...candidateGuard })
        : checkNewer(from, version);
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
      ...(candidateGuard !== undefined ? { candidate: candidateGuard } : {}),
    });
    if (refusal !== undefined) {
      throw refusal;
    }

    const target = this.options.resolvePeer?.(requesterDeviceId);
    if (isCandidate && target === undefined) {
      // A candidate's bytes exist only on the pusher: GitHub has nothing
      // under that version before promotion, and other bytes after.
      throw new UpgradeError(
        "fetch-failed",
        "no address for the requesting node, and a release candidate can only be fetched from it",
      );
    }
    const peer =
      target !== undefined
        ? new PeerReleaseSource({
            client,
            target,
            manifestBytes,
            signature: request.signature,
          })
        : undefined;
    // The target: a candidate from the pusher only; a release from the
    // pusher, then our own source. The rollback copy of what we run never
    // comes from the pusher, which serves only the pushed version.
    const source =
      isCandidate && peer !== undefined
        ? peer
        : new FallbackReleaseSource(
            peer !== undefined
              ? [peer, this.options.source]
              : [this.options.source],
          );
    this.claim();
    void this.runUpgrade({
      version,
      source,
      rollbackSource: this.options.source,
      // Pinned to the pushed bytes, so the cache entry is found by hash and
      // never reused as the final release by a plain by-version lookup.
      sha256: pushedSha256,
      ...(isCandidate ? { candidate: {} } : {}),
    })
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
        // Success: inProgress now holds the node. Failure: free again, only
        // after the failure is recorded so a new push never races its write.
        this.pending = false;
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

/** The X.Y.Z of a `vX.Y.Z` or `vX.Y.Z-rc.N` tag; undefined for no tag. */
function versionOfTag(tag: string | undefined): string | undefined {
  if (tag === undefined) {
    return undefined;
  }
  const match = RELEASE_TAG.exec(tag);
  if (match === null) {
    throw new UpgradeError(
      "not-newer",
      `"${tag}" is not a release tag (vX.Y.Z or vX.Y.Z-rc.N)`,
    );
  }
  return match[1];
}
