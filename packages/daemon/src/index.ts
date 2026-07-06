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
