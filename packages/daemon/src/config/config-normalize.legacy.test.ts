import { expect, test } from "vitest";
import { normalizeLegacyConfig } from "./config-normalize.js";

test("two advisory models[] entries sharing an id merge into one catalog entry", () => {
  const out = normalizeLegacyConfig({
    models: [
      { id: "dup", contextWindow: 8192 },
      { id: "dup", contextWindow: 16384 },
    ],
  }) as { catalog: { models: Array<Record<string, unknown>> } };
  expect(out.catalog.models).toHaveLength(1);
  expect(out.catalog.models[0]?.id).toBe("dup");
});
