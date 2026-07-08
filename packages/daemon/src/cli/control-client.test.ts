/**
 * INTEGRATION test: exercises the REAL {@link ControlClient} over real HTTP
 * against a REAL {@link startControlServer} (ephemeral loopback port), backed
 * by a fake {@link ControlSurface}. Unlike control-server.test.ts (which
 * drives raw HTTP to pin down the server's wire behavior), this suite proves
 * the CLIENT's half of the contract: it builds well-formed requests
 * (including the required CSRF header — if it didn't, every call below would
 * 403 and fail) and correctly decodes real responses.
 */
import { afterEach, expect, test } from "vitest";
import {
  type ControlServerOptions,
  type ControlStatus,
  type ControlSurface,
  type PairConnectSummary,
  type RunningControlServer,
  startControlServer,
} from "../control/control-server.js";
import {
  ControlClient,
  ControlRequestError,
  DaemonUnreachableError,
} from "./control-client.js";

const running: RunningControlServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

const FAKE_DEVICE_ID = "a".repeat(64);
const FAKE_PEER_DEVICE_ID = "b".repeat(64);

function fakeSurface(overrides: Partial<ControlSurface> = {}): ControlSurface {
  const status: ControlStatus = {
    deviceId: FAKE_DEVICE_ID,
    name: "test-node",
    platform: "linux",
    daemonVersion: "0.1.0",
    protocolVersion: "0.1.0",
    hfpPort: 11111,
    mcpPort: 22222,
    controlPort: 33333,
    roles: ["execution"],
    executors: ["command"],
    models: [{ id: "test-model" }],
    activeJobs: 1,
    maxConcurrentJobs: 4,
  };
  return {
    beginPairing: () => ({ code: "ABCDEFGH", expiresAt: Date.now() + 600_000 }),
    pairWith: async (): Promise<PairConnectSummary> => ({
      accepted: true,
      deviceId: FAKE_PEER_DEVICE_ID,
      name: "peer-node",
    }),
    status: () => status,
    listNodes: async () => [],
    ...overrides,
  };
}

async function start(
  extra: Partial<ControlServerOptions> = {},
): Promise<RunningControlServer> {
  const server = await startControlServer({
    surface: fakeSurface(),
    host: "127.0.0.1",
    port: 0,
    ...extra,
  });
  running.push(server);
  return server;
}

test("pairBegin() round-trips the code and expiry over real HTTP", async () => {
  const server = await start();
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const result = await client.pairBegin();
  expect(result.code).toBe("ABCDEFGH");
  expect(result.expiresAt).toBeGreaterThan(Date.now());
});

test("pairConnect() round-trips an accepted summary and sends the exact input", async () => {
  let received: unknown;
  const server = await start({
    surface: fakeSurface({
      pairWith: async (input) => {
        received = input;
        return { accepted: true, deviceId: FAKE_PEER_DEVICE_ID, name: "peer" };
      },
    }),
  });
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const result = await client.pairConnect({
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
    expectedDeviceId: FAKE_PEER_DEVICE_ID,
  });
  expect(result).toEqual({
    accepted: true,
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer",
  });
  expect(received).toEqual({
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
    expectedDeviceId: FAKE_PEER_DEVICE_ID,
  });
});

test("pairConnect() round-trips a rejected summary (accepted:false, not an error)", async () => {
  const server = await start({
    surface: fakeSurface({ pairWith: async () => ({ accepted: false }) }),
  });
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const result = await client.pairConnect({
    host: "192.168.1.50",
    port: 56370,
    code: "WRONGCOD",
  });
  expect(result).toEqual({ accepted: false });
});

test("status() round-trips the full status shape", async () => {
  const server = await start();
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const status = await client.status();
  expect(status).toEqual({
    deviceId: FAKE_DEVICE_ID,
    name: "test-node",
    platform: "linux",
    daemonVersion: "0.1.0",
    protocolVersion: "0.1.0",
    hfpPort: 11111,
    mcpPort: 22222,
    controlPort: 33333,
    roles: ["execution"],
    executors: ["command"],
    models: [{ id: "test-model" }],
    activeJobs: 1,
    maxConcurrentJobs: 4,
  });
});

test("nodes() round-trips the node directory list", async () => {
  const entry = {
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer",
    host: "192.168.1.51",
    port: 56370,
    reachable: true,
  };
  const server = await start({
    surface: fakeSurface({ listNodes: async () => [entry] }),
  });
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const nodes = await client.nodes();
  expect(nodes).toEqual([entry]);
});

test("nodes() round-trips an empty directory", async () => {
  const server = await start();
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  expect(await client.nodes()).toEqual([]);
});

test("a client pointed at a dead port throws DaemonUnreachableError, not a raw fetch error", async () => {
  // Bind, note the port, then close: nothing is listening there anymore, so a
  // connection attempt reliably gets ECONNREFUSED (as opposed to picking an
  // arbitrary fixed port that might be in use by something else in CI).
  const server = await start();
  const deadPort = server.port;
  await server.close();
  running.splice(running.indexOf(server), 1);

  const client = new ControlClient({ host: "127.0.0.1", port: deadPort });
  const error = await client.status().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DaemonUnreachableError);
  expect((error as DaemonUnreachableError).host).toBe("127.0.0.1");
  expect((error as DaemonUnreachableError).port).toBe(deadPort);
});

test("every request carries the CONTROL_HEADER (proven by success — the server 403s without it)", async () => {
  // control-server.test.ts pins down the 403-without-header behavior directly
  // against raw HTTP; this test pins down the CLIENT's half: every one of its
  // request-issuing methods must succeed against that same enforcement, which
  // is only possible if each one sets the header.
  const server = await start();
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  await expect(client.pairBegin()).resolves.toBeDefined();
  await expect(client.status()).resolves.toBeDefined();
  await expect(client.nodes()).resolves.toBeDefined();
  await expect(
    client.pairConnect({ host: "h", port: 1, code: "ABCDEFGH" }),
  ).resolves.toBeDefined();
});

test("a surface that throws during pairWith surfaces as a ControlRequestError with the daemon's status/message", async () => {
  const server = await start({
    surface: fakeSurface({
      pairWith: async () => {
        throw new Error("connect ECONNREFUSED 192.168.1.50:56370");
      },
    }),
  });
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const error = await client
    .pairConnect({ host: "192.168.1.50", port: 56370, code: "ABCDEFGH" })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ControlRequestError);
  expect((error as ControlRequestError).status).toBe(502);
  expect((error as ControlRequestError).message).toBe(
    "connect ECONNREFUSED 192.168.1.50:56370",
  );
});

test("a malformed status response (missing required field) throws a clean 'malformed' error, not a TypeError", async () => {
  const server = await start();
  // Point the client's injectable fetch at a fixed, deliberately-broken JSON
  // body — a real bad response the server itself would never send, but
  // exactly the shape validateControlStatus is responsible for rejecting.
  const client = new ControlClient({
    host: "127.0.0.1",
    port: server.port,
    fetch: async () =>
      new Response(JSON.stringify({ name: "test-node" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await expect(client.status()).rejects.toThrow(/malformed status response/);
});

test("a non-2xx response with no JSON body falls back to a generic status message", async () => {
  const server = await start();
  const client = new ControlClient({
    host: "127.0.0.1",
    port: server.port,
    fetch: async () => new Response("", { status: 500 }),
  });
  const error = await client.status().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ControlRequestError);
  expect((error as ControlRequestError).status).toBe(500);
  expect((error as ControlRequestError).message).toContain(
    "control API request failed with status 500",
  );
});

test("host literals containing ':' (e.g. an IPv6 '::1') are bracketed in the request URL", async () => {
  // A schema-valid control.host of "::1" (see ../config/config.ts's
  // LoopbackHostSchema) must not make the client build an unparsable URL
  // (see DaemonUnreachableError's doc: any throw from fetch() itself reads
  // as "daemon unreachable", which would be a false negative here).
  let requestedUrl: string | undefined;
  const client = new ControlClient({
    host: "::1",
    port: 56373,
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ nodes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await expect(client.nodes()).resolves.toEqual([]);
  expect(requestedUrl).toBe("http://[::1]:56373/control/nodes");
});
