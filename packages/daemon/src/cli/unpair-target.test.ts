import { expect, test } from "vitest";
import { resolveUnpairTarget } from "./unpair-target.js";

const TOWER = { deviceId: `263d9c76${"1".repeat(56)}`, name: "tower" };
const LAPTOP = { deviceId: `6842f1f3${"2".repeat(56)}`, name: "laptop" };
const STALE = { deviceId: `6842f1f4${"3".repeat(56)}`, name: "laptop" };
const NODES = [TOWER, LAPTOP, STALE];

test("a full deviceId matches", () => {
  expect(resolveUnpairTarget(TOWER.deviceId, NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("a unique 8-char prefix matches, case-insensitively", () => {
  expect(resolveUnpairTarget("263D9C76", NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("an 8-char prefix shared by two nodes is ambiguous", () => {
  const twinA = { deviceId: `abcdef01${"4".repeat(56)}`, name: "twin-a" };
  const twinB = { deviceId: `abcdef01${"5".repeat(56)}`, name: "twin-b" };
  expect(resolveUnpairTarget("abcdef01", [twinA, twinB])).toEqual({
    kind: "ambiguous",
    candidates: [twinA, twinB],
  });
  // A longer prefix disambiguates.
  expect(resolveUnpairTarget("abcdef014", [twinA, twinB])).toEqual({
    kind: "match",
    node: twinA,
  });
});

test("fewer than 8 hex chars is not an id query (only a name match)", () => {
  // LAPTOP and STALE share the 7-char prefix "6842f1f"; it is not treated
  // as an id prefix, and no node is named that.
  expect(resolveUnpairTarget("6842f1f", NODES)).toEqual({ kind: "none" });
  // One more char picks exactly one of them.
  expect(resolveUnpairTarget("6842f1f4", NODES)).toEqual({
    kind: "match",
    node: STALE,
  });
});

test("an exact name matches", () => {
  expect(resolveUnpairTarget("tower", NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("names are case-sensitive", () => {
  expect(resolveUnpairTarget("Tower", NODES)).toEqual({ kind: "none" });
});

test("a duplicated name is ambiguous and lists every candidate", () => {
  expect(resolveUnpairTarget("laptop", NODES)).toEqual({
    kind: "ambiguous",
    candidates: [LAPTOP, STALE],
  });
});

test("an id prefix hit on one node and a name hit on another is ambiguous", () => {
  const hexNamed = { deviceId: "f".repeat(64), name: "263d9c76" };
  expect(resolveUnpairTarget("263d9c76", [TOWER, hexNamed])).toEqual({
    kind: "ambiguous",
    candidates: [TOWER, hexNamed],
  });
});

test("the same node hit by both id and name is one match", () => {
  const self = { deviceId: `abcdef12${"0".repeat(56)}`, name: "abcdef12" };
  expect(resolveUnpairTarget("abcdef12", [self])).toEqual({
    kind: "match",
    node: self,
  });
});

test("nothing matching is none", () => {
  expect(resolveUnpairTarget("desktop", NODES)).toEqual({ kind: "none" });
  expect(resolveUnpairTarget("tower", [])).toEqual({ kind: "none" });
});

test("extra fields on directory entries are not carried into the result", () => {
  const entry = { ...TOWER, reachable: true, host: "192.168.68.73" };
  expect(resolveUnpairTarget("tower", [entry])).toEqual({
    kind: "match",
    node: TOWER,
  });
});
