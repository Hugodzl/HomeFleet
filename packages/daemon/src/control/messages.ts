/**
 * Request/response shapes for the daemon control API (see control-server.ts
 * for the security model). Kept in a sibling module so the server file can
 * focus on HTTP wiring; these are intentionally tiny — control bodies carry
 * a host, a port, and a human-relayed pairing code, nothing larger.
 */
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
