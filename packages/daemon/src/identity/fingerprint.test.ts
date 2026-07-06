import { DeviceIdSchema } from "@homefleet/protocol";
import { expect, test } from "vitest";
import { certFingerprint } from "./fingerprint.js";

// Known SHA-256 vectors.
const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("computes the SHA-256 of the input bytes as lowercase hex", () => {
  const abc = new TextEncoder().encode("abc");
  expect(certFingerprint(abc)).toBe(SHA256_ABC);
});

test("handles empty input", () => {
  expect(certFingerprint(new Uint8Array(0))).toBe(SHA256_EMPTY);
});

test("accepts an ArrayBuffer and produces the same digest", () => {
  const bytes = new TextEncoder().encode("abc");
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  expect(certFingerprint(buffer)).toBe(SHA256_ABC);
});

test("output satisfies the protocol DeviceIdSchema", () => {
  const fingerprint = certFingerprint(new TextEncoder().encode("anything"));
  expect(DeviceIdSchema.parse(fingerprint)).toBe(fingerprint);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
});
