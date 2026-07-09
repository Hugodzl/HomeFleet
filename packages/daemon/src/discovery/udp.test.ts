import { createSocket, type Socket } from "node:dgram";
import { once } from "node:events";
import {
  DISCOVERY_MAX_DATAGRAM_BYTES,
  type DiscoveryAnnouncement,
  type DiscoveryDatagram,
} from "@homefleet/protocol";
import { afterEach, expect, test, vi } from "vitest";
import type { DiscoveryCandidate } from "./candidate.js";
import { UdpDiscovery } from "./udp.js";

const deviceIdA = "aa".repeat(32);
const deviceIdB = "bb".repeat(32);

/**
 * Generous timeout for assertions that wait on real UDP socket delivery or
 * interval re-announces. These tests assert protocol BEHAVIOR, not latency;
 * vi.waitFor's 1s default is too tight when the event loop is starved by the
 * parallel test suite (the source of prior flakes), so we give delivery real
 * headroom without depending on any particular timing.
 */
const DELIVERY_TIMEOUT_MS = 5_000;

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

interface Instance {
  discovery: UdpDiscovery;
  candidates: DiscoveryCandidate[];
  port: number;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * Starts an instance bound to 127.0.0.1 on an ephemeral port. Tests use
 * unicast between instances (the send target is injectable); actual
 * multicast delivery is unreliable on loopback/CI and is never depended on.
 */
function newInstance(
  own: DiscoveryAnnouncement,
  options: {
    sendTarget?: { address: string; port: number };
    announceIntervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): { discovery: UdpDiscovery; candidates: DiscoveryCandidate[] } {
  const candidates: DiscoveryCandidate[] = [];
  const discovery = new UdpDiscovery({
    announcement: own,
    onCandidate: (candidate) => candidates.push(candidate),
    udpPort: 0,
    multicastGroup: "239.255.42.98",
    announceIntervalMs: options.announceIntervalMs ?? 60_000,
    bindAddress: "127.0.0.1",
    sendTarget: options.sendTarget ?? { address: "127.0.0.1", port: 9 },
    onError: options.onError,
  });
  cleanups.push(() => discovery.stop());
  return { discovery, candidates };
}

async function startInstance(
  own: DiscoveryAnnouncement,
  options: {
    sendTarget?: { address: string; port: number };
    announceIntervalMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): Promise<Instance> {
  const { discovery, candidates } = newInstance(own, options);
  const { port } = await discovery.start();
  return { discovery, candidates, port };
}

/** A plain socket standing in for a remote peer. */
async function rawPeer(): Promise<{
  socket: Socket;
  port: number;
  received: Buffer[];
}> {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const received: Buffer[] = [];
  socket.on("message", (message) => received.push(message));
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => socket.close(() => resolve())),
  );
  return { socket, port: socket.address().port, received };
}

function send(socket: Socket, port: number, payload: Buffer | string): void {
  const buffer = typeof payload === "string" ? Buffer.from(payload) : payload;
  socket.send(buffer, port, "127.0.0.1");
}

test("announce -> response: both sides learn each other", async () => {
  const a = await startInstance(announcement(deviceIdA));
  // B announces to A (unicast, injected target).
  const b = await startInstance(
    announcement(deviceIdB, { name: "laptop", port: 47999 }),
    { sendTarget: { address: "127.0.0.1", port: a.port } },
  );

  // A hears B's announce...
  await vi.waitFor(() => {
    expect(a.candidates).toContainEqual({
      deviceId: deviceIdB,
      name: "laptop",
      host: "127.0.0.1",
      port: 47999,
      source: "udp",
      lastSeenAt: expect.any(Number),
    });
  }, DELIVERY_TIMEOUT_MS);
  // ...and B hears A's response.
  await vi.waitFor(() => {
    expect(b.candidates).toContainEqual({
      deviceId: deviceIdA,
      name: "tower",
      host: "127.0.0.1",
      port: 47113,
      source: "udp",
      lastSeenAt: expect.any(Number),
    });
  }, DELIVERY_TIMEOUT_MS);
});

test("replies to an announce with a response, unicast to the sender", async () => {
  const a = await startInstance(announcement(deviceIdA));
  const peer = await rawPeer();

  const datagram: DiscoveryDatagram = {
    ...announcement(deviceIdB),
    kind: "announce",
  };
  send(peer.socket, a.port, JSON.stringify(datagram));

  await vi.waitFor(() => {
    expect(peer.received).toHaveLength(1);
  }, DELIVERY_TIMEOUT_MS);
  const reply = JSON.parse((peer.received[0] ?? Buffer.of()).toString("utf8"));
  expect(reply).toEqual({
    kind: "response",
    deviceId: deviceIdA,
    name: "tower",
    port: 47113,
    protocolVersion: "0.1.0",
  });
});

test("never replies to a response (reply-storm guard)", async () => {
  const a = await startInstance(announcement(deviceIdA));
  const peer = await rawPeer();

  const datagram: DiscoveryDatagram = {
    ...announcement(deviceIdB),
    kind: "response",
  };
  send(peer.socket, a.port, JSON.stringify(datagram));

  // The response itself still surfaces B as a candidate...
  await vi.waitFor(() => {
    expect(a.candidates.some((c) => c.deviceId === deviceIdB)).toBe(true);
  }, DELIVERY_TIMEOUT_MS);
  // ...but no datagram goes back to the sender.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(peer.received).toEqual([]);
});

test("ignores its own announcements (multicast echo)", async () => {
  const a = await startInstance(announcement(deviceIdA));
  const peer = await rawPeer();

  const echo: DiscoveryDatagram = {
    ...announcement(deviceIdA),
    kind: "announce",
  };
  send(peer.socket, a.port, JSON.stringify(echo));

  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(a.candidates).toEqual([]);
  expect(peer.received).toEqual([]);
});

test("drops garbage, schema-invalid, and oversized datagrams silently", async () => {
  const a = await startInstance(announcement(deviceIdA));
  const peer = await rawPeer();

  // Garbage bytes.
  send(peer.socket, a.port, Buffer.from([0xff, 0x00, 0x13, 0x37]));
  // Valid JSON that fails the schema.
  send(peer.socket, a.port, JSON.stringify({ kind: "announce", port: 1 }));
  send(
    peer.socket,
    a.port,
    JSON.stringify({ ...announcement("nope".repeat(16)), kind: "announce" }),
  );
  // A valid announce padded past the size cap: JSON.parse would accept the
  // trailing whitespace, so only the size check can reject it.
  const oversized = JSON.stringify({
    ...announcement(deviceIdB),
    kind: "announce",
  }).padEnd(DISCOVERY_MAX_DATAGRAM_BYTES + 1, " ");
  send(peer.socket, a.port, oversized);

  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(a.candidates).toEqual([]);
  expect(peer.received).toEqual([]);

  // The socket is still alive: a valid announce still gets through.
  send(
    peer.socket,
    a.port,
    JSON.stringify({ ...announcement(deviceIdB), kind: "announce" }),
  );
  await vi.waitFor(() => {
    expect(a.candidates.some((c) => c.deviceId === deviceIdB)).toBe(true);
  }, DELIVERY_TIMEOUT_MS);
});

test("re-announces on the configured interval", async () => {
  const peer = await rawPeer();
  await startInstance(announcement(deviceIdA), {
    sendTarget: { address: "127.0.0.1", port: peer.port },
    announceIntervalMs: 40,
  });

  // Startup announce plus at least two interval re-announces.
  await vi.waitFor(() => {
    expect(peer.received.length).toBeGreaterThanOrEqual(3);
  }, DELIVERY_TIMEOUT_MS);
  for (const message of peer.received) {
    expect(JSON.parse(message.toString("utf8")).kind).toBe("announce");
  }
});

test("stop closes the socket and halts re-announcing", async () => {
  const peer = await rawPeer();
  const a = await startInstance(announcement(deviceIdA), {
    sendTarget: { address: "127.0.0.1", port: peer.port },
    announceIntervalMs: 30,
  });
  await vi.waitFor(() => {
    expect(peer.received.length).toBeGreaterThanOrEqual(1);
  }, DELIVERY_TIMEOUT_MS);

  await a.discovery.stop();
  const seen = peer.received.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(peer.received.length).toBe(seen);

  // Idempotent.
  await a.discovery.stop();
});

test("cannot be started twice", async () => {
  const a = await startInstance(announcement(deviceIdA));
  await expect(a.discovery.start()).rejects.toThrow(/already started/);
});

test("stop during a pending start leaves no socket or timer behind", async () => {
  const peer = await rawPeer();
  const { discovery } = newInstance(announcement(deviceIdA), {
    sendTarget: { address: "127.0.0.1", port: peer.port },
    announceIntervalMs: 20,
  });

  // stop() races the bind that start() is awaiting.
  const startPromise = discovery.start();
  const stopPromise = discovery.stop();
  const [{ port }] = await Promise.all([startPromise, stopPromise]);

  // The socket is fully closed: the port rebinds without reuseAddr.
  const probe = createSocket({ type: "udp4" });
  probe.bind(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  // Nothing was announced and no re-announce timer survived.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(peer.received).toEqual([]);

  // The raced instance stays stopped for good.
  await expect(discovery.start()).rejects.toThrow(/cannot be restarted/);
});

test("post-bind socket errors reach onError", async () => {
  const errors: unknown[] = [];
  const a = await startInstance(announcement(deviceIdA), {
    onError: (error) => errors.push(error),
  });

  // There is no deterministic cross-platform way to force an async dgram
  // error (the production case is Windows surfacing ECONNRESET for an
  // unreachable send target), so emit on the real socket to exercise the
  // real listener wiring.
  const socket = (a.discovery as unknown as { socket: Socket }).socket;
  socket.emit("error", new Error("boom"));

  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("boom");
});
