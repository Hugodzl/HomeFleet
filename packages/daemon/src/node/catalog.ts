/**
 * The node's model catalog at runtime: config flattened into an id→entry map
 * with endpoints resolved, plus a pure resolver used for submit-time
 * enforcement. Startup validation is added alongside.
 */
import {
  type AgentEndpointOptions,
  MIN_AGENT_CONTEXT_WINDOW,
} from "@homefleet/executors";
import type {
  HfpErrorCode,
  JobType,
  ModelInfo,
  ModelStatus,
} from "@homefleet/protocol";
import type { DaemonConfig } from "../config/config.js";

/** A catalog entry with its endpoint resolved (entry.endpoint ?? defaultEndpoint). */
export interface CatalogEntry {
  id: string;
  label?: string;
  contextWindow?: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface CatalogRuntime {
  /** id → resolved entry, insertion-ordered. */
  entries: Map<string, CatalogEntry>;
  /** Default model id per model-bearing job type. */
  defaults: { recon?: string; write?: string };
}

export function buildCatalog(
  config: Pick<DaemonConfig, "catalog" | "executors">,
): CatalogRuntime {
  const def = config.catalog.defaultEndpoint;
  const entries = new Map<string, CatalogEntry>();
  for (const m of config.catalog.models) {
    const ep = m.endpoint ?? def;
    const entry: CatalogEntry = {
      id: m.id,
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.contextWindow !== undefined
        ? { contextWindow: m.contextWindow }
        : {}),
      ...(ep !== undefined
        ? {
            baseUrl: ep.baseUrl,
            ...(ep.apiKey !== undefined ? { apiKey: ep.apiKey } : {}),
          }
        : {}),
    };
    entries.set(m.id, entry);
  }
  return {
    entries,
    defaults: {
      ...(config.executors.agent?.defaultModel !== undefined
        ? { recon: config.executors.agent.defaultModel }
        : {}),
      ...(config.executors.write?.defaultModel !== undefined
        ? { write: config.executors.write.defaultModel }
        : {}),
    },
  };
}

export type ModelResolution =
  | { ok: true; endpoint?: AgentEndpointOptions }
  | {
      ok: false;
      code: HfpErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };

export type ModelResolver = (
  jobType: JobType,
  requestedModel: string | undefined,
) => ModelResolution;

const MODEL_BEARING: ReadonlySet<JobType> = new Set<JobType>([
  "recon",
  "write",
]);

export function makeModelResolver(catalog: CatalogRuntime): ModelResolver {
  return (jobType, requestedModel): ModelResolution => {
    if (!MODEL_BEARING.has(jobType)) return { ok: true };
    const dflt =
      jobType === "recon" ? catalog.defaults.recon : catalog.defaults.write;
    const sole =
      catalog.entries.size === 1 ? [...catalog.entries.keys()][0] : undefined;
    const chosen = requestedModel ?? dflt ?? sole;
    if (chosen === undefined) {
      return {
        ok: false,
        code: "NO_MODEL_SPECIFIED",
        message:
          "no model specified and this node has no single default; name a " +
          "model from this node's catalog (see list_nodes).",
      };
    }
    const entry = catalog.entries.get(chosen);
    if (entry === undefined) {
      return {
        ok: false,
        code: "MODEL_NOT_OFFERED",
        message: `this node does not offer model "${chosen}"`,
        details: { model: chosen },
      };
    }
    if (entry.baseUrl === undefined) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: `model "${chosen}" is advertised but has no configured endpoint`,
        details: { model: chosen },
      };
    }
    if (
      entry.contextWindow === undefined ||
      entry.contextWindow < MIN_AGENT_CONTEXT_WINDOW
    ) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message:
          `model "${chosen}" contextWindow ${entry.contextWindow ?? "(unset)"} ` +
          `is below the required minimum of ${MIN_AGENT_CONTEXT_WINDOW}; raise ` +
          "the served context window.",
        details: { model: chosen },
      };
    }
    return {
      ok: true,
      endpoint: {
        baseUrl: entry.baseUrl,
        model: chosen,
        contextWindow: entry.contextWindow,
        ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
      },
    };
  };
}

export interface ValidateOptions {
  /** Per-endpoint probe timeout in ms. */
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Best-effort startup probe. For each DISTINCT endpoint, GET `{baseUrl}/models`
 * and map declared ids to ok/not_served/unreachable. Never throws — a down or
 * slow server just yields `unreachable` for its models. Endpoint-less entries
 * are `unreachable` without a probe.
 */
export async function validateCatalog(
  catalog: CatalogRuntime,
  opts: ValidateOptions,
): Promise<Map<string, ModelStatus>> {
  const f = opts.fetchImpl ?? fetch;
  const status = new Map<string, ModelStatus>();
  const byBase = new Map<string, { ids: string[]; apiKey?: string }>();
  for (const e of catalog.entries.values()) {
    if (e.baseUrl === undefined) {
      status.set(e.id, "unreachable");
      continue;
    }
    const g = byBase.get(e.baseUrl);
    if (g === undefined) {
      // Entries sharing a baseUrl are probed once using the FIRST grouped
      // entry's apiKey. Fine because status is advisory; each entry still
      // carries its own apiKey at dispatch (see makeModelResolver).
      byBase.set(e.baseUrl, {
        ids: [e.id],
        ...(e.apiKey !== undefined ? { apiKey: e.apiKey } : {}),
      });
    } else {
      g.ids.push(e.id);
    }
  }
  await Promise.all(
    [...byBase.entries()].map(async ([baseUrl, { ids, apiKey }]) => {
      const served = await probeServed(f, baseUrl, apiKey, opts.timeoutMs);
      for (const id of ids) {
        status.set(
          id,
          served === null
            ? "unreachable"
            : served.has(id)
              ? "ok"
              : "not_served",
        );
      }
    }),
  );
  return status;
}

async function probeServed(
  f: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<Set<string> | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      signal: controller.signal,
      ...(apiKey !== undefined
        ? { headers: { authorization: `Bearer ${apiKey}` } }
        : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    return new Set(
      data
        .map((m) => (m as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_CATALOG_PROBE_TIMEOUT_MS = 3000;

/** The catalog as advertised in NodeInfo: entries + their validation status. */
export function advertisedModels(
  catalog: CatalogRuntime,
  statuses: Map<string, ModelStatus>,
): ModelInfo[] {
  return [...catalog.entries.values()].map((e) => ({
    id: e.id,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.contextWindow !== undefined
      ? { contextWindow: e.contextWindow }
      : {}),
    status: statuses.get(e.id) ?? "unreachable",
  }));
}
