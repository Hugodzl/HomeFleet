/**
 * Fleet rollout: push a signed release to each older peer one at a time, watch
 * it restart, stop at the first rollback/failure/timeout, and upgrade the
 * requesting node last.
 *
 * It runs inside the requesting daemon on purpose: the loop outlives the CLI
 * that started it, and the dashboard can reuse it. The logic is pure over the
 * narrow `RolloutPeers` seam, so it is unit-tested with fakes and no network.
 *
 * Failure policy: a refusal, a too-old peer (404: no upgrade route) or an
 * unreachable peer is reported and the rollout CONTINUES; a peer that rolled
 * back, failed, or never came back STOPS it, because the same release is
 * likely to hurt the next node too. Self goes last so the coordinating daemon
 * is never down while peers are still being watched.
 *
 * A failure is recognized without comparing clocks: the peer's `lastUpgrade`
 * from the selection snapshot is remembered before the push, and only a
 * target-version failure record that differs from it counts as fresh.
 */
import { randomUUID } from "node:crypto";
import type {
  UpgradeRequest as HfpUpgradeRequest,
  NodeInfo,
} from "@homefleet/protocol";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import { HfpRequestError } from "../transport/client.js";
import type { UpgradeSelfInput, UpgradeStarted } from "./coordinator.js";
import type { PreparedRelease } from "./prepare.js";
import { compareSemver, isSemver } from "./semver.js";

/** How long a pushed peer gets to come back on the new version (spec: 3 minutes). */
export const UPGRADE_WAIT_MS = 180_000;
const DEFAULT_POLL_MS = 2_000;

export type PeerRolloutState =
  | "pending"
  | "pushing"
  | "restarting"
  | "succeeded"
  | "refused"
  | "too-old"
  | "unreachable"
  | "rolled-back"
  | "failed"
  | "timeout";

export interface PeerRolloutStatus {
  deviceId: string;
  name: string;
  from?: string;
  state: PeerRolloutState;
  reason?: string;
}

export interface RolloutStatus {
  id: string;
  target: string;
  startedAt: string;
  state: "running" | "stopped" | "done";
  peers: PeerRolloutStatus[];
  self: {
    state: "pending" | "skipped" | "restarting" | "refused";
    reason?: string;
  };
}

/** Narrow seam over NodeDirectory + HfpClient, faked in tests. */
export interface RolloutPeers {
  list(): Promise<NodeDirectoryEntry[]>;
  /** Throws `HfpRequestError` on an HTTP refusal; any other error means unreachable. */
  push(entry: NodeDirectoryEntry, request: HfpUpgradeRequest): Promise<void>;
  /** `undefined` while the node is unreachable (e.g. mid-restart). */
  hello(entry: NodeDirectoryEntry): Promise<NodeInfo | undefined>;
}

export interface FleetRolloutOptions {
  peers: RolloutPeers;
  currentVersion: string;
  upgradeSelf: (input: UpgradeSelfInput) => Promise<UpgradeStarted>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
}

export interface RolloutStartInput {
  prepared: PreparedRelease;
  manifestBytes: Buffer;
  /** Base64 signature, passed through as-is. */
  signature: string;
  nodes?: string[];
  forceLocal?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LastUpgrade = NonNullable<NodeInfo["lastUpgrade"]>;

function sameRecord(a: LastUpgrade, b: LastUpgrade | undefined): boolean {
  return (
    b !== undefined &&
    a.at === b.at &&
    a.outcome === b.outcome &&
    a.version === b.version &&
    a.reason === b.reason
  );
}

export class FleetRollout {
  private readonly peers: RolloutPeers;
  private readonly currentVersion: string;
  private readonly upgradeSelf: FleetRolloutOptions["upgradeSelf"];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly waitMs: number;
  private current: RolloutStatus | undefined;

  constructor(options: FleetRolloutOptions) {
    this.peers = options.peers;
    this.currentVersion = options.currentVersion;
    this.upgradeSelf = options.upgradeSelf;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.waitMs = options.waitMs ?? UPGRADE_WAIT_MS;
  }

  /** Selects peers and returns the initial status; the loop continues in the background. */
  async start(input: RolloutStartInput): Promise<RolloutStatus> {
    const target = input.prepared.version;
    const entries = await this.peers.list();
    const selected = this.select(entries, target, input.nodes);

    const status: RolloutStatus = {
      id: randomUUID(),
      target,
      startedAt: new Date(this.now()).toISOString(),
      state: "running",
      peers: selected.map((entry) => {
        const from = entry.nodeInfo?.daemonVersion;
        const unreachable =
          input.nodes !== undefined && entry.host === undefined;
        return {
          deviceId: entry.deviceId,
          name: entry.name,
          ...(from !== undefined ? { from } : {}),
          state: unreachable ? "unreachable" : "pending",
          ...(unreachable ? { reason: "no known address for this node" } : {}),
        } satisfies PeerRolloutStatus;
      }),
      self: {
        state:
          compareSemver(this.currentVersion, target) < 0
            ? "pending"
            : "skipped",
      },
    };
    this.current = status;

    const request: HfpUpgradeRequest = {
      version: target,
      manifest: input.manifestBytes.toString("base64"),
      signature: input.signature,
    };
    void this.run(status, selected, request, input.forceLocal === true).catch(
      (error) => {
        // A bug must never become an unhandled rejection in the daemon.
        status.state = "stopped";
        const peer = status.peers.find(
          (p) => p.state === "pushing" || p.state === "restarting",
        );
        if (peer) {
          peer.state = "failed";
          peer.reason = messageOf(error);
        } else {
          status.self.reason = messageOf(error);
        }
      },
    );
    return structuredClone(status);
  }

  status(): RolloutStatus | undefined {
    return this.current === undefined
      ? undefined
      : structuredClone(this.current);
  }

  private select(
    entries: NodeDirectoryEntry[],
    target: string,
    nodes: string[] | undefined,
  ): NodeDirectoryEntry[] {
    if (nodes !== undefined) {
      return entries.filter((e) => nodes.includes(e.deviceId));
    }
    return entries.filter((e) => {
      const version = e.nodeInfo?.daemonVersion;
      return (
        e.reachable &&
        version !== undefined &&
        compareSemver(version, target) < 0
      );
    });
  }

  private async run(
    status: RolloutStatus,
    selected: NodeDirectoryEntry[],
    request: HfpUpgradeRequest,
    forceLocal: boolean,
  ): Promise<void> {
    for (const [index, entry] of selected.entries()) {
      const peer = status.peers[index];
      if (peer === undefined || peer.state === "unreachable") continue;
      const proceed = await this.rolloutPeer(
        entry,
        peer,
        status.target,
        request,
      );
      if (!proceed) {
        status.state = "stopped";
        return;
      }
    }

    if (status.self.state !== "pending") {
      status.state = "done";
      return;
    }
    try {
      await this.upgradeSelf({ version: status.target, force: forceLocal });
      // state stays "running": this daemon is about to exit and restart.
      status.self.state = "restarting";
    } catch (error) {
      status.self = { state: "refused", reason: messageOf(error) };
      status.state = "done";
    }
  }

  /** Returns false when the rollout must stop. */
  private async rolloutPeer(
    entry: NodeDirectoryEntry,
    peer: PeerRolloutStatus,
    target: string,
    request: HfpUpgradeRequest,
  ): Promise<boolean> {
    peer.state = "pushing";
    // What the peer reported before this push; a record equal to it is stale.
    const before = entry.nodeInfo?.lastUpgrade;
    const pushedAt = this.now(); // our clock only: the wait deadline
    try {
      await this.peers.push(entry, request);
    } catch (error) {
      if (error instanceof HfpRequestError) {
        if (error.status === 404) {
          peer.state = "too-old";
          peer.reason =
            'too old for remote upgrade; run "homefleet upgrade" there (npm i -g on v0.4 or older)';
        } else {
          peer.state = "refused";
          peer.reason = error.hfpError?.message ?? error.message;
        }
      } else {
        peer.state = "unreachable";
        peer.reason = messageOf(error);
      }
      return true;
    }

    peer.state = "restarting";
    while (this.now() - pushedAt < this.waitMs) {
      await this.sleep(this.pollMs);
      const info = await this.peers.hello(entry).catch(() => undefined);
      const version = info?.daemonVersion;
      if (
        version !== undefined &&
        isSemver(version) &&
        compareSemver(version, target) >= 0
      ) {
        peer.state = "succeeded";
        return true;
      }
      const last = info?.lastUpgrade;
      if (
        last !== undefined &&
        last.version === target &&
        (last.outcome === "rolled-back" || last.outcome === "failed") &&
        !sameRecord(last, before)
      ) {
        peer.state = last.outcome;
        if (last.reason !== undefined) peer.reason = last.reason;
        return false;
      }
    }
    peer.state = "timeout";
    peer.reason = "unknown — check the node";
    return false;
  }
}
