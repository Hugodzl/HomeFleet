/**
 * The MCP front's HTTP transport: a Node HTTP server bound to loopback only,
 * fronting the Streamable HTTP transport in STATELESS mode with DNS-rebinding
 * protection.
 *
 * Security boundary (load-bearing — this is what keeps a browser or any other
 * origin from driving the daemon):
 * - Binds to 127.0.0.1 only; a non-loopback host is rejected outright (never
 *   0.0.0.0).
 * - Enables the SDK's DNS-rebinding protection with an allow-list of the bound
 *   loopback Host/Origin values, so a request whose Host points off-localhost,
 *   or whose Origin is a foreign site, is rejected with 403 before it reaches
 *   any tool. The allow-lists are built SYNCHRONOUSLY inside the `listen`
 *   callback (before the server can accept a request) and a defensive guard
 *   refuses any request that would otherwise be served with an empty
 *   allow-list — so the boundary fails CLOSED, by construction, not by
 *   incidental event-loop ordering.
 * - Bounds the request body at {@link MAX_MCP_REQUEST_BYTES}, mirroring the
 *   HFP node server's MAX_BODY_BYTES discipline: the body is read (and JSON
 *   parsed) HERE with a hard cap and handed to the SDK as a pre-parsed body,
 *   so neither an honest oversize content-length nor a lying/absent one (a
 *   chunked flood) can balloon daemon memory.
 *
 * Statelessness: each request gets a fresh `McpServer` + fresh
 * `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, torn down
 * when the response closes — the SDK's documented stateless pattern, which also
 * guarantees no session state leaks between requests and no handles are held
 * between them.
 *
 * NOTE: the SDK marks `allowedHosts` / `allowedOrigins` /
 * `enableDnsRebindingProtection` as `@deprecated` in favour of external
 * middleware, but they remain the transport's built-in, functional mechanism in
 * v1.29.x and are exactly what this daemon needs; we use them deliberately.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Hosts the MCP front is allowed to bind to — loopback only. Exported so the
 * daemon config can validate `mcp.host` / `control.host` against the same
 * set at PARSE time (fail early with a config error, not at bind time).
 */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Hard cap on an MCP request body. Mirrors the HFP transport's MAX_BODY_BYTES
 * rationale: legitimate MCP tool calls are tiny (a recon prompt is capped at
 * 16 KiB), so 1 MiB is very generous while still bounding a buggy or runaway
 * local agent — the daemon's front door must not be able to balloon memory.
 */
export const MAX_MCP_REQUEST_BYTES = 1_048_576;

export interface McpHttpServerOptions {
  /** Builds a fresh MCP server per request (stateless isolation). */
  createServer: () => McpServer;
  /** Loopback host to bind; defaults to `127.0.0.1`. Non-loopback is rejected. */
  host?: string;
  /** Port to bind; `0` (the default) picks an ephemeral port (tests). */
  port?: number;
  /** Extra allowed Host header values (beyond the bound loopback host:port). */
  allowedHosts?: string[];
  /** Extra allowed Origin header values (beyond the bound loopback origins). */
  allowedOrigins?: string[];
}

export interface RunningMcpHttpServer {
  /** The actually-bound port. */
  port: number;
  /** The bound (loopback) host. */
  host: string;
  /** The effective Host allow-list (populated before the first request). */
  readonly allowedHosts: readonly string[];
  /** The effective Origin allow-list (populated before the first request). */
  readonly allowedOrigins: readonly string[];
  /** Stops the server and tears down every open transport (no leaked handles). */
  close(): Promise<void>;
}

/** Writes a tiny JSON-RPC-style error response (headers-safe). */
function respondError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

type BodyRead =
  | { status: "ok"; body: unknown }
  | { status: "too_large" }
  | { status: "invalid" };

/**
 * Reads and JSON-parses a POST body with a hard byte cap. The content-length
 * fast path rejects before reading; the streaming counter catches a lying or
 * absent content-length (chunked flood). We are the SOLE consumer of the
 * stream — the parsed value is handed to the SDK via `handleRequest`'s
 * `parsedBody`, so the SDK never re-reads it.
 */
async function readCappedJsonBody(req: IncomingMessage): Promise<BodyRead> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    return { status: "too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_MCP_REQUEST_BYTES) {
        return { status: "too_large" };
      }
      chunks.push(buffer);
    }
  } catch {
    // Client aborted or the stream errored mid-read.
    return { status: "invalid" };
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") {
    return { status: "invalid" };
  }
  try {
    return { status: "ok", body: JSON.parse(text) };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Starts the MCP HTTP front. Resolves once bound; the returned handle exposes
 * the bound port, the effective allow-lists, and a clean `close()`.
 */
export async function startMcpHttpServer(
  options: McpHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `MCP HTTP transport refuses to bind to non-loopback host "${host}"; ` +
        "the MCP front must never leave localhost (bind 127.0.0.1).",
    );
  }

  // Built synchronously in the listen callback (below) before any request can
  // be accepted. The request handler additionally refuses to serve while these
  // are empty, so the security boundary fails CLOSED even if that ordering is
  // ever broken.
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];
  const openTransports = new Set<StreamableHTTPServerTransport>();

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Fail CLOSED: never serve a request against an empty allow-list (which the
    // SDK would treat as "validation disabled"). By construction the lists are
    // populated before listen resolves; this is the defensive backstop.
    if (allowedHosts.length === 0 || allowedOrigins.length === 0) {
      respondError(res, 503, -32000, "server not ready");
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
    });
    const mcp = options.createServer();
    openTransports.add(transport);
    const cleanup = (): void => {
      if (!openTransports.has(transport)) {
        return;
      }
      openTransports.delete(transport);
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    };
    res.on("close", cleanup);
    try {
      // Bound the body ourselves and hand the SDK a pre-parsed value, so it
      // never reads an uncapped stream. GET/DELETE carry no body.
      let parsedBody: unknown;
      if (req.method === "POST") {
        const read = await readCappedJsonBody(req);
        if (read.status === "too_large") {
          respondError(
            res,
            413,
            -32000,
            `request body exceeds the ${MAX_MCP_REQUEST_BYTES}-byte limit`,
          );
          cleanup();
          return;
        }
        if (read.status === "invalid") {
          respondError(res, 400, -32700, "Parse error: invalid JSON body");
          cleanup();
          return;
        }
        parsedBody = read.body;
      }
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
      cleanup();
    }
  }

  let boundPort = 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("MCP HTTP server bound to a non-TCP address"));
        return;
      }
      boundPort = address.port;
      // Populate the allow-lists synchronously, before resolve(), so a request
      // can never be serviced with an empty (fail-open) allow-list.
      allowedHosts = [
        ...new Set([
          `${host}:${boundPort}`,
          `127.0.0.1:${boundPort}`,
          `localhost:${boundPort}`,
          `[::1]:${boundPort}`,
          ...(options.allowedHosts ?? []),
        ]),
      ];
      allowedOrigins = [
        ...new Set([
          `http://127.0.0.1:${boundPort}`,
          `http://localhost:${boundPort}`,
          `http://[::1]:${boundPort}`,
          ...(options.allowedOrigins ?? []),
        ]),
      ];
      resolve();
    });
  });
  // Post-listen async errors must not crash the process.
  httpServer.on("error", () => {});

  return {
    port: boundPort,
    host,
    get allowedHosts() {
      return allowedHosts;
    },
    get allowedOrigins() {
      return allowedOrigins;
    },
    async close(): Promise<void> {
      for (const transport of openTransports) {
        await transport.close().catch(() => {});
      }
      openTransports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      });
    },
  };
}
