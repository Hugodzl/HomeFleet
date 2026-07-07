/**
 * UDP multicast discovery fallback, LocalSend-style (docs/rfc/hfp-v0.md,
 * "Discovery"): announce ourselves to the multicast group on start and on a
 * re-announce interval (UDP is lossy), reply to announces with a unicast
 * response so both sides learn each other, and never reply to a response —
 * the `kind` tag is the reply-storm guard.
 *
 * This socket receives untrusted bytes. Datagrams are size-capped before
 * parsing and zod-validated after; anything invalid — garbage bytes,
 * oversized payloads, valid JSON failing the schema, our own echo — is
 * dropped silently. Discovery never answers garbage.
 */
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import {
  DISCOVERY_MAX_DATAGRAM_BYTES,
  type DiscoveryAnnouncement,
  type DiscoveryDatagram,
  DiscoveryDatagramSchema,
} from "@homefleet/protocol";
import type { DiscoveryCandidate } from "./candidate.js";

/** Where announce datagrams are sent. */
export interface UdpSendTarget {
  address: string;
  port: number;
}

export interface UdpDiscoveryOptions {
  /** What this node advertises about itself. */
  announcement: DiscoveryAnnouncement;
  onCandidate: (candidate: DiscoveryCandidate) => void;
  /** Port to listen on; `0` binds an ephemeral port (tests). */
  udpPort: number;
  multicastGroup: string;
  /** How often to re-announce; UDP is lossy. */
  announceIntervalMs: number;
  /**
   * Interface-selection override (config `discovery.bindAddress`); applies
   * to the socket bind, the multicast membership, and the outgoing
   * multicast interface. Default: all interfaces.
   */
  bindAddress?: string;
  /**
   * Test seam: where announces are sent. Production default is the
   * multicast group at `udpPort` — tests inject a unicast target because
   * actual multicast delivery is unreliable on loopback/CI.
   */
  sendTarget?: UdpSendTarget;
  /** Injectable wall clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The UDP discovery channel. {@link UdpDiscovery.start} binds and sends the
 * first announce; {@link UdpDiscovery.stop} halts the re-announce timer and
 * closes the socket, leaving no open handles.
 */
export class UdpDiscovery {
  private readonly announcement: DiscoveryAnnouncement;
  private readonly onCandidate: (candidate: DiscoveryCandidate) => void;
  private readonly udpPort: number;
  private readonly multicastGroup: string;
  private readonly announceIntervalMs: number;
  private readonly bindAddress: string | undefined;
  private readonly sendTarget: UdpSendTarget;
  private readonly now: () => number;
  private socket: Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;

  constructor(options: UdpDiscoveryOptions) {
    this.announcement = options.announcement;
    this.onCandidate = options.onCandidate;
    this.udpPort = options.udpPort;
    this.multicastGroup = options.multicastGroup;
    this.announceIntervalMs = options.announceIntervalMs;
    this.bindAddress = options.bindAddress;
    this.sendTarget = options.sendTarget ?? {
      address: options.multicastGroup,
      port: options.udpPort,
    };
    this.now = options.now ?? Date.now;
  }

  /** Binds, joins the multicast group (best-effort), announces. */
  async start(): Promise<{ port: number }> {
    if (this.socket !== null) {
      throw new Error("UdpDiscovery is already started");
    }
    // reuseAddr: multiple daemons on one machine (and a daemon restarting
    // in TIME_WAIT conditions) must all be able to bind the discovery port.
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (message, rinfo) => {
      this.handleMessage(message, rinfo);
    });
    // Only claim `this.socket` after bind succeeds: a failed bind (e.g. a
    // bad bindAddress) must surface loudly and leave the instance
    // restartable, mirroring NodeServer.start.
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ port: this.udpPort, address: this.bindAddress }, () => {
        socket.removeListener("error", reject);
        resolve();
      });
    });
    // Post-bind async errors (e.g. a transient ECONNRESET surfaced by
    // Windows for an unreachable send target) must not crash the process.
    socket.on("error", () => {});
    try {
      // Best-effort: receiving multicast is a bonus, not a requirement.
      // Membership can fail on loopback-only binds and on adapters without
      // multicast (the known Windows VPN failure mode); unicast responses
      // and re-announces still work without it, and the other discovery
      // channels are unaffected.
      socket.addMembership(this.multicastGroup, this.bindAddress);
    } catch {
      // Tolerated; see above.
    }
    if (this.bindAddress !== undefined) {
      try {
        // Route outgoing multicast via the selected interface too.
        socket.setMulticastInterface(this.bindAddress);
      } catch {
        // Same best-effort stance as the membership above.
      }
    }
    this.socket = socket;
    this.sendDatagram("announce", this.sendTarget);
    this.announceTimer = setInterval(() => {
      this.sendDatagram("announce", this.sendTarget);
    }, this.announceIntervalMs);
    return { port: socket.address().port };
  }

  /** Idempotent: halts the timer and closes the socket. */
  async stop(): Promise<void> {
    if (this.announceTimer !== null) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    this.socket = null;
    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
  }

  private handleMessage(message: Buffer, rinfo: RemoteInfo): void {
    if (message.length > DISCOVERY_MAX_DATAGRAM_BYTES) {
      // Dropped before parsing; see the size cap's doc in the protocol.
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(message.toString("utf8"));
    } catch {
      return;
    }
    const parsed = DiscoveryDatagramSchema.safeParse(json);
    if (!parsed.success) {
      return;
    }
    const datagram = parsed.data;
    if (datagram.deviceId === this.announcement.deviceId) {
      // Our own multicast echo.
      return;
    }
    this.onCandidate({
      deviceId: datagram.deviceId,
      name: datagram.name,
      // The datagram's `port` is the peer's HFP port; the host is where the
      // datagram actually came from — payloads don't get to claim an
      // address.
      host: rinfo.address,
      port: datagram.port,
      source: "udp",
      lastSeenAt: this.now(),
    });
    if (datagram.kind === "announce") {
      // Unicast back so the announcer learns us. Never sent for a
      // `response` — that would be a reply storm.
      this.sendDatagram("response", {
        address: rinfo.address,
        port: rinfo.port,
      });
    }
  }

  private sendDatagram(
    kind: DiscoveryDatagram["kind"],
    target: UdpSendTarget,
  ): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    const datagram: DiscoveryDatagram = { ...this.announcement, kind };
    const payload = Buffer.from(JSON.stringify(datagram), "utf8");
    // Best-effort: a failed send (unreachable adapter, closed peer) is what
    // the re-announce interval exists for.
    socket.send(payload, target.port, target.address, () => {});
  }
}
