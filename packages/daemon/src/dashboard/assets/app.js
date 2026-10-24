/**
 * Dashboard DOM glue: polls the control API and renders it. Read-only except
 * for the upgrade flow: the one POST helper (postJson) is used only for
 * /control/upgrade/prepare and /control/upgrade and always sends the per-boot
 * token from the page meta. Every value reaches the DOM through textContent,
 * never through a raw-HTML sink. Both rules are enforced by
 * ../assets.scan.test.ts; the page's CSP backs them up. All decisions live in
 * view-model.js; this file only wires them to the DOM.
 */
import {
  confirmSummary,
  currentRollout,
  delegatedJobRows,
  modelRows,
  nodeRows,
  progressRows,
  progressTitle,
  reloadDecision,
  restartBannerState,
  selfRows,
  selfUpgrade,
  shouldKeepWatching,
  startOutcome,
  versionCell,
  workerJobRows,
} from "./view-model.js";

const POLL_MS = 3000;
const PROGRESS_POLL_MS = 2000;
const RELOAD_KEY = "homefleet-last-reload-at";
const token =
  document
    .querySelector('meta[name="homefleet-control-token"]')
    ?.getAttribute("content") ?? "";
let lastSuccessAt;
let timer;
let progressTimer;
let loadedVersion;
let latest; // { status, peers } from the last successful poll
let restarting = false;
let confirmedSelfOrFleet = false;
let confirmedAt = 0;
let sawDown = false; // a poll failed while restarting
let badToken = false;
let action; // the open dialog's { kind, row, prepared, error }

function lastReloadAt() {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Reloads when the view model says so; remembers when, across the reload. */
function maybeReload(statusVersion) {
  const now = Date.now();
  if (
    !reloadDecision({
      loadedVersion,
      statusVersion,
      badToken,
      lastReloadAt: lastReloadAt(),
      now,
    })
  ) {
    return;
  }
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // no storage: the page may reload more often, but never loops faster
    // than the poll interval allows
  }
  location.reload();
}

async function getJson(path) {
  const response = await fetch(path, {
    method: "GET",
    headers: { "x-homefleet-control": "1" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.json();
}

/** The only mutating call. Rejects with an Error carrying status and code. */
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "x-homefleet-control": "1",
      "x-homefleet-control-token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

function renderKv(container, pairs) {
  const dl = el("dl", undefined, "kv");
  for (const [label, value] of pairs) {
    dl.append(el("dt", label), el("dd", value));
  }
  container.replaceChildren(dl);
}

/**
 * @param columns Array<[key, header]>
 * @param rows objects whose values are strings
 * @param cellClass optional (key, row) => className | undefined
 * @param actions optional row => element | null, rendered in a last column
 */
function renderTable(container, columns, rows, emptyText, cellClass, actions) {
  if (rows.length === 0) {
    container.replaceChildren(el("p", emptyText, "muted"));
    return;
  }
  const table = el("table");
  const headRow = el("tr");
  for (const [, header] of columns) {
    headRow.append(el("th", header));
  }
  if (actions !== undefined) {
    headRow.append(el("th", ""));
  }
  table.append(el("thead"));
  table.tHead.append(headRow);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const [key] of columns) {
      tr.append(el("td", String(row[key]), cellClass?.(key, row)));
    }
    if (actions !== undefined) {
      const td = el("td");
      const control = actions(row);
      if (control !== null) {
        td.append(control);
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  container.replaceChildren(table);
}

const statusClass = (key, row) =>
  key === "status" ? `status status-${row.status}` : undefined;

function render(status, nodes, jobs, now) {
  renderKv(document.getElementById("self"), selfRows(status));
  renderTable(
    document.getElementById("models"),
    [
      ["id", "Model"],
      ["label", "Label"],
      ["status", "Catalog status"],
    ],
    modelRows(status.models),
    "No models advertised.",
    statusClass,
  );
  const peers = nodeRows(
    nodes,
    status.daemonVersion,
    status.availableUpgrade,
  ).map((row) => ({
    ...row,
    version: versionCell(row).text,
  }));
  latest = { status, peers };
  renderUpgradeControls();
  renderTable(
    document.getElementById("nodes"),
    [
      ["name", "Name"],
      ["deviceId", "Device"],
      ["endpoint", "Endpoint"],
      ["reachable", "Reachable"],
      ["version", "Version"],
      ["executors", "Executors"],
      ["models", "Models"],
      ["load", "Load"],
    ],
    peers,
    "No paired nodes yet. Pair one with `homefleet pair begin` / `pair connect`.",
    (key, row) => {
      if (key === "reachable") {
        return row.reachable === "yes" ? "ok" : "bad";
      }
      if (key === "version") {
        return versionCell(row).className;
      }
      return undefined;
    },
    (row) => {
      if (!row.upgrade.eligible) {
        return null;
      }
      const button = el("button", "Upgrade");
      button.type = "button";
      button.addEventListener("click", () => openUpgrade("node", row));
      return button;
    },
  );
  renderTable(
    document.getElementById("worker-jobs"),
    [
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
    workerJobRows(jobs.worker, now),
    "No worker jobs since the daemon started.",
    statusClass,
  );
  renderTable(
    document.getElementById("delegated-jobs"),
    [
      ["jobId", "Job"],
      ["type", "Type"],
      ["target", "To"],
      ["repoId", "Repo"],
      ["sent", "Sent"],
      ["status", "Last seen status"],
      ["seen", "Seen"],
      ["branch", "Applied branch"],
    ],
    delegatedJobRows(jobs.delegated, now),
    "No delegated jobs since the daemon started.",
    statusClass,
  );
}

async function refresh() {
  const banner = document.getElementById("banner");
  try {
    const [status, nodes, jobs] = await Promise.all([
      getJson("/control/status?dashboard=1"),
      getJson("/control/nodes"),
      getJson("/control/jobs"),
    ]);
    const now = Date.now();
    loadedVersion ??= status.daemonVersion;
    if (restarting && sawDown) {
      // The daemon came back from a restart: its per-boot token changed even
      // if the version did not, so this page's copy is dead either way.
      badToken = true;
    }
    maybeReload(status.daemonVersion);
    render(status, nodes.nodes, jobs, now);
    lastSuccessAt = now;
    if (!restarting) {
      banner.hidden = true;
    }
    document.getElementById("updated").textContent =
      `Updated ${new Date(now).toLocaleTimeString()}`;
  } catch (error) {
    if (restarting) {
      sawDown = true;
      showRestarting();
      return;
    }
    banner.classList.remove("info");
    const last =
      lastSuccessAt === undefined
        ? "never"
        : new Date(lastSuccessAt).toLocaleTimeString();
    banner.textContent = `Daemon unreachable (${error instanceof Error ? error.message : "request failed"}). Last update: ${last}. Retrying…`;
    banner.hidden = false;
  }
}

function showRestarting() {
  restarting = true;
  const banner = document.getElementById("banner");
  banner.textContent = "Restarting… this page reloads when the node is back";
  banner.classList.add("info");
  banner.hidden = false;
}

/** Applies restartBannerState; clears a banner that no longer applies. */
function syncRestarting(rollout, pollFailed) {
  if (restartBannerState({ confirmedSelfOrFleet, rollout, pollFailed })) {
    showRestarting();
  } else if (restarting && !sawDown) {
    restarting = false;
    const banner = document.getElementById("banner");
    banner.classList.remove("info");
    banner.hidden = true;
  }
}

/** Shows the Upgrade all / Upgrade this node buttons when anything is eligible. */
function renderUpgradeControls() {
  const { status, peers } = latest;
  const self = selfUpgrade(status);
  const all = document.getElementById("upgrade-all");
  all.hidden = !(self.eligible || peers.some((p) => p.upgrade.eligible));
  const mine = document.getElementById("upgrade-self");
  mine.hidden = !self.eligible;
}

// ---- verify-then-confirm dialog ----

const dialog = () => document.getElementById("upgrade-dialog");
const forceBox = () => document.getElementById("upgrade-force");

/** Redraws the dialog body from `action` (a pure view of confirmSummary). */
function renderDialog() {
  const { status } = latest;
  const { kind, row, prepared, error } = action;
  const peers = kind === "node" ? [row] : kind === "fleet" ? latest.peers : [];
  const self = {
    included: kind !== "node",
    version: status.daemonVersion,
    activeJobs: status.activeJobs,
  };
  const forceSelf = forceBox().checked;
  const summary = confirmSummary({ prepared, error, peers, self, forceSelf });
  document.getElementById("upgrade-title").textContent = summary.title;
  document
    .getElementById("upgrade-lines")
    .replaceChildren(...summary.lines.map((line) => el("p", line)));
  document.getElementById("upgrade-force-row").hidden = !(
    prepared !== undefined &&
    self.included &&
    self.activeJobs > 0
  );
  document.getElementById("upgrade-confirm").disabled = !summary.canConfirm;
}

async function openUpgrade(kind, row) {
  action = { kind, row };
  forceBox().checked = false;
  document.getElementById("upgrade-title").textContent = "Verifying…";
  document.getElementById("upgrade-lines").replaceChildren();
  document.getElementById("upgrade-force-row").hidden = true;
  document.getElementById("upgrade-confirm").disabled = true;
  if (!dialog().open) {
    dialog().showModal();
  }
  const mine = action;
  try {
    const prepared = await postJson("/control/upgrade/prepare", {});
    mine.prepared = prepared;
  } catch (error) {
    noteBadToken(error);
    mine.error = error instanceof Error ? error.message : "request failed";
  }
  if (action === mine && dialog().open) {
    renderDialog();
  }
}

function noteBadToken(error) {
  if (error?.code === "bad-token") {
    badToken = true;
    maybeReload(loadedVersion);
  }
}

function startBody() {
  const version = action.prepared.target;
  const force = forceBox().checked;
  if (action.kind === "fleet") {
    return {
      targets: "fleet",
      version,
      ...(force ? { forceLocal: true } : {}),
    };
  }
  if (action.kind === "node") {
    return { targets: [action.row.fullId], includeSelf: false, version };
  }
  return { targets: "self", version, ...(force ? { force: true } : {}) };
}

async function confirmUpgrade() {
  const confirm = document.getElementById("upgrade-confirm");
  confirm.disabled = true;
  const includesSelf = action.kind !== "node";
  // Stamped before the POST so the new rollout record is never older than it.
  confirmedAt = Date.now();
  confirmedSelfOrFleet = false;
  try {
    await postJson("/control/upgrade", startBody());
    dialog().close();
    // This daemon may restart itself; a failing poll then means "restarting".
    confirmedSelfOrFleet = includesSelf;
    startProgress();
  } catch (error) {
    noteBadToken(error);
    const outcome = startOutcome({
      status: error?.status,
      code: error?.code,
      message: error instanceof Error ? error.message : "request failed",
    });
    if (outcome.kind === "already-running") {
      // Someone else's rollout: show it as-is, not as ours.
      confirmedAt = 0;
      dialog().close();
      startProgress();
    } else {
      action.error = outcome.message;
      renderDialog();
    }
  }
}

// ---- rollout progress ----

async function pollProgress() {
  try {
    const body = await getJson("/control/upgrades");
    // The daemon may answer with the record of an old, finished rollout.
    const rollout = currentRollout(body.rollout, confirmedAt);
    const rows = progressRows(rollout);
    document.getElementById("upgrade-progress").hidden = rows.length === 0;
    if (rollout) {
      document.getElementById("upgrade-progress-title").textContent =
        progressTitle(rollout);
    }
    renderTable(
      document.getElementById("upgrade-progress-body"),
      [
        ["name", "Node"],
        ["state", "State"],
        ["reason", "Detail"],
      ],
      rows,
      "",
      statusClass,
    );
    syncRestarting(rollout, false);
    const keepWatching = shouldKeepWatching({
      confirmedSelfOrFleet,
      confirmedAt,
      now: Date.now(),
      rollout: body.rollout,
    });
    if (keepWatching) {
      progressTimer = setTimeout(pollProgress, PROGRESS_POLL_MS);
    } else {
      progressTimer = undefined;
      confirmedSelfOrFleet = false;
      confirmedAt = 0;
    }
  } catch {
    // The daemon is going down for its own restart, or hiccuped: keep
    // polling until the main refresh loop reloads the page or it answers.
    syncRestarting(null, true);
    progressTimer = setTimeout(pollProgress, PROGRESS_POLL_MS);
  }
}

function startProgress() {
  clearTimeout(progressTimer);
  pollProgress();
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) {
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, POLL_MS);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
  } else {
    refresh().then(schedule);
  }
});
document.getElementById("refresh").addEventListener("click", () => {
  refresh().then(schedule);
});
refresh().then(schedule);
document.getElementById("upgrade-all").addEventListener("click", () => {
  openUpgrade("fleet");
});
document.getElementById("upgrade-self").addEventListener("click", () => {
  openUpgrade("self");
});
document.getElementById("upgrade-confirm").addEventListener("click", () => {
  confirmUpgrade();
});
document.getElementById("upgrade-cancel").addEventListener("click", () => {
  dialog().close();
});
forceBox().addEventListener("change", () => {
  if (action?.prepared !== undefined || action?.error !== undefined) {
    renderDialog();
  }
});
// A rollout may already be running (started elsewhere or before a reload).
pollProgress();
