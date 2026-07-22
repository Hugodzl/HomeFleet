import { expect, test } from "vitest";
import { normalizeLegacyConfig } from "./config-normalize.js";

/**
 * `normalizeLegacyConfig` returns `unknown` (its output is re-validated by
 * the config schema, never trusted directly); this is the shape these tests
 * actually read off the result, used below in place of `as any`.
 */
type NormalizedLegacyConfig = {
  models?: unknown;
  catalog: { models: Array<Record<string, unknown>> };
  executors: Record<string, Record<string, unknown>>;
};

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
  }) as NormalizedLegacyConfig;
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
  }) as NormalizedLegacyConfig;
  expect(out.catalog.models).toEqual([
    { id: "w", endpoint: { baseUrl: "http://h/v1" }, contextWindow: 32768 },
  ]);
  expect(out.executors.write).toEqual({ defaultModel: "w" });
});

test("legacy advisory models[] fold in as endpoint-less entries", () => {
  const out = normalizeLegacyConfig({
    models: [{ id: "a", contextWindow: 8192 }, { id: "b" }],
  }) as NormalizedLegacyConfig;
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
  }) as NormalizedLegacyConfig;
  expect(out.catalog.models).toEqual([
    { id: "qwen", contextWindow: 65536, endpoint: { baseUrl: "http://h/v1" } },
  ]);
});

test("agent+write endpoints sharing an id with an IDENTICAL endpoint still collapse to one entry", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://h/v1",
          model: "qwen",
          contextWindow: 32768,
        },
      },
      write: {
        endpoint: {
          baseUrl: "http://h/v1",
          model: "qwen",
          contextWindow: 32768,
        },
      },
    },
  }) as NormalizedLegacyConfig;
  expect(out.catalog.models).toEqual([
    { id: "qwen", endpoint: { baseUrl: "http://h/v1" }, contextWindow: 32768 },
  ]);
  expect(out.executors.agent).toEqual({ defaultModel: "qwen" });
  expect(out.executors.write).toEqual({ defaultModel: "qwen" });
});

test("agent+write endpoints sharing an id but DIFFERENT baseUrls do not merge (duplicate id, left for the schema to reject)", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://agent/v1",
          model: "qwen",
          contextWindow: 32768,
        },
      },
      write: {
        endpoint: {
          baseUrl: "http://write/v1",
          model: "qwen",
          contextWindow: 32768,
        },
      },
    },
  }) as NormalizedLegacyConfig;
  // Deliberately NOT merged: two entries with the same id. The schema's
  // duplicate-id superRefine rule turns this into a load-time rejection
  // (see config.test.ts) instead of the normalizer picking a winner.
  expect(out.catalog.models).toEqual([
    {
      id: "qwen",
      endpoint: { baseUrl: "http://agent/v1" },
      contextWindow: 32768,
    },
    {
      id: "qwen",
      endpoint: { baseUrl: "http://write/v1" },
      contextWindow: 32768,
    },
  ]);
});

test("agent+write endpoints sharing an id and baseUrl but DIFFERENT apiKeys do not merge", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://h/v1",
          apiKey: "key-a",
          model: "qwen",
          contextWindow: 32768,
        },
      },
      write: {
        endpoint: {
          baseUrl: "http://h/v1",
          apiKey: "key-b",
          model: "qwen",
          contextWindow: 32768,
        },
      },
    },
  }) as NormalizedLegacyConfig;
  expect(out.catalog.models).toHaveLength(2);
});

test("agent+write endpoints sharing an id and baseUrl but DIFFERENT contextWindows do not merge", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: {
          baseUrl: "http://h/v1",
          model: "qwen",
          contextWindow: 32768,
        },
      },
      write: {
        endpoint: {
          baseUrl: "http://h/v1",
          model: "qwen",
          contextWindow: 8192,
        },
      },
    },
  }) as NormalizedLegacyConfig;
  expect(out.catalog.models).toHaveLength(2);
});

test("non-object input is returned unchanged", () => {
  expect(normalizeLegacyConfig(null)).toBeNull();
  expect(normalizeLegacyConfig(42)).toBe(42);
});
