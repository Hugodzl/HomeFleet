/**
 * HFP job-dispatch routes (M5), registered on a {@link NodeServer}. Every
 * route runs AFTER the server's identify-peer → paired chokepoint, so the
 * peer's device ID (`peer.deviceId`) is the job owner and is never null on a
 * `paired` route.
 *
 *   POST /hfp/v0/jobs             -> DelegateResponse   (submit)
 *   GET  /hfp/v0/jobs/{id}        -> JobSnapshot        (poll)
 *   GET  /hfp/v0/jobs/{id}/events -> text/event-stream  (subscribe)
 *   POST /hfp/v0/jobs/{id}/cancel -> CancelResponse     (cancel)
 *
 * Worker-side failures map to HTTP via {@link statusForCode} with an
 * `HfpError` JSON body: UNKNOWN_JOB → 404 (identical for absent and
 * non-owned, so existence never leaks), BUSY → 503, UNSUPPORTED_JOB_TYPE →
 * 400. Result-carried failures (e.g. WORKSPACE_UNAVAILABLE) are 200 job
 * results, not route errors.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DelegateRequestSchema,
  DelegateResponseSchema,
  type HfpError,
  type HfpErrorCode,
  type JobEvent,
} from "@homefleet/protocol";
import { z } from "zod";
import type { NodeServer } from "../transport/server.js";
import { JobDispatchError } from "./job.js";
import type { JobManager } from "./job-manager.js";

/** Bodyless routes still go through `route()`, which parses a body: accept none. */
const NO_BODY_SCHEMA = z.unknown();

/** Interval between SSE keepalive comments, so a slow job's socket stays live. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Registers the four job-dispatch routes against `manager`. */
export function registerJobRoutes(
  server: NodeServer,
  manager: JobManager,
): void {
  server.route(
    "POST",
    "/jobs",
    { schema: DelegateRequestSchema },
    ({ body, peer }) => {
      const owner = requireOwner(peer.deviceId);
      try {
        const { jobId } = manager.submit(body.params, owner);
        return { status: 200, body: DelegateResponseSchema.parse({ jobId }) };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.route(
    "GET",
    "/jobs/:id",
    { schema: NO_BODY_SCHEMA },
    ({ peer, params }) => {
      const owner = requireOwner(peer.deviceId);
      try {
        return { status: 200, body: manager.snapshot(params.id ?? "", owner) };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.route(
    "POST",
    "/jobs/:id/cancel",
    { schema: NO_BODY_SCHEMA },
    async ({ peer, params }) => {
      const owner = requireOwner(peer.deviceId);
      try {
        return {
          status: 200,
          body: await manager.cancel(params.id ?? "", owner),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.routeStream("GET", "/jobs/:id/events", {}, (context) => {
    handleEventsStream(
      manager,
      context.peer.deviceId,
      context.params.id ?? "",
      context.req,
      context.res,
    );
  });
}

/** Opens (or refuses) the SSE stream for one job. */
function handleEventsStream(
  manager: JobManager,
  deviceId: string | null,
  jobId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // Ownership is checked BEFORE any SSE header is written, so an absent or
  // non-owned job gets a plain JSON 404 (never a stream that then reveals
  // nothing).
  let owner: string;
  try {
    owner = requireOwner(deviceId);
    manager.snapshot(jobId, owner);
  } catch (error) {
    const { status, body } = errorResult(error);
    sendJson(res, status, body);
    return;
  }

  const fromSeq = parseLastEventId(req.headers["last-event-id"]);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Defeat proxy buffering (nginx and friends honor this hint).
    "x-accel-buffering": "no",
  });

  let ended = false;
  let unsubscribe = (): void => {};
  // Heartbeat keeps a sparse stream's socket active; unref'd so it can never
  // hold the event loop open, and cleared on end regardless.
  const heartbeat = setInterval(() => {
    write(": keepalive\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  function write(chunk: string): void {
    // Shield writes: a dead socket must not crash the daemon (M4 discipline).
    try {
      res.write(chunk);
    } catch {
      end();
    }
  }

  function end(): void {
    if (ended) {
      return;
    }
    ended = true;
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // Already torn down.
    }
  }

  // Client disconnect (socket closed before the terminal event) frees the
  // subscription; 'close' also fires after our own res.end(), guarded by
  // `ended`. A genuine response 'error' (e.g. ECONNRESET on a half-open
  // socket) routes to the same cleanup so it never surfaces as an unhandled
  // error.
  res.on("close", end);
  res.on("error", end);

  const subscription = manager.subscribe(jobId, owner, fromSeq, {
    onEvent: (event) => {
      writeEvent(event);
      if (event.type === "result") {
        end();
      }
    },
    onClose: end,
  });
  unsubscribe = subscription.unsubscribe;
  // Terminal-at-subscribe (including a Last-Event-ID past the final seq, where
  // nothing was replayed): the buffered replay already ran, so end now.
  if (subscription.isTerminal) {
    end();
  }

  function writeEvent(event: JobEvent): void {
    // One SSE record: `id:` = seq (so Last-Event-ID resumes), `data:` = the
    // event JSON on a single line.
    write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

/** Reads a non-negative `Last-Event-ID`; resume starts at that seq + 1. */
function parseLastEventId(header: string | string[] | undefined): number {
  if (typeof header !== "string") {
    return 0;
  }
  const value = Number.parseInt(header, 10);
  if (!Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value + 1;
}

/** Paired routes always have a device ID; guard defensively. */
function requireOwner(deviceId: string | null): string {
  if (deviceId === null) {
    throw new JobDispatchError("UNAUTHORIZED", "peer is not identified");
  }
  return deviceId;
}

function errorResult(error: unknown): { status: number; body: HfpError } {
  if (error instanceof JobDispatchError) {
    return { status: statusForCode(error.code), body: error.toHfpError() };
  }
  return { status: 500, body: { code: "INTERNAL", message: "internal error" } };
}

/** Maps an HFP error code to the HTTP status the route answers with. */
export function statusForCode(code: HfpErrorCode): number {
  switch (code) {
    case "UNAUTHORIZED":
      return 401;
    case "UNKNOWN_JOB":
      return 404;
    case "BUSY":
      return 503;
    case "UNSUPPORTED_JOB_TYPE":
      return 400;
    default:
      return 400;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    try {
      res.end();
    } catch {
      // Already torn down.
    }
  }
}
