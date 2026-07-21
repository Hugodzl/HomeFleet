import type { DiscoveryAnnouncement } from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { DiscoveryConfigSchema } from "../config/config.js";
import {
  FakeMdnsBackend,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import {
  DiscoveryAggregator,
  LAST_SEEN_PERSIST_THRESHOLD_MS,
} from "./aggregator.js";
import type { DiscoveryCandidate } from "./candidate.js";
import { KnownNodesRegistry, MAX_KNOWN_NODES } from "./known-nodes.js";

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
    protocolVersion: "0.3.0",
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
  registry: KnownNodesRegistry;
  seen: DiscoveryCandidate[];
  errors: unknown[];
  diagnostics: string[];
  dataDir: string;
}

async function startAggregator(
  options: {
    configOverrides?: Record<string, unknown>;
    dataDir?: string;
    registry?: KnownNodesRegistry;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const dataDir = options.dataDir ?? (await newDataDir());
  const backend = new FakeMdnsBackend();
  const registry = options.registry ?? (await KnownNodesRegistry.load(dataDir));
  const seen: DiscoveryCandidate[] = [];
  const errors: unknown[] = [];
  const diagnostics: string[] = [];
  const aggregator = new DiscoveryAggregator({
    config: config(options.configOverrides),
    announcement: announcement(deviceIdA),
    knownNodes: registry,
    onCandidate: (candidate) => seen.push(candidate),
    onError: (error) => errors.push(error),
    onDiagnostic: (message) => diagnostics.push(message),
    now: options.now ?? (() => T0),
    mdnsBackend: backend,
  });
  await aggregator.start();
  cleanups.push(() => aggregator.stop());
  return { aggregator, backend, registry, seen, errors, diagnostics, dataDir };
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
    txt: { id: deviceId, pv: "0.3.0" },
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
  // In the past relative to the harness clock (T0), so it is not clamped.
  const storedAt = new Date(T0 - 86_400_000).toISOString();
  await registry.record({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.50",
    port: 47400,
    lastSeenAt: storedAt,
    source: "udp",
  });

  const { aggregator } = await startAggregator({ dataDir });
  expect(aggregator.candidates()).toContainEqual({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.50",
    port: 47400,
    source: "udp",
    lastSeenAt: T0 - 86_400_000,
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

test("stop during a pending start tears down the UDP channel", async () => {
  const dataDir = await newDataDir();
  const aggregator = new DiscoveryAggregator({
    config: config({
      mdnsEnabled: false,
      udpEnabled: true,
      udpPort: 0,
      bindAddress: "127.0.0.1",
      announceIntervalMs: 20,
    }),
    announcement: announcement(deviceIdA),
    knownNodes: await KnownNodesRegistry.load(dataDir),
    udpSendTarget: { address: "127.0.0.1", port: 9 },
  });
  cleanups.push(() => aggregator.stop());

  // stop() races the UDP bind that start() is awaiting. A leaked socket or
  // re-announce timer here would hang vitest at exit.
  const startPromise = aggregator.start();
  const stopPromise = aggregator.stop();
  await Promise.all([startPromise, stopPromise]);

  expect(aggregator.udpBoundPort).toBeNull();
});

test("udp socket errors reach the aggregator's onError", async () => {
  const dataDir = await newDataDir();
  const errors: unknown[] = [];
  const aggregator = new DiscoveryAggregator({
    config: config({
      mdnsEnabled: false,
      udpEnabled: true,
      udpPort: 0,
      bindAddress: "127.0.0.1",
    }),
    announcement: announcement(deviceIdA),
    knownNodes: await KnownNodesRegistry.load(dataDir),
    onError: (error) => errors.push(error),
    udpSendTarget: { address: "127.0.0.1", port: 9 },
  });
  await aggregator.start();
  cleanups.push(() => aggregator.stop());

  // No deterministic cross-platform way to force an async dgram error;
  // emit on the real socket to exercise the real wiring (see udp.test.ts).
  const internals = aggregator as unknown as {
    udp: { socket: { emit(event: string, error: Error): void } };
  };
  internals.udp.socket.emit("error", new Error("boom"));

  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("boom");
});

test("mdns rename diagnostics surface through the aggregator's onDiagnostic", async () => {
  const { backend, diagnostics } = await startAggregator();

  // A peer under our own name ("tower") with a smaller deviceId: our mDNS
  // channel loses the tie-break and renames. The diagnostic must ride the
  // aggregator's onDiagnostic — the channel has no other outlet.
  backend.deliver({
    type: "homefleet",
    name: "tower",
    port: 47113,
    txt: { id: "00".repeat(32), pv: "0.3.0" },
    addresses: ["192.168.1.30"],
  });

  // Threading is this test's subject, not prose: the exact wording is
  // mdns.test.ts's deliverable, so assert only that the rename surfaced.
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('renamed to "tower (2)"');
});

test("dedup: a stale identified sighting does not drop a fresh anonymous entry", async () => {
  let nowValue = T0;
  const { aggregator, backend } = await startAggregator({
    now: () => nowValue,
    configOverrides: {
      staticNodes: [{ host: "192.168.1.30", port: 47200 }],
    },
  });

  // B is known at another endpoint, fresher than everything below.
  nowValue = T0 + 10_000;
  deliverPeer(backend, deviceIdB, {
    port: 47201,
    addresses: ["192.168.1.31"],
  });

  // A stale B sighting claims the anonymous endpoint: it must change
  // nothing — neither B's entry nor the anonymous one.
  nowValue = T0;
  deliverPeer(backend, deviceIdB, {
    port: 47200,
    addresses: ["192.168.1.30"],
  });

  const candidates = aggregator.candidates();
  expect(candidates).toContainEqual({
    host: "192.168.1.30",
    port: 47200,
    source: "static",
    lastSeenAt: T0,
  });
  expect(candidates.find((c) => c.deviceId === deviceIdB)?.port).toBe(47201);
});

test("registry timestamps from the future are clamped to now", async () => {
  const dataDir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dataDir);
  // E.g. the wall clock rolled back between runs. Unclamped, this entry
  // would outrank every live sighting for a day.
  await registry.record({
    deviceId: deviceIdB,
    name: "laptop",
    host: "192.168.1.50",
    port: 47400,
    lastSeenAt: new Date(T0 + 86_400_000).toISOString(),
    source: "mdns",
  });

  const { aggregator, backend } = await startAggregator({ dataDir });
  expect(
    aggregator.candidates().find((c) => c.deviceId === deviceIdB)?.lastSeenAt,
  ).toBe(T0);

  // A live sighting at T0 now wins (ties go to the newer sighting).
  deliverPeer(backend, deviceIdB, { name: "laptop", port: 47401 });
  expect(
    aggregator.candidates().find((c) => c.deviceId === deviceIdB)?.port,
  ).toBe(47401);
});

test("the candidate map is capped, evicting the oldest sighting", async () => {
  let nowValue = T0;
  const { aggregator, backend } = await startAggregator({
    now: () => nowValue,
  });

  const total = MAX_KNOWN_NODES + 5;
  for (let i = 0; i < total; i += 1) {
    nowValue = T0 + i * 1_000;
    deliverPeer(backend, i.toString(16).padStart(64, "0"), {
      name: "flood",
    });
  }

  const candidates = aggregator.candidates();
  expect(candidates).toHaveLength(MAX_KNOWN_NODES);
  const ids = new Set(candidates.map((c) => c.deviceId));
  // The 5 oldest sightings were evicted; the newest survive.
  for (let i = 0; i < 5; i += 1) {
    expect(ids.has(i.toString(16).padStart(64, "0"))).toBe(false);
  }
  expect(ids.has((total - 1).toString(16).padStart(64, "0"))).toBe(true);
});

test("repeated sightings inside the persist threshold write once", async () => {
  let nowValue = T0;
  const harness = await startAggregator({ now: () => nowValue });
  const recordSpy = vi.spyOn(harness.registry, "record");
  // Records run on the persist chain, behind earlier (real) file writes —
  // positive count transitions need waitFor; the skip path is synchronous,
  // so a short settle suffices before asserting nothing new was queued.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  deliverPeer(harness.backend, deviceIdB);
  await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(1));

  // Re-sightings of the same stable node within the threshold: no writes.
  for (let second = 1; second <= 10; second += 1) {
    nowValue = T0 + second * 1_000;
    deliverPeer(harness.backend, deviceIdB);
  }
  await settle();
  expect(recordSpy).toHaveBeenCalledTimes(1);

  // Past the threshold, lastSeenAt is worth persisting again.
  nowValue = T0 + LAST_SEEN_PERSIST_THRESHOLD_MS + 1_000;
  deliverPeer(harness.backend, deviceIdB);
  await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(2));

  // A change to any other field persists immediately, threshold or not.
  nowValue += 1_000;
  deliverPeer(harness.backend, deviceIdB, { port: 47999 });
  await vi.waitFor(() => expect(recordSpy).toHaveBeenCalledTimes(3));
  await settle();
  expect(recordSpy).toHaveBeenCalledTimes(3);
});

test("a failing registry persist reaches onError and later writes still land", async () => {
  const dataDir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dataDir);
  vi.spyOn(registry, "record").mockRejectedValueOnce(new Error("disk full"));

  const harness = await startAggregator({ dataDir, registry });
  deliverPeer(harness.backend, deviceIdB); // this persist fails
  deliverPeer(harness.backend, deviceIdC, { port: 47201 }); // this one lands
  await harness.aggregator.stop();

  expect(harness.errors).toHaveLength(1);
  expect((harness.errors[0] as Error).message).toBe("disk full");
  const reloaded = await KnownNodesRegistry.load(dataDir);
  expect(reloaded.list().map((n) => n.deviceId)).toEqual([deviceIdC]);
});
