/**
 * mDNS discovery channel: advertise our announcement as a `_homefleet._tcp`
 * DNS-SD service and browse for peers (docs/rfc/hfp-v0.md, "Discovery").
 *
 * bonjour-service is wrapped behind the minimal {@link MdnsBackend}
 * interface so tests can inject a fake — real mDNS is not exercisable
 * deterministically in CI. Everything above the backend (TXT encode/decode,
 * label truncation, collision handling, candidate mapping) is real code
 * under test.
 *
 * Collision handling lives here, not in bonjour-service: v1.4.x detects a
 * probe conflict but only logs it (no error event, no rename), so we detect
 * collisions from browse results instead. The tie-break is deterministic —
 * the node with the lexicographically larger deviceId renames — so exactly
 * one side of a collision moves and a pair cannot rename-storm each other.
 * Browse results cannot see a publication that lost the probe race before
 * ever announcing, though, so each publication also arms a self-echo
 * watchdog: if our own browser has not echoed the current name back within
 * {@link SELF_ECHO_DEADLINE_MS}, the publication is presumed silently dead
 * and renamed through the same machinery.
 */
import {
  DISCOVERY_MDNS_SERVICE_TYPE,
  type DiscoveryAnnouncement,
  DiscoveryAnnouncementSchema,
} from "@homefleet/protocol";
import type { DiscoveryCandidate } from "./candidate.js";

/**
 * TXT record keys (RFC 6763 recommends short keys): `id` carries the
 * deviceId, `pv` the protocol version. Encode and decode live in this file,
 * so advertiser and browser cannot drift.
 */
const TXT_KEY_DEVICE_ID = "id";
const TXT_KEY_PROTOCOL_VERSION = "pv";

/** DNS labels — mDNS instance names included — are limited to 63 bytes. */
export const MAX_INSTANCE_LABEL_BYTES = 63;

/**
 * Renames attempted before giving up on collision resolution. Beyond this
 * something is systematically wrong (a peer mirroring our renames?) and
 * continuing would spam the network.
 */
const MAX_RENAME_ATTEMPTS = 10;

/**
 * How long a publication may go without our own browser echoing it back
 * before it is presumed killed at probe time (bonjour-service v1.4.x loses
 * a probe conflict silently — no announce, no error event). A healthy stack
 * completes probe + announce well under 2 s (RFC 6762: three probes 250 ms
 * apart, then announce), so 5 s clears slow networks with margin while
 * still recovering within seconds of the race.
 */
export const SELF_ECHO_DEADLINE_MS = 5_000;

export interface MdnsPublishRequest {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
}

/** A service found by the backend's browser. `txt` values are untrusted. */
export interface MdnsFoundService {
  type: string;
  name: string;
  port: number;
  txt: Record<string, unknown>;
  addresses: string[];
}

export interface MdnsPublication {
  stop(): Promise<void>;
}

export interface MdnsBrowser {
  stop(): void;
}

/**
 * The slice of bonjour-service the daemon uses. Tests inject a fake;
 * production uses `createBonjourBackend` (discovery/bonjour-backend.ts).
 */
export interface MdnsBackend {
  publish(request: MdnsPublishRequest): MdnsPublication;
  browse(type: string, onUp: (service: MdnsFoundService) => void): MdnsBrowser;
  /** Tears down the backend's sockets. */
  destroy(): Promise<void>;
}

/**
 * Truncates a name to `maxBytes` of UTF-8 without splitting a multi-byte
 * character.
 */
export function truncateInstanceLabel(
  name: string,
  maxBytes: number = MAX_INSTANCE_LABEL_BYTES,
): string {
  const bytes = Buffer.from(name, "utf8");
  if (bytes.length <= maxBytes) {
    return name;
  }
  let end = maxBytes;
  // A UTF-8 continuation byte is 0b10xxxxxx; if the byte just past the cut
  // is one, the cut would split a character — back up to its start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * The instance label for a rename attempt: attempt 1 is the bare name,
 * attempt n appends ` (n)` — always within the 63-byte label limit.
 */
function instanceLabel(name: string, attempt: number): string {
  if (attempt <= 1) {
    return truncateInstanceLabel(name);
  }
  const suffix = ` (${attempt})`;
  const budget = MAX_INSTANCE_LABEL_BYTES - Buffer.byteLength(suffix, "utf8");
  return `${truncateInstanceLabel(name, budget)}${suffix}`;
}

/** Encodes the TXT half of an announcement (port rides in the SRV record). */
export function encodeAnnouncementTxt(
  announcement: DiscoveryAnnouncement,
): Record<string, string> {
  return {
    [TXT_KEY_DEVICE_ID]: announcement.deviceId,
    [TXT_KEY_PROTOCOL_VERSION]: announcement.protocolVersion,
  };
}

/**
 * Reconstructs an announcement from a found service (instance name, SRV
 * port, TXT record). Returns `null` when validation fails — mDNS responses
 * are untrusted input and invalid services are dropped silently.
 */
export function decodeFoundService(
  service: MdnsFoundService,
): DiscoveryAnnouncement | null {
  const parsed = DiscoveryAnnouncementSchema.safeParse({
    deviceId: service.txt[TXT_KEY_DEVICE_ID],
    name: service.name,
    port: service.port,
    protocolVersion: service.txt[TXT_KEY_PROTOCOL_VERSION],
  });
  return parsed.success ? parsed.data : null;
}

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Picks the address to dial: the first IPv4 if any (the HFP transport dials
 * plain host strings and v4 is the LAN common denominator), else the first
 * address, else `null` (a service we cannot reach is not a candidate).
 */
function pickHost(addresses: string[]): string | null {
  return (
    addresses.find((address) => IPV4_PATTERN.test(address)) ??
    addresses[0] ??
    null
  );
}

/** DNS names are ASCII case-insensitive. */
function labelsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface MdnsDiscoveryOptions {
  backend: MdnsBackend;
  /** What this node advertises about itself. */
  announcement: DiscoveryAnnouncement;
  onCandidate: (candidate: DiscoveryCandidate) => void;
  /** Injectable wall clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable timers for the self-echo watchdog; default
   * `setTimeout`/`clearTimeout`. Tests drive the deadline manually — real
   * timers are not exercisable deterministically. A single pair so schedule
   * and cancel cannot be injected mismatched (an injected schedule with the
   * default cancel would never cancel anything).
   */
  timers?: {
    schedule: (callback: () => void, delayMs: number) => unknown;
    cancel: (handle: unknown) => void;
  };
}

/**
 * Advertises this node over mDNS and surfaces browsed peers as candidates.
 * Owns its backend: {@link MdnsDiscovery.stop} destroys it.
 */
export class MdnsDiscovery {
  private readonly backend: MdnsBackend;
  private readonly announcement: DiscoveryAnnouncement;
  private readonly onCandidate: (candidate: DiscoveryCandidate) => void;
  private readonly now: () => number;
  private readonly timers: Required<MdnsDiscoveryOptions>["timers"];
  private publication: MdnsPublication | null = null;
  private browser: MdnsBrowser | null = null;
  private currentName = "";
  private renameAttempt = 1;
  /**
   * The live watchdog's identity token — its callback renames only while
   * this still points at its own wrapper. Wrapping also keeps any scheduler
   * return value (`null` included) usable as a handle.
   */
  private echoWatchdog: { handle: unknown } | null = null;
  private state: "new" | "started" | "stopped" = "new";

  constructor(options: MdnsDiscoveryOptions) {
    this.backend = options.backend;
    this.announcement = options.announcement;
    this.onCandidate = options.onCandidate;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  start(): void {
    if (this.state !== "new") {
      throw new Error("MdnsDiscovery cannot be restarted");
    }
    this.state = "started";
    this.currentName = instanceLabel(this.announcement.name, 1);
    // Armed before publishing: a backend may deliver the echo synchronously
    // from publish(), and it must find the watchdog there to confirm.
    this.armEchoWatchdog();
    this.publication = this.publish();
    this.browser = this.backend.browse(DISCOVERY_MDNS_SERVICE_TYPE, (service) =>
      this.handleServiceUp(service),
    );
  }

  async stop(): Promise<void> {
    if (this.state !== "started") {
      return;
    }
    this.state = "stopped";
    this.cancelEchoWatchdog();
    this.browser?.stop();
    this.browser = null;
    const publication = this.publication;
    this.publication = null;
    if (publication !== null) {
      await publication.stop();
    }
    await this.backend.destroy();
  }

  private publish(): MdnsPublication {
    return this.backend.publish({
      name: this.currentName,
      type: DISCOVERY_MDNS_SERVICE_TYPE,
      port: this.announcement.port,
      txt: encodeAnnouncementTxt(this.announcement),
    });
  }

  private handleServiceUp(service: MdnsFoundService): void {
    if (this.state !== "started") {
      return;
    }
    const decoded = decodeFoundService(service);
    if (decoded !== null && decoded.deviceId === this.announcement.deviceId) {
      // Our own announcement echoed back. Only an echo of the CURRENT name
      // proves the live publication survived probing — a stale echo of a
      // pre-rename name says nothing about it and must not confirm.
      if (labelsEqual(service.name, this.currentName)) {
        this.cancelEchoWatchdog();
      }
      return;
    }
    if (
      labelsEqual(service.name, this.currentName) &&
      this.losesTieBreak(decoded)
    ) {
      this.rename();
    }
    if (decoded === null) {
      // Untrusted input that failed validation: drop silently.
      return;
    }
    const host = pickHost(service.addresses);
    if (host === null) {
      return;
    }
    this.onCandidate({
      deviceId: decoded.deviceId,
      name: decoded.name,
      host,
      port: decoded.port,
      source: "mdns",
      lastSeenAt: this.now(),
    });
  }

  /**
   * Collision tie-break: only a service that decodes to a DIFFERENT
   * deviceId is a rename-worthy collision, and of the two colliding nodes
   * only the one with the lexicographically larger deviceId renames — so
   * exactly one side moves. A same-name service whose TXT does not decode
   * is ignored: it may be a mangled echo of our own advertisement (renaming
   * would chase ourselves) or a garbage-TXT squatter (which never renames
   * in response, so yielding to it buys nothing).
   */
  private losesTieBreak(peer: DiscoveryAnnouncement | null): boolean {
    return peer !== null && peer.deviceId < this.announcement.deviceId;
  }

  private rename(): void {
    if (this.renameAttempt >= MAX_RENAME_ATTEMPTS) {
      return;
    }
    this.renameAttempt += 1;
    const previous = this.publication;
    if (previous !== null) {
      // Best-effort teardown of the colliding advertisement.
      void previous.stop().catch(() => {});
    }
    this.currentName = instanceLabel(
      this.announcement.name,
      this.renameAttempt,
    );
    // Re-armed (superseding any watchdog on the old name) before publishing
    // — see start() for why arming must precede publish().
    this.armEchoWatchdog();
    this.publication = this.publish();
  }

  /**
   * Arms (or re-arms) the watchdog for the publication about to be made: an
   * unconfirmed deadline means the publication was killed at probe time and
   * it renames like a browsed collision. Where self-echo never arrives at
   * all (e.g. multicast loopback disabled), this burns at most
   * {@link MAX_RENAME_ATTEMPTS} renames — `rename()` then declines and the
   * node stays on its last name, unconfirmed but quiet.
   */
  private armEchoWatchdog(): void {
    this.cancelEchoWatchdog();
    const wrapper: { handle: unknown } = { handle: null };
    wrapper.handle = this.timers.schedule(() => {
      // Only the live watchdog may rename. Every invalidation — stop(), a
      // confirming echo, supersession by a newer watchdog — moves
      // `echoWatchdog` off this wrapper, so the identity check makes a
      // late fire from a misbehaving injected scheduler a no-op (the
      // built-in timers never fire after clearTimeout).
      if (this.echoWatchdog !== wrapper) {
        return;
      }
      this.echoWatchdog = null;
      this.rename();
    }, SELF_ECHO_DEADLINE_MS);
    this.echoWatchdog = wrapper;
  }

  private cancelEchoWatchdog(): void {
    if (this.echoWatchdog !== null) {
      this.timers.cancel(this.echoWatchdog.handle);
      this.echoWatchdog = null;
    }
  }
}
