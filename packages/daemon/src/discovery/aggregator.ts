/**
 * Discovery aggregator — the discovery module's public face. Merges the
 * three sources (mDNS, UDP multicast, static config entries) plus the
 * persisted known-nodes registry into one deduplicated stream of connection
 * candidates.
 *
 * Dedup rules: a candidate is keyed by deviceId when it has one, else by
 * host:port; an identified sighting absorbs the anonymous entry for the same
 * endpoint (deviceId beats host:port) and an anonymous sighting never
 * shadows an identified one; within a key, the latest sighting wins.
 *
 * Candidates are hints. This module emits them and nothing more —
 * connection establishment, pairing UX, and liveness are consumers' business
 * (M5+), and staleness is judged by consumers via `lastSeenAt`.
 */
import type { DiscoveryAnnouncement } from "@homefleet/protocol";
import type { DiscoveryConfig } from "../config/config.js";
import type { DiscoveryCandidate } from "./candidate.js";
import type { KnownNode, KnownNodesRegistry } from "./known-nodes.js";
import {
  createBonjourBackend,
  type MdnsBackend,
  MdnsDiscovery,
} from "./mdns.js";
import { staticNodeCandidates } from "./static.js";
import { UdpDiscovery, type UdpSendTarget } from "./udp.js";

export interface DiscoveryAggregatorOptions {
  config: DiscoveryConfig;
  /** What this node advertises about itself on every channel. */
  announcement: DiscoveryAnnouncement;
  /**
   * The persisted registry: its entries are surfaced as candidates at
   * startup (previously seen nodes are reachable before rediscovery), and
   * every live candidate carrying a deviceId is recorded back into it.
   */
  knownNodes: KnownNodesRegistry;
  /**
   * Called on every accepted (new or refreshed) candidate with the merged
   * entry. Snapshot alternative: {@link DiscoveryAggregator.candidates}.
   */
  onCandidate?: (candidate: DiscoveryCandidate) => void;
  /**
   * Receives background failures that must not crash discovery: mDNS socket
   * errors and known-nodes persist failures. Defaults to swallowing them —
   * discovery is best-effort by design.
   */
  onError?: (error: unknown) => void;
  /** Injectable wall clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable mDNS backend (tests); defaults to the real bonjour-service
   * backend bound per `config.bindAddress`.
   */
  mdnsBackend?: MdnsBackend;
  /** Test seam, forwarded to {@link UdpDiscovery}. */
  udpSendTarget?: UdpSendTarget;
}

/** Converts a persisted registry entry back into a startup candidate. */
function knownNodeToCandidate(node: KnownNode): DiscoveryCandidate {
  const candidate: DiscoveryCandidate = {
    deviceId: node.deviceId,
    host: node.host,
    port: node.port,
    source: node.source,
    lastSeenAt: Date.parse(node.lastSeenAt),
  };
  if (node.name !== undefined) {
    candidate.name = node.name;
  }
  return candidate;
}

export class DiscoveryAggregator {
  private readonly config: DiscoveryConfig;
  private readonly announcement: DiscoveryAnnouncement;
  private readonly knownNodes: KnownNodesRegistry;
  private readonly onCandidate: ((c: DiscoveryCandidate) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly now: () => number;
  private readonly injectedMdnsBackend: MdnsBackend | undefined;
  private readonly udpSendTarget: UdpSendTarget | undefined;

  /** Keyed by deviceId when known, else by `host:port`. */
  private readonly entries = new Map<string, DiscoveryCandidate>();
  private mdns: MdnsDiscovery | null = null;
  private udp: UdpDiscovery | null = null;
  private udpPort: number | null = null;
  /**
   * Chains known-nodes writes so stop() can await the lot; failures are
   * reported through onError and never break the chain.
   */
  private persistChain: Promise<void> = Promise.resolve();
  private state: "new" | "started" | "stopped" = "new";

  constructor(options: DiscoveryAggregatorOptions) {
    this.config = options.config;
    this.announcement = options.announcement;
    this.knownNodes = options.knownNodes;
    this.onCandidate = options.onCandidate;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.injectedMdnsBackend = options.mdnsBackend;
    this.udpSendTarget = options.udpSendTarget;
  }

  /** The UDP channel's bound port, when running (useful with `udpPort: 0`). */
  get udpBoundPort(): number | null {
    return this.udpPort;
  }

  /** A snapshot of the current candidates (copies). */
  candidates(): DiscoveryCandidate[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  async start(): Promise<void> {
    if (this.state !== "new") {
      throw new Error("DiscoveryAggregator cannot be restarted");
    }
    this.state = "started";

    // 1. Registry-backed candidates: reachable before rediscovery. Not
    //    persisted back — they came from the file.
    for (const node of this.knownNodes.list()) {
      this.ingest(knownNodeToCandidate(node), { persist: false });
    }

    // 2. Static config entries.
    for (const candidate of staticNodeCandidates(
      this.config.staticNodes,
      this.now(),
    )) {
      this.ingest(candidate, { persist: true });
    }

    // 3. Live channels.
    if (this.config.mdnsEnabled) {
      const backend =
        this.injectedMdnsBackend ??
        createBonjourBackend({
          bindAddress: this.config.bindAddress,
          onError: this.onError,
        });
      this.mdns = new MdnsDiscovery({
        backend,
        announcement: this.announcement,
        onCandidate: (candidate) => this.ingest(candidate, { persist: true }),
        now: this.now,
      });
      this.mdns.start();
    }
    if (this.config.udpEnabled) {
      this.udp = new UdpDiscovery({
        announcement: this.announcement,
        onCandidate: (candidate) => this.ingest(candidate, { persist: true }),
        udpPort: this.config.udpPort,
        multicastGroup: this.config.multicastGroup,
        announceIntervalMs: this.config.announceIntervalMs,
        bindAddress: this.config.bindAddress,
        sendTarget: this.udpSendTarget,
        now: this.now,
      });
      const { port } = await this.udp.start();
      this.udpPort = port;
    }
  }

  /**
   * Idempotent: tears down both live channels (sockets, browsers — no open
   * handles survive) and waits for queued known-nodes writes to land.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopped";
    const mdns = this.mdns;
    this.mdns = null;
    if (mdns !== null) {
      await mdns.stop();
    }
    const udp = this.udp;
    this.udp = null;
    this.udpPort = null;
    if (udp !== null) {
      await udp.stop();
    }
    await this.persistChain;
  }

  private ingest(
    candidate: DiscoveryCandidate,
    options: { persist: boolean },
  ): void {
    if (this.state !== "started") {
      return;
    }
    const endpointKey = `${candidate.host}:${candidate.port}`;
    let key: string;
    let existing: DiscoveryCandidate | undefined;
    if (candidate.deviceId !== undefined) {
      key = candidate.deviceId;
      // deviceId beats host:port: absorb the anonymous entry, if any.
      this.entries.delete(endpointKey);
      existing = this.entries.get(key);
    } else {
      // An anonymous sighting never shadows an identified entry for the
      // same endpoint — the identified one strictly carries more.
      for (const entry of this.entries.values()) {
        if (
          entry.deviceId !== undefined &&
          entry.host === candidate.host &&
          entry.port === candidate.port
        ) {
          return;
        }
      }
      key = endpointKey;
      existing = this.entries.get(key);
    }

    if (existing !== undefined && candidate.lastSeenAt < existing.lastSeenAt) {
      // Stale: we already hold a fresher sighting.
      return;
    }

    // Latest sighting wins, but a field the new sighting lacks (e.g. no
    // name on a static entry) never erases one we already know.
    const merged: DiscoveryCandidate = {
      host: candidate.host,
      port: candidate.port,
      source: candidate.source,
      lastSeenAt: candidate.lastSeenAt,
    };
    const deviceId = candidate.deviceId ?? existing?.deviceId;
    if (deviceId !== undefined) {
      merged.deviceId = deviceId;
    }
    const name = candidate.name ?? existing?.name;
    if (name !== undefined) {
      merged.name = name;
    }

    this.entries.set(key, merged);
    this.onCandidate?.({ ...merged });

    if (options.persist && merged.deviceId !== undefined) {
      this.queueRecord(merged.deviceId, merged);
    }
  }

  private queueRecord(deviceId: string, candidate: DiscoveryCandidate): void {
    const entry: KnownNode = {
      deviceId,
      host: candidate.host,
      port: candidate.port,
      lastSeenAt: new Date(candidate.lastSeenAt).toISOString(),
      source: candidate.source,
    };
    if (candidate.name !== undefined) {
      entry.name = candidate.name;
    }
    this.persistChain = this.persistChain
      .then(() => this.knownNodes.record(entry))
      .catch((error) => {
        // A failed persist must not kill discovery (or the chain); the
        // registry is an accelerator, not a source of truth.
        this.onError?.(error);
      });
  }
}
