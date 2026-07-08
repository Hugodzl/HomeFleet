/**
 * The `homefleet` CLI's client for the daemon's loopback CONTROL API (see
 * ../control/control-server.ts for the routes and security model this talks
 * to).
 *
 * Deliberately thin: no retries, no connection pooling, no keep-alive tuning
 * — every CLI invocation is a one-shot process that makes at most a couple of
 * requests and exits. `fetch` is injectable (defaults to the global `fetch`)
 * so tests can supply either a fake implementation or point the real
 * implementation at a real, ephemeral-port control server (see
 * control-client.test.ts) without a live daemon.
 *
 * Response validation is intentionally MINIMAL, not a full zod re-parse of
 * the daemon's response schemas: the daemon and the CLI ship together (same
 * repo, same release), so a shape mismatch here means a bug in this repo, not
 * an adversarial or independently-versioned peer. What's checked is just
 * enough to fail closed with a clear message instead of `undefined` silently
 * flowing into the CLI's printers (e.g. `status.deviceId.slice(...)` throwing
 * a confusing `TypeError` deep in some formatting code).
 */
import {
  CONTROL_HEADER,
  type ControlStatus,
  type PairConnectSummary,
} from "../control/control-server.js";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";

/**
 * Thrown when the client could not even reach the daemon process — connection
 * refused/reset, DNS failure, etc. This is deliberately distinct from a
 * request that reached the daemon and got an error response ({@link
 * ControlRequestError}): the CLI catches THIS one specifically to print "is
 * homefleetd running?" instead of dumping a raw fetch stack trace (see
 * cli.ts's `withControlClient`).
 *
 * WHY this is detected structurally (any throw from `fetch()` itself) rather
 * than by matching `ECONNREFUSED` specifically: `fetch()` (Node's undici
 * implementation) throws ONLY for network/transport-level failures — a
 * non-2xx HTTP response still resolves normally. So any throw here already
 * means "the daemon could not be reached at all," and enumerating every
 * OS/transport errno (ECONNREFUSED, ECONNRESET, EHOSTUNREACH, ENOTFOUND, a
 * TLS failure, ...) would just be a second, incomplete copy of that same
 * fact.
 */
export class DaemonUnreachableError extends Error {
  readonly host: string;
  readonly port: number;

  constructor(host: string, port: number, cause: unknown) {
    super(
      `could not reach the homefleet daemon at ${host}:${port}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "DaemonUnreachableError";
    this.host = host;
    this.port = port;
  }
}

/**
 * Thrown when the daemon responded, but with a non-2xx status (e.g. a
 * validation error, or a pairing ATTEMPT that failed transport-wise — see
 * control-server.ts's `pairingErrorStatus`). Carries the daemon's own
 * `{error}` message when the body parsed as one.
 */
export class ControlRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ControlRequestError";
    this.status = status;
  }
}

export interface ControlClientOptions {
  host: string;
  port: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface PairConnectInput {
  host: string;
  port: number;
  code: string;
  expectedDeviceId?: string;
}

export interface PairBeginResult {
  code: string;
  expiresAt?: number;
}

/**
 * The client-facing surface `cli.ts` depends on. A structural interface
 * (rather than requiring the concrete {@link ControlClient} class) so tests
 * can drive `runCli` against a small hand-written fake with no HTTP involved
 * at all — see cli.test.ts.
 */
export interface ControlClientLike {
  pairBegin(): Promise<PairBeginResult>;
  pairConnect(input: PairConnectInput): Promise<PairConnectSummary>;
  status(): Promise<ControlStatus>;
  nodes(): Promise<NodeDirectoryEntry[]>;
}

// ---------------------------------------------------------------------------
// Minimal response validation (see the module header for why this isn't a
// full zod schema). Each `assert*` narrows via a type predicate/assertion so
// call sites read as plain field checks; each throws a message naming both
// the offending field and which response it came from.
// ---------------------------------------------------------------------------

function assertIsObject(
  value: unknown,
  what: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `control API returned a malformed ${what} response (expected a JSON object)`,
    );
  }
}

function assertString(
  value: unknown,
  field: string,
  what: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(
      `control API returned a malformed ${what} response (missing/invalid "${field}")`,
    );
  }
}

function assertNumber(
  value: unknown,
  field: string,
  what: string,
): asserts value is number {
  if (typeof value !== "number") {
    throw new Error(
      `control API returned a malformed ${what} response (missing/invalid "${field}")`,
    );
  }
}

function assertBoolean(
  value: unknown,
  field: string,
  what: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `control API returned a malformed ${what} response (missing/invalid "${field}")`,
    );
  }
}

function assertArray(
  value: unknown,
  field: string,
  what: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `control API returned a malformed ${what} response (missing/invalid "${field}")`,
    );
  }
}

function validatePairBeginResponse(json: unknown): PairBeginResult {
  assertIsObject(json, "pair/begin");
  assertString(json.code, "code", "pair/begin");
  if (json.expiresAt === undefined) {
    return { code: json.code };
  }
  assertNumber(json.expiresAt, "expiresAt", "pair/begin");
  return { code: json.code, expiresAt: json.expiresAt };
}

function validatePairConnectSummary(json: unknown): PairConnectSummary {
  assertIsObject(json, "pair/connect");
  assertBoolean(json.accepted, "accepted", "pair/connect");
  if (json.deviceId !== undefined) {
    assertString(json.deviceId, "deviceId", "pair/connect");
  }
  if (json.name !== undefined) {
    assertString(json.name, "name", "pair/connect");
  }
  // The remaining fields (deviceId/name) are only ever present together with
  // `accepted: true` per the server contract; a structural cast here is safe
  // because every field that IS present has just been type-checked above.
  return json as unknown as PairConnectSummary;
}

function validateControlStatus(json: unknown): ControlStatus {
  assertIsObject(json, "status");
  assertString(json.deviceId, "deviceId", "status");
  assertString(json.name, "name", "status");
  assertString(json.platform, "platform", "status");
  assertString(json.daemonVersion, "daemonVersion", "status");
  assertString(json.protocolVersion, "protocolVersion", "status");
  assertNumber(json.hfpPort, "hfpPort", "status");
  assertNumber(json.mcpPort, "mcpPort", "status");
  assertNumber(json.controlPort, "controlPort", "status");
  assertArray(json.roles, "roles", "status");
  assertArray(json.executors, "executors", "status");
  assertArray(json.models, "models", "status");
  assertNumber(json.activeJobs, "activeJobs", "status");
  assertNumber(json.maxConcurrentJobs, "maxConcurrentJobs", "status");
  return json as unknown as ControlStatus;
}

function validateNodeDirectoryEntry(
  json: unknown,
  index: number,
): NodeDirectoryEntry {
  const what = `nodes[${index}]`;
  assertIsObject(json, what);
  assertString(json.deviceId, "deviceId", what);
  assertString(json.name, "name", what);
  assertBoolean(json.reachable, "reachable", what);
  if (json.host !== undefined) {
    assertString(json.host, "host", what);
  }
  if (json.port !== undefined) {
    assertNumber(json.port, "port", what);
  }
  return json as unknown as NodeDirectoryEntry;
}

function validateNodesResponse(json: unknown): NodeDirectoryEntry[] {
  assertIsObject(json, "nodes");
  assertArray(json.nodes, "nodes", "nodes");
  return json.nodes.map((entry, index) =>
    validateNodeDirectoryEntry(entry, index),
  );
}

/**
 * Issues one request against the control API. Every request carries {@link
 * CONTROL_HEADER} (required by every route, see control-server.ts) — this is
 * the ONLY place that header is set, so every {@link ControlClient} method
 * automatically satisfies the server's CSRF check.
 */
async function controlRequest(
  options: ControlClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // IPv6 literals (e.g. "::1", schema-accepted for control.host — see
  // ../config/config.ts's LoopbackHostSchema) must be bracketed in a URL
  // authority ("[::1]"), or URL parsing (and thus `fetch`) throws. A bare
  // "::1" would otherwise make every request look like a transport failure
  // (see DaemonUnreachableError's doc) even though the daemon is reachable.
  const urlHost = options.host.includes(":")
    ? `[${options.host}]`
    : options.host;
  const url = `http://${urlHost}:${options.port}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        [CONTROL_HEADER]: "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    // See the DaemonUnreachableError class doc: any throw here is a
    // transport-level failure, never a non-2xx response.
    throw new DaemonUnreachableError(options.host, options.port, error);
  }

  const text = await response.text();
  let json: unknown = null;
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `control API returned invalid JSON (status ${response.status}): ` +
          `${text.slice(0, 200)}`,
        { cause },
      );
    }
  }

  if (!response.ok) {
    const message =
      json !== null &&
      typeof json === "object" &&
      "error" in json &&
      typeof (json as { error: unknown }).error === "string"
        ? (json as { error: string }).error
        : `control API request failed with status ${response.status}`;
    throw new ControlRequestError(response.status, message);
  }

  return json;
}

/**
 * The real control-API client: talks HTTP to a running daemon's control
 * server. See {@link ControlClientLike} for the interface `cli.ts` actually
 * depends on (tests use a fake satisfying that interface, not this class).
 */
export class ControlClient implements ControlClientLike {
  private readonly options: ControlClientOptions;

  constructor(options: ControlClientOptions) {
    this.options = options;
  }

  async pairBegin(): Promise<PairBeginResult> {
    const json = await controlRequest(
      this.options,
      "POST",
      "/control/pair/begin",
      {},
    );
    return validatePairBeginResponse(json);
  }

  async pairConnect(input: PairConnectInput): Promise<PairConnectSummary> {
    const json = await controlRequest(
      this.options,
      "POST",
      "/control/pair/connect",
      input,
    );
    return validatePairConnectSummary(json);
  }

  async status(): Promise<ControlStatus> {
    const json = await controlRequest(this.options, "GET", "/control/status");
    return validateControlStatus(json);
  }

  async nodes(): Promise<NodeDirectoryEntry[]> {
    const json = await controlRequest(this.options, "GET", "/control/nodes");
    return validateNodesResponse(json);
  }
}
