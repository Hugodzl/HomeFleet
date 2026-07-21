import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import { expect, test } from "vitest";
import {
  buildCatalog,
  type CatalogRuntime,
  makeModelResolver,
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

test("resolver returns the endpoint for a requested model in the catalog", () => {
  const resolve = makeModelResolver(runtime([OK]));
  const r = resolve("recon", "qwen");
  expect(r).toEqual({
    ok: true,
    endpoint: { baseUrl: "http://h/v1", model: "qwen", contextWindow: 32768 },
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
