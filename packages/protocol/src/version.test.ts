import { expect, test } from "vitest";
import { HFP_PATH_PREFIX, HFP_PROTOCOL_VERSION } from "./version.js";

test("HFP_PROTOCOL_VERSION is a semver string", () => {
  expect(HFP_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("HFP_PATH_PREFIX is derived from the protocol major version", () => {
  expect(HFP_PATH_PREFIX).toBe("/hfp/v0");
  expect(HFP_PATH_PREFIX).toBe(`/hfp/v${HFP_PROTOCOL_VERSION.split(".")[0]}`);
});
