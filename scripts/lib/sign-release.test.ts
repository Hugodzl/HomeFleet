import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { verifyRelease } from "../../packages/daemon/src/upgrade/manifest.js";
import {
  generateReleaseKeyPair,
  signRelease,
  versionFromTarball,
} from "./sign-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("a signed tarball verifies under the generated public key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-sign-"));
  dirs.push(dir);
  const tarballPath = path.join(dir, "homefleet-0.5.0.tgz");
  await writeFile(tarballPath, "release bytes");
  const keys = generateReleaseKeyPair();

  const { manifestPath, signaturePath } = await signRelease({
    tarballPath,
    privateKeyPem: keys.privateKeyPem,
    hfpVersion: "0.3.0",
  });

  const result = await verifyRelease({
    manifestBytes: await readFile(manifestPath),
    signature: await readFile(signaturePath, "utf8"),
    tarballPath,
    expectedVersion: "0.5.0",
    publicKeys: [keys.publicKeyBase64],
  });
  expect(result.ok).toBe(true);
  expect(path.basename(manifestPath)).toBe("homefleet-0.5.0.manifest.json");
  expect(path.basename(signaturePath)).toBe("homefleet-0.5.0.manifest.sig");
});

test("versionFromTarball", () => {
  expect(versionFromTarball("/x/homefleet-1.2.3.tgz")).toBe("1.2.3");
  expect(() => versionFromTarball("/x/other-1.2.3.tgz")).toThrow(
    /homefleet-X.Y.Z.tgz/,
  );
});

test("signRelease refuses a non-Ed25519 key", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dir = await mkdtemp(path.join(tmpdir(), "hf-sign-"));
  dirs.push(dir);
  const tarballPath = path.join(dir, "homefleet-0.5.0.tgz");
  await writeFile(tarballPath, "x");
  await expect(
    signRelease({
      tarballPath,
      privateKeyPem: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    }),
  ).rejects.toThrow(/Ed25519/);
});

test("signRelease rejects an invalid hfpVersion before signing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-sign-"));
  dirs.push(dir);
  const tarballPath = path.join(dir, "homefleet-0.5.0.tgz");
  await writeFile(tarballPath, "x");
  await expect(
    signRelease({
      tarballPath,
      privateKeyPem: generateReleaseKeyPair().privateKeyPem,
      hfpVersion: "v1",
    }),
  ).rejects.toThrow();
});
