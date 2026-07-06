/**
 * HomeFleet Protocol (HFP) version, as a semver string.
 *
 * The HTTP path prefix is derived from the major version: `/hfp/v0`.
 * Nodes exchange their `protocolVersion` in `hello`; same-major versions
 * are expected to interoperate (see docs/rfc/hfp-v0.md, "Versioning").
 */
export const HFP_PROTOCOL_VERSION = "0.1.0";
