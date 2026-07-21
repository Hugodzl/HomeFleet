/**
 * Control API security + behavior tests. Drives the REAL HTTP server
 * (ephemeral port) against a FAKE {@link ControlSurface} — the point of this
 * suite is the HTTP surface (routing, auth headers, body caps, status
 * codes), not any real pairing/trust/directory logic (those are covered
 * where they live: pairing.test.ts, trust-store.test.ts, node-directory.test.ts).
 */
import { type IncomingMessage, request } from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  CONTROL_HEADER,
  type ControlServerOptions,
  type ControlStatus,
  type ControlSurface,
  MAX_CONTROL_REQUEST_BYTES,
  type PairConnectSummary,
  type RunningControlServer,
  startControlServer,
} from "./control-server.js";

const running: RunningControlServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

const FAKE_DEVICE_ID = "a".repeat(64);
const FAKE_PEER_DEVICE_ID = "b".repeat(64);

/** A fully-functional fake surface; individual fields are overridden per test. */
function fakeSurface(overrides: Partial<ControlSurface> = {}): ControlSurface {
  const status: ControlStatus = {
    deviceId: FAKE_DEVICE_ID,
    name: "test-node",
    platform: "linux",
    daemonVersion: "0.1.0",
    protocolVersion: "0.3.0",
    hfpPort: 11111,
    mcpPort: 22222,
    controlPort: 33333,
    roles: ["execution"],
    executors: ["command"],
    models: [],
    activeJobs: 0,
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

interface RawResponse {
  status: number;
  json: unknown;
}

/**
 * Sends a raw HTTP request with full control over headers/body/host header.
 *
 * `options.headers` values can be `undefined` to DELETE a default header
 * (e.g. `{ [CONTROL_HEADER]: undefined }` sends the request with that
 * header truly absent, not merely overridden to an empty value) — plain
 * object spread can only override a key, never remove it.
 */
function send(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string | undefined>;
    body?: Buffer | string;
    hostHeader?: string;
  },
): Promise<RawResponse> {
  const body =
    options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, "utf8");
  const mergedHeaders: Record<string, string | undefined> = {
    host: options.hostHeader ?? `127.0.0.1:${port}`,
    [CONTROL_HEADER]: "1",
    ...(body !== undefined
      ? {
          "content-type": "application/json",
          "content-length": String(body.length),
        }
      : {}),
    ...options.headers,
  };
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(mergedHeaders).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        agent: false, // fresh socket per request (no keep-alive interference)
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<RawResponse> {
  return send(port, {
    method: "POST",
    path,
    body: JSON.stringify(body),
    ...(headers !== undefined ? { headers } : {}),
  });
}

test("refuses to bind to a non-loopback host", async () => {
  await expect(
    startControlServer({ surface: fakeSurface(), host: "0.0.0.0" }),
  ).rejects.toThrow(/loopback|localhost/i);
});

test("binds to 127.0.0.1 on an ephemeral port", async () => {
  const server = await start();
  expect(server.host).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);
});

test("POST /control/pair/begin returns a code", async () => {
  const server = await start();
  const res = await postJson(server.port, "/control/pair/begin", {});
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ code: "ABCDEFGH" });
});

test("POST /control/pair/connect on success adds to trust and returns the summary", async () => {
  let addedInput: unknown;
  const server = await start({
    surface: fakeSurface({
      pairWith: async (input) => {
        addedInput = input;
        return {
          accepted: true,
          deviceId: FAKE_PEER_DEVICE_ID,
          name: "peer-node",
        };
      },
    }),
  });
  const res = await postJson(server.port, "/control/pair/connect", {
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    accepted: true,
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer-node",
  });
  expect(addedInput).toEqual({
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
  });
});

test("POST /control/pair/connect on a rejected code returns 200 with accepted:false (not an error)", async () => {
  const server = await start({
    surface: fakeSurface({
      pairWith: async () => ({ accepted: false }),
    }),
  });
  const res = await postJson(server.port, "/control/pair/connect", {
    host: "192.168.1.50",
    port: 56370,
    code: "WRONGCOD",
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ accepted: false });
});

test("POST /control/pair/connect on a transport failure returns a clean JSON error, never a stack", async () => {
  class FakeHfpRequestError extends Error {
    status = 400;
  }
  const server = await start({
    surface: fakeSurface({
      pairWith: async () => {
        throw new FakeHfpRequestError("peer refused the connection");
      },
    }),
  });
  const res = await postJson(server.port, "/control/pair/connect", {
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
  });
  expect(res.status).toBe(400);
  expect(res.json).toEqual({ error: "peer refused the connection" });
});

test("POST /control/pair/connect on an unreachable peer (no .status) returns 502, never a stack", async () => {
  const server = await start({
    surface: fakeSurface({
      pairWith: async () => {
        throw new Error("connect ECONNREFUSED 192.168.1.50:56370");
      },
    }),
  });
  const res = await postJson(server.port, "/control/pair/connect", {
    host: "192.168.1.50",
    port: 56370,
    code: "ABCDEFGH",
  });
  expect(res.status).toBe(502);
  expect(res.json).toEqual({
    error: "connect ECONNREFUSED 192.168.1.50:56370",
  });
});

test("POST /control/pair/connect rejects a malformed body with 400", async () => {
  const server = await start();
  const res = await postJson(server.port, "/control/pair/connect", {
    host: "192.168.1.50",
    // port missing entirely -> schema validation failure
    code: "ABCDEFGH",
  });
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ error: expect.any(String) });
});

test("POST /control/pair/connect rejects syntactically-invalid JSON with 400 (not 500)", async () => {
  const server = await start();
  // A genuinely truncated body — sent via `send()`, not `postJson()`, so
  // `JSON.stringify` can't "fix" it into valid JSON. This exercises the
  // `JSON.parse` try/catch (distinct from the schema-validation 400 above);
  // if that catch were ever dropped, this would regress to a 500.
  const res = await send(server.port, {
    method: "POST",
    path: "/control/pair/connect",
    body: '{"host":"1.2.3.4"',
  });
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ error: expect.stringContaining("JSON") });
});

test("POST /control/pair/connect with an empty body is treated as {} and fails schema validation with 400", async () => {
  const server = await start();
  // No body at all (not even an empty JSON object) — exercises the
  // `read.text.trim() === "" ? {} : JSON.parse(read.text)` branch that
  // guards against `JSON.parse("")` throwing.
  const res = await send(server.port, {
    method: "POST",
    path: "/control/pair/connect",
  });
  expect(res.status).toBe(400);
  expect(res.json).toMatchObject({ error: expect.any(String) });
});

test("GET /control/status returns the live status shape", async () => {
  const server = await start();
  const res = await send(server.port, {
    method: "GET",
    path: "/control/status",
  });
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({
    deviceId: FAKE_DEVICE_ID,
    name: "test-node",
    platform: "linux",
    hfpPort: 11111,
    mcpPort: 22222,
    controlPort: 33333,
  });
});

test("GET /control/nodes returns the node directory list", async () => {
  const entry = {
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer",
    reachable: false,
  };
  const server = await start({
    surface: fakeSurface({ listNodes: async () => [entry] }),
  });
  const res = await send(server.port, {
    method: "GET",
    path: "/control/nodes",
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ nodes: [entry] });
});

test("empty control header value is rejected with 403", async () => {
  const server = await start();
  const res = await send(server.port, {
    method: "GET",
    path: "/control/status",
    headers: { [CONTROL_HEADER]: "" },
  });
  expect(res.status).toBe(403);
});

test("control header entirely absent (not just empty) is rejected with 403", async () => {
  const server = await start();
  const res = await send(server.port, {
    method: "GET",
    path: "/control/status",
    headers: { [CONTROL_HEADER]: undefined },
  });
  expect(res.status).toBe(403);
});

test("a non-loopback Host header is rejected with 403 (DNS-rebinding defense)", async () => {
  const server = await start();
  const res = await send(server.port, {
    method: "GET",
    path: "/control/status",
    hostHeader: `attacker.example.com:${server.port}`,
  });
  expect(res.status).toBe(403);
});

test("an unknown route returns 404", async () => {
  const server = await start();
  const res = await send(server.port, { method: "GET", path: "/control/nope" });
  expect(res.status).toBe(404);
});

test("a known path with the wrong HTTP method returns 404, not dispatched", async () => {
  const server = await start();
  // Pins down that method is part of the route match, not just the path —
  // if a route conditional ever dropped its method check, this would
  // regress from 404 to a dispatched (200) response.
  const wrongMethodOnKnownPath = await send(server.port, {
    method: "GET",
    path: "/control/pair/begin",
  });
  expect(wrongMethodOnKnownPath.status).toBe(404);

  const deleteOnStatus = await send(server.port, {
    method: "DELETE",
    path: "/control/status",
  });
  expect(deleteOnStatus.status).toBe(404);
});

test("an oversized body is rejected with 413, server stays up", async () => {
  const server = await start();
  const oversized = Buffer.alloc(MAX_CONTROL_REQUEST_BYTES + 1024, 0x20);
  const res = await send(server.port, {
    method: "POST",
    path: "/control/pair/connect",
    body: oversized,
  });
  expect(res.status).toBe(413);

  // The server survived and still serves a normal request.
  const ok = await send(server.port, {
    method: "GET",
    path: "/control/status",
  });
  expect(ok.status).toBe(200);
});

/**
 * Sends a POST with NO `Content-Length` header at all, writing the body in
 * multiple chunks — Node's http client automatically switches to
 * `Transfer-Encoding: chunked` whenever a body is written without a declared
 * length. This is what actually exercises `readCappedBody`'s streaming
 * byte-counting loop (as opposed to its up-front declared-length fast path),
 * i.e. the path that guards against a lying/absent Content-Length.
 */
function sendChunked(
  port: number,
  path: string,
  chunks: Buffer[],
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        agent: false,
        headers: {
          host: `127.0.0.1:${port}`,
          [CONTROL_HEADER]: "1",
          "content-type": "application/json",
          // Deliberately no content-length: forces chunked framing.
        },
      },
      (res: IncomingMessage) => {
        const buffers: Buffer[] = [];
        res.on("data", (chunk: Buffer) => buffers.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(buffers).toString("utf8");
          let json: unknown = null;
          try {
            json = text === "" ? null : JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(chunk);
    }
    req.end();
  });
}

test("a chunked oversized body (no Content-Length) is rejected with 413, server stays up", async () => {
  const server = await start();
  // Each chunk is under the cap on its own; only the running total exceeds
  // it, so this can only be caught by the streaming byte-counting loop, not
  // the up-front declared-Content-Length fast path (there is no declared
  // length here at all).
  const chunkSize = 8192;
  const chunkCount = Math.ceil(MAX_CONTROL_REQUEST_BYTES / chunkSize) + 2;
  const chunks = Array.from({ length: chunkCount }, () =>
    Buffer.alloc(chunkSize, 0x20),
  );
  const res = await sendChunked(server.port, "/control/pair/connect", chunks);
  expect(res.status).toBe(413);

  // The server survived and still serves a normal request.
  const ok = await send(server.port, {
    method: "GET",
    path: "/control/status",
  });
  expect(ok.status).toBe(200);
});

test("close() is clean and idempotent-safe across restarts", async () => {
  const first = await start();
  await first.close();
  running.splice(running.indexOf(first), 1);
  const second = await start();
  expect(second.port).toBeGreaterThan(0);
});
