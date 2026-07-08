import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_UDP_PORT,
} from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import {
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_CACHED_CHECKOUTS,
  DEFAULT_WORKSPACE_GC_AFTER_FETCHES,
  DEFAULT_WORKSPACE_GIT_TIMEOUT_MS,
  loadDaemonConfig,
} from "./config.js";

const tempDirs: string[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-config-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

async function writeConfig(dir: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, "config.json"), contents, "utf8");
}

test("a missing config file yields all defaults", async () => {
  const config = await loadDaemonConfig(await newDataDir());
  expect(config).toEqual({
    discovery: {
      mdnsEnabled: true,
      udpEnabled: true,
      udpPort: DISCOVERY_UDP_PORT,
      multicastGroup: DISCOVERY_MULTICAST_GROUP,
      announceIntervalMs: 60_000,
      staticNodes: [],
    },
    workspace: {
      allowedRepoIds: [],
      maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
      maxCachedCheckouts: DEFAULT_MAX_CACHED_CHECKOUTS,
      gcAfterFetches: DEFAULT_WORKSPACE_GC_AFTER_FETCHES,
      gitTimeoutMs: DEFAULT_WORKSPACE_GIT_TIMEOUT_MS,
    },
  });
  expect(config.discovery.bindAddress).toBeUndefined();
  // Empty allowlist by default => the worker accepts no repos (fail closed).
  expect(config.workspace.cacheDir).toBeUndefined();
});

test("workspace config: empty allowlist is the fail-closed default", async () => {
  const config = await loadDaemonConfig(await newDataDir());
  expect(config.workspace.allowedRepoIds).toEqual([]);
});

test("workspace config merges partial overrides with defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      workspace: {
        allowedRepoIds: ["homefleet", "my-repo"],
        maxCachedCheckouts: 4,
        cacheDir: "/srv/homefleet/ws",
      },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.workspace.allowedRepoIds).toEqual(["homefleet", "my-repo"]);
  expect(config.workspace.maxCachedCheckouts).toBe(4);
  expect(config.workspace.cacheDir).toBe("/srv/homefleet/ws");
  // Untouched fields keep their defaults.
  expect(config.workspace.maxBundleBytes).toBe(DEFAULT_MAX_BUNDLE_BYTES);
  expect(config.workspace.gitTimeoutMs).toBe(DEFAULT_WORKSPACE_GIT_TIMEOUT_MS);
});

test("a schema-invalid workspace config throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ workspace: { maxBundleBytes: "huge" } }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an empty JSON object yields all defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, "{}");
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.mdnsEnabled).toBe(true);
  expect(config.discovery.udpPort).toBe(DISCOVERY_UDP_PORT);
});

test("partial discovery config merges with defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: { udpEnabled: false, bindAddress: "192.168.1.10" },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.udpEnabled).toBe(false);
  expect(config.discovery.bindAddress).toBe("192.168.1.10");
  // Untouched fields keep their defaults.
  expect(config.discovery.mdnsEnabled).toBe(true);
  expect(config.discovery.multicastGroup).toBe(DISCOVERY_MULTICAST_GROUP);
  expect(config.discovery.announceIntervalMs).toBe(60_000);
});

test("static nodes round-trip, with and without expectedDeviceId", async () => {
  const dir = await newDataDir();
  const deviceId = "ab".repeat(32);
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: {
        staticNodes: [
          { host: "192.168.1.20", port: 47113, expectedDeviceId: deviceId },
          { host: "nas.local", port: 47113 },
        ],
      },
    }),
  );
  const config = await loadDaemonConfig(dir);
  expect(config.discovery.staticNodes).toEqual([
    { host: "192.168.1.20", port: 47113, expectedDeviceId: deviceId },
    { host: "nas.local", port: 47113 },
  ]);
});

test("a corrupt config file throws instead of falling back to defaults", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, "{oops");
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a schema-invalid config file throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({ discovery: { udpPort: "not-a-port" } }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an invalid static node deviceId throws", async () => {
  const dir = await newDataDir();
  await writeConfig(
    dir,
    JSON.stringify({
      discovery: {
        staticNodes: [{ host: "h", port: 1, expectedDeviceId: "nope" }],
      },
    }),
  );
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a non-ENOENT read failure throws instead of yielding defaults", async () => {
  const dir = await newDataDir();
  // A directory where the file should be makes readFile fail with a
  // non-ENOENT error (EISDIR/EPERM depending on platform). Falling back to
  // defaults here would silently re-enable channels the user disabled.
  await mkdir(path.join(dir, "config.json"));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(
    /Failed to read daemon config/,
  );
});
