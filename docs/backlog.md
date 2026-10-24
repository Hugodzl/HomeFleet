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
scope (tray vs. web vs. both) and which mutations the API should expose. The
read-only viewing half shipped as the dashboard (spec
`specs/2026-09-24-read-only-dashboard-design.md`); A1 now means the
mutations. The first, upgrade, shipped in v0.6.0 (Upgrade all, per node, this
node, behind a per-boot control token); the rest are still to do.

### Unpair a node

**Shipped (2026-09-25)** as `homefleet unpair <name|deviceId> [--yes]` backed
by `POST /control/unpair` — spec
`specs/2026-09-25-unpair-node-design.md`. One-sided, CLI-first; no dashboard
control yet (that needs the A1 mutation CSRF story). Follow-up candidate:
surface "peer no longer trusts us" as its own directory state instead of
`reachable: false`.

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

### Fleet rollout: keep the final status across the requester's restart

**Fixed in v0.5.4 (2026-10-23)** — takes effect once the *requesting* node already runs v0.5.4 (the 0.5.3 → 0.5.4 rig push still showed the old behavior, since it ran in a 0.5.3 daemon and CLI; devlog 023 addendum). The rollout saves its final status to
`<dataDir>/upgrades/rollout-status.json` (on every final step and at the self
hand-off), the restarted daemon serves it from `GET /control/upgrades` with
the self step settled, and the CLI re-reads it after the restart.

Found in the v0.5.3 rig run (devlog 023). When the requesting node upgrades
itself as the last step of `homefleet fleet upgrade`, its daemon restarts and
the in-memory rollout status is lost. If peers settle between two CLI polls,
for example a fast `refused`, the CLI only ever saw their earlier states and
reports them wrong (`tower: pushing` instead of `refused (…UPGRADE_DISABLED…)`).
The exit code stays correct. Fix: write the final `RolloutStatus` to the data
directory right before the self-upgrade hands off, and have the restarted
daemon serve it from `GET /control/upgrades` as the last rollout. The CLI then
re-reads it after the restart instead of summarizing a stale poll. Pairs with
the Phase 4 dashboard, which needs the same persisted status. The v0.6.0
dashboard reads it.

### Node lifecycle automation (daemon + model server)

Keeping a node running is still hand work. The v0.5.0 rig rollout
(2026-10-22) hit every step:

- `npm i -g` replaces the files but not the running daemon; the tower kept
  serving nothing on 56370 until homefleetd was found and restarted by hand.
- Starting the installed daemon detached means a long `Start-Process node
  "<npm root -g>\homefleet\dist\bin\homefleetd.js" …` line, and finding the
  live process means a `Get-CimInstance` query (`daemon.pid` goes stale
  across reboots). `homefleet setup` prints an at-logon Task Scheduler
  command, but nothing applies or checks it.
- llama-server doesn't come back after a reboot, and it must be up BEFORE
  homefleetd: model status is probed once at startup, so a model server that
  starts late stays `unreachable` until the daemon restarts.
- Checking any of this needs the control API: `homefleet nodes` and
  `homefleet status` don't show peer versions or per-model status.

Brainstorm threads, roughly from cheapest to largest:

- **`homefleet daemon start|stop|restart|status`** for the installed bin:
  detached launch, log file, live-process lookup. The shipped equivalent of
  the rig's `hf-daemon.ps1`, and the same launch the updater already does.
- ~~**Re-probe models periodically**~~ **shipped in v0.5.5** (every 60 s; on-demand probing not done) so a late model server
  turns `ok` without a daemon restart.
- **Show versions and model status in the CLI** (`nodes`, `status`).
- **Install the autostart for real:** `homefleet setup --apply` registers
  the at-logon task (or a proper Windows service) and verifies it.
- **Supervise the model server:** an optional per-model `launch` command the
  daemon starts, health-checks and restarts (llama-server first; Ollama
  already restarts itself). It runs a local process from config, so it
  needs the same fail-closed treatment as `executors.*`.
- **Restart a peer remotely** from the central node. It rides on fleet
  upgrade Phase 3 (HFP push) and the A1 mutation story, and is a privileged
  operation like A3.

Overlaps B1 (painless install) and the fleet-upgrade spec
(`specs/2026-09-25-fleet-upgrade-design.md`): `homefleet upgrade` already
does the stop → install → relaunch → health-check for upgrades; this item is
the same lifecycle for everything else.

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

### Flaky Windows test: oversized-body 413 in `mcp/http-transport.test.ts`

**Fixed in v0.5.5:** the test now sends only the headers of the oversized request (the content-length fast path refuses on the declared size), so there is no unread body for the server's close to reset.

"rejects an oversized body via an honest large content-length (413), stays
up" occasionally fails on the Windows CI runner with `expected 'errored' to
be 413`. The server answers 413 and closes the socket, and the client sees
the reset before it reads the response. Seen on the v0.5.4 release-prep PR
(passed on re-run) and probably the one-off failure during Phase 3; the test
and the transport are unchanged since M9. Fix: let the client finish reading
the 413 before the server destroys the socket (e.g. `res.end()` then destroy
on `finish`, or read with `Connection: close`), or assert "413 or a reset
after the 413 was written" in the test.

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
