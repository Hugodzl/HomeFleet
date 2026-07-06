/**
 * Certificate fingerprinting (ADR-0004): a device's ID is the SHA-256 hash of
 * its certificate's DER encoding, as 64 lowercase hex characters.
 */
import { createHash } from "node:crypto";

/**
 * Computes the SHA-256 fingerprint of a certificate's DER bytes.
 *
 * The result is 64 lowercase hex characters and satisfies the protocol's
 * `DeviceIdSchema` — this *is* the device ID (ADR-0004).
 */
export function certFingerprint(der: ArrayBuffer | Uint8Array): string {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  return createHash("sha256").update(bytes).digest("hex");
}
