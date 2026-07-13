/**
 * Unit tests for the write-job artifact registry (v0.2 Task 6): an in-memory
 * jobId -> bundle index whose remove/removeAll also delete the bundle file
 * from disk. Pure unit tests over real temp files — no git involved.
 */
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { ArtifactStore } from "./artifact-store.js";

const JOB_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const JOB_B = "22222222-2222-4222-9222-bbbbbbbbbbbb";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeBundleFile(name: string): Promise<string> {
  const dir = await makeTempDataDir("homefleet-artifact-");
  cleanups.push(() => removeTempDataDir(dir));
  const bundlePath = path.join(dir, name);
  await writeFile(bundlePath, `bundle bytes for ${name}\n`);
  return bundlePath;
}

test("register/get round-trips an entry; get returns a defensive copy", async () => {
  const store = new ArtifactStore();
  const bundlePath = await makeBundleFile("a.bundle");
  store.register(JOB_A, {
    bundlePath,
    headCommit: "b".repeat(40),
    byteLength: 123,
  });

  const entry = store.get(JOB_A);
  expect(entry).toEqual({
    bundlePath,
    headCommit: "b".repeat(40),
    byteLength: 123,
  });
  // Mutating the returned object must not corrupt the registry.
  if (entry === undefined) {
    throw new Error("expected an entry");
  }
  entry.headCommit = "tampered";
  expect(store.get(JOB_A)?.headCommit).toBe("b".repeat(40));

  expect(store.get(JOB_B)).toBeUndefined();
});

test("remove deletes the bundle file and deregisters; unknown/second removes are no-ops", async () => {
  const store = new ArtifactStore();
  const bundlePath = await makeBundleFile("a.bundle");
  store.register(JOB_A, {
    bundlePath,
    headCommit: "b".repeat(40),
    byteLength: 24,
  });

  await store.remove(JOB_A);
  expect(store.get(JOB_A)).toBeUndefined();
  await expect(stat(bundlePath)).rejects.toThrow();

  // Idempotent, and an unknown jobId is a quiet no-op too.
  await expect(store.remove(JOB_A)).resolves.toBeUndefined();
  await expect(store.remove(JOB_B)).resolves.toBeUndefined();
});

test("remove tolerates a bundle file that is already gone", async () => {
  const store = new ArtifactStore();
  const dir = await makeTempDataDir("homefleet-artifact-");
  cleanups.push(() => removeTempDataDir(dir));
  // Registered but never actually on disk (e.g. reaped by an init purge).
  store.register(JOB_A, {
    bundlePath: path.join(dir, "vanished.bundle"),
    headCommit: "b".repeat(40),
    byteLength: 24,
  });

  await expect(store.remove(JOB_A)).resolves.toBeUndefined();
  expect(store.get(JOB_A)).toBeUndefined();
});

test("removeAll deletes every bundle file and clears the registry", async () => {
  const store = new ArtifactStore();
  const pathA = await makeBundleFile("a.bundle");
  const pathB = await makeBundleFile("b.bundle");
  store.register(JOB_A, {
    bundlePath: pathA,
    headCommit: "a".repeat(40),
    byteLength: 1,
  });
  store.register(JOB_B, {
    bundlePath: pathB,
    headCommit: "b".repeat(40),
    byteLength: 2,
  });

  await store.removeAll();

  expect(store.get(JOB_A)).toBeUndefined();
  expect(store.get(JOB_B)).toBeUndefined();
  await expect(stat(pathA)).rejects.toThrow();
  await expect(stat(pathB)).rejects.toThrow();
});

test("re-registering a jobId replaces its entry", async () => {
  const store = new ArtifactStore();
  const bundlePath = await makeBundleFile("a.bundle");
  store.register(JOB_A, {
    bundlePath,
    headCommit: "a".repeat(40),
    byteLength: 1,
  });
  store.register(JOB_A, {
    bundlePath,
    headCommit: "c".repeat(40),
    byteLength: 2,
  });
  expect(store.get(JOB_A)).toEqual({
    bundlePath,
    headCommit: "c".repeat(40),
    byteLength: 2,
  });
});
