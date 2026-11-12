import { createPublicKey } from "node:crypto";
import { expect, test } from "vitest";
import { generateReleaseKeyPair, versionFromTarball } from "./sign-release.js";

test("versionFromTarball", () => {
  expect(versionFromTarball("/x/homefleet-1.2.3.tgz")).toBe("1.2.3");
  expect(() => versionFromTarball("/x/other-1.2.3.tgz")).toThrow(
    /homefleet-X.Y.Z.tgz/,
  );
});

test("generateReleaseKeyPair returns an Ed25519 PEM and its SPKI public key", () => {
  const keys = generateReleaseKeyPair();
  expect(keys.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  const pub = createPublicKey({
    key: Buffer.from(keys.publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  expect(pub.asymmetricKeyType).toBe("ed25519");
});
