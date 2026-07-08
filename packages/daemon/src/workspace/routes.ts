/**
 * HFP workspace-sync routes (M7, ADR-0005), registered on a {@link NodeServer}.
 * Both routes run AFTER the server's identify-peer → paired chokepoint, so only
 * a paired peer ever reaches them.
 *
 *   POST /hfp/v0/workspace/have    -> HaveTipResponse       (JSON)
 *   POST /hfp/v0/workspace/bundle  -> BundleUploadResponse  (binary upload)
 *
 * The bundle upload is a binary, potentially many-MiB body. It is NOT buffered
 * or base64'd: the handler streams the request body straight to a temp file,
 * aborting with 413 the instant it exceeds the store's `maxBundleBytes` cap
 * (streamed to disk — never the 1 MiB JSON body limit, never held in memory).
 * `repoId` and `headCommit` travel in request headers (a binary body is not
 * JSON-friendly), validated at the boundary. A non-allowlisted repo is rejected
 * BEFORE any byte is written, so a probe leaves nothing on disk.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  BundleUploadResponseSchema,
  HaveTipRequestSchema,
  HaveTipResponseSchema,
  type HfpError,
} from "@homefleet/protocol";
import type { NodeServer } from "../transport/server.js";
import { COMMIT_HASH_RE } from "./git.js";
import { WorkspaceError, type WorkspaceStore } from "./workspace-store.js";

/** Header carrying the (URL-encoded) repoId for the binary bundle upload. */
export const REPO_ID_HEADER = "x-homefleet-repo-id";
/** Header carrying the 40-hex headCommit the bundle claims to deliver. */
export const HEAD_COMMIT_HEADER = "x-homefleet-head-commit";

/** Registers the two workspace-sync routes against `store`. */
export function registerWorkspaceRoutes(
  server: NodeServer,
  store: WorkspaceStore,
): void {
  // have-tip: a small JSON query the delegator uses to pick full vs incremental.
  server.route(
    "POST",
    "/workspace/have",
    { schema: HaveTipRequestSchema },
    async ({ body }) => {
      try {
        const headCommit = await store.haveTip(body.repoId);
        return {
          status: 200,
          body: HaveTipResponseSchema.parse({ headCommit }),
        };
      } catch (error) {
        return workspaceErrorResult(error);
      }
    },
  );

  // bundle upload: inbound binary stream to a size-capped temp file, then apply.
  server.routeUpload("POST", "/workspace/bundle", {}, (context) =>
    handleBundleUpload(store, context.req, context.res),
  );
}

async function handleBundleUpload(
  store: WorkspaceStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const repoIdRaw = firstHeader(req.headers[REPO_ID_HEADER]);
  const headCommit = firstHeader(req.headers[HEAD_COMMIT_HEADER]);

  let repoId: string | undefined;
  if (repoIdRaw !== undefined) {
    try {
      repoId = decodeURIComponent(repoIdRaw);
    } catch {
      repoId = undefined; // malformed percent-encoding
    }
  }
  if (repoId === undefined || repoId === "" || headCommit === undefined) {
    respondAndDrain(req, res, 400, {
      code: "INVALID_REQUEST",
      message: `missing or invalid ${REPO_ID_HEADER}/${HEAD_COMMIT_HEADER} headers`,
    });
    return;
  }
  if (!COMMIT_HASH_RE.test(headCommit)) {
    respondAndDrain(req, res, 400, {
      code: "INVALID_REQUEST",
      message: "headCommit must be a 40-char lowercase hex commit hash",
    });
    return;
  }

  // Allowlist check BEFORE touching disk: a non-allowlisted repo writes nothing.
  if (!store.isAllowed(repoId)) {
    respondAndDrain(req, res, 403, {
      code: "WORKSPACE_UNAVAILABLE",
      message: "repo is not on this worker's allowlist",
      details: { repoId },
    });
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "homefleet-bundle-in-"));
  const bundlePath = path.join(tempDir, "upload.bundle");
  const cleanup = async (): Promise<void> => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  };

  try {
    const stream = await streamToFileCapped(
      req,
      bundlePath,
      store.maxBundleBytes,
    );
    if (stream === "too-large") {
      // Exceeded the cap: 413 and abort. The daemon survives (temp cleaned up).
      respondAndDrain(req, res, 413, {
        code: "INVALID_REQUEST",
        message: `bundle exceeds the ${store.maxBundleBytes}-byte limit`,
      });
      return;
    }
    if (stream === "error") {
      sendJson(res, 400, {
        code: "INVALID_REQUEST",
        message: "failed to receive the bundle body",
      });
      return;
    }

    await store.applyBundle(repoId, bundlePath, headCommit);
    sendJson(
      res,
      200,
      BundleUploadResponseSchema.parse({ ok: true, headCommit }),
    );
  } catch (error) {
    const { status, body } = workspaceErrorResult(error);
    sendJson(res, status, body);
  } finally {
    await cleanup();
  }
}

type StreamResult = "ok" | "too-large" | "error";

/**
 * Streams `req` to `filePath`, honoring backpressure, and returns `"too-large"`
 * the moment the received bytes exceed `maxBytes` (the partial file is
 * discarded by the caller's cleanup). Never buffers the whole body in memory.
 */
function streamToFileCapped(
  req: IncomingMessage,
  filePath: string,
  maxBytes: number,
): Promise<StreamResult> {
  return new Promise((resolve) => {
    const out = createWriteStream(filePath);
    let size = 0;
    let settled = false;
    const settle = (result: StreamResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    out.on("error", () => {
      settle("error");
    });
    req.on("error", () => {
      out.destroy();
      settle("error");
    });
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        out.destroy();
        settle("too-large");
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => {
          if (!settled) {
            req.resume();
          }
        });
      }
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      out.end(() => settle("ok"));
    });
  });
}

/** Maps a caught error to an HTTP status + HfpError body for a route result. */
function workspaceErrorResult(error: unknown): {
  status: number;
  body: HfpError;
} {
  if (error instanceof WorkspaceError) {
    return { status: statusForWorkspaceError(error), body: error.toHfpError() };
  }
  return { status: 500, body: { code: "INTERNAL", message: "internal error" } };
}

function statusForWorkspaceError(error: WorkspaceError): number {
  switch (error.code) {
    case "REPO_NOT_ALLOWED":
      return 403;
    case "NOT_SYNCED":
      return 404;
    case "BUNDLE_INVALID":
    case "COMMIT_NOT_DELIVERED":
      return 400;
    default:
      return 500;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
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

/**
 * Sends a JSON error, then destroys the request once the response is flushed —
 * so a still-uploading client does not leave a half-read socket dangling
 * (mirrors the server's 413 handling for JSON bodies).
 */
function respondAndDrain(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: HfpError,
): void {
  sendJson(res, status, body);
  res.once("finish", () => req.destroy());
}
