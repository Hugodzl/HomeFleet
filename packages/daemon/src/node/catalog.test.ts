import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import { expect, test } from "vitest";
import {
  buildCatalog,
  type CatalogRuntime,
  makeModelResolver,
  validateCatalog,
} from "./catalog.js";

function runtime(
  entries: CatalogRuntime["entries"] extends Map<infer _K, infer V>
    ? V[]
    : never,
  defaults: CatalogRuntime["defaults"] = {},
): CatalogRuntime {
  return { entries: new Map(entries.map((e) => [e.id, e])), defaults };
}

const OK = { id: "qwen", contextWindow: 32768, baseUrl: "http://h/v1" };

test("buildCatalog resolves per-entry endpoint over the default", () => {
  const cat = buildCatalog({
    catalog: {
      defaultEndpoint: { baseUrl: "http://default/v1", apiKey: "k" },
      models: [
        { id: "a", contextWindow: 32768 },
        { id: "b", endpoint: { baseUrl: "http://b/v1" } },
      ],
    },
    executors: { agent: { defaultModel: "a" } },
  });
  expect(cat.entries.get("a")).toEqual({
    id: "a",
    contextWindow: 32768,
    baseUrl: "http://default/v1",
    apiKey: "k",
  });
  expect(cat.entries.get("b")).toEqual({ id: "b", baseUrl: "http://b/v1" });
  expect(cat.defaults).toEqual({ recon: "a", write: undefined });
});

test("buildCatalog maps both the agent and write executor defaults", () => {
  const cat = buildCatalog({
    catalog: {
      models: [
        { id: "a", contextWindow: 32768 },
        { id: "b", contextWindow: 32768 },
      ],
    },
    executors: { agent: { defaultModel: "a" }, write: { defaultModel: "b" } },
  });
  expect(cat.defaults).toEqual({ recon: "a", write: "b" });
  expect(cat.entries.has("a")).toBe(true);
  expect(cat.entries.has("b")).toBe(true);
});

test("resolver returns the endpoint for a requested model in the catalog", () => {
  const resolve = makeModelResolver(runtime([OK]));
  const r = resolve("recon", "qwen");
  expect(r).toEqual({
    ok: true,
    endpoint: { baseUrl: "http://h/v1", model: "qwen", contextWindow: 32768 },
  });
});

test("resolver carries the entry apiKey onto the resolved endpoint", () => {
  const resolve = makeModelResolver(
    runtime([
      { id: "qwen", contextWindow: 32768, baseUrl: "http://h/v1", apiKey: "k" },
    ]),
  );
  expect(resolve("recon", "qwen")).toEqual({
    ok: true,
    endpoint: {
      baseUrl: "http://h/v1",
      model: "qwen",
      contextWindow: 32768,
      apiKey: "k",
    },
  });
});

test("resolver uses the executor default when no model is requested", () => {
  const resolve = makeModelResolver(
    runtime(
      [OK, { id: "other", contextWindow: 32768, baseUrl: "http://o/v1" }],
      { recon: "qwen" },
    ),
  );
  expect(resolve("recon", undefined)).toMatchObject({
    ok: true,
    endpoint: { model: "qwen" },
  });
});

test("resolver uses a single-entry catalog as the implicit default", () => {
  const resolve = makeModelResolver(runtime([OK])); // no defaults set
  expect(resolve("recon", undefined)).toMatchObject({
    ok: true,
    endpoint: { model: "qwen" },
  });
});

test("resolver rejects NO_MODEL_SPECIFIED when multi-entry and no default/request", () => {
  const resolve = makeModelResolver(
    runtime([OK, { id: "b", contextWindow: 32768, baseUrl: "http://b/v1" }]),
  );
  expect(resolve("recon", undefined)).toMatchObject({
    ok: false,
    code: "NO_MODEL_SPECIFIED",
  });
});

test("resolver rejects MODEL_NOT_OFFERED for an unknown id", () => {
  const resolve = makeModelResolver(runtime([OK]));
  expect(resolve("recon", "ghost")).toMatchObject({
    ok: false,
    code: "MODEL_NOT_OFFERED",
    details: { model: "ghost" },
  });
});

test("resolver rejects INVALID_REQUEST for a model with no endpoint", () => {
  const resolve = makeModelResolver(
    runtime([{ id: "adv", contextWindow: 32768 }]),
  );
  expect(resolve("recon", "adv")).toMatchObject({
    ok: false,
    code: "INVALID_REQUEST",
  });
});

test("resolver rejects INVALID_REQUEST for a contextWindow below the floor", () => {
  const resolve = makeModelResolver(
    runtime([
      {
        id: "small",
        contextWindow: MIN_AGENT_CONTEXT_WINDOW - 1,
        baseUrl: "http://h/v1",
      },
    ]),
  );
  expect(resolve("recon", "small")).toMatchObject({
    ok: false,
    code: "INVALID_REQUEST",
  });
});

test("resolver returns ok with no endpoint for a command job", () => {
  const resolve = makeModelResolver(runtime([OK]));
  expect(resolve("command", undefined)).toEqual({ ok: true });
});

test("write resolves against the write default, not the agent default", () => {
  const resolve = makeModelResolver(
    runtime(
      [OK, { id: "writer", contextWindow: 32768, baseUrl: "http://w/v1" }],
      { recon: "qwen", write: "writer" },
    ),
  );
  expect(resolve("write", undefined)).toMatchObject({
    ok: true,
    endpoint: { model: "writer" },
  });
});

/** A fake fetch mapping baseUrl -> served ids; "THROW" simulates a down server. */
function fakeFetch(byUrl: Record<string, string[] | "THROW">): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const base = url.replace(/\/models$/, "");
    const served = byUrl[base];
    if (served === undefined)
      return { ok: false, json: async () => ({}) } as Response;
    if (served === "THROW") throw new Error("connection refused");
    return {
      ok: true,
      json: async () => ({ data: served.map((id) => ({ id })) }),
    } as Response;
  }) as unknown as typeof fetch;
}

test("validateCatalog marks served models ok, absent models not_served", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "b", contextWindow: 32768, baseUrl: "http://h/v1" },
  ]);
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: fakeFetch({ "http://h/v1": ["a"] }),
  });
  expect(status.get("a")).toBe("ok");
  expect(status.get("b")).toBe("not_served");
});

test("validateCatalog marks entries on a down server unreachable", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://down/v1" },
  ]);
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: fakeFetch({ "http://down/v1": "THROW" }),
  });
  expect(status.get("a")).toBe("unreachable");
});

test("validateCatalog marks an endpoint-less entry unreachable without fetching", async () => {
  const cat = runtime([{ id: "adv", contextWindow: 32768 }]);
  let calls = 0;
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: (async () => {
      calls++;
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch,
  });
  expect(status.get("adv")).toBe("unreachable");
  expect(calls).toBe(0);
});

test("validateCatalog probes each distinct endpoint once", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "b", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "c", contextWindow: 32768, baseUrl: "http://other/v1" },
  ]);
  const seen: string[] = [];
  const impl = (async (input: string | URL) => {
    seen.push(String(input));
    return {
      ok: true,
      json: async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    } as Response;
  }) as unknown as typeof fetch;
  await validateCatalog(cat, { timeoutMs: 1000, fetchImpl: impl });
  expect(seen.sort()).toEqual(["http://h/v1/models", "http://other/v1/models"]);
});

test("validateCatalog treats a timeout/abort as unreachable", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://slow/v1" },
  ]);
  const impl = ((_input: string | URL, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as unknown as typeof fetch;
  const status = await validateCatalog(cat, { timeoutMs: 5, fetchImpl: impl });
  expect(status.get("a")).toBe("unreachable");
});
