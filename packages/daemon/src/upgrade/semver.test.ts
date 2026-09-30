import { describe, expect, test } from "vitest";
import { compareSemver, isSemver, majorOf } from "./semver.js";

describe("semver", () => {
  test("isSemver accepts only X.Y.Z", () => {
    expect(isSemver("0.5.0")).toBe(true);
    expect(isSemver("10.20.30")).toBe(true);
    expect(isSemver("v0.5.0")).toBe(false);
    expect(isSemver("0.5")).toBe(false);
    expect(isSemver("0.5.0-rc.1")).toBe(false);
  });

  test("compareSemver orders numerically, not lexically", () => {
    expect(compareSemver("0.5.0", "0.5.0")).toBe(0);
    expect(compareSemver("0.5.1", "0.5.0")).toBe(1);
    expect(compareSemver("0.4.9", "0.5.0")).toBe(-1);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  test("compareSemver throws on invalid input", () => {
    expect(() => compareSemver("latest", "0.5.0")).toThrow(/not a semver/);
  });

  test("majorOf", () => {
    expect(majorOf("0.3.0")).toBe(0);
    expect(majorOf("2.1.0")).toBe(2);
  });
});
