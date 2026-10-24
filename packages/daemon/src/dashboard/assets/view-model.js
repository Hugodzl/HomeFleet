/**
 * Pure display helpers for the HomeFleet dashboard: control-API JSON in,
 * plain strings/objects out. NO DOM access here — app.js owns rendering, and
 * this module stays unit-testable under vitest (see ../view-model.test.ts).
 * Shipped to the browser unmodified (served at /dashboard/view-model.js).
 */

const DASH = "—";

/** @param {string} id */
export function shortId(id) {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** @param {string[]} items */
function list(items) {
  return items.length > 0 ? items.join(", ") : "(none)";
}

/** @param {number} n */
function jobs(n) {
  return `${n} ${n === 1 ? "job" : "jobs"}`;
}

/** @param {string} v strict X.Y.Z only */
function isSemver(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * @param {number | undefined} epochMs
 * @param {number} nowMs
 */
export function relativeTime(epochMs, nowMs) {
  if (epochMs === undefined) {
    return DASH;
  }
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** @param {any} status a ControlStatus */
export function selfRows(status) {
  return [
    ["Name", status.name],
    ["Device ID", status.deviceId],
    ["Platform", status.platform],
    [
      "Version",
      `daemon ${status.daemonVersion} · protocol ${status.protocolVersion}`,
    ],
    [
      "Ports",
      `HFP ${status.hfpPort} · MCP ${status.mcpPort} · control ${status.controlPort}`,
    ],
    ["Roles", list(status.roles)],
    ["Executors", list(status.executors)],
    ["Load", `${status.activeJobs} / ${status.maxConcurrentJobs} jobs running`],
  ];
}

/** @param {any[]} models ModelInfo[] */
export function modelRows(models) {
  return models.map((model) => ({
    id: model.id,
    label: model.label ?? DASH,
    status: model.status ?? DASH,
  }));
}

/**
 * Strict X.Y.Z comparison, self-contained (this file ships to the browser
 * with no imports). Anything that is not X.Y.Z sorts lowest.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const parse = (/** @type {string} */ v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) {
    return pa === pb ? 0 : pa === undefined ? -1 : 1;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Upgrade badge for one node. `label` is only set when eligible; `why`
 * explains an ineligible node (shown in the confirm dialog).
 * @param {{reachable: boolean, nodeInfo?: any}} node
 * @param {string | undefined} target
 */
function peerUpgrade(node, target) {
  const info = node.reachable ? node.nodeInfo : undefined;
  /** @param {string} why */
  const no = (why) => ({ eligible: false, label: "", why });
  if (target === undefined) {
    return no("no upgrade available");
  }
  if (info === undefined) {
    return no("unreachable");
  }
  if (info.upgrade === undefined) {
    return no("too old for remote upgrade");
  }
  if (!info.upgrade.allowRemote) {
    return no("remote upgrades off");
  }
  if (!isSemver(info.daemonVersion)) {
    return no("unknown version");
  }
  if (compareVersions(info.daemonVersion, target) >= 0) {
    return no("already up to date");
  }
  return { eligible: true, label: `⬆ ${target} available`, why: "" };
}

/** @param {any} status a ControlStatus (daemonVersion, availableUpgrade?) */
export function selfUpgrade(status) {
  const target = status.availableUpgrade;
  if (target === undefined) {
    return { eligible: false, label: "", why: "no upgrade available" };
  }
  if (!isSemver(status.daemonVersion)) {
    return { eligible: false, label: "", why: "unknown version" };
  }
  if (compareVersions(status.daemonVersion, target) >= 0) {
    return { eligible: false, label: "", why: "no upgrade available" };
  }
  return { eligible: true, label: `⬆ ${target} available`, why: "" };
}

/**
 * @param {any[]} nodes NodeDirectoryEntry[]
 * @param {string} ourVersion this daemon's daemonVersion
 * @param {string} [target] the upgrade target, when one is available
 */
export function nodeRows(nodes, ourVersion, target) {
  return nodes.map((node) => {
    const info = node.reachable ? node.nodeInfo : undefined;
    return {
      fullId: node.deviceId,
      allowRemote: info?.upgrade?.allowRemote === true,
      activeJobs: info?.activeJobs ?? 0,
      upgrade: peerUpgrade(node, target),
      name: node.name,
      deviceId: shortId(node.deviceId),
      endpoint:
        node.host !== undefined && node.port !== undefined
          ? `${node.host}:${node.port}`
          : DASH,
      reachable: node.reachable ? "yes" : "no",
      version: info?.daemonVersion ?? DASH,
      skew: info !== undefined && info.daemonVersion !== ourVersion,
      executors: info !== undefined ? list(info.executors) : DASH,
      models: info !== undefined ? list(info.models.map((m) => m.id)) : DASH,
      load:
        info !== undefined
          ? `${info.activeJobs} / ${info.maxConcurrentJobs}`
          : DASH,
    };
  });
}

/**
 * @param {any[]} jobs WorkerJobSummary[]
 * @param {number} nowMs
 */
export function workerJobRows(jobs, nowMs) {
  return jobs.map((job) => ({
    jobId: shortId(job.jobId),
    type: job.type,
    owner: job.ownerName ?? shortId(job.ownerDeviceId),
    repoId: job.repoId,
    status: job.status,
    created: relativeTime(job.createdAt, nowMs),
    started: relativeTime(job.startedAt, nowMs),
    finished: relativeTime(job.terminalAt, nowMs),
    error: job.errorCode ?? "",
  }));
}

/**
 * @param {any[]} jobs DelegatedJobSummary[]
 * @param {number} nowMs
 */
export function delegatedJobRows(jobs, nowMs) {
  return jobs.map((job) => ({
    jobId: shortId(job.jobId),
    type: job.type,
    target: job.targetName ?? shortId(job.targetDeviceId),
    repoId: job.repoId,
    sent: relativeTime(job.recordedAt, nowMs),
    status: job.lastStatus,
    seen: relativeTime(job.lastStatusAt, nowMs),
    branch: job.appliedBranch ?? "",
  }));
}

/**
 * Everything the confirm dialog shows. Peers are the rows the dialog targets;
 * busy peers are listed as refused because remote pushes never force.
 * @param {{
 *   prepared?: {target: string},
 *   error?: string,
 *   peers: Array<{name: string, activeJobs: number, upgrade: {eligible: boolean, why: string}}>,
 *   self: {included: boolean, version: string, activeJobs: number},
 *   forceSelf: boolean,
 * }} input
 */
export function confirmSummary({ prepared, error, peers, self, forceSelf }) {
  if (error !== undefined || prepared === undefined) {
    return {
      title: "Upgrade failed to prepare",
      lines: [error ?? "No verified release"],
      canConfirm: false,
    };
  }
  const target = prepared.target;
  const lines = [`v${target} — signature verified`];
  let anyEligible = false;
  for (const peer of peers) {
    if (!peer.upgrade.eligible) {
      lines.push(`${peer.name}: not eligible (${peer.upgrade.why})`);
    } else if (peer.activeJobs > 0) {
      lines.push(
        `${peer.name}: busy (${jobs(peer.activeJobs)}) — will be refused`,
      );
    } else {
      anyEligible = true;
      lines.push(`${peer.name}: will upgrade`);
    }
  }
  if (self.included) {
    if (compareVersions(self.version, target) >= 0) {
      lines.push(`This node: already on ${self.version}`);
    } else if (self.activeJobs > 0 && !forceSelf) {
      lines.push(
        `This node: busy (${jobs(self.activeJobs)}) — will be refused unless forced`,
      );
    } else {
      anyEligible = true;
      lines.push(
        forceSelf && self.activeJobs > 0
          ? "This node: will upgrade last (forced)"
          : "This node: will upgrade last",
      );
    }
  }
  return { title: `Upgrade to v${target}`, lines, canConfirm: anyEligible };
}

/** @param {any} rollout RolloutStatus | null */
export function progressRows(rollout) {
  if (rollout === null || rollout === undefined) {
    return [];
  }
  return [
    ...rollout.peers.map((/** @type {any} */ p) => ({
      name: p.name,
      state: p.state,
      reason: p.reason ?? "",
    })),
    {
      name: "This node",
      state: rollout.self.state,
      reason: rollout.self.reason ?? "",
    },
  ];
}

/** @param {{status?: number, code?: string, message: string}} error */
export function startOutcome(error) {
  return error.code === "locked"
    ? { kind: "already-running" }
    : { kind: "error", message: error.message };
}

/**
 * Reload the page after an upgrade changed the daemon under it (new version
 * or a per-boot token that no longer matches), at most once per 10 s.
 * @param {{loadedVersion: string, statusVersion: string, badToken: boolean, lastReloadAt: number, now: number}} input
 */
export function reloadDecision({
  loadedVersion,
  statusVersion,
  badToken,
  lastReloadAt,
  now,
}) {
  return (
    (statusVersion !== loadedVersion || badToken) &&
    now - lastReloadAt >= 10_000
  );
}
