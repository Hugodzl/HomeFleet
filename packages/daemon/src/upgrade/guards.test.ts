import { describe, expect, test } from "vitest";
import { checkNewer, checkUpgradeGuards, isInstalledEntry } from "./guards.js";

const INSTALLED_WIN =
  "C:\\Users\\hugo\\AppData\\Roaming\\npm\\node_modules\\homefleet\\dist\\bin\\homefleetd.js";
const base = {
  current: "0.5.0",
  target: "0.5.1",
  targetHfpVersion: "0.3.0",
  localHfpVersion: "0.3.0",
  activeJobs: 0,
  force: false,
  entryPath: INSTALLED_WIN,
};

describe("checkUpgradeGuards", () => {
  test("passes a normal upgrade", () => {
    expect(checkUpgradeGuards(base)).toBeUndefined();
  });

  test.each([
    ["0.5.0", "equal"],
    ["0.4.9", "older"],
  ])("refuses a %s target (%s)", (target) => {
    expect(checkUpgradeGuards({ ...base, target })?.code).toBe("not-newer");
  });

  test("refuses an HFP major change", () => {
    expect(
      checkUpgradeGuards({ ...base, targetHfpVersion: "1.0.0" })?.code,
    ).toBe("hfp-major-mismatch");
  });

  test("allows an HFP minor change", () => {
    expect(
      checkUpgradeGuards({ ...base, targetHfpVersion: "0.4.0" }),
    ).toBeUndefined();
  });

  test("refuses a checkout-run daemon", () => {
    expect(
      checkUpgradeGuards({
        ...base,
        entryPath:
          "D:\\Git\\LocalAgentCoordinator\\packages\\daemon\\dist\\bin\\homefleetd.js",
      })?.code,
    ).toBe("not-installed");
  });

  test("refuses while jobs run, unless forced", () => {
    expect(checkUpgradeGuards({ ...base, activeJobs: 2 })?.code).toBe("busy");
    expect(
      checkUpgradeGuards({ ...base, activeJobs: 2, force: true }),
    ).toBeUndefined();
  });
});

test("isInstalledEntry handles posix and windows paths", () => {
  expect(
    isInstalledEntry("/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js"),
  ).toBe(true);
  expect(isInstalledEntry(INSTALLED_WIN)).toBe(true);
  expect(
    isInstalledEntry(
      "/home/h/HomeFleet/packages/daemon/dist/bin/homefleetd.js",
    ),
  ).toBe(false);
});

test("checkNewer alone", () => {
  expect(checkNewer("0.5.0", "0.5.1")).toBeUndefined();
  expect(checkNewer("0.5.1", "0.5.1")?.message).toMatch(
    /downgrades are refused/,
  );
});
