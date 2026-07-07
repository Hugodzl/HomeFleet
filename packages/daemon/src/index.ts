/**
 * homefleetd — the HomeFleet per-machine daemon.
 *
 * M2 surface: device identity, trust store, mTLS transport with fingerprint
 * pinning, and the pairing-code flow. M3 adds LAN discovery (mDNS + UDP
 * multicast + static entries, merged by the aggregator) and the daemon
 * config file. Job dispatch (M5) builds on these.
 */
export {
  type DaemonConfig,
  DaemonConfigSchema,
  type DiscoveryConfig,
  DiscoveryConfigSchema,
  loadDaemonConfig,
  type StaticNode,
  StaticNodeSchema,
} from "./config/config.js";
export { resolveDataDir } from "./config/paths.js";
export {
  DiscoveryAggregator,
  type DiscoveryAggregatorOptions,
  LAST_SEEN_PERSIST_THRESHOLD_MS,
} from "./discovery/aggregator.js";
export type {
  DiscoveryCandidate,
  DiscoverySource,
} from "./discovery/candidate.js";
export {
  type KnownNode,
  KnownNodeSchema,
  KnownNodesRegistry,
  MAX_KNOWN_NODES,
} from "./discovery/known-nodes.js";
export type {
  MdnsBackend,
  MdnsBrowser,
  MdnsFoundService,
  MdnsPublication,
  MdnsPublishRequest,
} from "./discovery/mdns.js";
export type { UdpSendTarget } from "./discovery/udp.js";
export { certFingerprint } from "./identity/fingerprint.js";
export { type Identity, loadOrCreateIdentity } from "./identity/identity.js";
export {
  DEFAULT_PAIRING_TTL_MS,
  generatePairingCode,
  MAX_PAIRING_FAILURES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingManager,
  type PairingManagerOptions,
} from "./pairing/pairing.js";
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  FingerprintMismatchError,
  HfpClient,
  HfpRequestError,
  type HfpRequestOptions,
  HfpResponseTooLargeError,
  type HfpTarget,
  HfpTimeoutError,
  MissingServerCertificateError,
  type PairTarget,
} from "./transport/client.js";
export { MAX_BODY_BYTES } from "./transport/limits.js";
export {
  NodeServer,
  type NodeServerOptions,
  type PeerInfo,
  type RouteAuth,
  type RouteContext,
  type RouteHandler,
  type RouteOptions,
  type RouteResult,
} from "./transport/server.js";
export {
  type TrustedDevice,
  TrustedDeviceSchema,
  TrustStore,
} from "./trust/trust-store.js";
