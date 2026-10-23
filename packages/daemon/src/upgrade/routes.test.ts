import { describe, expect, test } from "vitest";
import { UpgradeError } from "./errors.js";
import { checkUpgradeGuards } from "./guards.js";
import { peerFacingMessage } from "./routes.js";

const guardInput = {
  current: "0.5.0",
  target: "0.5.1",
  targetHfpVersion: "0.4.0",
  localHfpVersion: "0.4.0",
  activeJobs: 0,
  force: false,
  entryPath: "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js",
};

describe("peerFacingMessage", () => {
  test("busy: no --force advice, which a pushing peer cannot act on", () => {
    const refusal = checkUpgradeGuards({ ...guardInput, activeJobs: 2 });
    expect(refusal?.code).toBe("busy");
    const message = peerFacingMessage(refusal as UpgradeError);
    expect(message).not.toContain("--force");
    expect(message).toMatch(/2 job\(s\) running/);
  });

  test("not-installed: no local path", () => {
    const refusal = checkUpgradeGuards({
      ...guardInput,
      entryPath: "C:\\Users\\me\\src\\HomeFleet\\dist\\bin\\homefleetd.js",
    });
    expect(refusal?.code).toBe("not-installed");
    const message = peerFacingMessage(refusal as UpgradeError);
    expect(message).not.toContain("Users");
    expect(message).toMatch(/checkout/);
  });

  test("every other refusal passes through unchanged", () => {
    const error = new UpgradeError("disabled", "remote upgrades are disabled");
    expect(peerFacingMessage(error)).toBe("remote upgrades are disabled");
  });
});
