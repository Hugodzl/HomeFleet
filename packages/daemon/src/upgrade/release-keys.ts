/**
 * Ed25519 public keys that may sign HomeFleet release manifests, as base64
 * SPKI DER (the output of `pnpm release:keygen`). A LIST so a key can be
 * rotated: ship the new key alongside the old one for at least one release
 * before signing with it. The matching private key lives only in the
 * `HOMEFLEET_RELEASE_KEY` GitHub secret (see docs/reference/releasing.md).
 *
 * Empty until the real key is generated (plan Task 4) — with no pinned key
 * every verification fails closed.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];
