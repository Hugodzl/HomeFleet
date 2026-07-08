/**
 * The daemon's CONTROL API (M9 Unit 7): a loopback HTTP server the
 * `homefleet` CLI uses to drive pairing, list nodes, and read status against
 * the RUNNING daemon.
 *
 * Why this exists: pairing is server-side state — the RESPONDER's live
 * `PairingManager` owns the currently-active pairing code, and the RUNNING
 * daemon's in-memory `TrustStore` is what accepts peer requests. A CLI that
 * only wrote the trust-store file on disk would be invisible to the running
 * daemon and could never open a real pairing window. `status`/`listNodes`
 * are routed through here for the same reason: they must reflect LIVE
 * daemon state (current job load, currently-discoverable peers), not a
 * snapshot the CLI reconstructs from files on disk.
 *
 * Security model (LOAD-BEARING — this is a mutating, network-unauthenticated
 * surface: `pair/begin` opens a pairing window and `pair/connect` can add a
 * trusted device to the live trust store):
 *
 * - Loopback-only bind, exactly like the MCP HTTP transport: a non-loopback
 *   `host` is refused at start time (never silently coerced to something
 *   else). Reuses {@link LOOPBACK_HOSTS} from ../mcp/http-transport.js so
 *   the two local fronts can never drift on what counts as "local".
 * - DNS-rebinding defense: every request's `Host` header must be one of the
 *   allowed loopback `host:port` aliases. A request that reached this
 *   process because a DNS name was rebound to resolve to 127.0.0.1 still
 *   carries the ATTACKER'S chosen Host header (browsers don't rewrite it),
 *   so checking Host — not just "which socket did this arrive on" — is what
 *   catches it. The allow-list is built synchronously in the `listen`
 *   callback, before any request can be accepted (see fail-closed
 *   readiness, below).
 * - Browser CSRF defense: EVERY route requires the custom request header
 *   `x-homefleet-control: 1` (see {@link CONTROL_HEADER}); a request missing
 *   it is rejected with 403 before any route logic runs. A plain HTML form
 *   or an `<img>`/`fetch()`-without-custom-headers cross-origin request from
 *   a malicious web page cannot set an arbitrary header, so it never
 *   satisfies this check. A `fetch()` call that DOES set the header
 *   triggers a CORS preflight (`OPTIONS`); this server returns no
 *   `Access-Control-Allow-*` headers on any response, so the browser blocks
 *   the real request before it is even sent. The CLI always sends this
 *   header — see the CLI's control-API client (Unit 8).
 * - Fail-closed readiness: mirrors the MCP front's "never serve before fully
 *   ready" guard — the Host allow-list starts empty and is populated
 *   synchronously right after `listen` succeeds; the request handler
 *   refuses to serve (503) while it is still empty, so the boundary fails
 *   CLOSED even if that ordering were ever broken by a future refactor.
 * - Small JSON body cap ({@link MAX_CONTROL_REQUEST_BYTES}): control bodies
 *   are tiny (a host, a port, an 8-char code), so this is very generous
 *   while still bounding a buggy or malicious sender.
 * - Handlers never leak stack traces: every error response is a plain
 *   `{ error: string }` object built from a caught error's `.message`
 *   (never the error object, never `.stack`).
 *
 * NOTE: local processes are trusted (same posture as the MCP front) — there
 * is no per-request auth token in v0. The defenses above are about the
 * NETWORK boundary (nothing off-loopback can reach this at all) and the
 * BROWSER boundary (no web page can drive it cross-origin); any other
 * process already running as the same OS user could reach this port
 * regardless of what token scheme we invented, so v0 does not pretend
 * otherwise — see ../mcp/http-transport.js for the identical stance.
 *
 * EXPLICIT SIGN-OFF for the trust-store-WRITE routes specifically (not
 * inherited by assumption from the MCP front's mostly-read rationale):
 * `pair/begin` opens a pairing window and `pair/connect` can make THIS
 * daemon perform an outbound TLS handshake against a caller-named
 * `host:port` and, on acceptance, write a new device into the LIVE
 * `TrustStore` (see `pairWithPeer` in ../daemon.js). `CONTROL_HEADER`'s
 * value is a compile-time constant, not a per-boot secret, so it stops a
 * browser (see above) but NOT a same-OS-user co-resident process, which can
 * read the constant from source and drive these routes itself. Accepted as
 * a deliberate v0 tradeoff: "same OS user" is the trust boundary for this
 * live-write surface too, same as every other local, same-user-trusted
 * front in this daemon (MCP, HFP loopback admin). If that boundary is ever
 * judged insufficient for this specific write path, the fix is a per-daemon
 * -instance random token (e.g. a 0600 file only the same user can read) in
 * place of the static header value — not a rewrite of the network/browser
 * defenses above, which hold independently.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ExecutorKind, ModelInfo, NodeRole } from "@homefleet/protocol";
import { LOOPBACK_HOSTS } from "../mcp/http-transport.js";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import {
  type PairConnectRequest,
  PairConnectRequestSchema,
} from "./messages.js";

/**
 * Hard cap on a control request body. Control bodies are tiny (host, port,
 * an 8-char pairing code) — 64 KiB is generous while still bounding a
 * runaway or malicious sender, mirroring the MAX_MCP_REQUEST_BYTES /
 * MAX_BODY_BYTES discipline used by the daemon's other local fronts.
 */
export const MAX_CONTROL_REQUEST_BYTES = 65_536;

/**
 * The CSRF defense header every route requires (see the module header).
 * Exported so the CLI's client and this server's tests share one constant.
 */
export const CONTROL_HEADER = "x-homefleet-control";

/** The live status snapshot returned by `GET /control/status`. */
export interface ControlStatus {
  deviceId: string;
  name: string;
  platform: "win32" | "linux" | "darwin";
  daemonVersion: string;
  protocolVersion: string;
  hfpPort: number;
  mcpPort: number;
  controlPort: number;
  roles: NodeRole[];
  executors: ExecutorKind[];
  models: ModelInfo[];
  activeJobs: number;
  maxConcurrentJobs: number;
}

/** The outcome of an outbound pairing attempt, as `pair/connect` reports it. */
export interface PairConnectSummary {
  accepted: boolean;
  /** Present only when `accepted` is true. */
  deviceId?: string;
  /** Present only when `accepted` is true. */
  name?: string;
}

/**
 * The daemon-side operations the control API fronts. Injected (built by the
 * `Daemon` assembly, closing over its live collaborators) so this module has
 * no direct dependency on `PairingManager`/`HfpClient`/`TrustStore`/etc — and
 * so tests can drive the HTTP surface against a small fake.
 */
export interface ControlSurface {
  /** Opens (or replaces) a pairing window on THIS node; wraps `PairingManager.beginPairing`. */
  beginPairing(): { code: string; expiresAt?: number };
  /**
   * Attempts outbound pairing against a peer: performs the HFP pair
   * handshake and, on acceptance, adds the peer to the LIVE trust store.
   * A rejected pairing (wrong/expired code) resolves `{accepted: false}` —
   * it is NOT a thrown error. A thrown error means the attempt itself could
   * not complete (peer unreachable, TLS/fingerprint mismatch, etc).
   */
  pairWith(input: {
    host: string;
    port: number;
    code: string;
    expectedDeviceId?: string;
  }): Promise<PairConnectSummary>;
  /** This node's own live status. */
  status(): ControlStatus;
  /** The live paired-node directory; wraps `NodeDirectory.list`. */
  listNodes(): Promise<NodeDirectoryEntry[]>;
}

export interface ControlServerOptions {
  /** The daemon operations this server fronts (see {@link ControlSurface}). */
  surface: ControlSurface;
  /** Loopback host to bind; defaults to `127.0.0.1`. Non-loopback is rejected. */
  host?: string;
  /** Port to bind; `0` (the default) picks an ephemeral port (tests). */
  port?: number;
  /** Extra allowed Host header values (beyond the bound loopback host:port). */
  allowedHosts?: string[];
}

export interface RunningControlServer {
  /** The actually-bound port. */
  port: number;
  /** The bound (loopback) host. */
  host: string;
  /** Stops the server (no leaked handles). */
  close(): Promise<void>;
}

/** Writes a `{ error }` JSON response. Never includes a stack or raw error object. */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  respondJson(res, status, { error: message });
}

/** Extracts a safe, stack-free message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Maps a thrown pairing-attempt error to an HTTP status. Errors that carry a
 * numeric `.status` in the 4xx/5xx range (e.g. `HfpRequestError`) pass it
 * through; anything else (timeout, connection refused, fingerprint mismatch)
 * becomes 502 — the honest "the peer/attempt failed, not this server" code.
 */
function pairingErrorStatus(error: unknown): number {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return 502;
}

type BodyRead =
  | { status: "ok"; text: string }
  | { status: "too_large" }
  | { status: "read_error" };

/**
 * Reads a request body with a hard byte cap. Unlike the MCP transport's
 * reader this does NOT JSON-parse — `pair/begin` has no body at all, so
 * parsing is left to the one route (`pair/connect`) that needs it.
 */
async function readCappedBody(req: IncomingMessage): Promise<BodyRead> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_CONTROL_REQUEST_BYTES) {
    return { status: "too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_CONTROL_REQUEST_BYTES) {
        return { status: "too_large" };
      }
      chunks.push(buffer);
    }
  } catch {
    // Client aborted or the stream errored mid-read.
    return { status: "read_error" };
  }
  return { status: "ok", text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Starts the control HTTP front. Resolves once bound; the returned handle
 * exposes the bound port and a clean `close()`.
 */
export async function startControlServer(
  options: ControlServerOptions,
): Promise<RunningControlServer> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Control server refuses to bind to non-loopback host "${host}"; ` +
        "the control API must never leave localhost (bind 127.0.0.1).",
    );
  }

  const { surface } = options;

  // Built synchronously in the `listen` callback (below), before any request
  // can be accepted. The handler additionally refuses to serve while this is
  // empty, so the boundary fails CLOSED, by construction, not by incidental
  // event-loop ordering (mirrors the MCP HTTP transport).
  let allowedHosts: string[] = [];

  async function handlePairBegin(res: ServerResponse): Promise<void> {
    const result = surface.beginPairing();
    respondJson(res, 200, result);
  }

  async function handlePairConnect(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const read = await readCappedBody(req);
    if (read.status === "too_large") {
      respondError(
        res,
        413,
        `request body exceeds the ${MAX_CONTROL_REQUEST_BYTES}-byte limit`,
      );
      return;
    }
    if (read.status === "read_error") {
      respondError(res, 400, "failed to read request body");
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = read.text.trim() === "" ? {} : JSON.parse(read.text);
    } catch {
      respondError(res, 400, "invalid JSON body");
      return;
    }
    const parsed = PairConnectRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      respondError(
        res,
        400,
        `invalid pair/connect request: ${parsed.error.message}`,
      );
      return;
    }
    const input: PairConnectRequest = parsed.data;
    let summary: PairConnectSummary;
    try {
      summary = await surface.pairWith(input);
    } catch (error) {
      // A rejected pairing (bad/expired code) is `{accepted: false}` from
      // `pairWith`, handled below as a normal 200 — reaching THIS catch means
      // the attempt itself failed (unreachable peer, fingerprint mismatch,
      // etc), which is a clean 4xx/5xx, never a leaked stack.
      respondError(res, pairingErrorStatus(error), errorMessage(error));
      return;
    }
    respondJson(res, 200, summary);
  }

  async function handleStatus(res: ServerResponse): Promise<void> {
    respondJson(res, 200, surface.status());
  }

  async function handleNodes(res: ServerResponse): Promise<void> {
    const nodes = await surface.listNodes();
    respondJson(res, 200, { nodes });
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Fail CLOSED: never serve a request against an empty allow-list. By
    // construction the list is populated before `listen` resolves; this is
    // the defensive backstop (see the module header).
    //
    // Deliberately untested by black-box HTTP tests: `allowedHosts` is
    // always non-empty by the time `startControlServer`'s promise resolves
    // (the only way a test can obtain a port to request against), so this
    // branch is structurally unreachable from the public entry point. Left
    // as a documented, intentionally-untested defensive branch rather than
    // contorting the module's internals to make it reachable from a test.
    if (allowedHosts.length === 0) {
      respondError(res, 503, "control server not ready");
      return;
    }

    // DNS-rebinding defense: the Host header itself must name a loopback
    // alias at the bound port, not merely "this socket happens to be bound
    // to loopback" (a rebound DNS name still carries the attacker's Host).
    const hostHeader = req.headers.host;
    if (hostHeader === undefined || !allowedHosts.includes(hostHeader)) {
      respondError(
        res,
        403,
        "request Host header is not an allowed loopback value",
      );
      return;
    }

    // Browser CSRF defense: see the module header. A cross-origin fetch()
    // cannot set this header without a CORS preflight, and this server sends
    // no Access-Control-Allow-* headers, so the browser blocks the real
    // request before it is ever sent.
    if (req.headers[CONTROL_HEADER] !== "1") {
      respondError(res, 403, `missing required "${CONTROL_HEADER}" header`);
      return;
    }

    const method = req.method ?? "GET";
    const pathname = (req.url ?? "").split("?")[0];

    try {
      if (method === "POST" && pathname === "/control/pair/begin") {
        await handlePairBegin(res);
        return;
      }
      if (method === "POST" && pathname === "/control/pair/connect") {
        await handlePairConnect(req, res);
        return;
      }
      if (method === "GET" && pathname === "/control/status") {
        await handleStatus(res);
        return;
      }
      if (method === "GET" && pathname === "/control/nodes") {
        await handleNodes(res);
        return;
      }
      respondError(res, 404, "not found");
    } catch (error) {
      // Defensive backstop: no route handler above should throw uncaught
      // (each has its own try/catch where a collaborator can fail), but if
      // one does, respond cleanly instead of letting Node tear the socket
      // down with no body or leak a stack.
      respondError(res, 500, errorMessage(error));
    }
  }

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res);
  });

  let boundPort = 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Control server bound to a non-TCP address"));
        return;
      }
      boundPort = address.port;
      // Populate the allow-list synchronously, before resolve(), so a
      // request can never be serviced against an empty (fail-open) list.
      allowedHosts = [
        ...new Set([
          `${host}:${boundPort}`,
          `127.0.0.1:${boundPort}`,
          `localhost:${boundPort}`,
          `[::1]:${boundPort}`,
          ...(options.allowedHosts ?? []),
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
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
        httpServer.closeAllConnections();
      });
    },
  };
}
