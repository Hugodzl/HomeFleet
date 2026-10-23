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
 *
 * The final status is handed to `persist` (the data directory) whenever the
 * run ends AND right after this node's own upgrade hands off, because that
 * restart loses the in-memory status; the restarted daemon serves it back via
 * `previous` + {@link restoreRolloutStatus}.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  UpgradeRequest as HfpUpgradeRequest,
  NodeInfo,
} from "@homefleet/protocol";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import { HfpRequestError } from "../transport/client.js";
import type { UpgradeSelfInput, UpgradeStarted } from "./coordinator.js";
import type { UpgradeResult } from "./files.js";
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
    /** succeeded / rolled-back / failed only appear once restored after the restart. */
    state:
      | "pending"
      | "skipped"
      | "restarting"
      | "refused"
      | "succeeded"
      | "rolled-back"
      | "failed";
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
  /** Saves a final status (best effort); see the module comment. */
  persist?: (status: RolloutStatus) => Promise<void>;
  /** The status saved before this daemon's last restart, served until a new rollout starts. */
  previous?: () => RolloutStatus | undefined;
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

const ABORTED_REASON = "the daemon stopped during the rollout";

/**
 * Turns a status saved before this node's own restart into what the
 * restarted daemon reports: nothing runs it any more, so it is never
 * "running", and a self step still `restarting` is settled from what the
 * restart left behind — the version now running, or a failure record for
 * the target written after the rollout started (same machine, same clock).
 */
export function restoreRolloutStatus(
  saved: RolloutStatus,
  now: { daemonVersion: string; lastUpgrade?: UpgradeResult | undefined },
): RolloutStatus {
  const status = structuredClone(saved);
  if (status.state === "running") {
    status.state = "done";
  }
  if (status.self.state !== "restarting") {
    return status;
  }
  const last = now.lastUpgrade;
  if (
    isSemver(now.daemonVersion) &&
    compareSemver(now.daemonVersion, status.target) >= 0
  ) {
    status.self = { state: "succeeded" };
  } else if (
    last !== undefined &&
    last.to === status.target &&
    last.outcome !== "succeeded" &&
    last.at >= Date.parse(status.startedAt)
  ) {
    status.self = {
      state: last.outcome,
      ...(last.reason !== undefined ? { reason: last.reason } : {}),
    };
  }
  return status;
}

export class FleetRollout {
  private readonly peers: RolloutPeers;
  private readonly currentVersion: string;
  private readonly upgradeSelf: FleetRolloutOptions["upgradeSelf"];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly waitMs: number;
  private readonly persist: FleetRolloutOptions["persist"];
  private readonly previous: FleetRolloutOptions["previous"];
  private readonly abortController = new AbortController();
  private current: RolloutStatus | undefined;
  private running: Promise<void> | undefined;

  constructor(options: FleetRolloutOptions) {
    this.peers = options.peers;
    this.currentVersion = options.currentVersion;
    this.upgradeSelf = options.upgradeSelf;
    this.now = options.now ?? Date.now;
    // The default sleep ends early on abort, so a stopping daemon is neither
    // held up by nor left with a pending poll timer.
    this.sleep =
      options.sleep ??
      ((ms) =>
        delay(ms, undefined, { signal: this.abortController.signal }).catch(
          () => undefined,
        ));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.waitMs = options.waitMs ?? UPGRADE_WAIT_MS;
    this.persist = options.persist;
    this.previous = options.previous;
  }

  /**
   * Stops a running loop at its next step (the daemon is stopping) and
   * resolves once it has exited with its stopped status saved. A no-op when
   * nothing runs. Permanent: the loop never resumes.
   */
  async abort(): Promise<void> {
    this.abortController.abort();
    await this.running;
  }

  private get aborted(): boolean {
    return this.abortController.signal.aborted;
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
    this.running = this.run(
      status,
      selected,
      request,
      input.forceLocal === true,
    )
      .catch((error) => {
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
      })
      .then(() => this.save(status));
    return structuredClone(status);
  }

  status(): RolloutStatus | undefined {
    return this.current === undefined
      ? this.previous?.()
      : structuredClone(this.current);
  }

  private async save(status: RolloutStatus): Promise<void> {
    try {
      await this.persist?.(structuredClone(status));
    } catch {
      // Best effort: losing it only degrades the CLI's closing summary.
    }
  }

  private stopAborted(status: RolloutStatus): void {
    status.state = "stopped";
    status.self.reason = ABORTED_REASON;
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
      if (this.aborted) {
        this.stopAborted(status);
        return;
      }
      const proceed = await this.rolloutPeer(
        entry,
        peer,
        status.target,
        request,
      );
      if (!proceed) {
        status.state = "stopped";
        if (this.aborted) this.stopAborted(status);
        return;
      }
    }

    if (this.aborted) {
      this.stopAborted(status);
      return;
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
    // A --nodes peer may have been selected without a hello (no nodeInfo):
    // ask now, or an old failure for the same target would look fresh.
    const before =
      entry.nodeInfo !== undefined
        ? entry.nodeInfo.lastUpgrade
        : (await this.peers.hello(entry).catch(() => undefined))?.lastUpgrade;
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
      if (this.aborted) {
        return false; // run() marks the rollout stopped
      }
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
