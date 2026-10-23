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

export function checkUpgradeGuards(
  input: GuardInput,
): UpgradeError | undefined {
  const notNewer = checkNewer(input.current, input.target);
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
