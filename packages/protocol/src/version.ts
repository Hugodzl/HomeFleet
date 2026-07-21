/**
 * HomeFleet Protocol (HFP) version, as a semver string.
 *
 * Nodes exchange their `protocolVersion` in `hello`; same-major versions
 * are expected to interoperate (see docs/rfc/hfp-v0.md, "Versioning").
 */
export const HFP_PROTOCOL_VERSION = "0.3.0";

/**
 * HTTP path prefix for all HFP endpoints (`/hfp/v0`), derived from the major
 * version of `HFP_PROTOCOL_VERSION` so the transport layer cannot drift.
 */
export const HFP_PATH_PREFIX = `/hfp/v${HFP_PROTOCOL_VERSION.split(".")[0] ?? ""}`;
