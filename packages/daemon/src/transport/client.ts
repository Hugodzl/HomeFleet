/**
 * HFP client (ADR-0004): presents this device's certificate as the TLS
 * client certificate, disables chain validation, and pins the server by
 * fingerprint — the TLS handshake completes, the server certificate's
 * SHA-256 fingerprint is compared to the expected device ID, and on
 * mismatch the connection is destroyed before a single HTTP byte is sent.
 *
 * Every call opens a fresh TLS connection (a full handshake per request, no
 * keep-alive) — a deliberate v0 simplicity choice that also means removing a
 * device from the trust store takes effect immediately: there are no
 * long-lived authenticated connections to outlive the revocation.
 */
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type HelloRequest,
  type HelloResponse,
  HelloResponseSchema,
  HFP_PATH_PREFIX,
  type HfpError,
  HfpErrorSchema,
  type NodeInfo,
  type PairRequest,
  type PairResponse,
  PairResponseSchema,
} from "@homefleet/protocol";
import type { z } from "zod";
import { certFingerprint } from "../identity/fingerprint.js";
import type { Identity } from "../identity/identity.js";
import { MAX_BODY_BYTES } from "./limits.js";

/**
 * Default per-request timeout. Covers connect + TLS handshake as well as
 * waiting on the response (as a socket-inactivity timeout). M3 discovery
 * will routinely `hello()` machines that are asleep or half-offline.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** A non-2xx HFP response, carrying the parsed `HfpError` when present. */
export class HfpRequestError extends Error {
  readonly status: number;
  readonly hfpError: HfpError | undefined;

  constructor(status: number, hfpError: HfpError | undefined, message: string) {
    super(message);
    this.name = "HfpRequestError";
    this.status = status;
    this.hfpError = hfpError;
  }
}

/**
 * The server's certificate fingerprint did not match the expected device
 * ID. The connection was severed before any request data was sent.
 */
export class FingerprintMismatchError extends Error {
  readonly expectedDeviceId: string;
  readonly actualDeviceId: string;

  constructor(expectedDeviceId: string, actualDeviceId: string) {
    super(
      `server certificate fingerprint ${actualDeviceId} does not match ` +
        `expected device ID ${expectedDeviceId}; aborting before sending the request`,
    );
    this.name = "FingerprintMismatchError";
    this.expectedDeviceId = expectedDeviceId;
    this.actualDeviceId = actualDeviceId;
  }
}

/** The peer went idle past the request timeout; the socket was destroyed. */
export class HfpTimeoutError extends Error {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;

  constructor(host: string, port: number, timeoutMs: number) {
    super(`request to ${host}:${port} timed out after ${timeoutMs}ms`);
    this.name = "HfpTimeoutError";
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }
}

/** The response body exceeded {@link MAX_BODY_BYTES}; download aborted. */
export class HfpResponseTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`response body exceeded the ${limitBytes}-byte limit; aborting`);
    this.name = "HfpResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/**
 * The TLS handshake completed but the server presented no certificate —
 * there is no identity to pin against, so the request is aborted
 * (fail-closed, mirroring the server's no-client-cert guard).
 */
export class MissingServerCertificateError extends Error {
  constructor(host: string, port: number) {
    super(
      `server at ${host}:${port} presented no certificate; ` +
        "refusing to send a request to an unidentifiable peer",
    );
    this.name = "MissingServerCertificateError";
  }
}

/** A peer endpoint whose identity is already known. */
export interface HfpTarget {
  host: string;
  port: number;
  expectedDeviceId: string;
  /**
   * Per-request inactivity timeout; defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. `0` disables the timeout entirely
   * (Node socket semantics) — it does not mean "fail immediately".
   */
  timeoutMs?: number;
}

/**
 * A peer endpoint for pairing: `expectedDeviceId` MAY be absent because
 * pairing can happen before the peer's ID is known (trust-on-first-use for
 * this one call, by design — the pairing code proves intent).
 */
export interface PairTarget {
  host: string;
  port: number;
  expectedDeviceId?: string;
  /**
   * Per-request inactivity timeout; defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. `0` disables the timeout entirely
   * (Node socket semantics) — it does not mean "fail immediately".
   */
  timeoutMs?: number;
}

export interface HfpRequestOptions<T> {
  host: string;
  port: number;
  expectedDeviceId: string;
  method: "GET" | "POST";
  /** Path relative to `HFP_PATH_PREFIX`, e.g. `"/hello"` (mirrors `NodeServer.route`). */
  path: string;
  body?: unknown;
  responseSchema: z.ZodType<T>;
  /**
   * Per-request inactivity timeout; defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}. `0` disables the timeout entirely
   * (Node socket semantics) — it does not mean "fail immediately".
   */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  bodyText: string;
  serverDeviceId: string;
}

export class HfpClient {
  private readonly identity: Identity;

  constructor(identity: Identity) {
    this.identity = identity;
  }

  /**
   * Sends one HFP request to a known peer. The server certificate is pinned
   * to `expectedDeviceId`; the response is validated against
   * `responseSchema`; non-2xx statuses throw {@link HfpRequestError}.
   */
  async request<T>(options: HfpRequestOptions<T>): Promise<T> {
    const { value } = await this.requestInternal(options);
    return value;
  }

  /** `POST /hfp/v0/hello` against a paired peer. */
  async hello(
    target: HfpTarget,
    ourNodeInfo: NodeInfo,
  ): Promise<HelloResponse> {
    const body: HelloRequest = { nodeInfo: ourNodeInfo };
    return this.request({
      ...target,
      method: "POST",
      path: "/hello",
      body,
      responseSchema: HelloResponseSchema,
    });
  }

  /**
   * `POST /hfp/v0/pair`. When `target.expectedDeviceId` is absent the server
   * is not pinned (the code proves intent); the observed server fingerprint
   * is always returned so the caller can record it in its trust store. On an
   * accepted response the server's claimed `nodeInfo.deviceId` must equal
   * the TLS-observed fingerprint — a mismatch throws.
   */
  async pair(
    target: PairTarget,
    code: string,
    ourNodeInfo: NodeInfo,
  ): Promise<{ response: PairResponse; serverDeviceId: string }> {
    const body: PairRequest = { code, nodeInfo: ourNodeInfo };
    const { value: response, serverDeviceId } = await this.requestInternal({
      host: target.host,
      port: target.port,
      expectedDeviceId: target.expectedDeviceId,
      timeoutMs: target.timeoutMs,
      method: "POST",
      path: "/pair",
      body,
      responseSchema: PairResponseSchema,
    });
    if (
      response.accepted &&
      response.nodeInfo !== undefined &&
      response.nodeInfo.deviceId !== serverDeviceId
    ) {
      // The peer claims an identity other than the certificate it presented.
      throw new FingerprintMismatchError(
        response.nodeInfo.deviceId,
        serverDeviceId,
      );
    }
    return { response, serverDeviceId };
  }

  private async requestInternal<T>(options: {
    host: string;
    port: number;
    expectedDeviceId?: string;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    responseSchema: z.ZodType<T>;
    timeoutMs?: number;
  }): Promise<{ value: T; serverDeviceId: string }> {
    const { status, bodyText, serverDeviceId } = await this.rawRequest(options);
    if (status < 200 || status >= 300) {
      throw buildRequestError(status, bodyText);
    }
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      throw new HfpRequestError(
        status,
        undefined,
        `peer returned a 2xx response with a non-JSON body`,
      );
    }
    return { value: options.responseSchema.parse(json), serverDeviceId };
  }

  /**
   * The security-critical core: TLS handshake with our identity as the
   * client certificate, then the fingerprint pin — all BEFORE any HTTP data
   * is written. Shared by `rawRequest` today and by any future streaming
   * variant (M5 SSE), which must reuse this rather than reimplement it.
   *
   * Ownership: on success the caller owns the returned socket and is
   * responsible for destroying it. `rawRequest` does so in a `finally`; a
   * streaming variant must instead keep the socket alive for the stream's
   * lifetime and destroy it when the stream ends.
   *
   * Why verify on 'secureConnect' rather than via `checkServerIdentity`:
   * Node only invokes `checkServerIdentity` when chain verification
   * succeeded, and a self-signed peer cert always fails chain verification —
   * so with `rejectUnauthorized: false` the callback would silently never
   * run. Verifying after the handshake, before any HTTP bytes are written,
   * gives the same abort-before-send guarantee (proven by the
   * fingerprint-mismatch integration test).
   */
  private async connectPinned(options: {
    host: string;
    port: number;
    expectedDeviceId?: string;
    timeoutMs: number;
  }): Promise<{ socket: TLSSocket; serverDeviceId: string }> {
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      key: this.identity.keyPem,
      cert: this.identity.certPem,
      rejectUnauthorized: false,
    });
    // Inactivity timeout covering connect + handshake now and the response
    // wait later (the timer stays armed for the socket's whole life).
    socket.setTimeout(options.timeoutMs, () => {
      socket.destroy(
        new HfpTimeoutError(options.host, options.port, options.timeoutMs),
      );
    });
    try {
      await once(socket, "secureConnect");
      // From here on, socket errors surface through the HTTP request (or
      // are moot once we throw); avoid an unhandled 'error' crash.
      socket.on("error", () => {});

      const peerCert = socket.getPeerCertificate();
      if (peerCert === null || peerCert.raw === undefined) {
        throw new MissingServerCertificateError(options.host, options.port);
      }
      const serverDeviceId = certFingerprint(peerCert.raw);
      if (
        options.expectedDeviceId !== undefined &&
        serverDeviceId !== options.expectedDeviceId
      ) {
        throw new FingerprintMismatchError(
          options.expectedDeviceId,
          serverDeviceId,
        );
      }
      return { socket, serverDeviceId };
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  /**
   * Connects, verifies the server fingerprint, then (and only then) sends
   * the HTTP request over the verified socket.
   */
  private async rawRequest(options: {
    host: string;
    port: number;
    expectedDeviceId?: string;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<RawResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { socket, serverDeviceId } = await this.connectPinned({
      host: options.host,
      port: options.port,
      expectedDeviceId: options.expectedDeviceId,
      timeoutMs,
    });
    try {
      const payload =
        options.body === undefined ? undefined : JSON.stringify(options.body);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            // With createConnection set and no agent, the HTTP client uses
            // our already-verified TLS socket as the transport.
            createConnection: () => socket,
            method: options.method,
            path: `${HFP_PATH_PREFIX}${options.path}`,
            headers: {
              host: `${options.host}:${options.port}`,
              ...(payload === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(payload)),
                  }),
            },
          },
          resolve,
        );
        req.on("error", reject);
        req.end(payload);
      });

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of response) {
        const buffer = chunk as Buffer;
        totalBytes += buffer.length;
        if (totalBytes > MAX_BODY_BYTES) {
          throw new HfpResponseTooLargeError(MAX_BODY_BYTES);
        }
        chunks.push(buffer);
      }
      return {
        status: response.statusCode ?? 0,
        bodyText: Buffer.concat(chunks).toString("utf8"),
        serverDeviceId,
      };
    } catch (error) {
      // A timeout destroys the socket with an HfpTimeoutError, but the
      // failure can surface through the HTTP layer as a generic stream
      // error; re-raise the typed timeout in that case.
      if (
        !(error instanceof HfpTimeoutError) &&
        socket.errored instanceof HfpTimeoutError
      ) {
        throw socket.errored;
      }
      throw error;
    } finally {
      socket.destroy();
    }
  }
}

function buildRequestError(status: number, bodyText: string): HfpRequestError {
  let hfpError: HfpError | undefined;
  try {
    const parsed = HfpErrorSchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      hfpError = parsed.data;
    }
  } catch {
    // Non-JSON error body: keep hfpError undefined.
  }
  const detail = hfpError ? `${hfpError.code}: ${hfpError.message}` : bodyText;
  return new HfpRequestError(
    status,
    hfpError,
    `HFP request failed with status ${status} (${detail})`,
  );
}
