/**
 * The "⬆ <version> available" hint the dashboard shows. It is a lazily
 * refreshed cache of the coordinator's latest-release lookup: nothing runs on
 * a timer, and the daemon only calls `refreshIfStale()` while the dashboard is
 * actually polling (`GET /control/status?dashboard=1`), so a CLI status call —
 * or an idle daemon with no browser open — never causes network traffic.
 * A good answer is cached for 6 hours; a failure for 15 minutes (no hint, but
 * no hammering GitHub from every poll while offline either).
 */
import { compareSemver, isSemver } from "./semver.js";

export const AVAILABLE_UPGRADE_TTL_MS = 6 * 60 * 60_000;
export const AVAILABLE_UPGRADE_FAILURE_TTL_MS = 15 * 60_000;

export interface AvailableUpgradeOptions {
  currentVersion: string;
  /** The coordinator's `source.latestVersion`. */
  latestVersion: () => Promise<string>;
  now?: () => number;
}

export interface AvailableUpgrade {
  /** Cached value (never awaits network): the newer version, or undefined. */
  current(): string | undefined;
  /** Kick a background refresh if the cache is stale; never throws, one in flight at a time. */
  refreshIfStale(): void;
  /**
   * Store the answer of a lookup made elsewhere (the uncached
   * `GET /control/upgrade/check`, i.e. the dashboard's "Check for updates"
   * button), as if this cache had just looked it up. A non-semver value is
   * ignored.
   */
  record(latest: string): void;
}

export function createAvailableUpgrade(
  options: AvailableUpgradeOptions,
): AvailableUpgrade {
  const now = options.now ?? Date.now;
  let value: string | undefined;
  /** When the cache goes stale; 0 means never looked up. */
  let staleAt = 0;
  let inFlight = false;

  function store(latest: string): void {
    value =
      compareSemver(latest, options.currentVersion) > 0 ? latest : undefined;
    staleAt = now() + AVAILABLE_UPGRADE_TTL_MS;
  }

  async function refresh(): Promise<void> {
    try {
      const latest = await options.latestVersion();
      if (!isSemver(latest)) {
        throw new Error("latest release is not a semver string");
      }
      store(latest);
    } catch {
      value = undefined;
      staleAt = now() + AVAILABLE_UPGRADE_FAILURE_TTL_MS;
    } finally {
      inFlight = false;
    }
  }

  return {
    current: () => value,
    refreshIfStale: () => {
      if (inFlight || now() < staleAt) {
        return;
      }
      inFlight = true;
      void refresh();
    },
    record: (latest) => {
      if (isSemver(latest)) {
        store(latest);
      }
    },
  };
}
