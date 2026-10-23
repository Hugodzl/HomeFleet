/**
 * Fleet upgrade over HFP (see docs/rfc/hfp-v0.md, "Upgrade"): a paired peer
 * pushes a signed release manifest, and the receiver verifies it with its own
 * pinned key before installing. The wire carries the exact signed bytes
 * (base64), never a re-serialized manifest, so the signature stays checkable.
 */
import { z } from "zod";
import { SemverSchema } from "./semver.js";

/**
 * `POST /hfp/v0/upgrade` request. `manifest` is the base64 of the exact signed
 * manifest bytes; `signature` is the base64 detached signature (the `.sig`
 * file's content).
 */
export const UpgradeRequestSchema = z.object({
  version: SemverSchema,
  manifest: z.base64(),
  signature: z.base64(),
});
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;

/**
 * `POST /hfp/v0/upgrade` 202 response: signature and guards passed, the
 * install proceeds asynchronously.
 */
export const UpgradeAcceptedSchema = z.object({
  accepted: z.literal(true),
  version: SemverSchema,
});
export type UpgradeAccepted = z.infer<typeof UpgradeAcceptedSchema>;

/** `NodeInfo.upgrade`: whether this node accepts remotely pushed upgrades. */
export const UpgradeInfoSchema = z.object({
  allowRemote: z.boolean(),
});
export type UpgradeInfo = z.infer<typeof UpgradeInfoSchema>;

/**
 * `NodeInfo.lastUpgrade`: outcome of the node's most recent self-upgrade.
 * `at` is an ISO 8601 UTC string on the wire.
 */
export const LastUpgradeSchema = z.object({
  version: SemverSchema,
  outcome: z.enum(["succeeded", "rolled-back", "failed"]),
  reason: z.string().optional(),
  at: z.iso.datetime(),
});
export type LastUpgrade = z.infer<typeof LastUpgradeSchema>;
