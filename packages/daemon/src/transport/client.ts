/**
 * HFP client (ADR-0004): presents this device's certificate as the TLS
 * client certificate, disables chain validation, and pins the server by
 * fingerprint — the TLS handshake completes, the server certificate's
 * SHA-256 fingerprint is compared to the expected device ID, and on
 * mismatch the connection is destroyed before a single HTTP byte is sent.
 */
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as tlsConnect } from "node:tls";
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

/** A peer endpoint whose identity is already known. */
export interface HfpTarget {
  host: string;
  port: number;
  expectedDeviceId: string;
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
}

export interface HfpRequestOptions<T> {
  host: string;
  port: number;
  expectedDeviceId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  responseSchema: z.ZodType<T>;
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
      path: `${HFP_PATH_PREFIX}/hello`,
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
      method: "POST",
      path: `${HFP_PATH_PREFIX}/pair`,
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
  }): Promise<RawResponse> {
    // Step 1: TLS handshake with our identity as the client certificate.
    // Chain validation is off (self-signed certs); trust comes from the
    // fingerprint pin below, not from a CA (ADR-0004).
    //
    // Why verify on 'secureConnect' rather than via `checkServerIdentity`:
    // Node only invokes `checkServerIdentity` when chain verification
    // succeeded, and a self-signed peer cert always fails chain
    // verification — so with `rejectUnauthorized: false` the callback would
    // silently never run. Verifying after the handshake, before any HTTP
    // bytes are written, gives the same abort-before-send guarantee
    // (proven by the fingerprint-mismatch integration test).
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      key: this.identity.keyPem,
      cert: this.identity.certPem,
      rejectUnauthorized: false,
    });
    try {
      await once(socket, "secureConnect");
      // From here on, socket errors surface through the HTTP request (or
      // are moot once we throw); avoid an unhandled 'error' crash.
      socket.on("error", () => {});

      // Step 2: pin check BEFORE any HTTP data is written.
      const peerCert = socket.getPeerCertificate();
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

      // Step 3: send the HTTP request over the verified socket.
      const payload =
        options.body === undefined ? undefined : JSON.stringify(options.body);
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            // With createConnection set and no agent, the HTTP client uses
            // our already-verified TLS socket as the transport.
            createConnection: () => socket,
            method: options.method,
            path: options.path,
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
      for await (const chunk of response) {
        chunks.push(chunk as Buffer);
      }
      return {
        status: response.statusCode ?? 0,
        bodyText: Buffer.concat(chunks).toString("utf8"),
        serverDeviceId,
      };
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
