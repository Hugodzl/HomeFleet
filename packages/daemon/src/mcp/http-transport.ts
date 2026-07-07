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
 *   any tool.
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

/** Hosts the MCP front is allowed to bind to — loopback only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
  /** Stops the server and tears down every open transport (no leaked handles). */
  close(): Promise<void>;
}

/**
 * Starts the MCP HTTP front. Resolves once bound; the returned handle exposes
 * the bound port and a clean `close()`.
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

  // Populated after listen (needs the bound port); the request handler closes
  // over these and only runs after listen has resolved.
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
      void transport.close();
      void mcp.close();
    };
    res.on("close", cleanup);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
      cleanup();
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  // Post-listen async errors must not crash the process.
  httpServer.on("error", () => {});

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("MCP HTTP server bound to a non-TCP address");
  }
  const boundPort = address.port;

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

  return {
    port: boundPort,
    host,
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
