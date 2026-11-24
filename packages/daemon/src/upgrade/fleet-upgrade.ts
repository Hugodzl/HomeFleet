/**
 * The daemon's answer to `POST /control/upgrade` for the fleet paths, and to
 * `GET /control/upgrades`. Self upgrades keep going straight to the
 * coordinator; "fleet" and explicit device lists go through here.
 *
 * Order matters and every refusal happens BEFORE anything is downloaded or
 * pushed: a second start while a rollout runs (the loop is not re-entrant, so
 * the surface is the only guard), then unknown device ids, then target
 * resolution, `prepareRelease` (download + verify into the cache) and finally
 * the push of the cached manifest bytes + signature, exactly as this node
 * verified them.
 */
import type {
  PrepareUpgradeRequest,
  UpgradeRequest,
} from "../control/messages.js";
import type { UpgradeCheck, UpgradeStarted } from "./coordinator.js";
import { UpgradeError } from "./errors.js";
import type { PreparedRelease } from "./prepare.js";
import type { RolloutStartInput, RolloutStatus } from "./rollout.js";

export interface FleetUpgradeSurfaceOptions {
  rollout: {
    start(input: RolloutStartInput): Promise<RolloutStatus>;
    status(): RolloutStatus | undefined;
  };
  coordinator: {
    check(): Promise<UpgradeCheck>;
    upgradeSelf(input: {
      version?: string;
      force?: boolean;
      candidate?: { tag?: string; sha256?: string };
    }): Promise<UpgradeStarted>;
  };
  /** This daemon's version (the coordinator's and rollout's), reported as `current`. */
  currentVersion: string;
  /** Device ids currently in the trust store. */
  pairedDeviceIds: () => string[];
  /**
   * Download + verify `version` into the cache (the coordinator's source and
   * keys); `tag` fetches a release candidate's GitHub release instead.
   */
  prepare: (
    version: string,
    options?: { tag?: string },
  ) => Promise<PreparedRelease>;
  upgradesDir: string;
}

/**
 * What `POST /control/upgrade/prepare` reports once the target release is
 * downloaded and verified into the cache. Not an eligibility verdict: a
 * target that is not newer than this node is still reported.
 */
export interface PreparedUpgrade {
  current: string;
  target: string;
  verified: true;
  size: number;
}

/** The release a rollout pushed: the bytes this node's tarball route serves. */
export interface ServedRelease {
  version: string;
  sha256: string;
}

export interface FleetUpgradeSurface {
  /**
   * The release this node's latest rollout pushed, or undefined before any.
   * The tarball route serves exactly these bytes for that version, so a
   * candidate push is never answered with a cached final (or vice versa).
   */
  servedRelease(): ServedRelease | undefined;
  /** Download + verify the target now, so the confirm dialog can say so. */
  prepare(input: PrepareUpgradeRequest): Promise<PreparedUpgrade>;
  upgrade(input: UpgradeRequest): Promise<UpgradeStarted | RolloutStatus>;
  upgrades(): RolloutStatus | undefined;
}

export function createFleetUpgradeSurface(
  options: FleetUpgradeSurfaceOptions,
): FleetUpgradeSurface {
  // Set synchronously so two overlapping starts cannot both pass the check
  // while the first is still downloading (status() only says "running" after
  // rollout.start() returns).
  let starting = false;
  let served: ServedRelease | undefined;

  function rolloutBusy(): boolean {
    return starting || options.rollout.status()?.state === "running";
  }

  /**
   * The ONE place the target is resolved and prepared, shared by `prepare`
   * and `startFleet` so the dialog's verify step and the later start agree.
   */
  async function resolveAndPrepare(
    version: string | undefined,
    tag?: string,
  ): Promise<{ current: string; prepared: PreparedRelease }> {
    // An explicit version (or a candidate tag) never touches the network
    // here, so a cached verified release can still be rolled out offline.
    const target =
      versionOfTag(tag) ??
      version ??
      (await options.coordinator.check()).latest;
    return {
      current: options.currentVersion,
      prepared: await options.prepare(target, tag !== undefined ? { tag } : {}),
    };
  }

  async function startFleet(input: UpgradeRequest): Promise<RolloutStatus> {
    if (rolloutBusy()) {
      throw new UpgradeError("locked", "a fleet rollout is already running");
    }
    starting = true;
    try {
      const nodes = Array.isArray(input.targets) ? input.targets : undefined;
      if (nodes !== undefined) {
        const paired = new Set(options.pairedDeviceIds());
        const unknown = nodes.filter((id) => !paired.has(id));
        if (unknown.length > 0) {
          throw new UpgradeError(
            "unknown-node",
            `not a paired device: ${unknown.join(", ")}`,
          );
        }
      }
      const { prepared } = await resolveAndPrepare(
        input.version,
        input.candidate,
      );
      const { manifestBytes, signature } = prepared;
      // Only now - past the busy check and a successful prepare - does the
      // tarball route switch to these bytes, before the first push.
      const before = served;
      served = { version: prepared.version, sha256: prepared.sha256 };
      return await options.rollout
        .start({
          prepared,
          manifestBytes,
          signature,
          ...(nodes !== undefined ? { nodes } : {}),
          ...(input.forceLocal !== undefined
            ? { forceLocal: input.forceLocal }
            : {}),
          ...(input.includeSelf !== undefined
            ? { includeSelf: input.includeSelf }
            : {}),
          ...(input.candidate !== undefined ? { candidate: true } : {}),
        })
        .catch((error: unknown) => {
          served = before;
          throw error;
        });
    } finally {
      starting = false;
    }
  }

  return {
    servedRelease: () => served,
    prepare: async (input) => {
      const { current, prepared } = await resolveAndPrepare(input.version);
      return {
        current,
        target: prepared.version,
        verified: true,
        size: prepared.manifest.size,
      };
    },
    upgrade: async (input) => {
      if (input.targets !== "self") {
        return startFleet(input);
      }
      // A self upgrade restarts this daemon, which would silently end a
      // rollout that is still pushing to peers.
      if (rolloutBusy()) {
        throw new UpgradeError(
          "locked",
          "a fleet rollout is running; a self upgrade would end it",
        );
      }
      return options.coordinator.upgradeSelf({
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.candidate !== undefined
          ? { candidate: { tag: input.candidate } }
          : {}),
      });
    },
    upgrades: () => options.rollout.status(),
  };
}

/** The X.Y.Z of a `vX.Y.Z` / `vX.Y.Z-rc.N` tag (already schema-checked). */
function versionOfTag(tag: string | undefined): string | undefined {
  return tag === undefined ? undefined : /^v(\d+\.\d+\.\d+)/.exec(tag)?.[1];
}
