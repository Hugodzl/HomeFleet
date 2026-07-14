/**
 * MCP HTTP front security + lifecycle tests. These use the REAL Streamable
 * HTTP transport (not the in-memory pair): the security boundary is only
 * meaningful over the wire.
 *
 * Covered: bind is 127.0.0.1 only; a non-loopback bind is refused; a request
 * with an off-localhost Host or a foreign Origin is rejected with 403 (DNS
 * rebinding protection); a legitimate localhost MCP client is accepted and can
 * call a tool; start/stop is clean (the suite exits with no hung handles).
 */
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { DelegationRegistry } from "./delegation-registry.js";
import {
  MAX_MCP_REQUEST_BYTES,
  type McpHttpServerOptions,
  type RunningMcpHttpServer,
  startMcpHttpServer,
} from "./http-transport.js";
import { createMcpServer } from "./server.js";

const running: RunningMcpHttpServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) {
    await server.close();
  }
});

/** An MCP server factory backed by an empty directory (no paired nodes). */
function emptyServerFactory(): McpHttpServerOptions["createServer"] {
  const delegations = new DelegationRegistry();
  return () =>
    createMcpServer({
      hfpClient: {
        delegate: async () => {
          throw new Error("unused");
        },
        jobSnapshot: async () => {
          throw new Error("unused");
        },
        cancelJob: async () => {
          throw new Error("unused");
        },
      },
      workspaceSync: {
        syncWorkspace: async () => {
          throw new Error("unused");
        },
      },
      repoResolver: { resolveRepoPath: () => undefined },
      nodeDirectory: { list: async () => [], resolve: () => undefined },
      delegations,
      applyArtifact: async () => {
        throw new Error("unused");
      },
    });
}

async function start(
  extra: Partial<McpHttpServerOptions> = {},
): Promise<RunningMcpHttpServer> {
  const server = await startMcpHttpServer({
    createServer: emptyServerFactory(),
    host: "127.0.0.1",
    port: 0,
    ...extra,
  });
  running.push(server);
  return server;
}

/** A raw POST with custom headers; resolves with the status code. */
function rawPost(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "0.0.0" },
    },
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        agent: false, // fresh socket per request (no keep-alive interference)
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * POST an arbitrary body. When `chunked`, no content-length is sent (forcing
 * chunked transfer-encoding) so the streaming byte guard — not the
 * content-length fast path — is exercised. Resolves with the status code, or
 * `"errored"` if the socket was torn down mid-send (also an acceptable
 * rejection of an oversized body).
 */
function rawPostBody(
  port: number,
  body: Buffer,
  options: { chunked?: boolean } = {},
): Promise<number | "errored"> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: `127.0.0.1:${port}`,
          ...(options.chunked ? {} : { "content-length": String(body.length) }),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", () => resolve("errored"));
    if (options.chunked) {
      // Write in slices with no content-length -> chunked encoding.
      const slice = 256 * 1024;
      for (let i = 0; i < body.length; i += slice) {
        req.write(body.subarray(i, i + slice));
      }
      req.end();
    } else {
      req.end(body);
    }
  });
}

test("refuses to bind to a non-loopback host", async () => {
  await expect(
    startMcpHttpServer({ createServer: emptyServerFactory(), host: "0.0.0.0" }),
  ).rejects.toThrow(/loopback|localhost/i);
});

test("binds to 127.0.0.1 on an ephemeral port", async () => {
  const server = await start();
  expect(server.host).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);
});

test("rejects a request with an off-localhost Host header (DNS rebinding)", async () => {
  const server = await start();
  const status = await rawPost(server.port, {
    host: `attacker.example.com:${server.port}`,
  });
  expect(status).toBe(403);
});

test("rejects a request with a foreign Origin header", async () => {
  const server = await start();
  const status = await rawPost(server.port, {
    host: `127.0.0.1:${server.port}`,
    origin: "http://evil.example.com",
  });
  expect(status).toBe(403);
});

test("accepts a legitimate localhost request (not blanket-denied)", async () => {
  const server = await start();
  const status = await rawPost(server.port, {
    host: `127.0.0.1:${server.port}`,
  });
  // Anything but 403 proves the allow-list is not rejecting valid localhost.
  expect(status).not.toBe(403);
  expect(status).toBe(200);
});

test("a real MCP client over HTTP can list tools and call list_nodes", async () => {
  const server = await start();
  const client = new Client({ name: "http-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
  );
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "cancel_job",
      "delegate_task",
      "job_result",
      "job_status",
      "list_nodes",
    ]);

    const result = await client.callTool({ name: "list_nodes", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ nodes: [] });
  } finally {
    await client.close();
    await transport.close();
  }
});

test("close() is clean and idempotent-safe across restarts", async () => {
  const first = await start();
  await first.close();
  running.splice(running.indexOf(first), 1);
  // A second server binds fine after the first closed (no leaked handle/port lock).
  const second = await start();
  expect(second.port).toBeGreaterThan(0);
});

test("allow-lists are populated (non-empty) once started (fail-closed by construction)", async () => {
  const server = await start();
  // An empty allow-list would fail OPEN (the SDK skips validation); a populated
  // one is what makes the 403 rejections above meaningful.
  expect(server.allowedHosts.length).toBeGreaterThan(0);
  expect(server.allowedOrigins.length).toBeGreaterThan(0);
  expect(server.allowedHosts).toContain(`127.0.0.1:${server.port}`);
  expect(server.allowedOrigins).toContain(`http://127.0.0.1:${server.port}`);
});

test("rejects an oversized body via an honest large content-length (413), stays up", async () => {
  const server = await start();
  const oversized = Buffer.alloc(MAX_MCP_REQUEST_BYTES + 1024, 0x20); // spaces
  const status = await rawPostBody(server.port, oversized);
  expect(status).toBe(413);

  // The daemon survived and still serves a normal request.
  const ok = await rawPost(server.port, { host: `127.0.0.1:${server.port}` });
  expect(ok).toBe(200);
});

test("rejects an oversized chunked body (no content-length can bypass the cap), stays up", async () => {
  const server = await start();
  const oversized = Buffer.alloc(MAX_MCP_REQUEST_BYTES + 512 * 1024, 0x20);
  const result = await rawPostBody(server.port, oversized, { chunked: true });
  // Either an explicit 413 or a torn socket is an acceptable rejection.
  expect(result === 413 || result === "errored").toBe(true);

  const ok = await rawPost(server.port, { host: `127.0.0.1:${server.port}` });
  expect(ok).toBe(200);
});

test("rejects a malformed JSON body with 400, stays up", async () => {
  const server = await start();
  const status = await rawPostBody(server.port, Buffer.from("{ not json "));
  expect(status).toBe(400);

  const ok = await rawPost(server.port, { host: `127.0.0.1:${server.port}` });
  expect(ok).toBe(200);
});
