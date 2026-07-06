import { expect, test } from "vitest";
import { HfpErrorCodeSchema, HfpErrorSchema } from "./errors.js";

const ALL_CODES = [
  "UNAUTHORIZED",
  "UNKNOWN_JOB",
  "UNSUPPORTED_JOB_TYPE",
  "WORKSPACE_UNAVAILABLE",
  "BUSY",
  "INVALID_REQUEST",
  "CANCELED",
  "INTERNAL",
] as const;

test("HfpErrorCodeSchema accepts every defined code", () => {
  for (const code of ALL_CODES) {
    expect(HfpErrorCodeSchema.parse(code)).toBe(code);
  }
});

test("HfpErrorCodeSchema rejects unknown codes", () => {
  expect(HfpErrorCodeSchema.safeParse("NOT_A_CODE").success).toBe(false);
  expect(HfpErrorCodeSchema.safeParse("unauthorized").success).toBe(false);
});

test("HfpErrorSchema round-trips a minimal error", () => {
  const err = { code: "BUSY", message: "node at capacity" };
  expect(HfpErrorSchema.parse(err)).toEqual(err);
});

test("HfpErrorSchema round-trips an error with arbitrary details", () => {
  const err = {
    code: "INVALID_REQUEST",
    message: "prompt too long",
    details: { maxLength: 16384, actual: 20000 },
  };
  expect(HfpErrorSchema.parse(err)).toEqual(err);
});

test("HfpErrorSchema rejects a missing message", () => {
  expect(HfpErrorSchema.safeParse({ code: "INTERNAL" }).success).toBe(false);
});

test("HfpErrorSchema rejects non-JSON-serializable details", () => {
  expect(
    HfpErrorSchema.safeParse({
      code: "INTERNAL",
      message: "boom",
      details: () => "not json",
    }).success,
  ).toBe(false);
});
