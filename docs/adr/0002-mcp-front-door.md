# ADR-0002: MCP is the front door; HomeFleet ships no agent UI

- **Status:** accepted
- **Date:** 2026-07-06

## Context

Users already have an agent they like (Claude Code, LM Studio, goose, Cline, ...). Building our own chat UI or agent loop for the *calling* side would triple scope and put us in competition with mature agent products. The Model Context Protocol is the established integration standard in 2026 (600+ clients), and GitHub validated the exact UX — delegating work to a remote coding agent via an MCP tool — with their Copilot delegation server.

## Decision

HomeFleet's user-facing surface is an **MCP server** exposed by the local daemon: `list_nodes`, `delegate_task`, `job_status`, `job_result`, `cancel_job`. Whatever MCP client the user already runs becomes the HomeFleet cockpit.

Implementation constraints (from the July 2026 MCP landscape):

- SDK `@modelcontextprotocol/sdk` v1.29.x now; **stateless design** so the 2026-07-28 spec (sessions removed) is a codemod-level migration.
- No reliance on Sampling, Roots, or MCP Logging — all deprecated in the 2026-07-28 revision.
- Transport: Streamable HTTP bound to `127.0.0.1` (a daemon has independent lifecycle; stdio cannot attach to a running process), with Origin validation + DNS-rebinding protection; a thin stdio shim for stdio-only clients.
- Tools use zod input **and** output schemas and return `structuredContent`.

## Consequences

- Zero UI work in v1; adoption piggybacks on every MCP client.
- We don't control the calling agent's UX; the product is a daemon (less shiny, easier to be first and best).
- A future GUI is just another client of the daemon's HTTP API — no architectural change.
