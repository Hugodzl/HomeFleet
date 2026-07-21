/**
 * The node's model catalog at runtime: config flattened into an id→entry map
 * with endpoints resolved, plus a pure resolver used for submit-time
 * enforcement. Startup validation (validateCatalog) lives here too (Task 5).
 */
import {
  type AgentEndpointOptions,
  MIN_AGENT_CONTEXT_WINDOW,
} from "@homefleet/executors";
import type { HfpErrorCode, JobType } from "@homefleet/protocol";
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
