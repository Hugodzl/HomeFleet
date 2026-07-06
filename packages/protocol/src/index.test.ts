import { expect, test } from "vitest";
import { HFP_VERSION } from "./index.js";

test("protocol package exports a version", () => {
  expect(HFP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
