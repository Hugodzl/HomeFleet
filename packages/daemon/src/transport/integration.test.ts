/**
 * Loopback integration tests: two full daemon stacks (identity, trust
 * store, pairing, server, client) on 127.0.0.1 ephemeral ports.
 */
import { once } from "node:events";
import { createServer, request as httpsRequest } from "node:https";
import {
  type AddressInfo,
  connect as netConnect,
  createServer as netCreateServer,
  type Socket,
} from "node:net";
import { HelloResponseSchema, type NodeInfo } from "@homefleet/protocol";
import { afterEach, expect, test } from "vitest";
import { resolveDataDir } from "../config/paths.js";
import { type Identity, loadOrCreateIdentity } from "../identity/identity.js";
import { PairingManager } from "../pairing/pairing.js";
import {
  makeNodeInfo,
  makeTempDataDir,
  removeTempDataDir,
} from "../test-fixtures.js";
import { TrustStore } from "../trust/trust-store.js";
import {
  FingerprintMismatchError,
  HfpClient,
  HfpRequestError,
  HfpTimeoutError,
} from "./client.js";
import { MAX_BODY_BYTES } from "./limits.js";
import { NodeServer } from "./server.js";

const HOST = "127.0.0.1";

interface Daemon {
  name: string;
  identity: Identity;
  trustStore: TrustStore;
  pairing: PairingManager;
  server: NodeServer;
  client: HfpClient;
  port: number;
  nodeInfo: () => NodeInfo;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createDaemon(name: string): Promise<Daemon> {
  const tempDir = await makeTempDataDir(`homefleet-it-${name}-`);
  // Resolve through the env override, HOMEFLEET_DATA_DIR-style.
  const dataDir = resolveDataDir({ HOMEFLEET_DATA_DIR: tempDir });
  const identity = await loadOrCreateIdentity(dataDir);
  const trustStore = await TrustStore.load(dataDir);
  const nodeInfo = (): NodeInfo => makeNodeInfo(identity.deviceId, name);
  const pairing = new PairingManager({
    trustStore,
    nodeInfoProvider: nodeInfo,
  });
  const server = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: pairing,
    host: HOST,
    port: 0,
  });
  const { port } = await server.start();
  cleanups.push(async () => {
    await server.stop();
    await removeTempDataDir(tempDir);
  });
  return {
    name,
    identity,
    trustStore,
    pairing,
    server,
    client: new HfpClient(identity),
    port,
    nodeInfo,
  };
}

/** Bare https request, bypassing HfpClient (for no-cert / raw-body cases). */
function rawRequest(options: {
  port: number;
  path: string;
  body: string;
  key?: string;
  cert?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: HOST,
        port: options.port,
        method: "POST",
        path: options.path,
        rejectUnauthorized: false,
        key: options.key,
        cert: options.cert,
        agent: false,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

test("full pairing handshake, then hello succeeds in both directions", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  // The user starts pairing on B and types B's code into A.
  const { code } = b.pairing.beginPairing();
  const { response, serverDeviceId } = await a.client.pair(
    { host: HOST, port: b.port },
    code,
    a.nodeInfo(),
  );

  expect(response.accepted).toBe(true);
  expect(serverDeviceId).toBe(b.identity.deviceId);
  expect(response.nodeInfo?.deviceId).toBe(b.identity.deviceId);
  expect(response.nodeInfo?.name).toBe("bravo");

  // B trusted A as a side effect of accepting.
  expect(b.trustStore.has(a.identity.deviceId)).toBe(true);

  // A records B's observed identity.
  await a.trustStore.add({
    deviceId: serverDeviceId,
    name: response.nodeInfo?.name ?? "unknown",
    addedAt: new Date().toISOString(),
  });

  // A -> B hello.
  const helloAtoB = await a.client.hello(
    { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId },
    a.nodeInfo(),
  );
  expect(helloAtoB.nodeInfo.deviceId).toBe(b.identity.deviceId);
  expect(helloAtoB.nodeInfo.name).toBe("bravo");

  // B -> A hello.
  const helloBtoA = await b.client.hello(
    { host: HOST, port: a.port, expectedDeviceId: a.identity.deviceId },
    b.nodeInfo(),
  );
  expect(helloBtoA.nodeInfo.deviceId).toBe(a.identity.deviceId);
  expect(helloBtoA.nodeInfo.name).toBe("alpha");
});

test("unpaired hello is rejected with 401 UNAUTHORIZED", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  const error = await a.client
    .hello(
      { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId },
      a.nodeInfo(),
    )
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );

  expect(error).toBeInstanceOf(HfpRequestError);
  const requestError = error as HfpRequestError;
  expect(requestError.status).toBe(401);
  expect(requestError.hfpError?.code).toBe("UNAUTHORIZED");
});

test("a wrong pairing code is rejected and trust stores stay empty", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  const { code } = b.pairing.beginPairing();
  const wrong = code === "ABCDEFGH" ? "ABCDEFGJ" : "ABCDEFGH";

  const { response } = await a.client.pair(
    { host: HOST, port: b.port },
    wrong,
    a.nodeInfo(),
  );
  expect(response).toEqual({ accepted: false });
  expect(a.trustStore.list()).toEqual([]);
  expect(b.trustStore.list()).toEqual([]);
});

test("the client severs the connection before sending when the server fingerprint mismatches", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  // A raw server with B's identity that counts every HTTP request it sees.
  let requestsSeen = 0;
  const rawServer = createServer(
    {
      key: b.identity.keyPem,
      cert: b.identity.certPem,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (_req, res) => {
      requestsSeen += 1;
      res.end("{}");
    },
  );
  await new Promise<void>((resolve) => rawServer.listen(0, HOST, resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      rawServer.close((err) => (err ? reject(err) : resolve()));
      rawServer.closeAllConnections();
    });
  });
  const { port } = rawServer.address() as AddressInfo;

  // Expect A's own device ID from a server that presents B's certificate.
  const error = await a.client
    .request({
      host: HOST,
      port,
      expectedDeviceId: a.identity.deviceId,
      method: "POST",
      path: "/hello",
      body: { nodeInfo: a.nodeInfo() },
      responseSchema: HelloResponseSchema,
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );

  expect(error).toBeInstanceOf(FingerprintMismatchError);
  const mismatch = error as FingerprintMismatchError;
  expect(mismatch.expectedDeviceId).toBe(a.identity.deviceId);
  expect(mismatch.actualDeviceId).toBe(b.identity.deviceId);
  // The TLS handshake completed, but not a single HTTP request went out.
  expect(requestsSeen).toBe(0);
});

test("requests without a client certificate get 401 on paired routes", async () => {
  const b = await createDaemon("bravo");

  const hello = await rawRequest({
    port: b.port,
    path: "/hfp/v0/hello",
    body: JSON.stringify({ nodeInfo: makeNodeInfo("ab".repeat(32), "ghost") }),
  });
  expect(hello.status).toBe(401);
  expect(JSON.parse(hello.body)).toMatchObject({ code: "UNAUTHORIZED" });

  // Even the unpaired-ok pair route refuses peers with no identity.
  b.pairing.beginPairing();
  const pair = await rawRequest({
    port: b.port,
    path: "/hfp/v0/pair",
    body: JSON.stringify({
      code: "ABCDEFGH",
      nodeInfo: makeNodeInfo("ab".repeat(32), "ghost"),
    }),
  });
  expect(pair.status).toBe(401);
  expect(JSON.parse(pair.body)).toMatchObject({ code: "UNAUTHORIZED" });
  expect(b.trustStore.list()).toEqual([]);
});

test("malformed JSON is rejected with 400 INVALID_REQUEST", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  const response = await rawRequest({
    port: b.port,
    path: "/hfp/v0/pair",
    body: "{this is not json",
    key: a.identity.keyPem,
    cert: a.identity.certPem,
  });
  expect(response.status).toBe(400);
  expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_REQUEST" });
});

test("unknown endpoints: 404 for paired peers, 401 for unpaired peers", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  // Unpaired peers must not be able to map the route table: unknown paths
  // look exactly like paired routes (401).
  const probed = await rawRequest({
    port: b.port,
    path: "/hfp/v0/definitely-not-a-route",
    body: "{}",
    key: a.identity.keyPem,
    cert: a.identity.certPem,
  });
  expect(probed.status).toBe(401);
  expect(JSON.parse(probed.body)).toMatchObject({ code: "UNAUTHORIZED" });

  // Paired peers get an honest 404.
  await b.trustStore.add({
    deviceId: a.identity.deviceId,
    name: "alpha",
    addedAt: new Date().toISOString(),
  });
  const paired = await rawRequest({
    port: b.port,
    path: "/hfp/v0/definitely-not-a-route",
    body: "{}",
    key: a.identity.keyPem,
    cert: a.identity.certPem,
  });
  expect(paired.status).toBe(404);
  expect(JSON.parse(paired.body)).toMatchObject({ code: "INVALID_REQUEST" });
});

test("start() on an occupied port throws without wedging the instance", async () => {
  const a = await createDaemon("alpha");

  // A second server configured for A's (occupied) port.
  const tempDir = await makeTempDataDir("homefleet-it-clash-");
  const identity = await loadOrCreateIdentity(tempDir);
  const trustStore = await TrustStore.load(tempDir);
  const nodeInfo = (): NodeInfo => makeNodeInfo(identity.deviceId, "clash");
  const clashing = new NodeServer({
    identity,
    trustStore,
    nodeInfoProvider: nodeInfo,
    pairingManager: new PairingManager({
      trustStore,
      nodeInfoProvider: nodeInfo,
    }),
    host: HOST,
    port: a.port,
  });
  cleanups.push(async () => {
    await clashing.stop();
    await removeTempDataDir(tempDir);
  });

  await expect(clashing.start()).rejects.toThrow(/EADDRINUSE/);
  // The failed start must not wedge the instance: stop() is a no-op ...
  await expect(clashing.stop()).resolves.toBeUndefined();
  // ... and once the port frees up, the same instance starts cleanly.
  await a.server.stop();
  const { port } = await clashing.start();
  expect(port).toBe(a.port);
  await clashing.stop();
});

test("raw TLS garbage on the port does not kill the daemon", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");
  await b.trustStore.add({
    deviceId: a.identity.deviceId,
    name: "alpha",
    addedAt: new Date().toISOString(),
  });

  // Throw non-TLS bytes at the HTTPS port; the server's default
  // tlsClientError handling must drop the connection, nothing more.
  // (The string is long enough that its would-be TLS record length exceeds
  // the maximum, so OpenSSL errors immediately instead of waiting for a
  // full record. resume() consumes the server's TLS alert so 'close' can
  // fire on this paused socket.)
  const socket = netConnect(b.port, HOST);
  socket.on("error", () => {});
  socket.resume();
  await once(socket, "connect");
  socket.write("THIS IS NOT A TLS HANDSHAKE\r\n\r\n");
  await once(socket, "close");

  // The daemon is still alive and serving.
  const hello = await a.client.hello(
    { host: HOST, port: b.port, expectedDeviceId: b.identity.deviceId },
    a.nodeInfo(),
  );
  expect(hello.nodeInfo.deviceId).toBe(b.identity.deviceId);
});

test("two concurrent correct-code pair requests: exactly one is accepted", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");
  const c = await createDaemon("charlie");

  const { code } = b.pairing.beginPairing();
  const [first, second] = await Promise.all([
    a.client.pair({ host: HOST, port: b.port }, code, a.nodeInfo()),
    c.client.pair({ host: HOST, port: b.port }, code, c.nodeInfo()),
  ]);

  // The code is consumed synchronously on the first match, so exactly one
  // of the two concurrent requests can win — never both.
  const accepted = [first.response.accepted, second.response.accepted].filter(
    (wasAccepted) => wasAccepted,
  );
  expect(accepted).toHaveLength(1);
  expect(b.trustStore.list()).toHaveLength(1);
  const winner = first.response.accepted ? a : c;
  expect(b.trustStore.has(winner.identity.deviceId)).toBe(true);
});

test("oversized request bodies are rejected with 413", async () => {
  const a = await createDaemon("alpha");
  const b = await createDaemon("bravo");

  const response = await rawRequest({
    port: b.port,
    path: "/hfp/v0/pair",
    body: "x".repeat(MAX_BODY_BYTES + 1024),
    key: a.identity.keyPem,
    cert: a.identity.certPem,
  });
  expect(response.status).toBe(413);
  expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_REQUEST" });
});

test("the client times out against a server that accepts TCP but never responds", async () => {
  const a = await createDaemon("alpha");

  // Accepts the TCP connection and then does nothing: no TLS handshake, no
  // response, ever.
  const openSockets: Socket[] = [];
  const stalledServer = netCreateServer((socket) => {
    openSockets.push(socket);
  });
  await new Promise<void>((resolve) => stalledServer.listen(0, HOST, resolve));
  cleanups.push(async () => {
    for (const socket of openSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      stalledServer.close(() => resolve());
    });
  });
  const { port } = stalledServer.address() as AddressInfo;

  const error = await a.client
    .request({
      host: HOST,
      port,
      expectedDeviceId: a.identity.deviceId,
      method: "POST",
      path: "/hello",
      body: { nodeInfo: a.nodeInfo() },
      responseSchema: HelloResponseSchema,
      timeoutMs: 250,
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );

  expect(error).toBeInstanceOf(HfpTimeoutError);
  const timeout = error as HfpTimeoutError;
  expect(timeout.timeoutMs).toBe(250);
  expect(timeout.port).toBe(port);
});
