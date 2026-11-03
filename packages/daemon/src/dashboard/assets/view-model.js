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
      // Same `id (status)` form as `homefleet nodes`: a reachable daemon can
      // still have a model server that is down.
      models:
        info !== undefined
          ? list(
              info.models.map((/** @type {any} */ m) =>
                m.status !== undefined ? `${m.id} (${m.status})` : m.id,
              ),
            )
          : DASH,
      modelsWarn:
        info?.models.some(
          (/** @type {any} */ m) => m.status !== undefined && m.status !== "ok",
        ) === true,
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
      // A verified release that then failed to start is not a prepare error.
      title:
        prepared === undefined ? "Upgrade failed to prepare" : "Upgrade failed",
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

/**
 * Heading over the progress table: the daemon also serves the saved record of
 * a finished rollout, which may be days old.
 * @param {{state: string}} rollout
 */
export function progressTitle(rollout) {
  return rollout.state === "running" ? "Upgrade progress" : "Last rollout";
}

/**
 * The line next to "Check for updates": the answer of the uncached
 * `GET /control/upgrade/check`, or why it failed.
 * @param {{current: string, latest: string, available: boolean} | Error} result
 */
export function checkSummary(result) {
  if (result instanceof Error) {
    return `Check failed: ${result.message}`;
  }
  return result.available
    ? `⬆ ${result.latest} available`
    : `Up to date (latest release: ${result.latest})`;
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

/**
 * Version column of a peer row: the upgrade badge wins whenever the node is
 * eligible (whatever its skew); otherwise skew gets the warning suffix.
 * @param {{version: string, skew: boolean, upgrade: {eligible: boolean, label: string}}} row
 * @returns {{text: string, className: string | undefined}}
 */
export function versionCell(row) {
  if (row.upgrade.eligible) {
    return { text: `${row.version} ${row.upgrade.label}`, className: "badge" };
  }
  if (row.skew) {
    return { text: `${row.version} (differs from ours)`, className: "warn" };
  }
  return { text: row.version, className: undefined };
}

/**
 * Whether the "Restarting…" banner applies: this node's step is restarting,
 * or a progress poll failed after a confirmed self/fleet start. A refused or
 * stopped rollout never restarts this node, so it gets no banner.
 * @param {{confirmedSelfOrFleet: boolean, rollout: any, pollFailed: boolean}} input
 */
export function restartBannerState({
  confirmedSelfOrFleet,
  rollout,
  pollFailed,
}) {
  // A persisted record can keep self "restarting" after the fact; only a
  // rollout that is still running means this node is about to restart.
  if (rollout?.state === "running" && rollout.self?.state === "restarting") {
    return true;
  }
  return pollFailed && confirmedSelfOrFleet;
}

const SELF_WATCH_MS = 90_000;

/**
 * GET /control/upgrades falls back to the persisted record of an OLD rollout
 * when none is in memory. A record that started before the user's confirm is
 * not the one they started, so it is ignored.
 * @param {any} rollout RolloutStatus | null
 * @param {number} confirmedAt epoch ms of the confirm, 0 when none
 */
export function currentRollout(rollout, confirmedAt) {
  if (rollout === null || rollout === undefined) {
    return null;
  }
  return confirmedAt > 0 && Date.parse(rollout.startedAt) < confirmedAt
    ? null
    : rollout;
}

/**
 * Whether the progress poller keeps going: while a rollout runs, or for 90 s
 * after a confirmed self/fleet start that has no current record yet (a
 * self-only upgrade never creates one — the daemon just goes down).
 * @param {{confirmedSelfOrFleet: boolean, confirmedAt: number, now: number, rollout: any}} input
 */
export function shouldKeepWatching({
  confirmedSelfOrFleet,
  confirmedAt,
  now,
  rollout,
}) {
  const current = currentRollout(rollout, confirmedAt);
  if (current !== null) {
    return current.state === "running";
  }
  return confirmedSelfOrFleet && now - confirmedAt < SELF_WATCH_MS;
}

/**
 * Table columns as [row key, header], per table. app.js renders headers from
 * here and takes each header's tooltip from HELP under the same scope + key.
 * @type {Record<string, Array<[string, string]>>}
 */
export const COLUMNS = {
  models: [
    ["id", "Model"],
    ["label", "Label"],
    ["status", "Catalog status"],
  ],
  nodes: [
    ["name", "Name"],
    ["deviceId", "Device"],
    ["endpoint", "Endpoint"],
    ["reachable", "Reachable"],
    ["version", "Version"],
    ["executors", "Executors"],
    ["models", "Models"],
    ["load", "Load"],
  ],
  workerJobs: [
    ["jobId", "Job"],
    ["type", "Type"],
    ["owner", "From"],
    ["repoId", "Repo"],
    ["status", "Status"],
    ["created", "Created"],
    ["started", "Started"],
    ["finished", "Finished"],
    ["error", "Error"],
  ],
  delegatedJobs: [
    ["jobId", "Job"],
    ["type", "Type"],
    ["target", "To"],
    ["repoId", "Repo"],
    ["sent", "Sent"],
    ["status", "Last seen status"],
    ["seen", "Seen"],
    ["branch", "Applied branch"],
  ],
  progress: [
    ["name", "Node"],
    ["state", "State"],
    ["reason", "Detail"],
  ],
};

const JOB_TYPES =
  "recon = read-only look at a repo; command = runs a command; write = makes code changes on a branch.";

/**
 * Every tooltip on the page, in one place for review. Table scopes match
 * COLUMNS; `self` is keyed by selfRows label; `page` and `dialog` are named by
 * data-help="scope.key" attributes in index.html.
 * @type {Record<string, Record<string, string>>}
 */
export const HELP = {
  page: {
    updated:
      "Time of the last successful refresh. The page refreshes every 3 s while this tab is visible.",
    refresh: "Fetch status, nodes and jobs now.",
    checkUpdates:
      "Ask GitHub for the newest release now. The upgrade badge otherwise rechecks only every 6 hours.",
    upgradeAll:
      "Upgrade every eligible paired node to the newest signed release, then this node last. You confirm in a dialog first.",
    upgradeSelf:
      "Upgrade only this node to the newest signed release. The daemon restarts and this page reloads when it is back.",
    progress:
      "The upgrade rollout this node ran. 'Last rollout' means it has finished; that record may be days old.",
    self: "The daemon serving this dashboard.",
    models:
      "Models in this node's catalog, advertised to peers so they can delegate jobs that name one.",
    nodes:
      "Devices paired with this node. On each refresh this node says hello to every one it has an address for; live details need a successful hello.",
    workerJobs: "Jobs this node ran for peers.",
    delegatedJobs: "Jobs this node sent to peers.",
  },
  self: {
    Name: "Name this node advertises to peers (node.name in config, or the hostname).",
    "Device ID":
      "This node's identity: the SHA-256 fingerprint of its certificate. Peers pin it when they pair.",
    Platform: "Operating system the daemon runs on.",
    Version:
      "daemon = installed HomeFleet release; protocol = version of the peer-to-peer protocol (HFP) it speaks.",
    Ports:
      "HFP = peer-to-peer port, open to the LAN; MCP = tools endpoint for local agents; control = this dashboard and the CLI. MCP and control are localhost only.",
    Roles:
      "Work this node accepts from peers, derived from its executors: inference (agent jobs: recon, write) and execution (command jobs).",
    Executors:
      "Job runners enabled in config (executors.*). All are off by default.",
    Load: "Jobs running now / maxConcurrentJobs. At the limit, new jobs are refused as BUSY.",
  },
  models: {
    id: "Model ID as the model server knows it; delegated jobs name this ID.",
    label: "Optional friendly name from the catalog.",
    status:
      "Checked once at daemon startup: ok = the model server lists it; not_served = the server answered but does not list it (typo or drift); unreachable = no endpoint, or the probe failed. Restart the daemon to re-check.",
  },
  nodes: {
    name: "Name the peer advertised when it paired.",
    deviceId:
      "Start of the peer's device ID (its pinned certificate fingerprint).",
    endpoint:
      "Last-known host:port, from LAN discovery or the known-nodes file. A dash means no address is known.",
    reachable:
      "yes = a hello to the peer just succeeded. no = no known address, or the hello failed or timed out (asleep, offline, wrong identity). The columns to the right need yes.",
    version:
      "Peer's daemon version. '(differs from ours)' = not the version this node runs. '⬆ X available' = this node can push that signed release to it (the peer has upgrade.allowRemote on and is older).",
    executors: "Job runners the peer has enabled.",
    models:
      "Peer's catalog, each with its startup check: ok, not_served or unreachable (see This node's Catalog status). Amber when any is not ok; no status = older peer.",
    load: "Peer's running jobs / its maxConcurrentJobs.",
  },
  workerJobs: {
    jobId: "Start of the job ID.",
    type: JOB_TYPES,
    owner: "Peer that sent the job.",
    repoId: "Repository the job works on.",
    status: "queued, running, succeeded, failed or canceled.",
    created: "When the job arrived.",
    started: "When it began running.",
    finished: "When it ended.",
    error: "Error code, when the job failed.",
  },
  delegatedJobs: {
    jobId: "Start of the job ID.",
    type: JOB_TYPES,
    target: "Peer the job was sent to.",
    repoId: "Repository the job works on.",
    sent: "When this node sent it.",
    status:
      "Last status an MCP tool (job_status / job_result) saw; not live. queued until one checks.",
    seen: "When that status was seen.",
    branch: "Local branch the job's changes were applied to, once applied.",
  },
  progress: {
    name: "Node in the rollout. Peers go one at a time; this node goes last.",
    state:
      "pending, pushing, restarting, succeeded; refused = the node said no (busy, or remote upgrades off); too-old = no remote-upgrade support; rolled-back = the new version did not come up, old one restored; timeout = not back within 3 min; skipped = this node was not included.",
    reason: "Why a step was refused or failed.",
  },
  dialog: {
    title:
      "The release is downloaded and its signature verified before anything starts. Nothing changes until you press Confirm.",
    lines:
      "will upgrade = takes the push; not eligible = cannot take it (reason in brackets); busy = running jobs, and a remote push never forces, so it will be refused.",
    force:
      "Upgrade this node even while it runs jobs. Only this node can be forced; the restart interrupts its running jobs.",
  },
};

/**
 * Tooltip text for "scope.key", or "" when there is none.
 * @param {string} key
 */
export function helpText(key) {
  const dot = key.indexOf(".");
  if (dot < 0) {
    return "";
  }
  const text = HELP[key.slice(0, dot)]?.[key.slice(dot + 1)];
  return typeof text === "string" ? text : "";
}
