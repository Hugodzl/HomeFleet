import { expect, test } from "vitest";
import { normalizeLegacyConfig } from "./config-normalize.js";

test("no-op when a catalog is already present", () => {
  const raw = { catalog: { models: [{ id: "a" }] }, executors: {} };
  expect(normalizeLegacyConfig(raw)).toEqual(raw);
});

test("legacy agent endpoint becomes a catalog entry + defaultModel", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://h/v1",
          apiKey: "k",
          model: "qwen",
          contextWindow: 32768,
        },
        commandAllowlist: { pnpm: {} },
      },
    },
  }) as any;
  expect(out.catalog.models).toEqual([
    {
      id: "qwen",
      endpoint: { baseUrl: "http://h/v1", apiKey: "k" },
      contextWindow: 32768,
    },
  ]);
  expect(out.executors.agent).toEqual({
    defaultModel: "qwen",
    commandAllowlist: { pnpm: {} },
  });
});

test("legacy write endpoint becomes a catalog entry + defaultModel", () => {
  const out = normalizeLegacyConfig({
    executors: {
      write: {
        endpoint: { baseUrl: "http://h/v1", model: "w", contextWindow: 32768 },
      },
    },
  }) as any;
  expect(out.catalog.models).toEqual([
    { id: "w", endpoint: { baseUrl: "http://h/v1" }, contextWindow: 32768 },
  ]);
  expect(out.executors.write).toEqual({ defaultModel: "w" });
});

test("legacy advisory models[] fold in as endpoint-less entries", () => {
  const out = normalizeLegacyConfig({
    models: [{ id: "a", contextWindow: 8192 }, { id: "b" }],
  }) as any;
  expect(out.models).toBeUndefined();
  expect(out.catalog.models).toEqual([
    { id: "a", contextWindow: 8192 },
    { id: "b" },
  ]);
});

test("an advisory entry and an executor endpoint with the same id merge (endpoint wins)", () => {
  const out = normalizeLegacyConfig({
    models: [{ id: "qwen", contextWindow: 65536 }],
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://h/v1",
          model: "qwen",
          contextWindow: 65536,
        },
      },
    },
  }) as any;
  expect(out.catalog.models).toEqual([
    { id: "qwen", contextWindow: 65536, endpoint: { baseUrl: "http://h/v1" } },
  ]);
});

test("non-object input is returned unchanged", () => {
  expect(normalizeLegacyConfig(null)).toBeNull();
  expect(normalizeLegacyConfig(42)).toBe(42);
});
