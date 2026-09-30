import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { serializeManifest, verifyRelease } from "./manifest.js";
import { makeTestKeys, writeSignedRelease } from "./test-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-manifest-"));
  dirs.push(dir);
  return dir;
}

describe("verifyRelease", () => {
  test("accepts a correctly signed release", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.hfpVersion).toBe("0.3.0");
  });

  test("accepts a signature from any pinned key (rotation)", async () => {
    const oldKeys = makeTestKeys();
    const newKeys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", newKeys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [oldKeys.publicKey, newKeys.publicKey],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown key", async () => {
    const release = await writeSignedRelease(
      await tempDir(),
      "0.5.1",
      makeTestKeys(),
    );
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [makeTestKeys().publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects with no pinned keys at all", async () => {
    const release = await writeSignedRelease(
      await tempDir(),
      "0.5.1",
      makeTestKeys(),
    );
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [],
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects a tampered manifest", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const tampered = Buffer.from(
      release.manifestBytes.toString("utf8").replace('"size":', '"size": '),
      "utf8",
    );
    const result = await verifyRelease({
      ...release,
      manifestBytes: tampered,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects a tampered tarball (same size)", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys, {
      content: "aaaa",
    });
    await writeFile(release.tarballPath, "bbbb");
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" });
  });

  test("rejects a size mismatch", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    await writeFile(release.tarballPath, "short");
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "size-mismatch" });
  });

  test("rejects a manifest for a different version", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.2",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "version-mismatch" });
  });

  test("rejects a missing tarball", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    await rm(release.tarballPath);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "missing-tarball" });
  });
});

test("serializeManifest has a fixed key order and trailing newline", () => {
  expect(
    serializeManifest({
      hfpVersion: "0.3.0",
      size: 3,
      sha256: "a".repeat(64),
      file: "homefleet-0.5.0.tgz",
      version: "0.5.0",
    }),
  ).toBe(
    `{"version":"0.5.0","file":"homefleet-0.5.0.tgz","sha256":"${"a".repeat(64)}","size":3,"hfpVersion":"0.3.0"}\n`,
  );
});
