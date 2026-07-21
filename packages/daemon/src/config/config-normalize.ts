/**
 * Upgrades a legacy raw config (pre-catalog) into the canonical catalog shape
 * so old configs keep loading unchanged. Pure; runs on parsed JSON BEFORE
 * schema validation. No-op when `catalog` is already present (new-mode).
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    } else {
      Object.assign(existing, entry); // executor endpoint wins over advisory-only
    }
  };

  if (Array.isArray(clone.models)) {
    for (const m of clone.models as unknown[]) {
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
