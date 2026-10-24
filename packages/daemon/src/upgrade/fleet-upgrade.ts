/**
 * The daemon's answer to `POST /control/upgrade` for the fleet paths, and to
 * `GET /control/upgrades`. Self upgrades keep going straight to the
 * coordinator; "fleet" and explicit device lists go through here.
 *
 * Order matters and every refusal happens BEFORE anything is downloaded or
 * pushed: a second start while a rollout runs (the loop is not re-entrant, so
 * the surface is the only guard), then unknown device ids, then target
 * resolution, `prepareRelease` (download + verify into the cache) and finally
 * the push of the cached manifest bytes + signature, which are read back from
 * the cache so peers verify exactly what this node verified.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  PrepareUpgradeRequest,
  UpgradeRequest,
} from "../control/messages.js";
import type { UpgradeCheck, UpgradeStarted } from "./coordinator.js";
import { UpgradeError } from "./errors.js";
import { manifestFileName, signatureFileName } from "./manifest.js";
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
    }): Promise<UpgradeStarted>;
  };
  /** Device ids currently in the trust store. */
  pairedDeviceIds: () => string[];
  /** Download + verify `version` into the cache (the coordinator's source and keys). */
  prepare: (version: string) => Promise<PreparedRelease>;
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

export interface FleetUpgradeSurface {
  /** Download + verify the target now, so the confirm dialog can say so. */
  prepare(input: PrepareUpgradeRequest): Promise<PreparedUpgrade>;
  upgrade(input: UpgradeRequest): Promise<UpgradeStarted | RolloutStatus>;
  upgrades(): RolloutStatus | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFleetUpgradeSurface(
  options: FleetUpgradeSurfaceOptions,
): FleetUpgradeSurface {
  // Set synchronously so two overlapping starts cannot both pass the check
  // while the first is still downloading (status() only says "running" after
  // rollout.start() returns).
  let starting = false;

  function rolloutBusy(): boolean {
    return starting || options.rollout.status()?.state === "running";
  }

  /**
   * The ONE place the target is resolved and prepared, shared by `prepare`
   * and `startFleet` so the dialog's verify step and the later start agree.
   */
  async function resolveAndPrepare(
    version: string | undefined,
  ): Promise<{ current: string; prepared: PreparedRelease }> {
    const check = await options.coordinator.check();
    const prepared = await options.prepare(version ?? check.latest);
    return { current: check.current, prepared };
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
      const { prepared } = await resolveAndPrepare(input.version);
      const dir = path.join(options.upgradesDir, prepared.version);
      let manifestBytes: Buffer;
      let signature: string;
      try {
        manifestBytes = await readFile(
          path.join(dir, manifestFileName(prepared.version)),
        );
        signature = (
          await readFile(
            path.join(dir, signatureFileName(prepared.version)),
            "utf8",
          )
        ).trim();
      } catch (error) {
        throw new UpgradeError(
          "fetch-failed",
          `cannot read the cached release ${prepared.version}: ${messageOf(error)}`,
        );
      }
      return await options.rollout.start({
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
      });
    } finally {
      starting = false;
    }
  }

  return {
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
      });
    },
    upgrades: () => options.rollout.status(),
  };
}
