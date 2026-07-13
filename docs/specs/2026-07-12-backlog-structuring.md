# Backlog Structuring & Post-v0.2 Sequencing

- **Date:** 2026-07-12
- **Status:** sequencing approved by Hugo 2026-07-12. The risk mitigations in
  this doc are recommendations feeding future brainstorms, not decisions —
  each cluster still gets its own design pass before implementation.

## Context

The [backlog](../backlog.md)'s five product ideas are not five independent
features: three are facets of one missing subsystem (a management plane), and
every idea leans on at least one piece of shared infrastructure the backlog
implies but does not name. This doc records the structure and the approved
build order so release brainstorms start from the map, not the flat list.

## Clusters

### A — Management plane

An escalation ladder: view → configure → mutate remote machines. Each step
raises the privilege and trust requirements.

- **A1 · Fleet management GUI** — see and *change* other nodes (state, name,
  capabilities, parameters). The roadmap's dashboard covers viewing; A1 adds
  mutations. The daemon HTTP API seam exists, but only for the local daemon.
- **A2 · Per-node model catalog** — the model set becomes an explicit,
  enforced allowlist/catalog per node, surfaced through capability ads so the
  delegating side can pick a model or be denied. Today `models[]` is purely
  advertisory.
- **A3 · Remote model install** — install models onto other nodes from the
  central GUI. Capstone: builds on A1 + A2, needs per-server adapters (S4)
  and a privilege tier above pairing (S5). Highest risk; ships last.

### B — Onboarding & distribution

- **B1 · Painless install & fleet expansion** — installer, guided first-run
  instead of hand-edited `config.json`, one-step add-a-machine (install on
  the new box, approve from an existing one). The approval side naturally
  lives in the A1 GUI, but the CLI serves interim — B1 is not blocked on
  cluster A. First rung is the npm-packaging debt item (S1).

### C — Capability breadth

- **C1 · Workspace-less tasks** — jobs with no git bundle (web search,
  calculations). Workspace becomes optional in the job spec; executors
  declare whether they need one. Protocol-shaped, independent of cluster A.

## Shared seams (build once, not five times)

| Seam | What | Used by |
| --- | --- | --- |
| **S1 · Packaging** | npm → single binary / winget (debt list) | B1 |
| **S2 · Config mutation API** | daemon-owned `config.json` writes, per-section reload semantics | A1, A2, B1 wizard |
| **S3 · Capability-ad schema rev** | one evolution carrying model catalogs, tool/workspace-needs flags, daemon version | A2, C1, B1 (version skew) |
| **S4 · Model-server adapters** | list / pull / load per server type (Ollama, LM Studio, llama.cpp) | A2 (list), A3 (install) |
| **S5 · Management trust tier** | per-node, off-by-default grant for remote mutation — ADR-0004 extension | A1 remote edits, A3, future remote upgrade |

## Known issues & recommended mitigations

Recommendations, not decisions:

1. **Remote management has no channel.** The control API is loopback-only;
   A1/A3 need management verbs crossing the LAN. Recommend an HFP management
   extension gated by an explicit per-node "managed by device X" consent flag
   (default off); fallback for the scariest verbs: GUI proposes, target node
   approves locally.
2. **Config ownership conflict.** `config.json` is hand-edited, strict-parsed,
   fatal-on-invalid. Once a GUI writes it, human and daemon writes collide.
   Recommend daemon-as-sole-writer (CLI/GUI go through the API); alternative
   is a human base file + machine-managed overlay.
3. **Adapter matrix bites before install.** A2 can't advertise an honest
   catalog without asking the server what's served (`/v1/models`,
   `/api/tags`); install stories diverge hard (Ollama pull API vs. GGUF
   download + restart). Recommend adapter interface with declared capability
   tiers; A3 v1 ships Ollama-only.
4. **Positioning drift on C1.** "Advertise arbitrary tools" is the road to
   the generic-agent platforms HomeFleet is deliberately not. Recommend the
   command-allowlist discipline: a small, named, opt-in tool set (e.g.
   `web_search` with domain allowlist + size caps), not a plugin system. Web
   access from a worker loop is a new egress/prompt-injection surface.
5. **Fail-closed defaults vs. painless first-run.** A fresh install runs no
   executors and syncs no repos — right posture, dead demo. Resolve in the
   B1 wizard (writes explicit opt-ins); never loosen the defaults.
6. **Version skew becomes routine once install is easy.** Advertise daemon
   version in `hello`/NodeInfo (S3); GUI flags mismatches. Remote upgrade is
   an S5-class privileged op, same gate as A3, later.
7. **Timing collision with v0.2.** C1 reshapes the same job-spec union the
   write task kind is extending. Land v0.2 first; workspace optionality is
   its own protocol rev, ideally scheduled while the union context is warm.

## Approved sequencing

> v0.2 write delegation (committed, in progress)
> → **S1** packaging (debt item, unlocks B1)
> → read-only dashboard (existing roadmap item)
> → **S2 + A1** config mutation API + GUI mutations
> → **S3 + A2** capability-ad rev + model catalog
> → **S5 + A3** management trust tier + remote install

- **B1** (installer, first-run wizard, pair flow) slots in any time after S1
  and improves every later step's demo story.
- **C1** runs parallel on the protocol track — it only competes for the job
  union; schedule right after v0.2's union work or defer at no cost to
  cluster A.
- **Not decided here:** how the pre-existing roadmap tail (macOS/Linux
  polish, multi-node fan-out, model-pool orchestration) interleaves with the
  above.
