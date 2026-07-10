# Backlog

Ideas and known follow-ups for releases after v0.1. Nothing here is committed
or ordered — this is the pool that future release brainstorms draw from. The
committed direction is the roadmap in the
[design doc](specs/2026-07-06-homefleet-design.md); items noted in devlogs get
mirrored here so nothing lives only in prose.

## Product ideas

### Fleet management GUI

A GUI on the central node to see and manage the other nodes: state,
capabilities, name, parameters, and so on — management, not just a read-only
dashboard. The roadmap's "tray app + web dashboard" covers the viewing half;
this extends it to editing (rename a node, tune its parameters). The daemon's
HTTP API was deliberately designed so a dashboard can be added as a client
(design doc, v0.1 non-goals), so the seam already exists — the brainstorm is
scope (tray vs. web vs. both) and which mutations the API should expose.

### Control over local models per node

More control over which local models can be used and installed on each node.
Today a worker drives tasks with whatever its OpenAI-compatible server happens
to serve; this would make the model set an explicit, managed part of node
configuration — an allowlist/catalog per node, surfaced through capability
advertisements so the delegating side can pick (or be denied) a model.

### Workspace-less tasks as node capabilities

Delegate tasks that don't need the git bundle / repo sync at all — web
searches, calculations, and similar self-contained work — advertised as
capabilities of the node that can perform them. Design hook: make the
workspace optional in the job spec rather than a required stage of dispatch,
and let executors declare whether they need one. This also broadens what a
weak-GPU box can contribute.

### Remote model install from the central node

Install new models onto other nodes from the main/central node's GUI. Builds
on the two ideas above (GUI + per-node model catalog). Two things to
brainstorm carefully: each model-server type needs its own adapter (Ollama
pull vs. LM Studio vs. llama.cpp have different install stories), and remote
install is a privileged management operation — it needs a deliberate story in
the Syncthing-style trust model (ADR 0004) rather than riding the existing
job-dispatch channel.

### Painless install and fleet expansion

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

## Known technical debt (from v0.1)

Carried over from the [v0.1 release-polish devlog](../devlog/2026-07-09-v01-release-polish.md):

- `registerExistingCheckouts` populated-dir filter
- Per-iteration stop-check in workspace eviction
- mDNS same-hostname probe race — mitigated, still worth fixing at the source
- npm packaging (v0.1 installs from source only)
