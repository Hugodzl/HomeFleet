import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { UpgradeError } from "./errors.js";
import { hashFile, releaseFileName } from "./manifest.js";
import {
  prepareRelease,
  RELEASES_DIRNAME,
  readVerifiedCache,
  TAGS_FILE,
} from "./prepare.js";
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
  const written = await writeSignedRelease(origin, "0.5.1", keys);
  const { sha256 } = await hashFile(written.tarballPath);
  const source = new FakeReleaseSource(origin, "0.5.1");
  return { root, origin, upgradesDir, keys, source, sha256 };
}

test("downloads, verifies and returns the prepared release", async () => {
  const { upgradesDir, keys, source, sha256 } = await setup();
  const prepared = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  });
  expect(prepared.tarballPath).toBe(
    path.join(upgradesDir, RELEASES_DIRNAME, sha256, releaseFileName("0.5.1")),
  );
  expect(prepared.sha256).toBe(sha256);
  expect(prepared.dir).toBe(path.join(upgradesDir, RELEASES_DIRNAME, sha256));
  expect(prepared.manifest.version).toBe("0.5.1");
  expect(prepared.manifestBytes.toString()).toContain('"version":"0.5.1"');
  expect(prepared.signature).not.toMatch(/\s$/);
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
  const second = await prepareRelease(opts);
  expect(source.fetchCount).toBe(2);
  expect(second.tarballPath).toBe(first.tarballPath);
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
  const { upgradesDir, keys, source, sha256 } = await setup();
  const query = { version: "0.5.1" };
  expect(
    await readVerifiedCache(upgradesDir, query, [keys.publicKey]),
  ).toBeUndefined();
  const prepared = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  });
  expect(await readVerifiedCache(upgradesDir, query, [keys.publicKey])).toEqual(
    prepared,
  );
  expect(
    await readVerifiedCache(upgradesDir, { version: "0.5.1", sha256 }, [
      keys.publicKey,
    ]),
  ).toEqual(prepared);
  await truncate(prepared.tarballPath, 3);
  expect(
    await readVerifiedCache(upgradesDir, query, [keys.publicKey]),
  ).toBeUndefined();
});

test("concurrent prepares of the same uncached version share one fetch", async () => {
  const { upgradesDir, keys, source } = await setup();
  const opts = {
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  };
  const [a, b] = await Promise.all([
    prepareRelease(opts),
    prepareRelease(opts),
  ]);
  expect(source.fetchCount).toBe(1);
  expect(a.manifest).toEqual(b.manifest);
  expect(a.tarballPath).toBe(b.tarballPath);
  // Once settled, the next call is served from the verified cache.
  await prepareRelease(opts);
  expect(source.fetchCount).toBe(1);
});

/**
 * Two signed builds of 0.8.0: A (served under v0.8.0-rc.1 and, after
 * promotion, v0.8.0) and B (v0.8.0-rc.2).
 */
async function twoBuilds() {
  const root = await mkdtemp(path.join(tmpdir(), "hf-prepare-"));
  dirs.push(root);
  const keys = makeTestKeys();
  const originA = path.join(root, "a");
  const originB = path.join(root, "b");
  const a = await writeSignedRelease(originA, "0.8.0", keys, {
    content: "build A",
  });
  const b = await writeSignedRelease(originB, "0.8.0", keys, {
    content: "build B",
  });
  const shaA = (await hashFile(a.tarballPath)).sha256;
  const shaB = (await hashFile(b.tarballPath)).sha256;
  const source = new FakeReleaseSource(originA, "0.8.0", {
    "v0.8.0-rc.1": originA,
    "v0.8.0-rc.2": originB,
  });
  const upgradesDir = path.join(root, "upgrades");
  const base = {
    source,
    upgradesDir,
    version: "0.8.0",
    publicKeys: [keys.publicKey],
  };
  const tagsOf = async (sha: string) =>
    JSON.parse(
      await readFile(
        path.join(upgradesDir, RELEASES_DIRNAME, sha, TAGS_FILE),
        "utf8",
      ),
    ) as string[];
  return { root, keys, source, upgradesDir, base, shaA, shaB, tagsOf };
}

describe("the cache is keyed by tarball hash", () => {
  test("a candidate tag misses a cache holding other bytes of the same version and fetches", async () => {
    const { base, source, shaB } = await twoBuilds();
    await prepareRelease(base);
    const b = await prepareRelease({ ...base, tag: "v0.8.0-rc.2" });
    expect(b.sha256).toBe(shaB);
    expect(source.fetchCount).toBe(2);
    expect(source.tags).toEqual(["v0.8.0", "v0.8.0-rc.2"]);
  });

  test("a sha256 request whose fetched manifest has another hash fails verify-failed and leaves no entry", async () => {
    const { base, upgradesDir } = await twoBuilds();
    const error = await prepareRelease({
      ...base,
      sha256: "f".repeat(64),
    }).catch((e: unknown) => e);
    expect((error as UpgradeError).code).toBe("verify-failed");
    const left = await readdir(upgradesDir).catch(() => []);
    expect(left.filter((name) => name.startsWith("staging-"))).toEqual([]);
    expect(
      await readdir(path.join(upgradesDir, RELEASES_DIRNAME)).catch(() => []),
    ).toEqual([]);
  });

  test("by-version lookup ignores entries without the v<version> tag", async () => {
    const { base, source, shaA, tagsOf } = await twoBuilds();
    // A cached by a candidate tag, and the same bytes as a push (hash only).
    await prepareRelease({ ...base, tag: "v0.8.0-rc.1" });
    expect(await tagsOf(shaA)).toEqual(["v0.8.0-rc.1"]);
    expect(
      await readVerifiedCache(base.upgradesDir, { version: "0.8.0" }, [
        ...base.publicKeys,
      ]),
    ).toBeUndefined();
    await prepareRelease(base);
    expect(source.fetchCount).toBe(2);
  });

  test("a hash-only fetch records tags: []", async () => {
    const { base, shaA, tagsOf } = await twoBuilds();
    await prepareRelease({ ...base, sha256: shaA });
    expect(await tagsOf(shaA)).toEqual([]);
  });

  test("a fetch by tag records the tag; the same bytes later fetched by v0.8.0 add that tag", async () => {
    const { base, shaA, tagsOf } = await twoBuilds();
    await prepareRelease({ ...base, tag: "v0.8.0-rc.1" });
    const promoted = await prepareRelease(base);
    expect(promoted.sha256).toBe(shaA);
    expect(await tagsOf(shaA)).toEqual(["v0.8.0-rc.1", "v0.8.0"]);
    expect(
      await readVerifiedCache(base.upgradesDir, { version: "0.8.0" }, [
        ...base.publicKeys,
      ]),
    ).toEqual(promoted);
  });

  test("cacheOnly never calls the source", async () => {
    const { base, source, shaA } = await twoBuilds();
    const error = await prepareRelease({
      ...base,
      sha256: shaA,
      cacheOnly: true,
    }).catch((e: unknown) => e);
    expect((error as UpgradeError).code).toBe("fetch-failed");
    expect(source.fetchCount).toBe(0);
    await prepareRelease({ ...base, sha256: shaA });
    const hit = await prepareRelease({
      ...base,
      sha256: shaA,
      cacheOnly: true,
    });
    expect(hit.sha256).toBe(shaA);
    expect(source.fetchCount).toBe(1);
  });

  test("a staging dir from a failed fetch is removed", async () => {
    const { base, upgradesDir } = await twoBuilds();
    await prepareRelease({ ...base, version: "0.9.9" }).catch(() => undefined);
    const left = await readdir(upgradesDir).catch(() => []);
    expect(left.filter((name) => name.startsWith("staging-"))).toEqual([]);
  });

  test("two prepares with different keys for the same bytes both succeed", async () => {
    const { base, shaA, tagsOf } = await twoBuilds();
    const [byTag, byHash] = await Promise.all([
      prepareRelease({ ...base, tag: "v0.8.0-rc.1" }),
      prepareRelease({ ...base, sha256: shaA }),
    ]);
    expect(byTag.tarballPath).toBe(byHash.tarballPath);
    expect(await tagsOf(shaA)).toContain("v0.8.0-rc.1");
  });

  test("leftover staging-* dirs older than an hour are removed on the next prepare", async () => {
    const { base, upgradesDir } = await twoBuilds();
    const old = path.join(upgradesDir, "staging-old");
    const fresh = path.join(upgradesDir, "staging-fresh");
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await prepareRelease(base);
    const left = await readdir(upgradesDir);
    expect(left).not.toContain("staging-old");
    expect(left).toContain("staging-fresh");
  });

  test("a legacy upgrades/<version>/ dir is ignored", async () => {
    const { base, source, upgradesDir, root, keys } = await twoBuilds();
    await writeSignedRelease(path.join(upgradesDir, "0.8.0"), "0.8.0", keys);
    expect(root).toBeTruthy();
    await prepareRelease(base);
    expect(source.fetchCount).toBe(1);
  });
});

describe("review round 1", () => {
  test("a tag that cannot be recorded never fails a verified release", async () => {
    const { base, source, shaA, upgradesDir } = await twoBuilds();
    await prepareRelease({ ...base, sha256: shaA });
    const tags = path.join(upgradesDir, RELEASES_DIRNAME, shaA, TAGS_FILE);
    await rm(tags, { force: true });
    await mkdir(tags); // tags.json can no longer be replaced
    // Fetched again under a tag: the entry exists, and recording the tag fails.
    const hit = await prepareRelease({ ...base, tag: "v0.8.0-rc.1" });
    expect(hit.sha256).toBe(shaA);
    expect(source.fetchCount).toBe(2);
  });

  test("tag and sha256 together are refused: a hash hit must never gain a tag it was not fetched under", async () => {
    const { base, source, shaA } = await twoBuilds();
    await expect(
      prepareRelease({ ...base, sha256: shaA, tag: "v0.8.0" }),
    ).rejects.toThrow(/tag and sha256/);
    expect(source.fetchCount).toBe(0);
  });
});
