/**
 * Upgrades a legacy raw config (pre-catalog) into the canonical catalog shape
 * so old configs keep loading unchanged. Pure; runs on parsed JSON BEFORE
 * schema validation. No-op when `catalog` is already present (new-mode).
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True when two legacy endpoints resolved onto the same catalog id are
 * equivalent (same server, same key) — used below to tell a benign
 * re-declaration (agent and write both point at one shared server) apart
 * from a genuine conflict.
 *
 * Deliberately compares the SERVER only, not `contextWindow`: v0.2 declared a
 * context window per executor, so one shared server legitimately arrives here
 * with two different windows (the canonical rig config: agent 16384, write
 * 32768). That is a value to reconcile, not an ambiguity — nothing can be
 * misrouted when both point at the same server.
 */
function sameEndpoint(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
}

/**
 * Reconciles two legacy context windows onto one catalog entry by taking the
 * larger. A2 moved `contextWindow` from per-executor to per-model, so the two
 * v0.2 values must collapse. Max is the safe choice: the value gates only the
 * resolver's `MIN_AGENT_CONTEXT_WINDOW` floor, and both legacy values already
 * had to clear that floor to parse under v0.2 — so taking the larger can never
 * turn a config that used to load into a floor rejection.
 */
function largerWindow(a: unknown, b: unknown): number | undefined {
  const an = typeof a === "number" ? a : undefined;
  const bn = typeof b === "number" ? b : undefined;
  if (an === undefined) return bn;
  if (bn === undefined) return an;
  return Math.max(an, bn);
}

export function normalizeLegacyConfig(raw: unknown): unknown {
  if (!isRecord(raw) || "catalog" in raw) return raw;
  const clone: Record<string, unknown> = structuredClone(raw);
  const models: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  const addEntry = (entry: Record<string, unknown>): void => {
    const id = entry.id as string;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, entry);
      models.push(entry);
      return;
    }
    // Both `executors.agent.endpoint` and `executors.write.endpoint` can
    // normalize onto the same model id. If `existing` already carries an
    // endpoint (i.e. it is itself an executor-derived entry, not a purely
    // advisory `models[]` entry) AND the incoming `entry` carries one naming
    // a DIFFERENT server, the two legacy executors are claiming one model id
    // ambiguously: there is no principled way to pick a winner, and merging
    // here (as a plain Object.assign would) would silently make one executor
    // start hitting the other's server. Push `entry` as a SEPARATE array
    // element under the same id instead of merging: the config schema's
    // duplicate-id `superRefine` rule then rejects the whole config loudly at
    // load time, rather than the normalizer silently guessing a winner.
    //
    // Differing context windows on the SAME server are NOT such a conflict —
    // they are reconciled below (see `largerWindow`).
    const existingEndpoint = existing.endpoint;
    const entryEndpoint = entry.endpoint;
    const conflictingEndpoints =
      isRecord(existingEndpoint) &&
      isRecord(entryEndpoint) &&
      !sameEndpoint(existingEndpoint, entryEndpoint);
    if (conflictingEndpoints) {
      models.push(entry);
      return;
    }
    const merged = largerWindow(existing.contextWindow, entry.contextWindow);
    Object.assign(existing, entry); // executor endpoint wins over advisory-only
    if (merged !== undefined) existing.contextWindow = merged;
  };

  if (Array.isArray(clone.models)) {
    for (const m of clone.models as unknown[]) {
      // A malformed advisory entry (non-object / missing string id) is skipped
      // here; if it mattered it surfaces later via schema rejection.
      if (isRecord(m) && typeof m.id === "string") {
        const e: Record<string, unknown> = { id: m.id };
        if (typeof m.contextWindow === "number")
          e.contextWindow = m.contextWindow;
        if (typeof m.label === "string") e.label = m.label;
        addEntry(e);
      }
    }
    delete clone.models;
  }

  if (isRecord(clone.executors)) {
    const executors: Record<string, unknown> = { ...clone.executors };
    for (const kind of ["agent", "write"] as const) {
      const ex = executors[kind];
      if (!isRecord(ex) || !isRecord(ex.endpoint)) continue;
      const ep = ex.endpoint;
      const endpoint: Record<string, unknown> = { baseUrl: ep.baseUrl };
      if (typeof ep.apiKey === "string") endpoint.apiKey = ep.apiKey;
      const entry: Record<string, unknown> = {
        id: ep.model as string,
        endpoint,
      };
      if (typeof ep.contextWindow === "number")
        entry.contextWindow = ep.contextWindow;
      addEntry(entry);
      const rewritten: Record<string, unknown> = { defaultModel: ep.model };
      if ("commandAllowlist" in ex)
        rewritten.commandAllowlist = ex.commandAllowlist;
      executors[kind] = rewritten;
    }
    clone.executors = executors;
  }

  if (models.length > 0) clone.catalog = { models };
  return clone;
}
