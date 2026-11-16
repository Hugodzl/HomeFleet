import { expect, test } from "vitest";
import { checkSignedHfpVersion } from "./hfp-version-check.js";

test("equal versions pass", () => {
  expect(() => checkSignedHfpVersion("0.4.0", "0.4.0")).not.toThrow();
});

test("a different signed version throws, naming both", () => {
  expect(() => checkSignedHfpVersion("9.9.9", "0.4.0")).toThrow(
    /9\.9\.9.*0\.4\.0/,
  );
});
