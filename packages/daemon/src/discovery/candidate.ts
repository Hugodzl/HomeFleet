/**
 * The discovery module's output shape: a connection candidate — enough to
 * attempt an HFP connection, and nothing more. Candidates are unauthenticated
 * hints (see docs/rfc/hfp-v0.md, "Discovery"); consumers establish identity
 * via the mTLS fingerprint pin at connect time (ADR-0004).
 */

/** Which discovery channel produced a candidate. */
export type DiscoverySource = "mdns" | "udp" | "static";

export interface DiscoveryCandidate {
  /** Claimed device ID, when the source carried one — a dedup hint only. */
  deviceId?: string;
  /** Human-readable node name, when the source carried one. */
  name?: string;
  host: string;
  /** The candidate's HFP HTTPS port. */
  port: number;
  source: DiscoverySource;
  /** Latest sighting, in ms since epoch. */
  lastSeenAt: number;
}
