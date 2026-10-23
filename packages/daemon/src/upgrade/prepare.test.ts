import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { UpgradeError } from "./errors.js";
import { releaseFileName } from "./manifest.js";
import { prepareRelease, readVerifiedCache } from "./prepare.js";
import {
  FakeReleaseSource,
  makeTestKeys,
  writeSignedRelease,
} from "./test-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "hf-prepare-"));
  dirs.push(root);
  const origin = path.join(root, "origin");
  const upgradesDir = path.join(root, "upgrades");
  const keys = makeTestKeys();
  await writeSignedRelease(origin, "0.5.1", keys);
  const source = new FakeReleaseSource(origin, "0.5.1");
  return { root, origin, upgradesDir, keys, source };
}

test("downloads, verifies and returns the prepared release", async () => {
  const { upgradesDir, keys, source } = await setup();
  const prepared = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  });
  expect(prepared.tarballPath).toBe(
    path.join(upgradesDir, "0.5.1", releaseFileName("0.5.1")),
  );
  expect(prepared.manifest.version).toBe("0.5.1");
  expect(source.fetchCount).toBe(1);
});

test("reuses a verified cached copy without downloading", async () => {
  const { upgradesDir, keys, source } = await setup();
  const opts = {
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  };
  await prepareRelease(opts);
  await prepareRelease(opts);
  expect(source.fetchCount).toBe(1);
});

test("re-downloads when the cached tarball was tampered with", async () => {
  const { upgradesDir, keys, source } = await setup();
  const opts = {
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  };
  const first = await prepareRelease(opts);
  await writeFile(first.tarballPath, "tampered");
  await prepareRelease(opts);
  expect(source.fetchCount).toBe(2);
});

test("a release that fails verification is deleted and reported", async () => {
  const { upgradesDir, source } = await setup();
  const error = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [makeTestKeys().publicKey],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  expect((error as UpgradeError).code).toBe("verify-failed");
  expect(await readdir(upgradesDir)).toEqual([]);
});

test("a download failure is fetch-failed", async () => {
  const { upgradesDir, keys, source } = await setup();
  const error = await prepareRelease({
    source,
    upgradesDir,
    version: "0.9.9",
    publicKeys: [keys.publicKey],
  }).catch((e: unknown) => e);
  expect((error as UpgradeError).code).toBe("fetch-failed");
});

test("readVerifiedCache returns the cached release, undefined once corrupted", async () => {
  const { upgradesDir, keys, source } = await setup();
  expect(
    await readVerifiedCache(upgradesDir, "0.5.1", [keys.publicKey]),
  ).toBeUndefined();
  const prepared = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  });
  expect(
    await readVerifiedCache(upgradesDir, "0.5.1", [keys.publicKey]),
  ).toEqual(prepared);
  await truncate(prepared.tarballPath, 3);
  expect(
    await readVerifiedCache(upgradesDir, "0.5.1", [keys.publicKey]),
  ).toBeUndefined();
});
