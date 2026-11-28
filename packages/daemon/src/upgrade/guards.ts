/**
 * Pure pre-flight checks, run BEFORE anything stops: a refused upgrade
 * leaves the node exactly as it was.
 */
import { UpgradeError } from "./errors.js";
import { compareSemver, majorOf } from "./semver.js";

export interface GuardInput {
  current: string;
  target: string;
  /** From the verified manifest. */
  targetHfpVersion: string;
  localHfpVersion: string;
  activeJobs: number;
  force: boolean;
  /** `process.argv[1]` of the running daemon. */
  entryPath: string;
  /**
   * A release-candidate install: the same version is allowed when its bytes
   * differ from the running ones (see {@link checkCandidate}).
   */
  candidate?: { currentSha256?: string; targetSha256: string };
}

/**
 * True when the daemon runs from an `npm i -g` install — the only layout
 * `npm i -g <tgz>` + relaunch can replace. A checkout's dist/bin would be
 * relaunched unchanged and fail the health check every time.
 */
export function isInstalledEntry(entryPath: string): boolean {
  return entryPath
    .replaceAll("\\", "/")
    .includes("/node_modules/homefleet/dist/bin/");
}

export function checkNewer(
  current: string,
  target: string,
): UpgradeError | undefined {
  return compareSemver(target, current) > 0
    ? undefined
    : new UpgradeError(
        "not-newer",
        `${target} is not newer than the running ${current} (downgrades are refused)`,
      );
}

/**
 * The version rule for a release candidate. A newer version passes. The same
 * version passes when its tarball hash differs from the running one, or the
 * running hash is unknown (a node that reached this version before hashes
 * were recorded); the same hash is `same-release`, a no-op. Older is refused.
 */
export function checkCandidate(input: {
  current: string;
  currentSha256?: string;
  target: string;
  targetSha256: string;
}): UpgradeError | undefined {
  const order = compareSemver(input.target, input.current);
  if (order > 0) {
    return undefined;
  }
  if (order < 0) {
    return new UpgradeError(
      "not-newer",
      `${input.target} is older than the running ${input.current} (downgrades are refused)`,
    );
  }
  if (input.currentSha256 === input.targetSha256) {
    return new UpgradeError(
      "same-release",
      `already running ${input.target} (sha256 ${input.targetSha256.slice(0, 12)})`,
      { peerMessage: "already running these bytes" },
    );
  }
  return undefined;
}

export function checkUpgradeGuards(
  input: GuardInput,
): UpgradeError | undefined {
  const notNewer =
    input.candidate !== undefined
      ? checkCandidate({
          current: input.current,
          ...(input.candidate.currentSha256 !== undefined
            ? { currentSha256: input.candidate.currentSha256 }
            : {}),
          target: input.target,
          targetSha256: input.candidate.targetSha256,
        })
      : checkNewer(input.current, input.target);
  if (notNewer !== undefined) {
    return notNewer;
  }
  if (majorOf(input.targetHfpVersion) !== majorOf(input.localHfpVersion)) {
    return new UpgradeError(
      "hfp-major-mismatch",
      `release ${input.target} speaks HFP ${input.targetHfpVersion}, this node speaks ` +
        `${input.localHfpVersion}; a major protocol change needs a manual upgrade`,
    );
  }
  if (!isInstalledEntry(input.entryPath)) {
    return new UpgradeError(
      "not-installed",
      `this daemon runs from ${input.entryPath}, not an npm-installed HomeFleet; ` +
        "update a checkout with git + pnpm build instead",
      {
        peerMessage:
          "this node runs HomeFleet from a source checkout, not an npm install; " +
          "update it there with git + pnpm build",
      },
    );
  }
  if (input.activeJobs > 0 && !input.force) {
    return new UpgradeError(
      "busy",
      `${input.activeJobs} job(s) running; wait for them to finish or pass --force`,
      {
        peerMessage: `${input.activeJobs} job(s) running on this node; push again once they finish`,
      },
    );
  }
  return undefined;
}
