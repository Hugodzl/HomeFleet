/**
 * Periodic re-probe of the model catalog. The startup probe
 * (`validateCatalog`) used to be the only one, so a model server started
 * AFTER the daemon (llama-server doesn't restart itself after a reboot)
 * stayed `unreachable` in NodeInfo until the daemon restarted. This re-runs
 * the same probe on an interval and refreshes the daemon's shared status map
 * in place; the NodeInfo provider reads it through a getter on every build.
 *
 * Status stays advisory (nothing gates on it), so a probe that fails just
 * leaves `unreachable` and the next tick tries again. One probe at a time:
 * a tick that lands while the previous probe is still running is skipped.
 */
import type { ModelStatus } from "@homefleet/protocol";
import {
  type CatalogRuntime,
  DEFAULT_CATALOG_PROBE_TIMEOUT_MS,
  validateCatalog,
} from "./catalog.js";

/** How often the catalog is re-probed. One cheap `GET /models` per server. */
export const MODEL_REPROBE_INTERVAL_MS = 60_000;

export interface ModelReprobeOptions {
  catalog: CatalogRuntime;
  /** The daemon's live status map, updated in place. */
  statuses: Map<string, ModelStatus>;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ModelReprobe {
  /** Probe now (resolves when done); joins an in-flight probe if one runs. */
  probeNow(): Promise<void>;
  stop(): void;
}

export function startModelReprobe(options: ModelReprobeOptions): ModelReprobe {
  let inFlight: Promise<void> | undefined;
  const probe = (): Promise<void> => {
    if (inFlight !== undefined) {
      return inFlight;
    }
    inFlight = validateCatalog(options.catalog, {
      timeoutMs: options.timeoutMs ?? DEFAULT_CATALOG_PROBE_TIMEOUT_MS,
      ...(options.fetchImpl !== undefined
        ? { fetchImpl: options.fetchImpl }
        : {}),
    })
      .then((fresh) => {
        for (const [id, status] of fresh) {
          options.statuses.set(id, status);
        }
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const timer = setInterval(() => {
    // validateCatalog never throws, so this can't become an unhandled rejection.
    void probe();
  }, options.intervalMs ?? MODEL_REPROBE_INTERVAL_MS);
  // Never keep the process alive just to re-probe models.
  timer.unref();
  return {
    probeNow: probe,
    stop: () => clearInterval(timer),
  };
}
