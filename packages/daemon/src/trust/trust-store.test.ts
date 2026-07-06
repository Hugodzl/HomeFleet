import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { type TrustedDevice, TrustStore } from "./trust-store.js";

const tempDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-trust-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

function entry(seed: string, name = "peer"): TrustedDevice {
  return {
    deviceId: seed.repeat(64 / seed.length),
    name,
    addedAt: "2026-07-06T12:00:00.000Z",
  };
}

test("starts empty when no file exists", async () => {
  const store = await TrustStore.load(await newDataDir());
  expect(store.list()).toEqual([]);
  expect(store.has(entry("a").deviceId)).toBe(false);
});

test("add / has / list / remove", async () => {
  const store = await TrustStore.load(await newDataDir());
  const first = entry("a", "tower");
  const second = entry("b", "laptop");

  await store.add(first);
  await store.add(second);
  expect(store.has(first.deviceId)).toBe(true);
  expect(store.has(second.deviceId)).toBe(true);
  expect(store.list()).toEqual([first, second]);

  expect(await store.remove(first.deviceId)).toBe(true);
  expect(store.has(first.deviceId)).toBe(false);
  expect(store.list()).toEqual([second]);
  expect(await store.remove(first.deviceId)).toBe(false);
});

test("entries persist across instances", async () => {
  const dir = await newDataDir();
  const store = await TrustStore.load(dir);
  const device = entry("c", "nas");
  await store.add(device);

  const reloaded = await TrustStore.load(dir);
  expect(reloaded.has(device.deviceId)).toBe(true);
  expect(reloaded.list()).toEqual([device]);
});

test("removal persists across instances", async () => {
  const dir = await newDataDir();
  const store = await TrustStore.load(dir);
  const device = entry("d");
  await store.add(device);
  await store.remove(device.deviceId);

  const reloaded = await TrustStore.load(dir);
  expect(reloaded.list()).toEqual([]);
});

test("atomic write leaves no temp file behind", async () => {
  const dir = await newDataDir();
  const store = await TrustStore.load(dir);
  await store.add(entry("e"));
  await store.add(entry("f"));
  await store.remove(entry("e").deviceId);
  expect(await readdir(dir)).toEqual(["trusted-devices.json"]);
});

test("rejects entries whose deviceId is not a valid device ID", async () => {
  const store = await TrustStore.load(await newDataDir());
  const bad = {
    deviceId: "not-a-fingerprint",
    name: "evil",
    addedAt: "2026-07-06T12:00:00.000Z",
  };
  await expect(store.add(bad)).rejects.toThrow();
  // Uppercase hex is not canonical either.
  const uppercase = { ...entry("a"), deviceId: "A".repeat(64) };
  await expect(store.add(uppercase)).rejects.toThrow();
  expect(store.list()).toEqual([]);
});

test("adding the same deviceId again replaces the entry", async () => {
  const store = await TrustStore.load(await newDataDir());
  await store.add(entry("a", "old-name"));
  await store.add(entry("a", "new-name"));
  expect(store.list()).toEqual([entry("a", "new-name")]);
});

test("a corrupt trust store file throws on load", async () => {
  const dir = await newDataDir();
  await writeFile(path.join(dir, "trusted-devices.json"), "{oops", "utf8");
  await expect(TrustStore.load(dir)).rejects.toThrow(/Corrupt trust store/);
});

test("a structurally invalid trust store file throws on load", async () => {
  const dir = await newDataDir();
  await writeFile(
    path.join(dir, "trusted-devices.json"),
    JSON.stringify([{ deviceId: "nope", name: "x", addedAt: "yesterday" }]),
    "utf8",
  );
  await expect(TrustStore.load(dir)).rejects.toThrow(/Corrupt trust store/);
});
