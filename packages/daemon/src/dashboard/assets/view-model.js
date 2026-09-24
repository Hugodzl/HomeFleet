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
 * @param {any[]} nodes NodeDirectoryEntry[]
 * @param {string} ourVersion this daemon's daemonVersion
 */
export function nodeRows(nodes, ourVersion) {
  return nodes.map((node) => {
    const info = node.reachable ? node.nodeInfo : undefined;
    return {
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
