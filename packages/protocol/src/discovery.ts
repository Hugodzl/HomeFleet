/**
 * LAN discovery: the payload a node advertises so peers can find connection
 * candidates before any pairing or connection happens.
 *
 * Discovery is a hint channel, not a capabilities exchange (that is `hello`).
 * Announcements are UNAUTHENTICATED HINTS: receivers validate them (schema +
 * size cap) but they never establish trust or identity — identity is only
 * ever established by the mTLS fingerprint pin at connect time (ADR-0004). A
 * forged announcement can at worst cause a connection attempt that fails the
 * pin. Spec: docs/rfc/hfp-v0.md, "Discovery".
 */
import { z } from "zod";
import { DeviceIdSchema, NodeNameSchema, SemverSchema } from "./node.js";

/**
 * mDNS/DNS-SD service type; advertised on the wire as `_homefleet._tcp`
 * (bonjour-style libraries take the bare name and add the underscores).
 */
export const DISCOVERY_MDNS_SERVICE_TYPE = "homefleet";

/** Default multicast group for the UDP discovery fallback. */
export const DISCOVERY_MULTICAST_GROUP = "239.255.42.98";

/** Default UDP port for the multicast discovery fallback. */
export const DISCOVERY_UDP_PORT = 56371;

/**
 * Maximum size of a UDP discovery datagram. The discovery port receives
 * untrusted bytes; oversized (and otherwise invalid) datagrams are dropped
 * silently, without parsing.
 */
export const DISCOVERY_MAX_DATAGRAM_BYTES = 4096;

export const DiscoveryAnnouncementSchema = z.object({
  /** Claimed device ID — a routing/dedup hint only, never an identity. */
  deviceId: DeviceIdSchema,
  name: NodeNameSchema,
  /** The node's HFP HTTPS port. */
  port: z.int().min(1).max(65535),
  protocolVersion: SemverSchema,
});
export type DiscoveryAnnouncement = z.infer<typeof DiscoveryAnnouncementSchema>;

/**
 * UDP wire format: an announcement tagged with `kind`. Nodes reply to an
 * `announce` with a unicast `response` (so both sides learn each other) and
 * MUST NOT reply to a `response` — that tag is what prevents reply storms.
 */
export const DiscoveryDatagramSchema = DiscoveryAnnouncementSchema.extend({
  kind: z.enum(["announce", "response"]),
});
export type DiscoveryDatagram = z.infer<typeof DiscoveryDatagramSchema>;
