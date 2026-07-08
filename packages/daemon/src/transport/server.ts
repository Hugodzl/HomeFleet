/**
 * HFP node server (ADR-0004): HTTPS with `requestCert: true` and
 * `rejectUnauthorized: false`, followed by a manual fingerprint check of the
 * peer certificate against the paired-device list. Unpaired peers can reach
 * exactly one route: `POST /hfp/v0/pair`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import {
  HelloRequestSchema,
  HelloResponseSchema,
  HFP_PATH_PREFIX,
  type HfpError,
  type HfpErrorCode,
  type NodeInfo,
  PairRequestSchema,
} from "@homefleet/protocol";
import type { z } from "zod";
import { certFingerprint } from "../identity/fingerprint.js";
import type { Identity } from "../identity/identity.js";
import type { PairingManager } from "../pairing/pairing.js";
import type { TrustStore } from "../trust/trust-store.js";
import { MAX_BODY_BYTES } from "./limits.js";

/** What the TLS layer knows about the requesting peer. */
export interface PeerInfo {
  /**
   * SHA-256 fingerprint of the peer's client certificate, or `null` when no
   * client certificate was presented.
   */
  deviceId: string | null;
  /** Whether that fingerprint is in the trust store. */
  paired: boolean;
}

export interface RouteContext<T> {
  /** Request body, parsed and validated by the route's schema. */
  body: T;
  peer: PeerInfo;
  /** Captured `:param` path segments (none in the v0 routes). */
  params: Record<string, string>;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteHandler<T> = (
  context: RouteContext<T>,
) => RouteResult | Promise<RouteResult>;

/**
 * Context for a streaming route (M5 SSE). Unlike a JSON route, the handler
 * takes over the raw {@link ServerResponse}: it owns writing headers, the
 * body, and ending the response. The auth gate has already run — a `paired`
 * stream route only reaches its handler for a paired peer.
 */
export interface StreamRouteContext {
  peer: PeerInfo;
  params: Record<string, string>;
  req: IncomingMessage;
  res: ServerResponse;
}

export type StreamRouteHandler = (
  context: StreamRouteContext,
) => void | Promise<void>;

export interface StreamRouteOptions {
  /** Defaults to `"paired"`. */
  auth?: RouteAuth;
}

/**
 * Context for an inbound binary-upload route (M7 bundle upload). Symmetric to
 * {@link StreamRouteContext} but the payload flows the other way: the handler
 * owns the raw request stream (`req`) — which it MUST consume or destroy — and
 * writes the JSON response on `res`. Like a stream route, the auth gate has
 * already run, so a `paired` upload route only ever reaches its handler for a
 * paired peer. The request body is NOT buffered or JSON-parsed by the server:
 * the handler streams it (e.g. to a size-capped temp file), so a many-MiB
 * bundle never hits the 1 MiB JSON body limit or balloons memory.
 */
export interface UploadRouteContext {
  peer: PeerInfo;
  params: Record<string, string>;
  req: IncomingMessage;
  res: ServerResponse;
}

export type UploadRouteHandler = (
  context: UploadRouteContext,
) => void | Promise<void>;

export interface UploadRouteOptions {
  /** Defaults to `"paired"`. */
  auth?: RouteAuth;
}

/**
 * `paired` routes reject peers that are not in the trust store (or present
 * no client certificate) with 401 UNAUTHORIZED before the handler runs.
 * `unpaired-ok` is reserved for `POST /hfp/v0/pair`.
 */
export type RouteAuth = "paired" | "unpaired-ok";

export interface RouteOptions<T> {
  schema: z.ZodType<T>;
  /** Defaults to `"paired"`. */
  auth?: RouteAuth;
}

interface JsonRegisteredRoute {
  kind: "json";
  method: string;
  /** Full path split into segments; `:name` segments capture. */
  segments: string[];
  auth: RouteAuth;
  invoke: (
    rawBody: unknown,
    peer: PeerInfo,
    params: Record<string, string>,
  ) => Promise<RouteResult>;
}

interface StreamRegisteredRoute {
  kind: "stream";
  method: string;
  segments: string[];
  auth: RouteAuth;
  invokeStream: StreamRouteHandler;
}

interface UploadRegisteredRoute {
  kind: "upload";
  method: string;
  segments: string[];
  auth: RouteAuth;
  invokeUpload: UploadRouteHandler;
}

type RegisteredRoute =
  | JsonRegisteredRoute
  | StreamRegisteredRoute
  | UploadRegisteredRoute;

export interface NodeServerOptions {
  identity: Identity;
  trustStore: TrustStore;
  /** Provides this node's own NodeInfo for `hello` responses. */
  nodeInfoProvider: () => NodeInfo;
  pairingManager: PairingManager;
  /** Interface to bind; defaults to `"127.0.0.1"`. */
  host?: string;
  /** Port to bind; `0` (the default) picks an ephemeral port. */
  port?: number;
}

function hfpError(code: HfpErrorCode, message: string): HfpError {
  return { code, message };
}

/**
 * The daemon's HFP-facing HTTPS server.
 *
 * Every request is attributed to a peer via its client-certificate
 * fingerprint and gated on the trust store before any handler runs. Bodies
 * are JSON only, capped at {@link MAX_BODY_BYTES}.
 */
export class NodeServer {
  private readonly identity: Identity;
  private readonly trustStore: TrustStore;
  private readonly nodeInfoProvider: () => NodeInfo;
  private readonly pairingManager: PairingManager;
  private readonly host: string;
  private readonly port: number;
  private readonly routes: RegisteredRoute[] = [];
  private server: Server | null = null;

  constructor(options: NodeServerOptions) {
    this.identity = options.identity;
    this.trustStore = options.trustStore;
    this.nodeInfoProvider = options.nodeInfoProvider;
    this.pairingManager = options.pairingManager;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.registerBuiltinRoutes();
  }

  /**
   * Registers a route. `path` is relative to `HFP_PATH_PREFIX`
   * (e.g. `"/hello"`). Segments starting with `:` capture into
   * `context.params` (job routes will use this in M5).
   */
  route<T>(
    method: "GET" | "POST",
    routePath: string,
    options: RouteOptions<T>,
    handler: RouteHandler<T>,
  ): void {
    const fullPath = `${HFP_PATH_PREFIX}${routePath}`;
    const auth = options.auth ?? "paired";
    // The closure erases T: the raw body only reaches the typed handler
    // after the schema has validated it.
    const invoke = async (
      rawBody: unknown,
      peer: PeerInfo,
      params: Record<string, string>,
    ): Promise<RouteResult> => {
      const parsed = options.schema.safeParse(rawBody);
      if (!parsed.success) {
        return {
          status: 400,
          body: hfpError("INVALID_REQUEST", "request body failed validation"),
        };
      }
      return handler({ body: parsed.data, peer, params });
    };
    this.routes.push({
      kind: "json",
      method,
      segments: fullPath.split("/"),
      auth,
      invoke,
    });
  }

  /**
   * Registers a streaming route (M5 SSE). Same path/auth semantics as
   * {@link route}, but the handler takes over the raw response AFTER the
   * identify-peer → paired chokepoint has run, so the auth gate is never
   * bypassed. No request-body schema: streaming routes are bodyless GETs.
   */
  routeStream(
    method: "GET" | "POST",
    routePath: string,
    options: StreamRouteOptions,
    handler: StreamRouteHandler,
  ): void {
    const fullPath = `${HFP_PATH_PREFIX}${routePath}`;
    this.routes.push({
      kind: "stream",
      method,
      segments: fullPath.split("/"),
      auth: options.auth ?? "paired",
      invokeStream: handler,
    });
  }

  /**
   * Registers an inbound binary-upload route (M7 bundle upload). Same path/auth
   * semantics as {@link route}, but the handler takes over the raw request AND
   * response AFTER the identify-peer → paired chokepoint has run — so the auth
   * gate is never bypassed — and the server does NOT read or JSON-parse the
   * body. The handler is responsible for streaming (and size-capping) the
   * request body and for writing the response.
   */
  routeUpload(
    method: "GET" | "POST",
    routePath: string,
    options: UploadRouteOptions,
    handler: UploadRouteHandler,
  ): void {
    const fullPath = `${HFP_PATH_PREFIX}${routePath}`;
    this.routes.push({
      kind: "upload",
      method,
      segments: fullPath.split("/"),
      auth: options.auth ?? "paired",
      invokeUpload: handler,
    });
  }

  async start(): Promise<{ port: number }> {
    if (this.server !== null) {
      throw new Error("NodeServer is already started");
    }
    const server = createServer(
      {
        key: this.identity.keyPem,
        cert: this.identity.certPem,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        void this.handleRequest(req, res);
      },
    );
    // Only claim `this.server` after listen succeeds: a failed bind (e.g.
    // EADDRINUSE) must leave the instance restartable — never wedged in a
    // state where retries say "already started" and stop() rejects.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    // Post-listen async errors (e.g. accept-loop EMFILE) must not crash the
    // process; a net.Server with no 'error' listener would throw them.
    server.on("error", () => {});
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("NodeServer bound to a non-TCP address");
    }
    return { port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  private registerBuiltinRoutes(): void {
    // POST /hfp/v0/hello — capability exchange between paired nodes.
    this.route("POST", "/hello", { schema: HelloRequestSchema }, () => ({
      status: 200,
      body: HelloResponseSchema.parse({ nodeInfo: this.nodeInfoProvider() }),
    }));

    // POST /hfp/v0/pair — the only route reachable by unpaired peers. The
    // peer still presented a client certificate (requestCert: true); its
    // fingerprint is the identity that gets trusted on acceptance.
    this.route(
      "POST",
      "/pair",
      { schema: PairRequestSchema, auth: "unpaired-ok" },
      async ({ body, peer }) => {
        if (peer.deviceId === null) {
          // A peer with no certificate has no identity to pair.
          return {
            status: 401,
            body: hfpError(
              "UNAUTHORIZED",
              "pairing requires a client certificate",
            ),
          };
        }
        const response = await this.pairingManager.handlePairRequest(
          body,
          peer.deviceId,
          body.nodeInfo.name,
        );
        return { status: 200, body: response };
      },
    );
  }

  private matchRoute(
    method: string,
    pathname: string,
  ): { route: RegisteredRoute; params: Record<string, string> } | null {
    const segments = pathname.split("/");
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }
      if (route.segments.length !== segments.length) {
        continue;
      }
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const expected = route.segments[i] ?? "";
        const actual = segments[i] ?? "";
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = actual;
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { route, params };
      }
    }
    return null;
  }

  /**
   * Attributes the request to a peer: fingerprint of the client certificate
   * (when one was presented) checked against the trust store.
   */
  private identifyPeer(req: IncomingMessage): PeerInfo {
    const socket = req.socket as TLSSocket;
    // Leaf certificate only: the fingerprint is computed over the presented
    // cert itself, never a chain (self-signed certs have no chain anyway).
    const cert = socket.getPeerCertificate();
    // Without a client certificate, getPeerCertificate returns an empty
    // object (or null); `raw` is only present on a real certificate.
    if (cert === null || cert.raw === undefined) {
      return { deviceId: null, paired: false };
    }
    const deviceId = certFingerprint(cert.raw);
    return { deviceId, paired: this.trustStore.has(deviceId) };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      const peer = this.identifyPeer(req);
      const match = this.matchRoute(req.method ?? "", pathname);
      if (match === null) {
        // Defense in depth: unpaired peers get the same 401 for unknown
        // paths as for paired routes, so probing cannot map the route
        // table. Paired peers get an honest 404.
        if (!peer.paired) {
          this.sendJson(
            res,
            401,
            hfpError("UNAUTHORIZED", "peer is not paired"),
          );
          return;
        }
        this.sendJson(
          res,
          404,
          hfpError("INVALID_REQUEST", "unknown endpoint"),
        );
        return;
      }

      if (match.route.auth === "paired" && !peer.paired) {
        this.sendJson(res, 401, hfpError("UNAUTHORIZED", "peer is not paired"));
        return;
      }

      // Streaming routes take over the response after the same auth gate; no
      // JSON body is read (they are bodyless GETs).
      if (match.route.kind === "stream") {
        await match.route.invokeStream({
          peer,
          params: match.params,
          req,
          res,
        });
        return;
      }

      // Upload routes take over BOTH the raw request (binary body) and the
      // response, after the same auth gate; the server does not read/parse the
      // body (the handler streams it to disk under its own size cap).
      if (match.route.kind === "upload") {
        await match.route.invokeUpload({
          peer,
          params: match.params,
          req,
          res,
        });
        return;
      }

      const body = await this.readJsonBody(req);
      if (!body.ok) {
        this.sendJson(res, body.status, body.error);
        if (body.destroySocket) {
          res.once("finish", () => req.destroy());
        }
        return;
      }

      const result = await match.route.invoke(body.value, peer, match.params);
      this.sendJson(res, result.status, result.body);
    } catch {
      if (!res.headersSent) {
        this.sendJson(res, 500, hfpError("INTERNAL", "internal error"));
      } else {
        res.end();
      }
    }
  }

  private readJsonBody(
    req: IncomingMessage,
  ): Promise<
    | { ok: true; value: unknown }
    | { ok: false; status: number; error: HfpError; destroySocket: boolean }
  > {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) {
          return;
        }
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          done = true;
          req.pause();
          resolve({
            ok: false,
            status: 413,
            error: hfpError("INVALID_REQUEST", "request body too large"),
            destroySocket: true,
          });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (done) {
          return;
        }
        done = true;
        const text = Buffer.concat(chunks).toString("utf8");
        if (text === "") {
          // No body: let the route schema decide (v0 POST routes require one).
          resolve({ ok: true, value: undefined });
          return;
        }
        try {
          resolve({ ok: true, value: JSON.parse(text) });
        } catch {
          resolve({
            ok: false,
            status: 400,
            error: hfpError(
              "INVALID_REQUEST",
              "request body is not valid JSON",
            ),
            destroySocket: false,
          });
        }
      });
      req.on("error", reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
