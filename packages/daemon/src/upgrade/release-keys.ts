/**
 * Ed25519 public keys that may sign HomeFleet release manifests, as base64
 * SPKI DER (the output of `pnpm release:keygen`). A LIST so a key can be
 * rotated: ship the new key alongside the old one for at least one release
 * before signing with it. The matching private key lives only in the
 * `HOMEFLEET_RELEASE_KEY` GitHub secret (see docs/reference/releasing.md).
 *
 * The first key was generated 2026-10-18 (plan Task 4).
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEAGDBUSlqhDcOtFkphquy+YEfyVr4/Gp9Qx/BI5+KXZ8I=",
];
