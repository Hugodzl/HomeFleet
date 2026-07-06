# HomeFleet

**Your coding agent, but your other PCs do the heavy lifting.**

HomeFleet turns the computers in your home into a fleet your AI coding agent can use. Install a small daemon on each machine, pair them once, and any MCP-capable agent (Claude Code, LM Studio, goose, Cline, ...) gains tools to see every machine in the house and delegate work to them — powered entirely by **local models**, entirely on **your LAN**, with no cloud in the loop.

> **Status: pre-alpha.** Under active development toward v0.1. Nothing here is ready to use yet — watch the repo if the idea speaks to you.

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

## Repository layout

| Path | What |
|---|---|
| `packages/protocol` | HomeFleet Protocol (HFP) — zod schemas + types; spec in `docs/rfc/` |
| `packages/daemon` | `homefleetd` — MCP front, node service, discovery, dispatch |
| `packages/executors` | Command executor + minimal agent loop |
| `docs/rfc/` | Versioned RFC-style protocol spec |
| `docs/adr/` | Architecture Decision Records |
| `docs/specs/` | Design documents |
| `devlog/` | Findings, benchmarks, lessons learned along the way |

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc across packages
pnpm lint        # biome
```

Everything is testable on a single machine — integration tests run multiple daemons as local processes with faked capability profiles.

## Roadmap

v0.1 (recon + command delegation) → code-writing delegation (diffs/branches back) → tray app + web dashboard → macOS/Linux polish → multi-node fan-out → model-pool orchestration on the same fabric.

## License

[Apache-2.0](LICENSE) — © 2026 Hugo Deziel
