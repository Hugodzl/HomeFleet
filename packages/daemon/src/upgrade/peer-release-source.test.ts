import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { HfpClient, HfpTarget } from "../transport/client.js";
import {
  manifestFileName,
  releaseFileName,
  signatureFileName,
  verifyRelease,
} from "./manifest.js";
import { PeerReleaseSource } from "./peer-release-source.js";
import { ReleaseFetchError } from "./release-source.js";
import { makeTestKeys, writeSignedRelease } from "./test-release.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "homefleet-peer-src-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const TARGET: HfpTarget = { host: "127.0.0.1", port: 1, expectedDeviceId: "x" };

test("fetchRelease writes the pushed manifest + signature and downloads the tarball; the result verifies", async () => {
  const keys = makeTestKeys();
  const originDir = path.join(root, "origin");
  const origin = await writeSignedRelease(originDir, "1.2.3", keys);
  const calls: Array<{ version: string; maxBytes: number }> = [];
  const client: Pick<HfpClient, "fetchUpgradeTarball"> = {
    async fetchUpgradeTarball(_target, version, destPath, options) {
      calls.push({ version, maxBytes: options.maxBytes });
      await copyFile(origin.tarballPath, destPath);
    },
  };
  const source = new PeerReleaseSource({
    client,
    target: TARGET,
    manifestBytes: origin.manifestBytes,
    signature: origin.signature,
  });
  const destDir = path.join(root, "dest");
  const fetched = await source.fetchRelease("1.2.3", destDir);

  expect(calls).toEqual([{ version: "1.2.3", maxBytes: 100 * 1024 * 1024 }]);
  expect(fetched.tarballPath).toBe(
    path.join(destDir, releaseFileName("1.2.3")),
  );
  expect(fetched.manifestBytes.equals(origin.manifestBytes)).toBe(true);
  expect(fetched.signature).toBe(origin.signature);
  expect(
    (await readFile(path.join(destDir, manifestFileName("1.2.3")))).equals(
      origin.manifestBytes,
    ),
  ).toBe(true);
  expect(
    (await readFile(path.join(destDir, signatureFileName("1.2.3"))))
      .toString("utf8")
      .trim(),
  ).toBe(origin.signature);

  const verified = await verifyRelease({
    manifestBytes: fetched.manifestBytes,
    signature: await readFile(
      path.join(destDir, signatureFileName("1.2.3")),
      "utf8",
    ),
    tarballPath: fetched.tarballPath,
    expectedVersion: "1.2.3",
    publicKeys: [keys.publicKey],
  });
  expect(verified.ok).toBe(true);
});

test("latestVersion throws: a peer source has no latest version", async () => {
  const source = new PeerReleaseSource({
    client: { fetchUpgradeTarball: async () => {} },
    target: TARGET,
    manifestBytes: Buffer.from("{}"),
    signature: "sig",
  });
  await expect(source.latestVersion()).rejects.toThrow(ReleaseFetchError);
});

test("fetchRelease for a version other than the pushed one rejects without touching the client", async () => {
  const keys = makeTestKeys();
  const origin = await writeSignedRelease(
    path.join(root, "origin"),
    "1.2.3",
    keys,
  );
  let calls = 0;
  const client: Pick<HfpClient, "fetchUpgradeTarball"> = {
    async fetchUpgradeTarball() {
      calls++;
    },
  };
  const source = new PeerReleaseSource({
    client,
    target: TARGET,
    manifestBytes: origin.manifestBytes,
    signature: origin.signature,
  });
  await expect(
    source.fetchRelease("1.2.2", path.join(root, "dest")),
  ).rejects.toBeInstanceOf(ReleaseFetchError);
  expect(calls).toBe(0);
});
