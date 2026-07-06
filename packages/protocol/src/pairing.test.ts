import { expect, test } from "vitest";
import { PairRequestSchema, PairResponseSchema } from "./pairing.js";
import { validNodeInfo } from "./test-fixtures.js";

test("PairRequestSchema round-trips a valid request", () => {
  const request = { code: "7KQ2XM", nodeInfo: validNodeInfo };
  expect(PairRequestSchema.parse(request)).toEqual(request);
});

test("PairRequestSchema accepts codes of 6 to 10 uppercase alphanumerics", () => {
  expect(
    PairRequestSchema.safeParse({ code: "ABC123", nodeInfo: validNodeInfo })
      .success,
  ).toBe(true);
  expect(
    PairRequestSchema.safeParse({ code: "ABCDE12345", nodeInfo: validNodeInfo })
      .success,
  ).toBe(true);
});

test("PairRequestSchema rejects malformed codes", () => {
  const bad = ["abc123", "AB12", "ABCDE123456", "ABC-12", "ABC 12", ""];
  for (const code of bad) {
    expect(
      PairRequestSchema.safeParse({ code, nodeInfo: validNodeInfo }).success,
    ).toBe(false);
  }
});

test("PairResponseSchema accepts an acceptance carrying nodeInfo", () => {
  const response = { accepted: true, nodeInfo: validNodeInfo };
  expect(PairResponseSchema.parse(response)).toEqual(response);
});

test("PairResponseSchema accepts a rejection without nodeInfo", () => {
  const response = { accepted: false };
  expect(PairResponseSchema.parse(response)).toEqual(response);
});

test("PairResponseSchema rejects an acceptance missing nodeInfo", () => {
  expect(PairResponseSchema.safeParse({ accepted: true }).success).toBe(false);
});

test("PairResponseSchema rejects a rejection carrying nodeInfo", () => {
  expect(
    PairResponseSchema.safeParse({ accepted: false, nodeInfo: validNodeInfo })
      .success,
  ).toBe(false);
});
