/**
 * Pairing-code flow (ADR-0004): a short human-relayed code confirms
 * certificate fingerprints out-of-band. The user reads the code off one
 * machine and enters it on the other; a correct code makes both sides
 * persist each other's device ID.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import type { NodeInfo, PairRequest, PairResponse } from "@homefleet/protocol";
import type { TrustStore } from "../trust/trust-store.js";

/**
 * Pairing-code alphabet: A-Z and 0-9 minus the ambiguous 0/O and 1/I.
 * 32 symbols; an 8-char code gives 32^8 = 2^40 combinations.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of generated pairing codes. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * Wrong-code attempts allowed before the active code self-invalidates
 * (brute-force guard — see {@link PairingManager.handlePairRequest}).
 */
export const MAX_PAIRING_FAILURES = 5;

/** Default pairing-code lifetime: 10 minutes. */
export const DEFAULT_PAIRING_TTL_MS = 10 * 60_000;

/**
 * Generates an 8-char pairing code from {@link PAIRING_CODE_ALPHABET} using
 * cryptographic randomness. The result satisfies the protocol's
 * `PairRequestSchema` code pattern (`^[A-Z0-9]{6,10}$`).
 */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Constant-time code comparison. Both codes are written into fixed-width
 * zero-filled buffers (codes are 6-10 ASCII chars by schema) so neither the
 * comparison time nor a length mismatch leaks how much of a guess matched.
 */
function pairingCodesEqual(a: string, b: string): boolean {
  const bufferA = Buffer.alloc(16);
  const bufferB = Buffer.alloc(16);
  bufferA.write(a, "utf8");
  bufferB.write(b, "utf8");
  return timingSafeEqual(bufferA, bufferB);
}

interface ActivePairingCode {
  code: string;
  expiresAt: number;
  failures: number;
}

export interface PairingManagerOptions {
  trustStore: TrustStore;
  /** Provides this node's own NodeInfo for accepted responses. */
  nodeInfoProvider: () => NodeInfo;
  /** Injectable wall clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Called when the brute-force guard burns the active code after
   * {@link MAX_PAIRING_FAILURES} wrong attempts, so a CLI/UI can tell the
   * user their code was invalidated (and why pairing suddenly stopped
   * working) rather than failing silently.
   */
  onBurn?: () => void;
}

/**
 * Owns the single active pairing code and decides incoming pair requests.
 *
 * Security properties:
 * - Wrong, expired, and missing codes all yield the same `{accepted: false}`
 *   — a prober learns nothing about whether pairing is even open.
 * - After {@link MAX_PAIRING_FAILURES} wrong-code attempts the active code is
 *   invalidated, so an attacker gets at most 5 guesses at the 2^40 code
 *   space per user-initiated pairing window (brute-force guard).
 * - The claimed `nodeInfo.deviceId` must equal the TLS-observed certificate
 *   fingerprint, so a peer cannot pair a device ID it does not hold the key
 *   for (spoofing guard).
 */
export class PairingManager {
  private readonly trustStore: TrustStore;
  private readonly nodeInfoProvider: () => NodeInfo;
  private readonly now: () => number;
  private readonly onBurn: (() => void) | undefined;
  private active: ActivePairingCode | null = null;

  constructor(options: PairingManagerOptions) {
    this.trustStore = options.trustStore;
    this.nodeInfoProvider = options.nodeInfoProvider;
    this.now = options.now ?? Date.now;
    this.onBurn = options.onBurn;
  }

  /**
   * Starts a pairing window: generates a fresh code valid for `ttlMs`.
   * There is at most one active code; calling again replaces it.
   */
  beginPairing(ttlMs: number = DEFAULT_PAIRING_TTL_MS): {
    code: string;
    expiresAt: number;
  } {
    const code = generatePairingCode();
    const expiresAt = this.now() + ttlMs;
    this.active = { code, expiresAt, failures: 0 };
    return { code, expiresAt };
  }

  /** Cancels the active pairing window, if any. */
  cancelPairing(): void {
    this.active = null;
  }

  /**
   * Decides an incoming pair request.
   *
   * @param request The validated `PairRequest` body.
   * @param peerDeviceId Fingerprint of the client certificate observed at
   *   the TLS layer — the identity that will be trusted on acceptance.
   * @param peerName Human-readable name to record for the peer.
   * @returns `{accepted: true, nodeInfo}` when the code matches and the
   *   claimed identity equals the TLS-observed one; `{accepted: false}` in
   *   every other case, deliberately without distinguishing why.
   */
  async handlePairRequest(
    request: PairRequest,
    peerDeviceId: string,
    peerName: string,
  ): Promise<PairResponse> {
    // Spoofing guard: the claimed identity must be the one presented at the
    // TLS layer. Does not count toward the failure budget — it is not a
    // code guess.
    if (request.nodeInfo.deviceId !== peerDeviceId) {
      return { accepted: false };
    }

    const active = this.active;
    if (active === null || this.now() >= active.expiresAt) {
      return { accepted: false };
    }

    if (!pairingCodesEqual(request.code, active.code)) {
      active.failures += 1;
      if (active.failures >= MAX_PAIRING_FAILURES) {
        // Brute-force guard: burn the code after too many wrong attempts.
        this.active = null;
        this.onBurn?.();
      }
      return { accepted: false };
    }

    // Correct code: consume it (single use), trust the peer, respond with
    // our own info so the caller can record us symmetrically.
    this.active = null;
    await this.trustStore.add({
      deviceId: peerDeviceId,
      name: peerName,
      addedAt: new Date(this.now()).toISOString(),
    });
    return { accepted: true, nodeInfo: this.nodeInfoProvider() };
  }
}
