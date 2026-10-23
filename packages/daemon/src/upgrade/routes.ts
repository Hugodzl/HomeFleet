/**
 * The peer-facing upgrade endpoints (see docs/rfc/hfp-v0.md, "Upgrade"):
 * `POST /upgrade` accepts a signed push from a paired peer, and `GET
 * /upgrade/tarball/:version` serves a release this node has cached AND
 * re-verified, so peers can pull it over the LAN instead of GitHub.
 *
 * Security: the tarball route never builds a path from the request. The
 * version must be strict X.Y.Z and `readVerifiedCache` must confirm the
 * cached copy (signature + hash) before a single byte is streamed. The push
 * route keeps the protocol schema on the body so `version` is strict semver
 * before the coordinator builds any source from it.
 */
import { createReadStream } from "node:fs";
import type { ServerResponse } from "node:http";
import { type HfpErrorCode, UpgradeRequestSchema } from "@homefleet/protocol";
import { statusForCode } from "../jobs/routes.js";
import type { HfpClient } from "../transport/client.js";
import type { NodeServer } from "../transport/server.js";
import type { UpgradeCoordinator } from "./coordinator.js";
import { UpgradeError, type UpgradeErrorCode } from "./errors.js";
import { readVerifiedCache } from "./prepare.js";
import { isSemver } from "./semver.js";

export interface UpgradeRouteDeps {
  coordinator: UpgradeCoordinator;
  client: HfpClient;
  upgradesDir: string;
  /** Test seam; defaults to the pinned RELEASE_PUBLIC_KEYS. */
  publicKeys?: readonly string[];
}

function wireCode(code: UpgradeErrorCode): HfpErrorCode {
  switch (code) {
    case "disabled":
      return "UPGRADE_DISABLED";
    case "locked":
    case "busy":
      return "UPGRADE_BUSY";
    default:
      return "UPGRADE_REJECTED";
  }
}

/**
 * What a refused push tells the requesting peer: the guards word some
 * refusals for this node's own operator (its local paths, `--force`), which
 * mean nothing — or too much — over there.
 */
export function peerFacingMessage(error: UpgradeError): string {
  return error.peerMessage ?? error.message;
}

export function registerUpgradeRoutes(
  server: NodeServer,
  deps: UpgradeRouteDeps,
): void {
  const { coordinator, client, upgradesDir, publicKeys } = deps;

  server.route(
    "POST",
    "/upgrade",
    { schema: UpgradeRequestSchema },
    async ({ body, peer }) => {
      try {
        const { version } = await coordinator.acceptRemote({
          request: body,
          requesterDeviceId: peer.deviceId ?? "",
          client,
        });
        return { status: 202, body: { accepted: true, version } };
      } catch (error) {
        if (!(error instanceof UpgradeError)) {
          return {
            status: 500,
            body: { code: "INTERNAL", message: "internal error" },
          };
        }
        const code = wireCode(error.code);
        return {
          status: statusForCode(code),
          body: {
            code,
            message: peerFacingMessage(error),
            ...(code === "UPGRADE_REJECTED"
              ? { details: { reason: error.code } }
              : {}),
          },
        };
      }
    },
  );

  server.routeStream(
    "GET",
    "/upgrade/tarball/:version",
    {},
    async (context) => {
      const version = context.params.version ?? "";
      const prepared = isSemver(version)
        ? await readVerifiedCache(upgradesDir, version, publicKeys)
        : undefined;
      const res = context.res;
      if (prepared === undefined) {
        sendNotCached(res);
        return;
      }
      // As handleArtifactDownload: headers only once the file is OPEN, so a
      // vanished file is a clean JSON 404; a mid-flight error destroys the
      // response rather than ending a promised-length body early.
      const file = createReadStream(prepared.tarballPath);
      file.on("open", () => {
        try {
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": prepared.manifest.size,
          });
        } catch {
          file.destroy();
          return;
        }
        file.pipe(res);
      });
      file.on("error", () => {
        if (!res.headersSent) {
          sendNotCached(res);
        } else {
          res.destroy();
        }
      });
      res.on("close", () => file.destroy());
      res.on("error", () => file.destroy());
    },
  );
}

function sendNotCached(res: ServerResponse): void {
  const payload = JSON.stringify({
    code: "INVALID_REQUEST",
    message: "release not cached",
  });
  try {
    res.writeHead(404, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    // Already torn down.
  }
}
