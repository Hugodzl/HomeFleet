import { expect, test } from "vitest";
import {
  checkTagVersion,
  highestCandidate,
  parseReleaseTag,
} from "./tag-version.js";

test("matching tag passes", () => {
  expect(() => checkTagVersion("v0.3.0", "0.3.0")).not.toThrow();
});

test("a candidate tag carries the final version", () => {
  expect(() => checkTagVersion("v0.8.0-rc.1", "0.8.0")).not.toThrow();
  expect(() => checkTagVersion("v0.8.0-rc.1", "0.8.0-rc.1")).toThrow();
});

test("any other prerelease suffix is refused", () => {
  for (const tag of [
    "v0.8.0-beta.1",
    "v0.8.0-rc.0",
    "v0.8.0-rc.01",
    "v0.8.0-rc1",
    "v0.8.0-rc.1.2",
  ]) {
    expect(() => parseReleaseTag(tag), tag).toThrow();
  }
});

test("parseReleaseTag splits version and candidate number", () => {
  expect(parseReleaseTag("v0.8.0")).toEqual({ version: "0.8.0" });
  expect(parseReleaseTag("v0.8.0-rc.12")).toEqual({
    version: "0.8.0",
    candidate: 12,
  });
});

test("highestCandidate picks rc.10 over rc.9 and ignores other versions", () => {
  expect(
    highestCandidate(
      ["v0.8.0-rc.9", "v0.8.0-rc.10", "v0.8.1-rc.11", "v0.8.0", "junk"],
      "0.8.0",
    ),
  ).toBe("v0.8.0-rc.10");
  expect(highestCandidate(["v0.8.0"], "0.8.0")).toBeUndefined();
});

test("mismatched tag fails and names both versions", () => {
  expect(() => checkTagVersion("v0.3.0", "0.2.0")).toThrow(/v0\.3\.0.*0\.2\.0/);
});

test("a tag that is not v<semver> fails", () => {
  expect(() => checkTagVersion("0.3.0", "0.3.0")).toThrow(/v<semver>/);
  expect(() => checkTagVersion("v0.3", "0.3")).toThrow(/v<semver>/);
});
