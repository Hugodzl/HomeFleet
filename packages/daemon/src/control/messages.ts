/**
 * Request/response shapes for the daemon control API (see control-server.ts
 * for the security model). Kept in a sibling module so the server file can
 * focus on HTTP wiring; these are intentionally tiny — control bodies carry
 * a host, a port, and a human-relayed pairing code, nothing larger.
 */
import { DeviceIdSchema } from "@homefleet/protocol";
import { z } from "zod";

/**
 * Body of `POST /control/pair/connect`: the CLI's outbound pairing attempt
 * against a peer at `host:port`, using the code the user read off that
 * peer's screen. `code` is intentionally NOT constrained to the protocol's
 * `PairRequestSchema` pattern here — a malformed code is the peer's problem
 * to reject (it validates its own `PairRequest`), and duplicating that regex
 * here would just be a second place for the two to drift.
 */
export const PairConnectRequestSchema = z.object({
  host: z.string().min(1),
  port: z.int().min(0).max(65535),
  code: z.string().min(1),
  expectedDeviceId: z.string().min(1).optional(),
});
export type PairConnectRequest = z.infer<typeof PairConnectRequestSchema>;

/**
 * Body of `POST /control/unpair`: the FULL device ID to revoke (64 lowercase
 * hex, the protocol's own DeviceIdSchema). Deliberately no name or prefix
 * matching here — resolving a human-typed name is the CLI's job
 * (../cli/unpair-target.ts); the route stays unambiguous so a future
 * dashboard control can reuse it as-is.
 */
export const UnpairRequestSchema = z.object({
  deviceId: DeviceIdSchema,
});
export type UnpairRequest = z.infer<typeof UnpairRequestSchema>;

/**
 * Body of `POST /control/upgrade` (fleet-upgrade spec). `targets` is "self"
 * (this node, the default), "fleet" (every reachable older peer, then this
 * node), or an explicit list of FULL paired device IDs (the CLI resolves
 * names; the daemon refuses ids that are not paired). `forceLocal` only
 * matters for a fleet rollout: it forces the requesting node's own upgrade.
 * `includeSelf: false` makes a rollout target peers only (the dashboard's
 * per-node button); it is meaningless for "self", so that combo is a 400.
 */
export const UpgradeRequestSchema = z
  .strictObject({
    targets: z
      .union([
        z.literal("self"),
        z.literal("fleet"),
        z.array(z.string().min(1)).min(1),
      ])
      .default("self"),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "must be X.Y.Z")
      .optional(),
    force: z.boolean().optional(),
    forceLocal: z.boolean().optional(),
    includeSelf: z.boolean().optional(),
  })
  .refine((r) => !(r.targets === "self" && r.includeSelf !== undefined), {
    message: 'includeSelf cannot be combined with targets "self"',
    path: ["includeSelf"],
  });
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;
