import { expect, test } from "vitest";
import { checkTagVersion } from "./tag-version.js";

test("matching tag passes", () => {
  expect(() => checkTagVersion("v0.3.0", "0.3.0")).not.toThrow();
});

test("prerelease tag matching a prerelease version passes", () => {
  expect(() => checkTagVersion("v0.3.0-rc.1", "0.3.0-rc.1")).not.toThrow();
});

test("mismatched tag fails and names both versions", () => {
  expect(() => checkTagVersion("v0.3.0", "0.2.0")).toThrow(/v0\.3\.0.*0\.2\.0/);
});

test("a tag that is not v<semver> fails", () => {
  expect(() => checkTagVersion("0.3.0", "0.3.0")).toThrow(/v<semver>/);
  expect(() => checkTagVersion("v0.3", "0.3")).toThrow(/v<semver>/);
});
