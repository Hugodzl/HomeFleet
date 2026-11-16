# HomeFleet

![HomeFleet — the computers in your home working as one fleet](docs/assets/homefleet-banner.png)

**Your coding agent, but your other PCs do the heavy lifting.**

HomeFleet turns the computers in your home into a fleet your AI coding agent can use. Install a small daemon on each machine, pair them once, and any MCP-capable agent (Claude Code, LM Studio, goose, Cline, ...) gains tools to see every machine in the house and delegate work to them — the delegated work runs entirely on **local models**, entirely on **your LAN**; the agent in front can be cloud or local, but the jobs never leave the house.

> **Status: v0.7.0 — pre-alpha.** Windows-first; installed from a GitHub
> Release, not from the npm registry yet. The [Quickstart](#quickstart) runs on a
> single machine; pairing two real machines is the
> [two-machine demo](#two-machine-demo). What changed in each version is on the
> [Releases page](https://github.com/Hugodzl/HomeFleet/releases).

## What it does today

- **Delegates three kinds of job** to a paired machine: read-only repo
  **recon** driven by its local model, allowlisted **command** runs (test
  suites, builds), and code-**writing** tasks whose result comes back as a
  reviewable `homefleet/<id>` branch in your own repo. See [Job types](#job-types).
- **Pairs machines on your LAN** with mDNS discovery, a short pairing code and
  mutual TLS. There is no CA and no account. `homefleet unpair` revokes a
  pairing.
- **Enforces a per-node model catalog.** Each node advertises the models it
  serves, and a job asking for a model the node doesn't have is denied.
- **Shows the fleet in a web dashboard** (`homefleet dashboard`): this node,
  paired nodes, and jobs in both directions, served by the local daemon on
  127.0.0.1.
- **Upgrades itself from signed releases.** `homefleet upgrade` checks a
  release against a pinned Ed25519 key, installs it, restarts the daemon and
  rolls back if the new version fails to start. `homefleet fleet upgrade`, or
  **Upgrade all** in the dashboard, rolls a release across the fleet.
- **Runs in the background** with `homefleet daemon start|stop|restart|status`.

### Proven on real hardware

Each milestone ran on a two-machine rig (a laptop and a tower) against a
local Qwen3.6-35B-A3B:

| Version | What ran | Devlog |
|---|---|---|
| v0.1 | Recon returned an accurate architecture summary in ~105 s | [rig bring-up](devlog/2026-07-09-m8-rig-bringup.md) |
| v0.2 | A write task added a test file that landed and passed in ~169 s | [write-delegation smoke](devlog/2026-07-15-v02-rig-smoke.md) |
| v0.3 | Both machines installed from the public release URL; delegation worked in both directions | [packaging](devlog/2026-09-22-s1-packaging.md) |
| v0.4 | The dashboard showed a live delegated job reach `succeeded` on the tower | [dashboard](devlog/2026-09-24-read-only-dashboard.md) |
| v0.5 | Both machines self-upgraded 0.5.0 → 0.5.1 and rolled back a deliberately broken build | [self-upgrade](devlog/2026-10-22-first-self-upgrade.md) |
| v0.5.3 | The laptop pushed the release to the tower with `homefleet fleet upgrade` in 14 s | [fleet push](devlog/2026-10-23-first-fleet-push.md) |
| v0.6.1 | **Upgrade all** in the dashboard upgraded both nodes, and the page reloaded onto the new version | [dashboard upgrade](devlog/2026-11-02-dashboard-upgrade.md) |
| v0.7.0 | `homefleet daemon` started and stopped the daemon through the autostart task (laptop) | [daemon command](devlog/2026-11-08-daemon-command.md) |

Design history is in the open: the [protocol RFC](docs/rfc/hfp-v0.md),
[ADRs](docs/adr/), the [design doc](docs/specs/2026-07-06-homefleet-design.md),
and day-by-day [devlogs](devlog/).

## Why

Local agents are getting genuinely useful, but a single machine is always the bottleneck — and most of us have more than one computer sitting around. Existing multi-machine tools either pool GPUs to serve one bigger model (exo, GPUStack, llama.cpp RPC) or replace your whole workflow with a new platform (dashboards, kanbans, custom protocols). Nothing lets the agent you *already use* simply reach over and put your other machines to work.

HomeFleet is that missing thin layer:

- **MCP-native** — appears as `list_nodes` / `delegate_task` tools inside your existing agent session; results stream back into its context
- **LAN auto-discovery** — daemons find each other via mDNS; pair with a short code, Syncthing-style (device ID = certificate fingerprint, mutual TLS, no CA, no accounts)
- **Local models by default** — worker machines drive tasks with whatever OpenAI-compatible server they have (Ollama, LM Studio, llama.cpp server)
- **Capability-aware** — nodes advertise a validated model catalog; delegate to a specific model or be cleanly denied

## How it works

```
┌─────────── Machine A (you) ───────────┐      ┌────────── Machine B (worker) ─────────┐
│                                        │      │                                        │
│  Your agent (Claude Code, goose, ...)  │      │  homefleetd                            │
│        │  MCP (localhost)              │      │   ├─ executor: minimal agent loop ──►  │
│        ▼                               │ mTLS │   │    local model (OpenAI-compat API) │
│  homefleetd  ◄──── discovery/pairing ──┼──────┼─► ├─ executor: command runner         │
│   ├─ list_nodes                        │ LAN  │   └─ workspace cache (git bundles)     │
│   └─ delegate_task ────────────────────┼──────┼─►                                      │
└────────────────────────────────────────┘      └────────────────────────────────────────┘
```

One daemon per machine. On your machine it faces your agent as an MCP server; on workers it executes delegated jobs — read-only repo recon driven by a local model, allowlisted commands (test suites, builds), or code-**writing** tasks that come back as reviewable `homefleet/<id>` branches (v0.2). Code travels as git bundles; nothing needs a shared remote.

## Job types

- **Recon** ("explore this repo, summarize the auth flow"): the worker's
  local model reads a synced copy of the repo and writes back a report.
- **Command** ("run the test suite"): the worker runs a command from its
  allowlist. No model needed.
- **Write** ("add a test for X"): the worker's local model changes the code,
  and the change comes back as a branch for you to review.

Out of scope for now: a cloud relay (jobs never leave your LAN). See the
[design doc](docs/specs/2026-07-06-homefleet-design.md) and the
[roadmap](#roadmap).

### Code-writing delegation

Workers can write code, not just read it. Configure `executors.write` on a worker (a [catalog](docs/reference/configuration.md#catalog) `defaultModel` plus an optional command allowlist) and `delegate_task` accepts `type: "write"` tasks. From there the flow is three steps: the worker's local model makes the requested change in an isolated, throwaway worktree of the synced repo; the daemon commits the result as `HomeFleet Worker`; and the next `job_result` call lands the change in *your* clone as a branch named `homefleet/<jobId12>` — your own branches and working tree are never touched. Review it with the exact command `job_result` returns (`git diff <base>...homefleet/<id>`), then merge or delete the branch. An optional allowlisted `verifyCommand` runs after the commit and reports its outcome without ever failing the job. Config shape, the git-in-allowlist caveat, and the artifact-lifecycle rules are in the [configuration reference](docs/reference/configuration.md#executorswrite).

## Install

You need **Node ≥ 20** and git. Install the [latest release](https://github.com/Hugodzl/HomeFleet/releases/latest) (currently v0.7.0) globally:

```bash
npm i -g https://github.com/Hugodzl/HomeFleet/releases/download/v<version>/homefleet-<version>.tgz
```

(the exact URL is on the [Releases page](https://github.com/Hugodzl/HomeFleet/releases)).
That puts `homefleetd`, `homefleet` and `homefleet-mcp-stdio` on your PATH.
To update an installed node (v0.5.0 or later), run `homefleet upgrade`: it
downloads the latest release, checks its signature, installs it, restarts
the daemon in the background and rolls back automatically if the new
version fails to start. `homefleet upgrade --check` only reports what is
available. Upgrading *to* v0.5.0 is the last manual `npm i -g`.

To upgrade the whole fleet from one node, run `homefleet fleet upgrade`
(optionally `--to <version>`, or `--nodes <name|id>…` to pick peers). The
daemon rolls the release out sequentially, peers first and this node last,
and stops at the first rollback, failure or timeout; a peer that refuses or
is too old is reported and skipped. A peer takes the push only if its config
has `"upgrade": { "allowRemote": true }` (off by default) and it already runs
v0.5.2 or later, so older nodes make that hop with a local `homefleet upgrade`.

You can also upgrade from the dashboard (`homefleet dashboard`). When a newer
release exists, nodes that can take it show an "available" badge (the daemon
checks GitHub every 6 hours; **Check for updates** asks right away), and the page
offers **Upgrade all**, a button per node and one for this node. Each one first
downloads and verifies the release, then opens a confirm dialog listing what
will happen (a busy peer is listed as refused; this node can be forced with an
explicit checkbox). While the rollout runs the page shows each node's step, and
it reloads once after this node restarts. The CLI and the daemon must both be
v0.6.0 or later for upgrade commands: they now share a per-boot control token.

Then scaffold the machine with `homefleet setup` (below).

To run the daemon in the background, use `homefleet daemon`:

```bash
homefleet daemon start     # launch homefleetd detached and wait until it answers
homefleet daemon status    # running or not, pid, version, log paths (exit 3 = not running)
homefleet daemon stop      # graceful shutdown; refuses while jobs run unless --force
homefleet daemon restart   # stop, then start (e.g. after editing config.json)
```

The daemon's own answer on the control API is how `status` finds it, so
nothing goes stale across reboots. On Windows, `start` runs the
`HomeFleet Daemon` autostart task when it is registered (and
`HOMEFLEET_DATA_DIR` is unset). Otherwise it launches `homefleetd` directly.
Its log is `homefleetd.log` in the data directory. `stop` needs a daemon
from v0.7.0 or later; an older one has to be stopped by hand once, or
upgraded.

**Windows:** run `homefleetd` from the Task Scheduler task `homefleet setup`
prints, or from your own terminal, not from a terminal inside a packaged
desktop app such as the Claude desktop app. Windows gives that app's child
processes a private `%LOCALAPPDATA%` (the daemon ends up with a separate
identity) and stops them when the app closes. `homefleet daemon start`
detects this and refuses, unless the autostart task is registered: a task
runs outside the app. See
[Data directory](docs/reference/configuration.md#data-directory).

Working on HomeFleet itself? See [Development](#development) for running from
source.

## Quickstart

Single machine, dev setup. This is enough to run the daemon and point an MCP
client at it — pairing a second real machine is the
[two-machine demo](#two-machine-demo) below.

See [Install](#install) above; recon jobs additionally need an
OpenAI-compatible model server on the worker (Ollama, LM Studio, llama.cpp
`llama-server`, ...).

Next, scaffold this machine — prints this node's identity and the commands
*you* run yourself in an elevated PowerShell (the daemon never elevates
itself):

```bash
homefleet setup
```

Run the printed `New-NetFirewallRule` commands (TCP for HFP — the daemon's
LAN protocol — plus discovery UDP, scoped to the Private network profile)
in an elevated PowerShell, and check the printed network-profile warning —
the rules only take effect on a Private-profile adapter. They only matter
once you pair a second machine; for this single-machine quickstart they're
safe to defer.

Then `config.json` goes in the daemon's data directory (by default
`%LOCALAPPDATA%\homefleet` on Windows; override with `HOMEFLEET_DATA_DIR`).
For this single-machine quickstart you can skip it and start the daemon
bare — with no config file it runs no executors and syncs no repos;
everything is opt-in. Write one when the machine takes a role. The two
examples below are the two roles — worker and delegator — and one machine
can carry both in the same file. A worker offering a local model plus a
command allowlist, for one repo:

```json
{
  "catalog": {
    "models": [
      {
        "id": "qwen3.5-9b",
        "contextWindow": 32768,
        "endpoint": { "baseUrl": "http://127.0.0.1:8080/v1" }
      }
    ]
  },
  "executors": {
    "agent": { "defaultModel": "qwen3.5-9b" },
    "command": { "allowlist": { "pnpm": {} } }
  },
  "workspace": { "allowedRepoIds": ["homefleet"] }
}
```

(The pre-A2 shape — `executors.agent.endpoint: { baseUrl, model,
contextWindow }` directly, no `catalog` section — still loads unchanged; the
daemon upgrades it automatically at startup.)

A delegator mapping a local repoId to its checkout, so `delegate_task` can
sync it to a worker:

```json
{
  "repos": [{ "repoId": "homefleet", "path": "D:\\Git\\HomeFleet" }]
}
```

Every key, type, and default is in the
[configuration reference](docs/reference/configuration.md) — cross-check
before writing a real config; parsing is strict (an unknown key throws rather
than being silently ignored).

Now start the daemon (foreground; stop with Ctrl-C):

```bash
homefleetd
```

It prints its device ID, bound ports, and data directory to stderr once it's
up. Finally, point an MCP-capable agent at it — for Claude Code:

```bash
claude mcp add --transport http homefleet http://127.0.0.1:56372/mcp
```

See [`packages/daemon/README.md`](packages/daemon/README.md#pointing-claude-code-at-the-daemon)
for the exact `.mcp.json` form and the stdio-shim alternative.

## Two-machine demo

This is the v0.1 acceptance path: two physical machines, each running
`homefleetd`, paired, delegating a real job to a real local model. This
exact path ran for real on the reference rig on 2026-07-09 — timings, token
rates, and the Windows MAX_PATH lesson it surfaced are in the
[rig devlog](devlog/2026-07-09-m8-rig-bringup.md). Follow
[Install](#install) above **on both machines** first, then:

1. On **each** machine, run `homefleet setup` and run the printed firewall
   commands in an elevated PowerShell. Then write `config.json`: give the
   worker machine an `agent` and/or `command` executor and a non-empty
   `workspace.allowedRepoIds`; give the delegating machine a `repos` mapping
   naming the same repoId (see the Quickstart's examples and the
   [configuration reference](docs/reference/configuration.md)). Only then
   start the daemon with `homefleet daemon start` (or run `homefleetd` in a
   terminal to watch it in the foreground). Config is read once at startup:
   after editing it, run `homefleet daemon restart`.
2. **Pair them.** On machine B (the worker), open a pairing window:
   ```bash
   homefleet pair begin
   ```
   This prints a short code. On machine A (the delegator), connect to B using
   B's LAN address, B's HFP port (`56370` by default), and that code:
   ```bash
   homefleet pair connect <B-host> <B-hfp-port> <code> [--expect <B-device-id>]
   ```
3. **Verify.** On either machine:
   ```bash
   homefleet nodes      # the peer, with live capabilities
   homefleet status     # this node's own live status
   homefleet dashboard  # opens the web dashboard (this node, paired nodes, recent jobs; read-only except upgrade) served by the local daemon on 127.0.0.1
   homefleet unpair <name|deviceId> --yes   # revoke a pairing on the running daemon (one-sided; run it on the peer too)
   ```
4. **Point a Claude Code session's MCP at machine A's local daemon** (see the
   Quickstart's `claude mcp add` command — always the *local* daemon; MCP
   never crosses the LAN).
5. **Delegate.** In that session, `delegate_task` a recon prompt naming
   machine A's configured `repoId` and machine B's device ID (from
   `list_nodes`/`homefleet nodes`) — the repo is bundled and synced to B
   automatically before the job runs on B's local model. Poll with
   `job_status`/`job_result`; `cancel_job` to abort mid-run.

Recon needs the worker machine to serve a local OpenAI-compatible endpoint
(llama.cpp `llama-server`, Ollama, LM Studio, ...); command jobs need no
model. The design doc's
[reference rig](docs/specs/2026-07-06-homefleet-design.md#reference-rig)
describes the two-machine setup this project develops against (a Vulkan
`llama-server` box and a CUDA Ollama box) if you want a concrete starting
point.

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | HomeFleet Protocol (HFP) — zod schemas + types; spec in `docs/rfc/` |
| `packages/daemon` | `homefleetd` — MCP front, node service, discovery, dispatch |
| `packages/executors` | Command executor + minimal agent loop |
| `docs/rfc/` | Versioned RFC-style protocol spec |
| `docs/adr/` | Architecture Decision Records |
| `docs/specs/` | Design documents |
| `docs/reference/` | Operator reference (e.g. [`configuration.md`](docs/reference/configuration.md)) |
| `devlog/` | Findings, benchmarks, lessons learned along the way |

## Development

Running from source instead of a release:

```bash
git clone https://github.com/Hugodzl/HomeFleet.git
cd HomeFleet
pnpm install     # pnpm 11 — `corepack enable` is the easiest way
pnpm build       # tsup — required before running any packages/daemon bin
node packages/daemon/dist/bin/homefleet.js --help
```

The bins are plain, bare-`node`-runnable ESM files; substitute
`node packages/daemon/dist/bin/<bin>.js` for the bare commands used above.

```bash
pnpm test          # vitest (includes a real build + npm pack of the release tarball)
pnpm typecheck     # tsc across packages and scripts/
pnpm lint          # biome
pnpm pack:release  # build release/homefleet-<version>.tgz locally
```

Everything is testable on a single machine — integration tests run multiple daemons as local processes with faked capability profiles. Cutting a release: [docs/reference/releasing.md](docs/reference/releasing.md).

## Roadmap

Done:

- **v0.1** recon and command delegation
- **v0.2** code-writing delegation (branches come back to your repo)
- **v0.3** per-node model catalog ([A2](docs/specs/2026-07-21-model-catalog-design.md))
  and packaged install from a GitHub Release ([S1](docs/specs/2026-07-12-s1-packaging-design.md))
- **v0.4** [read-only dashboard](docs/specs/2026-09-24-read-only-dashboard-design.md)
- **v0.5** [unpair a node](docs/specs/2026-09-25-unpair-node-design.md), signed
  releases and `homefleet upgrade` ([fleet upgrade spec](docs/specs/2026-09-25-fleet-upgrade-design.md));
  v0.5.2 added `homefleet fleet upgrade`
- **v0.6** upgrades from the dashboard
- **v0.7** `homefleet daemon start|stop|restart|status` ([spec](docs/specs/2026-11-05-daemon-lifecycle-command-design.md)),
  the first step of node lifecycle automation

Still open from the approved order ([backlog structuring doc](docs/specs/2026-07-12-backlog-structuring.md),
2026-07-12): painless install and fleet expansion (B1, beyond the v0.3
packaging), the rest of the fleet-management mutations (A1), and remote model
install (A3). The rest of node lifecycle automation (autostart for real,
supervising the model server, versions in `homefleet nodes`) is in the
[backlog](docs/backlog.md).

Longer horizon, not yet sequenced: macOS/Linux polish, multi-node fan-out,
model-pool orchestration on the same fabric.

Unordered ideas and known follow-ups live in the [backlog](docs/backlog.md).

## License

[Apache-2.0](LICENSE) — © 2026 Hugo Deziel
