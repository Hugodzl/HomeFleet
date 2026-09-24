/**
 * Dashboard DOM glue: polls the control API and renders it. READ-ONLY by
 * construction — the only network call is the GET in getJson(), and every
 * value reaches the DOM through textContent, never through a raw-HTML sink.
 * Both rules are enforced by ../assets.scan.test.ts; the page's CSP backs
 * them up.
 */
import {
  delegatedJobRows,
  modelRows,
  nodeRows,
  selfRows,
  workerJobRows,
} from "./view-model.js";

const POLL_MS = 3000;
let lastSuccessAt;
let timer;

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
 */
function renderTable(container, columns, rows, emptyText, cellClass) {
  if (rows.length === 0) {
    container.replaceChildren(el("p", emptyText, "muted"));
    return;
  }
  const table = el("table");
  const headRow = el("tr");
  for (const [, header] of columns) {
    headRow.append(el("th", header));
  }
  table.append(el("thead"));
  table.tHead.append(headRow);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const [key] of columns) {
      tr.append(el("td", String(row[key]), cellClass?.(key, row)));
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
  const peers = nodeRows(nodes, status.daemonVersion).map((row) => ({
    ...row,
    version: row.skew ? `${row.version} (differs from ours)` : row.version,
  }));
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
      if (key === "version" && row.skew) {
        return "warn";
      }
      return undefined;
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
      getJson("/control/status"),
      getJson("/control/nodes"),
      getJson("/control/jobs"),
    ]);
    const now = Date.now();
    render(status, nodes.nodes, jobs, now);
    lastSuccessAt = now;
    banner.hidden = true;
    document.getElementById("updated").textContent =
      `Updated ${new Date(now).toLocaleTimeString()}`;
  } catch (error) {
    const last =
      lastSuccessAt === undefined
        ? "never"
        : new Date(lastSuccessAt).toLocaleTimeString();
    banner.textContent = `Daemon unreachable (${error instanceof Error ? error.message : "request failed"}). Last update: ${last}. Retrying…`;
    banner.hidden = false;
  }
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
