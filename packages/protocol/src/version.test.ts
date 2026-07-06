import { expect, test } from "vitest";
import { HFP_PROTOCOL_VERSION } from "./version.js";

test("HFP_PROTOCOL_VERSION is a semver string", () => {
  expect(HFP_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("major version 0 corresponds to the /hfp/v0 path prefix", () => {
  expect(HFP_PROTOCOL_VERSION.split(".")[0]).toBe("0");
});
