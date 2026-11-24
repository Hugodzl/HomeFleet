import { describe, expect, test } from "vitest";
import {
  checkCandidate,
  checkNewer,
  checkUpgradeGuards,
  isInstalledEntry,
} from "./guards.js";

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

describe("checkCandidate: a candidate may reinstall the same version with other bytes", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  test.each([
    // [case, current, currentSha256, target, targetSha256, expected code]
    ["newer", "0.8.0", A, "0.8.1", B, undefined],
    ["newer, same hash", "0.8.0", A, "0.8.1", A, undefined],
    ["same version, different hash", "0.8.0", A, "0.8.0", B, undefined],
    ["same version, same hash", "0.8.0", A, "0.8.0", A, "same-release"],
    ["same version, unknown hash", "0.8.0", undefined, "0.8.0", B, undefined],
    ["older", "0.8.0", A, "0.7.9", B, "not-newer"],
    ["older, unknown hash", "0.8.0", undefined, "0.7.9", B, "not-newer"],
  ] as const)(
    "%s",
    (_name, current, currentSha256, target, targetSha256, code) => {
      expect(
        checkCandidate({
          current,
          ...(currentSha256 !== undefined ? { currentSha256 } : {}),
          target,
          targetSha256,
        })?.code,
      ).toBe(code);
    },
  );

  test("checkUpgradeGuards with candidate uses checkCandidate", () => {
    const same = { ...base, current: "0.8.0", target: "0.8.0" };
    expect(
      checkUpgradeGuards({
        ...same,
        candidate: { currentSha256: A, targetSha256: B },
      }),
    ).toBeUndefined();
    expect(
      checkUpgradeGuards({
        ...same,
        candidate: { currentSha256: A, targetSha256: A },
      })?.code,
    ).toBe("same-release");
    expect(
      checkUpgradeGuards({ ...same, candidate: { targetSha256: B } }),
    ).toBeUndefined();
    expect(
      checkUpgradeGuards({
        ...base,
        current: "0.8.0",
        target: "0.7.0",
        candidate: { targetSha256: B },
      })?.code,
    ).toBe("not-newer");
  });

  test("without candidate the same version is always not-newer", () => {
    expect(
      checkUpgradeGuards({ ...base, current: "0.8.0", target: "0.8.0" })?.code,
    ).toBe("not-newer");
  });

  test("a candidate still runs the other guards", () => {
    expect(
      checkUpgradeGuards({
        ...base,
        current: "0.8.0",
        target: "0.8.0",
        activeJobs: 1,
        candidate: { currentSha256: A, targetSha256: B },
      })?.code,
    ).toBe("busy");
  });
});
