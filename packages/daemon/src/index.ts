/**
 * homefleetd — the HomeFleet per-machine daemon.
 *
 * M2 surface: device identity, trust store, mTLS transport with fingerprint
 * pinning, and the pairing-code flow. Discovery (M3) and job dispatch (M5)
 * build on these.
 */
export { resolveDataDir } from "./config/paths.js";
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
  FingerprintMismatchError,
  HfpClient,
  HfpRequestError,
  type HfpRequestOptions,
  type HfpTarget,
  type PairTarget,
} from "./transport/client.js";
export {
  MAX_BODY_BYTES,
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
