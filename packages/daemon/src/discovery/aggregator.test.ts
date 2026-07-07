import type { DiscoveryAnnouncement } from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { DiscoveryConfigSchema } from "../config/config.js";
import {
  FakeMdnsBackend,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import { DiscoveryAggregator } from "./aggregator.js";
import type { DiscoveryCandidate } from "./candidate.js";
import { KnownNodesRegistry } from "./known-nodes.js";

const deviceIdA = "aa".repeat(32);
const deviceIdB = "bb".repeat(32);
const deviceIdC = "cc".repeat(32);

const T0 = 1_751_800_000_000;

function announcement(
  deviceId: string,
  overrides: Partial<DiscoveryAnnouncement> = {},
): DiscoveryAnnouncement {
  return {
    deviceId,
    name: "tower",
    port: 47113,
    protocolVersion: "0.1.0",
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return DiscoveryConfigSchema.parse({
    mdnsEnabled: true,
    udpEnabled: false,
    ...overrides,
  });
}

const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

async function newDataDir(): Promise<string> {
  const dir = await makeTempDataDir("homefleet-agg-");
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

interface Harness {
  aggregator: DiscoveryAggregator;
  backend: FakeMdnsBackend;
  seen: DiscoveryCandidate[];
  dataDir: string;
}

async function startAggregator(
  options: {
    configOverrides?: Record<string, unknown>;
    dataDir?: string;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const dataDir = options.dataDir ?? (await newDataDir());
  const backend = new FakeMdnsBackend();
  const seen: DiscoveryCandidate[] = [];
  const aggregator = new DiscoveryAggregator({
    config: config(options.configOverrides),
    announcement: announcement(deviceIdA),
    knownNodes: await KnownNodesRegistry.load(dataDir),
    onCandidate: (candidate) => seen.push(candidate),
    now: options.now ?? (() => T0),
    mdnsBackend: backend,
  });
  await aggregator.start();
  cleanups.push(() => aggregator.stop());
  return { aggregator, backend, seen, dataDir };
}

function deliverPeer(
  backend: FakeMdnsBackend,
  deviceId: string,
  overrides: Partial<{ name: string; port: number; addresses: string[] }> = {},
): void {
  backend.deliver({
    type: "homefleet",
    name: overrides.name ?? "peer",
    port: overrides.port ?? 47200,
    txt: { id: deviceId, pv: "0.1.0" },
    addresses: overrides.addresses ?? ["192.168.1.30"],
  });
}

test("static entries are surfaced as candidates at startup", async () => {
  const { aggregator } = await startAggregator({
    configOverrides: {
      staticNodes: [
        { host: "192.168.1.40", port: 47300, expectedDeviceId: deviceIdB },
        { host: "nas.local", port: 47301 },
      ],
    },
  });
  expect(aggregator.candidates()).toEqual(
    expect.arrayContaining([
      {
        deviceId: deviceIdB,
        host: "192.168.1.40",
        port: 47300,
        source: "static",
        lastSeenAt: T0,
      },
      { host: "nas.local", port: 47301, source: "static", lastSeenAt: T0 },
    ]),
  );
});

test("known nodes are surfaced at startup, source preserved", async () => {
  const dataDir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dataDir);
  await registry.record({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.50",
    port: 47400,
    lastSeenAt: "2026-07-05T12:00:00.000Z",
    source: "udp",
  });

  const { aggregator } = await startAggregator({ dataDir });
  expect(aggregator.candidates()).toContainEqual({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.50",
    port: 47400,
    source: "udp",
    lastSeenAt: Date.parse("2026-07-05T12:00:00.000Z"),
  });
});

test("mdns candidates merge in and reach subscribers", async () => {
  const { aggregator, backend, seen } = await startAggregator();
  deliverPeer(backend, deviceIdB, { name: "laptop" });

  const expected = {
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.30",
    port: 47200,
    source: "mdns",
    lastSeenAt: T0,
  };
  expect(aggregator.candidates()).toContainEqual(expected);
  expect(seen).toContainEqual(expected);
});

test("dedup: a deviceId sighting absorbs the anonymous host:port entry", async () => {
  const { aggregator, backend } = await startAggregator({
    configOverrides: {
      staticNodes: [{ host: "192.168.1.30", port: 47200 }],
    },
  });
  expect(aggregator.candidates()).toHaveLength(1);

  // The same endpoint shows up over mDNS, now with a deviceId.
  deliverPeer(backend, deviceIdB, {
    name: "laptop",
    addresses: ["192.168.1.30"],
  });

  expect(aggregator.candidates()).toEqual([
    {
      deviceId: deviceIdB,
      name: "laptop",
      host: "192.168.1.30",
      port: 47200,
      source: "mdns",
      lastSeenAt: T0,
    },
  ]);
});

test("dedup: an anonymous sighting never shadows an identified entry", async () => {
  const dataDir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dataDir);
  await registry.record({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.30",
    port: 47200,
    lastSeenAt: "2026-07-05T12:00:00.000Z",
    source: "mdns",
  });

  // A static entry for the same endpoint, without expectedDeviceId.
  const { aggregator } = await startAggregator({
    dataDir,
    configOverrides: {
      staticNodes: [{ host: "192.168.1.30", port: 47200 }],
    },
  });

  const matches = aggregator
    .candidates()
    .filter((c) => c.host === "192.168.1.30" && c.port === 47200);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.deviceId).toBe(deviceIdB);
});

test("dedup: the latest sighting wins; stale sightings are ignored", async () => {
  let nowValue = T0;
  const { aggregator, backend } = await startAggregator({
    now: () => nowValue,
  });

  deliverPeer(backend, deviceIdB, { name: "laptop", port: 47200 });
  nowValue = T0 + 5_000;
  deliverPeer(backend, deviceIdB, {
    name: "laptop",
    port: 47201,
    addresses: ["192.168.1.31"],
  });

  expect(aggregator.candidates()).toEqual([
    {
      deviceId: deviceIdB,
      name: "laptop",
      host: "192.168.1.31",
      port: 47201,
      source: "mdns",
      lastSeenAt: T0 + 5_000,
    },
  ]);

  // A sighting older than what we already hold changes nothing.
  nowValue = T0 - 60_000;
  deliverPeer(backend, deviceIdB, { name: "laptop", port: 47200 });
  expect(aggregator.candidates()[0]?.port).toBe(47201);
});

test("candidates with a deviceId are recorded in the known-nodes registry", async () => {
  const { aggregator, backend, dataDir } = await startAggregator({
    configOverrides: {
      staticNodes: [
        { host: "192.168.1.40", port: 47300, expectedDeviceId: deviceIdC },
      ],
    },
  });
  deliverPeer(backend, deviceIdB, { name: "laptop" });
  await aggregator.stop();

  const reloaded = await KnownNodesRegistry.load(dataDir);
  expect(new Map(reloaded.list().map((n) => [n.deviceId, n]))).toEqual(
    new Map([
      [
        deviceIdB,
        {
          deviceId: deviceIdB,
          name: "laptop",
          host: "192.168.1.30",
          port: 47200,
          lastSeenAt: new Date(T0).toISOString(),
          source: "mdns",
        },
      ],
      [
        deviceIdC,
        {
          deviceId: deviceIdC,
          host: "192.168.1.40",
          port: 47300,
          lastSeenAt: new Date(T0).toISOString(),
          source: "static",
        },
      ],
    ]),
  );
});

test("stop tears down the mdns backend and is idempotent", async () => {
  const { aggregator, backend } = await startAggregator();
  await aggregator.stop();
  expect(backend.destroyed).toBe(true);
  expect(backend.browsers.every((browser) => browser.stopped)).toBe(true);
  expect(backend.activePublications()).toEqual([]);
  await aggregator.stop();
});

test("disabled channels are not started", async () => {
  const { backend } = await startAggregator({
    configOverrides: { mdnsEnabled: false, udpEnabled: false },
  });
  expect(backend.publications).toEqual([]);
  expect(backend.browsers).toEqual([]);
});

test("two aggregators discover each other over UDP and persist the sighting", async () => {
  const dirA = await newDataDir();
  const dirB = await newDataDir();
  const seenA: DiscoveryCandidate[] = [];
  const seenB: DiscoveryCandidate[] = [];

  const aggregatorA = new DiscoveryAggregator({
    config: config({
      mdnsEnabled: false,
      udpEnabled: true,
      udpPort: 0,
      bindAddress: "127.0.0.1",
    }),
    announcement: announcement(deviceIdA),
    knownNodes: await KnownNodesRegistry.load(dirA),
    onCandidate: (candidate) => seenA.push(candidate),
    // A's own startup announce goes to the discard port; it learns B from
    // B's announce and B learns A from A's unicast response.
    udpSendTarget: { address: "127.0.0.1", port: 9 },
  });
  await aggregatorA.start();
  cleanups.push(() => aggregatorA.stop());
  const portA = aggregatorA.udpBoundPort;
  expect(portA).not.toBeNull();

  const aggregatorB = new DiscoveryAggregator({
    config: config({
      mdnsEnabled: false,
      udpEnabled: true,
      udpPort: 0,
      bindAddress: "127.0.0.1",
    }),
    announcement: announcement(deviceIdB, { name: "laptop", port: 47999 }),
    knownNodes: await KnownNodesRegistry.load(dirB),
    onCandidate: (candidate) => seenB.push(candidate),
    udpSendTarget: { address: "127.0.0.1", port: portA ?? 0 },
  });
  await aggregatorB.start();
  cleanups.push(() => aggregatorB.stop());

  await vi.waitFor(() => {
    expect(seenA.some((c) => c.deviceId === deviceIdB)).toBe(true);
    expect(seenB.some((c) => c.deviceId === deviceIdA)).toBe(true);
  });

  await aggregatorA.stop();
  const reloaded = await KnownNodesRegistry.load(dirA);
  expect(reloaded.list().map((n) => n.deviceId)).toEqual([deviceIdB]);
});

test("cannot be restarted after stop", async () => {
  const { aggregator } = await startAggregator();
  await aggregator.stop();
  await expect(aggregator.start()).rejects.toThrow(/restarted/);
});
