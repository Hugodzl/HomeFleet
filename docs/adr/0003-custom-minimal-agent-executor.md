# ADR-0003: Custom minimal agent loop as the v1 executor (not wrapping opencode)

- **Status:** accepted
- **Date:** 2026-07-06

## Context

The worker-side "agent executor" drives a local model through a delegated task. Options evaluated (research 2026-07-04): wrap an existing headless CLI agent, or write a minimal tool-calling loop.

Best wrap candidate was **opencode** (MIT; true server mode with OpenAPI HTTP API, SSE events, official TS SDK). But wrapping means every worker machine must also install and configure a third-party agent, and we inherit its event schema and release cadence.

Meanwhile, a minimal loop is genuinely viable in 2026: v1 scope is **read-only recon** (the hard part of mature harnesses — robust edit application — is not needed), small tool-trained models hit 93–97% tool-call accuracy (Qwen3 8B/14B class, Docker's 3,570-test eval), and MIT prior art (pi-agent-core: 4 tools + ~1k-token prompt) proves the pattern.

## Decision

v1 ships a **purpose-built minimal agent loop** in TypeScript: ~4 read-only tools (`read_file`, `grep`, `glob`, `list_dir`) plus allowlisted `run_command`, speaking to any OpenAI-compatible endpoint, emitting exactly the structured events the HomeFleet protocol wants, with hard budgets (max tool calls, wall time) and an enforced ≥16k context window (4k defaults silently break agentic behavior).

It lives behind a pluggable **Executor interface** — the same interface the no-LLM command executor implements.

## Consequences

- Worker install = our daemon + a model server. Nothing else.
- Full control of events, safety, and licensing; the executor is first-party portfolio work.
- We own harness robustness; acceptable at recon scope. When code-writing delegation arrives (post-MVP), an **opencode adapter** behind the same Executor interface is the likely path rather than growing our loop into a full editing harness.
