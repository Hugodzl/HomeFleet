# Backlog

Ideas and known follow-ups for releases after v0.1. Nothing here is committed
or ordered — this is the pool that future release brainstorms draw from. The
committed direction is the roadmap in the
[design doc](specs/2026-07-06-homefleet-design.md); items noted in devlogs get
mirrored here so nothing lives only in prose.

**Exception (2026-07-12):** the product ideas below have been clustered and
given an approved build order — see the
[backlog structuring doc](specs/2026-07-12-backlog-structuring.md) (idea keys
A1–A3, B1, C1 and shared seams S1–S5 come from there). The pool itself stays
open and unordered for new entries.

## Product ideas

### Fleet management GUI (A1)

A GUI on the central node to see and manage the other nodes: state,
capabilities, name, parameters, and so on — management, not just a read-only
dashboard. The roadmap's "tray app + web dashboard" covers the viewing half;
this extends it to editing (rename a node, tune its parameters). The daemon's
HTTP API was deliberately designed so a dashboard can be added as a client
(design doc, v0.1 non-goals), so the seam already exists — the brainstorm is
scope (tray vs. web vs. both) and which mutations the API should expose.

### Control over local models per node (A2)

More control over which local models can be used and installed on each node.
Today a worker drives tasks with whatever its OpenAI-compatible server happens
to serve; this would make the model set an explicit, managed part of node
configuration — an allowlist/catalog per node, surfaced through capability
advertisements so the delegating side can pick (or be denied) a model.

### Workspace-less tasks as node capabilities (C1)

Delegate tasks that don't need the git bundle / repo sync at all — web
searches, calculations, and similar self-contained work — advertised as
capabilities of the node that can perform them. Design hook: make the
workspace optional in the job spec rather than a required stage of dispatch,
and let executors declare whether they need one. This also broadens what a
weak-GPU box can contribute.

### Remote model install from the central node (A3)

Install new models onto other nodes from the main/central node's GUI. Builds
on the two ideas above (GUI + per-node model catalog). Two things to
brainstorm carefully: each model-server type needs its own adapter (Ollama
pull vs. LM Studio vs. llama.cpp have different install stories), and remote
install is a privileged management operation — it needs a deliberate story in
the Syncthing-style trust model (ADR 0004) rather than riding the existing
job-dispatch channel.

### Painless install and fleet expansion (B1)

Getting HomeFleet running for the first time is complicated today (clone,
pnpm, build, run bins with bare `node`), and so is managing the fleet and
expanding it onto new machines. Goal: someone should be able to install and
get up and running quickly, with as few CLI steps as possible — ideally
"run an installer, see the other machines, enter a pair code." Brainstorm
threads: real packaging (npm global install is already in the debt list
below; a single binary or winget/platform installers go further), a guided
first-run experience instead of hand-edited config, and making
add-a-new-machine a one-step flow on both ends (install on the new box,
approve from an existing one — the fleet GUI above is the natural surface
for the approval side).

### Coordination ideas

Patterns borrowed from multi-agent products; the analysis is in
[devlog 018](../devlog/2026-09-24-multi-agent-coordination-patterns.md).

#### Mid-job clarification requests

Let a worker's local model pause and ask instead of guessing or silently
failing: a new `question` `JobEvent` on the existing SSE stream plus an
endpoint to answer it (`POST /hfp/v0/jobs/{id}/answer`). The question
surfaces to the front agent via MCP, which answers or escalates to the user.
Brainstorm threads: timeout/default-answer semantics, how the job status
reflects "waiting for input", replay of unanswered questions after a
reconnect (`seq` / `Last-Event-ID` already give us that), and a per-job
"never ask" flag for fully unattended runs.

#### Job chaining without front-agent round-trips

Pipe one job's output straight into the next — e.g. recon on node A feeds a
write task on node B — without the intermediate result passing through the
front agent's context. Saves cloud tokens, which is the core value
proposition, and is a natural first slice of the roadmap's "multi-node
fan-out". Brainstorm threads: where the chain is defined (a `delegate_task`
pipeline spec vs. a follow-up referencing a prior `jobId`), which node holds
the hand-off, and failure/cancellation propagation along the chain.

#### Automatic node routing

`delegate_task` with `node: "auto"`: the daemon picks a node from the
capability catalog (model, executors, current load/queue depth) instead of
the front agent choosing. Grok's orchestrator "involves only the relevant
specialists"; this is the same idea over the model catalog (A2). Needs a
clear, explainable selection rule and a way to report *why* a node was
chosen or why none qualified.

#### Saved task templates

Named, reusable delegations stored on the daemon (e.g. "run tests +
summarize failures", "recon: summarize module X") and exposed as MCP prompts
or tools. The analogue of Grok's routines/skills. Cheap, and makes common
workflows one call instead of a hand-written prompt each time.

#### Node roles

A node advertises a specialist role (reviewer, test-runner, docs-writer) —
a system prompt + model + executor bundle — in its capability advertisement,
so the front agent (or auto routing) can delegate by role. Pairs with A2
(per-node model control) and C1 (workspace-less tasks).

#### Per-repo worker memory

Workers cache recon summaries per repo, keyed by commit, and seed later jobs
with them so repeat recon starts warm. Lowest priority: staleness is the
real risk — the brainstorm is invalidation (commit distance, touched paths)
and making reuse visible in the job result so it's never silent.

## Known technical debt (from v0.1)

Carried over from the [v0.1 release-polish devlog](../devlog/2026-07-09-v01-release-polish.md).
**Audited 2026-09-21** — this list had gone stale; status is now recorded
against each item.

- ~~`registerExistingCheckouts` populated-dir filter~~ — **done** (`e394923`,
  2026-07-10): the startup scan skips dirs with no `.git` gitlink, so a
  half-created checkout no longer counts against `maxCachedCheckouts`.
- ~~Per-iteration stop-check in workspace eviction~~ — **done** (`e394923`,
  2026-07-10): `evictToCapacity` re-checks `stopped` every iteration, and
  again inside the repo lock.
- mDNS same-hostname probe race — **open, and bigger than it reads.** The
  local mitigation (self-echo watchdog, `SELF_ECHO_DEADLINE_MS`) works and is
  tested; "at the source" means bonjour-service, which on a probe conflict
  calls `service.stop()` and `console.log`s an `Error` — no event, no rename.
  Re-checked 2026-09-21: **1.4.4, the current latest, is byte-identical on
  this path**, so there is no version to upgrade into. Real options are an
  upstream PR, a pinned `pnpm.patchedDependencies` patch, or replacing the
  library — none of them small. Not a quick win; decide deliberately.
- ~~npm packaging (v0.1 installs from source only)~~ — **done** (S1,
  2026-09-22): GitHub Releases tarball via `v*` tag; see
  [releasing](reference/releasing.md). Public npm registry publish is still
  deliberately deferred.
