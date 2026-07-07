import { expect, test } from "vitest";
import { staticNodeCandidates } from "./static.js";

const deviceId = "ab".repeat(32);
const now = 1_751_800_000_000;

test("maps config entries to candidates with source static", () => {
  const candidates = staticNodeCandidates(
    [
      { host: "192.168.1.20", port: 47113, expectedDeviceId: deviceId },
      { host: "nas.local", port: 47114 },
    ],
    now,
  );
  expect(candidates).toEqual([
    {
      deviceId,
      host: "192.168.1.20",
      port: 47113,
      source: "static",
      lastSeenAt: now,
    },
    { host: "nas.local", port: 47114, source: "static", lastSeenAt: now },
  ]);
  // An absent expectedDeviceId stays absent (not an explicit undefined),
  // so spreads over candidates cannot clobber a known deviceId.
  expect(Object.keys(candidates[1] ?? {})).not.toContain("deviceId");
});

test("an empty static list yields no candidates", () => {
  expect(staticNodeCandidates([], now)).toEqual([]);
});
