// tsyringe (used by @peculiar/x509) needs the reflect polyfill loaded first.
import "reflect-metadata";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeviceIdSchema } from "@homefleet/protocol";
import * as x509 from "@peculiar/x509";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { certFingerprint } from "./fingerprint.js";
import { loadOrCreateIdentity } from "./identity.js";

const tempDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-identity-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

test("first run generates an identity whose deviceId is a valid device ID", async () => {
  const dir = await newDataDir();
  const identity = await loadOrCreateIdentity(dir);
  expect(DeviceIdSchema.parse(identity.deviceId)).toBe(identity.deviceId);
  expect(identity.certPem).toContain("BEGIN CERTIFICATE");
  expect(identity.keyPem).toContain("BEGIN PRIVATE KEY");
});

test("create then load round-trips to the same deviceId and PEMs", async () => {
  const dir = await newDataDir();
  const created = await loadOrCreateIdentity(dir);
  const loaded = await loadOrCreateIdentity(dir);
  expect(loaded.deviceId).toBe(created.deviceId);
  expect(loaded.certPem).toBe(created.certPem);
  expect(loaded.keyPem).toBe(created.keyPem);
});

test("generated certificate parses and its fingerprint is the deviceId", async () => {
  const dir = await newDataDir();
  const identity = await loadOrCreateIdentity(dir);
  const cert = new x509.X509Certificate(identity.certPem);
  expect(certFingerprint(cert.rawData)).toBe(identity.deviceId);
  expect(cert.subject).toBe("CN=homefleet");
  expect(cert.notBefore.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(cert.notAfter.toISOString()).toBe("2076-01-01T00:00:00.000Z");
});

test("two identities in different data dirs get different deviceIds", async () => {
  const [a, b] = await Promise.all([newDataDir(), newDataDir()]);
  const [identityA, identityB] = await Promise.all([
    loadOrCreateIdentity(a),
    loadOrCreateIdentity(b),
  ]);
  expect(identityA.deviceId).not.toBe(identityB.deviceId);
});

test("a corrupt cert.pem throws instead of regenerating", async () => {
  const dir = await newDataDir();
  await loadOrCreateIdentity(dir);
  await writeFile(path.join(dir, "cert.pem"), "?!not-a-certificate!?", "utf8");
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(
    /Corrupt device identity/,
  );
});

test("a corrupt key.pem throws instead of regenerating", async () => {
  const dir = await newDataDir();
  await loadOrCreateIdentity(dir);
  await writeFile(path.join(dir, "key.pem"), "?!not-a-key!?", "utf8");
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(
    /Corrupt device identity/,
  );
});

test("a missing key.pem (cert present) throws instead of regenerating", async () => {
  const dir = await newDataDir();
  const created = await loadOrCreateIdentity(dir);
  await rm(path.join(dir, "key.pem"));
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/key\.pem/);
  // And the surviving cert was not clobbered by a silent regeneration.
  const stillThere = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(dir, "cert.pem"), "utf8"),
  );
  expect(stillThere).toBe(created.certPem);
});

test("a missing cert.pem (key present) throws instead of regenerating", async () => {
  const dir = await newDataDir();
  await loadOrCreateIdentity(dir);
  await rm(path.join(dir, "cert.pem"));
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/cert\.pem/);
});
