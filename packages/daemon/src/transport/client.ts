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
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type BundleUploadResponse,
  BundleUploadResponseSchema,
  type CancelResponse,
  CancelResponseSchema,
  type DelegateRequest,
  type DelegateResponse,
  DelegateResponseSchema,
  type HaveTipRequest,
  HaveTipResponseSchema,
  type HelloRequest,
  type HelloResponse,
  HelloResponseSchema,
  HFP_PATH_PREFIX,
  type HfpError,
  HfpErrorSchema,
  type JobEvent,
  JobEventSchema,
  type JobParams,
  type JobSnapshot,
  JobSnapshotSchema,
  type NodeInfo,
  type PairRequest,
  type PairResponse,
  PairResponseSchema,
} from "@homefleet/protocol";
import type { z } from "zod";
import { certFingerprint } from "../identity/fingerprint.js";
import type { Identity } from "../identity/identity.js";
import {
  COMMIT_HASH_RE,
  createBundle,
  isAncestor,
  resolveHeadCommit,
} from "../workspace/git.js";
import { HEAD_COMMIT_HEADER } from "../workspace/routes.js";
import { MAX_BODY_BYTES } from "./limits.js";

/**
 * Per-record cap on a buffered (not-yet-terminated) SSE event: the largest
 * legitimate event is a `result` carrying a full `JobResult`, itself bounded
 * by the transport body limit, so 2× that is generous while still rejecting
 * an unbounded event from an untrusted peer.
 */
export const MAX_SSE_EVENT_BYTES = 2 * MAX_BODY_BYTES;

/** Cap on total bytes read across one event stream (untrusted peer). */
export const MAX_SSE_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Socket-inactivity timeout for the SSE streaming phase. It MUST exceed the
 * server's SSE heartbeat interval (`SSE_HEARTBEAT_MS`, 15s) by a comfortable
 * margin so a live stream — kept ticking by heartbeats between sparse job
 * events — is never killed, while a silent or half-open peer (server slept,
 * crashed, or was unplugged with no clean FIN/RST) still trips it instead of
 * hanging the iterator forever. Overridable per call for tests.
 */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Socket-inactivity timeout for the bundle-upload phase. Re-armed after the
 * pinned connect so a large upload (and the worker's subsequent verify/fetch,
 * which delays the response) is not killed mid-flight, while a stalled peer
 * still trips it. Generous, since git work on the worker can take a while.
 */
export const BUNDLE_UPLOAD_IDLE_TIMEOUT_MS = 120_000;

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
 * A 2xx artifact-download response arrived without a usable
 * `x-homefleet-head-commit` header. That header is the artifact's integrity
 * anchor (the delegator verifies the fetched bundle's tip against it), so a
 * response missing it — or carrying a non-40-hex value — is unusable and the
 * download is refused before a byte is written.
 */
export class ArtifactHeadCommitError extends Error {
  constructor(received: string | undefined) {
    super(
      received === undefined
        ? `artifact response is missing the ${HEAD_COMMIT_HEADER} header`
        : `artifact response carries an invalid ${HEAD_COMMIT_HEADER} header`,
    );
    this.name = "ArtifactHeadCommitError";
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

  /** `POST /hfp/v0/jobs` — delegate a job to a paired worker. */
  async delegate(
    target: HfpTarget,
    params: JobParams,
  ): Promise<DelegateResponse> {
    const body: DelegateRequest = { params };
    return this.request({
      ...target,
      method: "POST",
      path: "/jobs",
      body,
      responseSchema: DelegateResponseSchema,
    });
  }

  /** `GET /hfp/v0/jobs/{id}` — poll a delegated job's snapshot. */
  async jobSnapshot(target: HfpTarget, jobId: string): Promise<JobSnapshot> {
    return this.request({
      ...target,
      method: "GET",
      path: `/jobs/${encodeURIComponent(jobId)}`,
      responseSchema: JobSnapshotSchema,
    });
  }

  /** `POST /hfp/v0/jobs/{id}/cancel` — request cancellation of a delegated job. */
  async cancelJob(target: HfpTarget, jobId: string): Promise<CancelResponse> {
    return this.request({
      ...target,
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/cancel`,
      responseSchema: CancelResponseSchema,
    });
  }

  /**
   * `POST /hfp/v0/workspace/have` — ask the worker which commit it already has
   * for `repoId`, so the delegator can build a full or incremental bundle.
   * Returns the worker's tip, or `null` if it has never synced the repo. A
   * repo the worker does not allowlist is an HFP error (WORKSPACE_UNAVAILABLE),
   * surfaced as {@link HfpRequestError} — NOT a silent `null`.
   */
  async haveTip(target: HfpTarget, repoId: string): Promise<string | null> {
    const body: HaveTipRequest = { repoId };
    const response = await this.request({
      ...target,
      method: "POST",
      path: "/workspace/have",
      body,
      responseSchema: HaveTipResponseSchema,
    });
    return response.headCommit;
  }

  /**
   * `POST /hfp/v0/workspace/bundle` — upload a git bundle for `repoId` claiming
   * to deliver `headCommit`. The bundle is BINARY and can be many MiB, so it is
   * NOT base64'd into JSON: it streams as the raw `application/octet-stream`
   * body over the verified socket, with `repoId`/`headCommit` in request
   * headers. Reuses {@link connectPinned} (the fingerprint pin is not
   * reimplemented); the socket is held for the upload and destroyed in the
   * `finally` (the ownership-transfer contract). Non-2xx (e.g. 413 too-large,
   * 403 not-allowlisted) throws {@link HfpRequestError}, mirroring `request`.
   */
  async uploadBundle(
    target: HfpTarget,
    repoId: string,
    headCommit: string,
    bundlePath: string,
    options: { idleTimeoutMs?: number } = {},
  ): Promise<BundleUploadResponse> {
    const connectTimeoutMs = target.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const idleTimeoutMs =
      options.idleTimeoutMs ?? BUNDLE_UPLOAD_IDLE_TIMEOUT_MS;
    const size = (await stat(bundlePath)).size;
    const { socket } = await this.connectPinned({
      host: target.host,
      port: target.port,
      expectedDeviceId: target.expectedDeviceId,
      timeoutMs: connectTimeoutMs,
    });
    try {
      // Re-arm the inactivity timer for the (possibly long) upload + the
      // worker's verify/fetch before it responds. connectPinned used the
      // connect timeout; swap in the upload idle timeout so streaming and a
      // slow server-side git op are not mistaken for a stall.
      socket.removeAllListeners("timeout");
      socket.setTimeout(idleTimeoutMs, () => {
        socket.destroy(
          new HfpTimeoutError(target.host, target.port, idleTimeoutMs),
        );
      });

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            createConnection: () => socket,
            method: "POST",
            path: `${HFP_PATH_PREFIX}/workspace/bundle`,
            headers: {
              host: `${target.host}:${target.port}`,
              "content-type": "application/octet-stream",
              "content-length": String(size),
              // repoId is opaque (may contain non-ASCII, `/`, `\`); URL-encode
              // it so it is a safe single-line header value. headCommit is
              // already 40-hex (header-safe).
              "x-homefleet-repo-id": encodeURIComponent(repoId),
              "x-homefleet-head-commit": headCommit,
            },
          },
          resolve,
        );
        req.on("error", reject);
        const file = createReadStream(bundlePath);
        file.on("error", (error) => {
          req.destroy(error);
          reject(error);
        });
        file.pipe(req);
      });
      response.on("error", () => {});

      const status = response.statusCode ?? 0;
      const bodyText = await readCappedBody(response, MAX_BODY_BYTES);
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
          "worker returned a 2xx bundle-upload response with a non-JSON body",
        );
      }
      return BundleUploadResponseSchema.parse(json);
    } catch (error) {
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

  /**
   * Delegating-side workspace sync (M7): make the worker's cache hold this
   * repo's current committed head, then return that head for a `WorkspaceRef`.
   *
   * Reads the local repo's HEAD, asks the worker what it already has
   * ({@link haveTip}), and ships the difference as a git bundle: nothing when
   * the worker is already at HEAD; an incremental `have..HEAD` bundle when the
   * worker's commit is an ancestor of HEAD; otherwise a full bundle. The temp
   * bundle is always cleaned up. Committed state only (ADR-0005): a bundle
   * carries commits, never the working tree.
   *
   * `repoPath` is the delegator's OWN repository (trusted). Errors surface
   * typed: a non-allowlisted repo makes {@link haveTip} throw
   * {@link HfpRequestError}; git failures throw {@link GitError}.
   */
  async syncWorkspace(
    target: HfpTarget,
    repo: { repoPath: string; repoId: string },
  ): Promise<{ headCommit: string }> {
    const headCommit = await resolveHeadCommit(repo.repoPath);
    const have = await this.haveTip(target, repo.repoId);
    if (have === headCommit) {
      // The worker is already at this commit; nothing to transfer.
      return { headCommit };
    }
    const incremental =
      have !== null && (await isAncestor(repo.repoPath, have, headCommit));
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "homefleet-bundle-out-"),
    );
    const bundlePath = path.join(tempDir, "sync.bundle");
    try {
      await createBundle({
        repoPath: repo.repoPath,
        bundlePath,
        headCommit,
        ...(incremental && have !== null ? { have } : {}),
      });
      await this.uploadBundle(target, repo.repoId, headCommit, bundlePath);
      return { headCommit };
    } finally {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  /**
   * `GET /hfp/v0/jobs/{id}/artifact` — download a write-job's bundle to
   * `destPath` (v0.2 Task 8). The response is BINARY and potentially large,
   * so it is streamed straight to disk, never buffered: mirrors the
   * server-side `streamToFileCapped` semantics — the moment more than
   * `options.maxBytes` arrive, the partial file is deleted, the connection
   * aborted, and {@link HfpResponseTooLargeError} thrown.
   *
   * Returns the bundle's claimed tip from the `x-homefleet-head-commit`
   * response header; a 2xx response without a valid 40-hex value there is
   * refused with {@link ArtifactHeadCommitError} (the header is the
   * integrity anchor the apply step verifies the fetched ref against).
   * Non-2xx responses throw {@link HfpRequestError}, exactly like
   * {@link jobSnapshot}. Reuses {@link connectPinned}; the socket is always
   * destroyed on the way out, and `destPath` never survives a failure.
   */
  async fetchJobArtifact(
    target: HfpTarget,
    jobId: string,
    destPath: string,
    options: { maxBytes: number; idleTimeoutMs?: number },
  ): Promise<{ headCommit: string }> {
    const connectTimeoutMs = target.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const idleTimeoutMs =
      options.idleTimeoutMs ?? BUNDLE_UPLOAD_IDLE_TIMEOUT_MS;
    const { socket } = await this.connectPinned({
      host: target.host,
      port: target.port,
      expectedDeviceId: target.expectedDeviceId,
      timeoutMs: connectTimeoutMs,
    });
    let fileStarted = false;
    try {
      // Re-arm the inactivity timer for the (possibly long) download; a large
      // bundle on a slow link must not be mistaken for a stall.
      socket.removeAllListeners("timeout");
      socket.setTimeout(idleTimeoutMs, () => {
        socket.destroy(
          new HfpTimeoutError(target.host, target.port, idleTimeoutMs),
        );
      });

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            createConnection: () => socket,
            method: "GET",
            path: `${HFP_PATH_PREFIX}/jobs/${encodeURIComponent(jobId)}/artifact`,
            headers: { host: `${target.host}:${target.port}` },
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      });
      response.on("error", () => {});

      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        // Error bodies are small JSON HfpErrors: surface the same typed
        // error family as jobSnapshot.
        const bodyText = await readCappedBody(response, MAX_BODY_BYTES);
        throw buildRequestError(status, bodyText);
      }

      const headCommit = firstHeaderValue(response.headers[HEAD_COMMIT_HEADER]);
      if (headCommit === undefined || !COMMIT_HASH_RE.test(headCommit)) {
        throw new ArtifactHeadCommitError(headCommit);
      }

      fileStarted = true;
      const outcome = await streamResponseToFileCapped(
        response,
        destPath,
        options.maxBytes,
      );
      if (outcome === "too-large") {
        throw new HfpResponseTooLargeError(options.maxBytes);
      }
      return { headCommit };
    } catch (error) {
      if (fileStarted) {
        // Never leave a partial (or oversized) download behind. The socket
        // teardown below aborts the transfer; the write stream is already
        // closed by streamResponseToFileCapped before it settles.
        await rm(destPath, { force: true, maxRetries: 3 });
      }
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

  /**
   * `GET /hfp/v0/jobs/{id}/events` — stream a delegated job's events over SSE.
   *
   * Reuses {@link connectPinned} (the fingerprint pin is NOT reimplemented):
   * the verified socket is held for the stream's lifetime and destroyed when
   * the stream ends, the consumer stops early, or an error is thrown — the
   * ownership-transfer contract for the streaming path. Each SSE `data:`
   * record is parsed as one {@link JobEvent} (malformed records reject);
   * events are yielded in order and the iterator ends after the terminal
   * `result` event. `fromSeq` resumes from that seq via `Last-Event-ID`.
   * A pinning/handshake failure surfaces the same typed errors as
   * {@link request}.
   */
  async *streamJobEvents(
    target: HfpTarget,
    jobId: string,
    options: { fromSeq?: number; idleTimeoutMs?: number } = {},
  ): AsyncGenerator<JobEvent, void, unknown> {
    const timeoutMs = target.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    const { socket } = await this.connectPinned({
      host: target.host,
      port: target.port,
      expectedDeviceId: target.expectedDeviceId,
      timeoutMs,
    });
    try {
      // Re-arm the socket-inactivity timer for the (possibly sparse) streaming
      // phase. connectPinned used `timeoutMs` to bound connect + handshake;
      // here a longer idle timeout — reset by the server's SSE heartbeats and
      // by every event — lets a live stream run indefinitely while a silent or
      // half-open peer still trips it, so the iterator can never hang forever.
      // Replace connectPinned's handler so the timeout error carries the
      // stream idle timeout rather than the connect one.
      socket.removeAllListeners("timeout");
      socket.setTimeout(idleTimeoutMs, () => {
        socket.destroy(
          new HfpTimeoutError(target.host, target.port, idleTimeoutMs),
        );
      });

      const headers: Record<string, string> = {
        host: `${target.host}:${target.port}`,
        accept: "text/event-stream",
      };
      const { fromSeq } = options;
      if (fromSeq !== undefined && Number.isInteger(fromSeq) && fromSeq > 0) {
        // "I already have through fromSeq-1" -> server resumes at fromSeq.
        headers["last-event-id"] = String(fromSeq - 1);
      }

      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            createConnection: () => socket,
            method: "GET",
            path: `${HFP_PATH_PREFIX}/jobs/${encodeURIComponent(jobId)}/events`,
            headers,
          },
          resolve,
        );
        req.on("error", reject);
        req.end();
      });
      // A late error (e.g. from the socket.destroy below) must not go unhandled.
      response.on("error", () => {});

      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        // Unknown/unowned job (or any error) arrives as a JSON body before
        // the stream opens: surface the same typed error as request().
        const bodyText = await readCappedBody(response, MAX_BODY_BYTES);
        throw buildRequestError(status, bodyText);
      }

      yield* parseSseEvents(response);
    } catch (error) {
      // A tripped idle timeout destroys the socket with HfpTimeoutError, but
      // the failure usually surfaces through the response stream as a generic
      // abort/reset; re-raise the typed timeout (mirrors rawRequest).
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

/**
 * Parses an SSE response into ordered {@link JobEvent}s, tolerating chunk
 * boundaries that split a record (incl. multi-byte UTF-8, via StringDecoder)
 * and ending after the terminal `result` event. Comment lines (`:` — the
 * server's heartbeats) and `id:` lines carry no payload and are skipped: the
 * seq travels inside the event JSON.
 */
async function* parseSseEvents(
  response: IncomingMessage,
): AsyncGenerator<JobEvent, void, unknown> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let totalBytes = 0;
  let dataLines: string[] = [];
  // Byte size of the in-progress record's accumulated `data:` content, so the
  // per-event cap is byte-accurate like the total cap (a string's `.length`
  // is UTF-16 code units, which undercounts multi-byte characters).
  let dataBytes = 0;

  for await (const chunk of response) {
    const bytes = chunk as Buffer;
    totalBytes += bytes.length;
    if (totalBytes > MAX_SSE_TOTAL_BYTES) {
      throw new HfpResponseTooLargeError(MAX_SSE_TOTAL_BYTES);
    }
    buffer += decoder.write(bytes);

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line === "") {
        const event = flushSseEvent(dataLines);
        dataLines = [];
        dataBytes = 0;
        if (event !== undefined) {
          yield event;
          if (event.type === "result") {
            return;
          }
        }
      } else if (line.startsWith("data:")) {
        // Strip one optional leading space after the colon (SSE convention).
        const content = line.slice(5).replace(/^ /, "");
        dataLines.push(content);
        dataBytes += Buffer.byteLength(content);
      }
      newlineIndex = buffer.indexOf("\n");
    }

    // The in-progress record is the buffered data-line content plus the
    // current unterminated trailing line; cap it in bytes.
    if (dataBytes + Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) {
      throw new HfpResponseTooLargeError(MAX_SSE_EVENT_BYTES);
    }
  }
}

/** Assembles buffered `data:` lines into one validated JobEvent, or nothing. */
function flushSseEvent(dataLines: string[]): JobEvent | undefined {
  if (dataLines.length === 0) {
    return undefined;
  }
  return JobEventSchema.parse(JSON.parse(dataLines.join("\n")));
}

/** First value of a possibly-repeated response header. */
function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Streams `response` to `filePath`, honoring backpressure, resolving
 * `"too-large"` the instant the received bytes exceed `maxBytes` (the caller
 * deletes the partial file and aborts the socket). The write stream is fully
 * closed before this settles — on Windows an open handle would block the
 * caller's cleanup `rm`. Mirrors the server-side `streamToFileCapped`.
 */
function streamResponseToFileCapped(
  response: IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<"ok" | "too-large"> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    let size = 0;
    let settled = false;
    // Settle only once the file handle is closed (destroy always emits
    // 'close'), so the caller can immediately rm the partial file.
    const settleOnClose = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      response.pause();
      out.once("close", outcome);
      out.destroy();
    };
    out.on("error", (error) => {
      settleOnClose(() => reject(error));
    });
    response.on("error", (error) => {
      settleOnClose(() => reject(error));
    });
    response.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        settleOnClose(() => resolve("too-large"));
        return;
      }
      if (!out.write(chunk)) {
        response.pause();
        out.once("drain", () => {
          if (!settled) {
            response.resume();
          }
        });
      }
    });
    response.on("end", () => {
      if (settled) {
        return;
      }
      // Do NOT mark settled yet: if the final flush fails, the 'error'
      // handler above must still be able to reject (the end callback only
      // runs on a clean finish).
      out.end(() => {
        if (!settled) {
          settled = true;
          resolve("ok");
        }
      });
    });
  });
}

/** Reads up to `limit` bytes of a (small, error) response body as text. */
async function readCappedBody(
  response: IncomingMessage,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total > limit) {
      break;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
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
