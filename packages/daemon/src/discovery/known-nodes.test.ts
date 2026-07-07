import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { type KnownNode, KnownNodesRegistry } from "./known-nodes.js";

const tempDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-known-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

function entry(seed: string, overrides: Partial<KnownNode> = {}): KnownNode {
  return {
    deviceId: seed.repeat(64 / seed.length),
    name: "peer",
    host: "192.168.1.20",
    port: 47113,
    lastSeenAt: "2026-07-06T12:00:00.000Z",
    source: "mdns",
    ...overrides,
  };
}

test("starts empty when no file exists", async () => {
  const registry = await KnownNodesRegistry.load(await newDataDir());
  expect(registry.list()).toEqual([]);
});

test("record / list", async () => {
  const registry = await KnownNodesRegistry.load(await newDataDir());
  const first = entry("a");
  const second = entry("b", { source: "udp", host: "192.168.1.21" });

  await registry.record(first);
  await registry.record(second);
  expect(registry.list()).toEqual([first, second]);
});

test("a nameless entry round-trips (static nodes have no name)", async () => {
  const dir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dir);
  const node = entry("c", { source: "static" });
  delete (node as Partial<KnownNode>).name;
  await registry.record(node);

  const reloaded = await KnownNodesRegistry.load(dir);
  expect(reloaded.list()).toEqual([node]);
  expect(reloaded.list()[0]?.name).toBeUndefined();
});

test("entries persist across instances", async () => {
  const dir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dir);
  const node = entry("d", { source: "udp" });
  await registry.record(node);

  const reloaded = await KnownNodesRegistry.load(dir);
  expect(reloaded.list()).toEqual([node]);
});

test("recording the same deviceId again replaces the entry", async () => {
  const registry = await KnownNodesRegistry.load(await newDataDir());
  await registry.record(entry("a", { host: "192.168.1.20" }));
  await registry.record(
    entry("a", {
      host: "192.168.1.99",
      lastSeenAt: "2026-07-06T13:00:00.000Z",
    }),
  );
  expect(registry.list()).toEqual([
    entry("a", {
      host: "192.168.1.99",
      lastSeenAt: "2026-07-06T13:00:00.000Z",
    }),
  ]);
});

test("atomic write leaves no temp file behind", async () => {
  const dir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dir);
  await registry.record(entry("e"));
  await registry.record(entry("f"));
  expect(await readdir(dir)).toEqual(["known-nodes.json"]);
});

test("rejects entries that do not validate", async () => {
  const registry = await KnownNodesRegistry.load(await newDataDir());
  await expect(
    registry.record(entry("a", { deviceId: "not-a-fingerprint" })),
  ).rejects.toThrow();
  await expect(registry.record(entry("a", { port: 0 }))).rejects.toThrow();
  await expect(
    registry.record(entry("a", { lastSeenAt: "yesterday" })),
  ).rejects.toThrow();
  expect(registry.list()).toEqual([]);
});

test("a corrupt known-nodes file throws on load", async () => {
  const dir = await newDataDir();
  await writeFile(path.join(dir, "known-nodes.json"), "{oops", "utf8");
  await expect(KnownNodesRegistry.load(dir)).rejects.toThrow(
    /Corrupt known-nodes registry/,
  );
});

test("a structurally invalid known-nodes file throws on load", async () => {
  const dir = await newDataDir();
  await writeFile(
    path.join(dir, "known-nodes.json"),
    JSON.stringify([{ deviceId: "nope" }]),
    "utf8",
  );
  await expect(KnownNodesRegistry.load(dir)).rejects.toThrow(
    /Corrupt known-nodes registry/,
  );
});

test("a non-ENOENT read failure throws instead of yielding an empty registry", async () => {
  const dir = await newDataDir();
  // A directory where the file should be makes readFile fail with a
  // non-ENOENT error (EISDIR/EPERM depending on platform). Failing open
  // would let the next record() silently wipe every known node.
  await mkdir(path.join(dir, "known-nodes.json"));
  await expect(KnownNodesRegistry.load(dir)).rejects.toThrow(
    /Failed to read known-nodes registry/,
  );
});

test("concurrent unawaited records serialize into a consistent file", async () => {
  const dir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dir);
  const alpha = entry("a");
  const bravo = entry("b");
  const carol = entry("c");
  const updatedAlpha = entry("a", {
    host: "192.168.1.50",
    lastSeenAt: "2026-07-06T14:00:00.000Z",
  });

  // Fire mutations without awaiting between them: persists must chain, not
  // interleave temp-file writes and renames.
  await Promise.all([
    registry.record(alpha),
    registry.record(bravo),
    registry.record(carol),
    registry.record(updatedAlpha),
  ]);

  expect(await readdir(dir)).toEqual(["known-nodes.json"]);
  const reloaded = await KnownNodesRegistry.load(dir);
  expect(new Map(reloaded.list().map((node) => [node.deviceId, node]))).toEqual(
    new Map([
      [updatedAlpha.deviceId, updatedAlpha],
      [bravo.deviceId, bravo],
      [carol.deviceId, carol],
    ]),
  );
});
