# HomeFleet

**Your coding agent, but your other PCs do the heavy lifting.**

HomeFleet turns the computers in your home into a fleet your AI coding agent can use. Install a small daemon on each machine, pair them once, and any MCP-capable agent (Claude Code, LM Studio, goose, Cline, ...) gains tools to see every machine in the house and delegate work to them — powered entirely by **local models**, entirely on **your LAN**, with no cloud in the loop.

> **Status: v0.1 — pre-alpha.** The product spine is complete — identity,
> mTLS transport, LAN discovery, executors, job dispatch, the MCP front door,
> workspace (git bundle) sync, the single-process daemon assembly, and the
> `homefleet` operator CLI — and the two-machine acceptance demo has run on
> real hardware: recon delegated laptop → tower against a local
> Qwen3.6-35B-A3B returned an accurate architecture summary in ~105 s end to
> end, and a repeat delegation re-synced in 129 ms vs ~6 s cold (details in
> the [rig devlog](devlog/2026-07-09-m8-rig-bringup.md)). v0.1 is a tagged
> release you install from source, Windows-first; npm packages come later.
> The [Quickstart](#quickstart) below runs today on a single machine;
> pairing two real machines is the [two-machine demo](#two-machine-demo).

## Why

Local agents are getting genuinely useful, but a single machine is always the bottleneck — and most of us have more than one computer sitting around. Existing multi-machine tools either pool GPUs to serve one bigger model (exo, GPUStack, llama.cpp RPC) or replace your whole workflow with a new platform (dashboards, kanbans, custom protocols). Nothing lets the agent you *already use* simply reach over and put your other machines to work.

HomeFleet is that missing thin layer:

- **MCP-native** — appears as `list_nodes` / `delegate_task` tools inside your existing agent session; results stream back into its context
- **LAN auto-discovery** — daemons find each other via mDNS; pair with a short code, Syncthing-style (device ID = certificate fingerprint, mutual TLS, no CA, no accounts)
- **Local models by default** — worker machines drive tasks with whatever OpenAI-compatible server they have (Ollama, LM Studio, llama.cpp server)
- **Capability-aware** — nodes advertise what they can do; a weak GPU box still earns its keep as an execution node (tests, builds, file ops) while stronger machines do the thinking

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

One daemon per machine. On your machine it faces your agent as an MCP server; on workers it executes delegated jobs — read-only repo recon driven by a local model, or allowlisted commands (test suites, builds). Code travels as git bundles; nothing needs a shared remote.

## v0.1 scope

- Delegate **recon** tasks ("explore this repo, summarize the auth flow") to a worker's local model
- Delegate **command** runs ("run the test suite") to any paired machine
- Live node list with capability info, job status/streaming, cancellation
- Windows-first reference setup; code is cross-platform TypeScript

Explicit non-goals for v0.1: code-*writing* delegation, GUI, cloud relay. See the [design doc](docs/specs/2026-07-06-homefleet-design.md) and [roadmap](#roadmap).

## Quickstart

Single machine, dev setup. This is enough to build the daemon, run it, and
point an MCP client at it — pairing a second real machine is the
[two-machine demo](#two-machine-demo) below.

```bash
git clone https://github.com/Hugodzl/HomeFleet.git
cd HomeFleet
pnpm install
pnpm build        # tsup bundles packages/daemon's three bins to dist/bin/*.js
```

`pnpm build` is required — the bins are plain, bare-`node`-runnable ESM files;
there is no `tsx`/dev-mode path for running them anymore. Invoke them with
`node`:

```bash
node packages/daemon/dist/bin/homefleet.js --help
```

(A bare `homefleet`/`homefleetd` shell command is also possible via `pnpm
link --global`, with a caveat — see
[`packages/daemon/README.md`](packages/daemon/README.md#bins). The `node ...`
form above always works with no setup, so the rest of this guide uses it.)

Next, scaffold this machine — prints this node's identity and the commands
*you* run yourself in an elevated PowerShell (the daemon never elevates
itself):

```bash
node packages/daemon/dist/bin/homefleet.js setup
```

Run the printed `New-NetFirewallRule` commands (HFP TCP + discovery UDP,
scoped to the Private network profile) in an elevated PowerShell, and check
the printed network-profile warning — the rules only take effect on a
Private-profile adapter.

Before starting the daemon, write a `config.json` in its data directory (by
default `%LOCALAPPDATA%\homefleet` on Windows; override with
`HOMEFLEET_DATA_DIR`). A fresh install with no config file runs no executors
and syncs no repos — everything below is opt-in. A worker offering a local
model plus a command allowlist, for one repo:

```json
{
  "executors": {
    "agent": {
      "endpoint": {
        "baseUrl": "http://127.0.0.1:8080/v1",
        "model": "qwen3.5-9b",
        "contextWindow": 32768
      }
    },
    "command": { "allowlist": { "pnpm": {} } }
  },
  "workspace": { "allowedRepoIds": ["homefleet"] }
}
```

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
node packages/daemon/dist/bin/homefleetd.js
```

It prints its device ID, bound ports, and data directory to stderr once it's
up. Finally, point an MCP-capable agent at it — for Claude Code:

```bash
claude mcp add --transport http homefleet http://127.0.0.1:56372/mcp
```

See [`packages/daemon/README.md`](packages/daemon/README.md#pointing-claude-code-at-the-daemon)
for the exact `.mcp.json` form and the stdio-shim alternative.

## Two-machine demo

This is the M8 acceptance path: two physical machines, each running
`homefleetd`, paired, delegating a real job to a real local model. This
exact path ran for real on the reference rig on 2026-07-09 — timings, token
rates, and the Windows MAX_PATH lesson it surfaced are in the
[rig devlog](devlog/2026-07-09-m8-rig-bringup.md). Follow the
[Quickstart](#quickstart) above through `pnpm build` **on both machines**
first, then:

1. On **each** machine, run `homefleet setup`, run the printed firewall
   commands in an elevated PowerShell, and start `homefleetd`. Give the
   worker machine a `config.json` with an `agent` and/or `command` executor
   and a non-empty `workspace.allowedRepoIds`; give the delegating machine a
   `repos` mapping naming the same repoId (see the Quickstart's examples and
   the [configuration reference](docs/reference/configuration.md)).
2. **Pair them.** On machine B (the worker), open a pairing window:
   ```bash
   node packages/daemon/dist/bin/homefleet.js pair begin
   ```
   This prints a short code. On machine A (the delegator), connect to B using
   B's LAN address, B's HFP port (`56370` by default), and that code:
   ```bash
   node packages/daemon/dist/bin/homefleet.js pair connect <B-host> <B-hfp-port> <code> [--expect <B-device-id>]
   ```
3. **Verify.** On either machine:
   ```bash
   node packages/daemon/dist/bin/homefleet.js nodes    # the peer, with live capabilities
   node packages/daemon/dist/bin/homefleet.js status   # this node's own live status
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

```bash
pnpm install
pnpm build       # tsup — required before running any packages/daemon bin
pnpm test        # vitest
pnpm typecheck   # tsc across packages
pnpm lint        # biome
```

Everything is testable on a single machine — integration tests run multiple daemons as local processes with faked capability profiles.

## Roadmap

v0.1 (recon + command delegation) → code-writing delegation (diffs/branches back) → tray app + web dashboard → macOS/Linux polish → multi-node fan-out → model-pool orchestration on the same fabric.

## License

[Apache-2.0](LICENSE) — © 2026 Hugo Deziel
