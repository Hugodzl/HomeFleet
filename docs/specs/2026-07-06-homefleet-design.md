# HomeFleet — v0.1 Design

- **Date:** 2026-07-06
- **Status:** approved (brainstorm + competitive research 2026-07-04)

## Product

**"Your coding agent, but your other PCs do the heavy lifting."** A daemon on each home machine; pair once; any MCP-capable agent gets `list_nodes` / `delegate_task` tools, and delegated work runs on other machines' local models — all on the LAN, no cloud.

Beachhead vertical: **coding tasks**. v0.1 capability: **recon** (read-only repo analysis by a worker's local model) and **command execution** (tests, builds) on remote nodes. Deliberately *not* generic-first: the fabric underneath (discovery, pairing, transport, dispatch) is use-case-agnostic, but the installed product nails one workflow out of the box.

Positioning (verified against the July 2026 landscape): no existing project combines an MCP-thin front-end, LAN auto-discovery, local-model executors, and capability-aware routing. Adjacent projects (Fusion, AgentsMesh, ai-maestro) are platforms that replace the user's workflow; HomeFleet plugs into it.

## Architecture

One daemon per machine — `homefleetd` (TypeScript/Node) — with five modules:

### 1. MCP front (`packages/daemon/src/mcp/`)
- `@modelcontextprotocol/sdk` v1.29.x; `McpServer` + `registerTool()`; zod input **and** output schemas; results as `structuredContent`.
- Streamable HTTP bound to `127.0.0.1`; Origin validation; DNS-rebinding protection; thin stdio shim bin for stdio-only clients.
- **Stateless design**; no Sampling/Roots/MCP-Logging (deprecated in MCP 2026-07-28; migration to SDK v2 later via official codemod).
- Tools: `list_nodes`, `delegate_task`, `job_status`, `job_result`, `cancel_job`.

### 2. Node service (LAN-facing, HTTPS + mTLS)
Where the **HomeFleet Protocol (HFP)** lives: `hello`/capabilities exchange, `delegate`, `events` (SSE stream), `result`, `cancel`. Versioned; job model extensible so future job types (model-pool orchestration) fit without redesign. Spec: `docs/rfc/hfp-v0.md`.

### 3. Discovery
mDNS advertise + browse (`bonjour-service`), LocalSend-style UDP multicast fallback, manual IP entry. Interface-selection config override (VPN/virtual adapters are the known Windows failure mode). Known-nodes registry persisted.

### 4. Executors (pluggable interface)
- **Command executor:** allowlisted commands per node, workspace cwd, timeouts, output capture. No LLM.
- **Agent executor:** minimal TS tool-calling loop — `read_file`, `grep`, `glob`, `list_dir` + allowlisted `run_command` — against any OpenAI-compatible endpoint; streaming events; budgets (max tool calls, wall time); enforced ≥16k context window.
- Nodes advertise **roles**: a weak-GPU machine is still a useful execution node.

### 5. Workspace manager
Repo transfer as **git bundles** over HFP (full first time, incremental after) into per-repo cached worker workspaces. Worker-side repo allowlist. Committed-state only in v0.1 (ADR-0005).

### Identity & trust (ADR-0004)
Per-device self-signed cert via `@peculiar/x509`; device ID = SHA-256 cert fingerprint; mTLS with fingerprint pinning against the paired-device list; short pairing codes. MCP front never leaves localhost.

### Windows realities
Firewall allow rules created during elevated `homefleet setup` (Private profile, LocalSubnet scope, UDP rule for discovery); detect-and-warn on Public network profile; autostart via Task Scheduler at-logon task. Tray app is post-MVP.

## Reference rig

| Machine | Serving | Model |
|---|---|---|
| Tower — Ryzen 5600X, 32GB, RX 6700 XT 12GB | llama.cpp `llama-server`, **Vulkan** build (gfx1031 has no official Windows ROCm; Vulkan ≈ ROCm on RDNA2) | **Qwen3.6-35B-A3B** Q4 with `--n-cpu-moe` offload (~20–30 tok/s expected); fallback Qwen3.5-9B Q6_K in-VRAM |
| Laptop — i7-6700HQ, 16GB, GTX 1060 6GB | **Ollama** (CUDA; NVIDIA driver ≥570 required or it silently falls back to CPU) | **Qwen3.5-4B** Q4 fully on GPU |

Different serving stacks on purpose — both integration paths get dogfooded. Primary demo client: Claude Code.

## Testing strategy

- **Single-machine multi-node is a hard constraint:** N daemon processes with faked capability profiles over loopback mTLS. No feature may require two physical machines to test.
- Mock OpenAI-compatible endpoint (deterministic scripted tool calls) for agent-loop tests.
- Real-model smoke tier on the rig; results feed `devlog/`.
- CI: lint, typecheck, tests on Windows + Linux.

## v0.1 acceptance

From a stock Claude Code session: (1) delegate a recon prompt against a repo → runs on the other machine's local model → structured summary returns into the session; (2) delegate a test-suite run → output + exit code return. `list_nodes` shows live capability info; cancellation works mid-job; an unpaired daemon on the LAN is rejected; the MCP server is unreachable from non-localhost.

## Non-goals (v0.1)

Code-writing delegation, GUI (the daemon's HTTP API is designed so a dashboard can be added as a client), cloud relay, non-Windows polish (code stays cross-platform-friendly).

## Roadmap after v0.1

Code-writing delegation (diffs/branches; likely opencode adapter behind the Executor interface) → tray app + web dashboard → macOS/Linux → multi-node fan-out → model-pool orchestration ("Product A") on the same fabric.
