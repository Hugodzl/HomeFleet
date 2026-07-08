# ADR-0006: Single-process daemon assembly, and a dedicated loopback control channel

- **Status:** accepted
- **Date:** 2026-07-08

## Context

Through M8, every module (identity, transport, discovery, executors, dispatch,
workspace sync, the MCP front) existed and was tested, but only as
independently-instantiated collaborators wired up ad hoc per test or per bin.
M9 needed to turn that into one runnable process — `homefleetd` — plus an
operator CLI (`homefleet`) to drive it. Two design questions fell out of that:

1. **Assembly order.** Discovery announces the HFP port; NodeInfo advertises
   live job load; the control API needs every other front already live before
   it answers `status`. Component start order is not arbitrary, and neither is
   teardown.
2. **How does a separate CLI process talk to the running daemon?** `homefleet
   setup` only prints commands and reads local files — no daemon needed. But
   `pair begin`, `pair connect`, `nodes`, and `status` need **live** state: the
   currently-open pairing window lives in the running `PairingManager`'s
   memory, not on disk; `status`/`nodes` must reflect current job load and
   current reachability, not a snapshot the CLI reconstructs by re-reading
   trust-store/known-nodes files itself (which would also race the running
   daemon's own writes to those files).

## Decision

### Assembly: one `Daemon` class, ordered start, LIFO teardown

`Daemon.start()` brings components up in dependency order: persistent state
(identity, trust store, known nodes) → workspace store → job manager → NodeInfo
provider (reads live job load) → the LAN-facing HFP `NodeServer` (started
before discovery, so discovery announces the *actually-bound* port, which
matters when config specifies port `0`) → discovery → the MCP front → the
control API **last**, after both the LAN-facing and delegating fronts are
live, so `status`/`nodes` never observe a half-assembled daemon.

Every start step pushes its teardown onto a stack; `stop()` (and a failed
`start()`'s unwind) pops it in reverse — control and MCP close first (no new
admin/agent traffic), then discovery (stop announcing), then the LAN server
(no new peer requests), then jobs and workspace git are drained/aborted. Every
teardown step is shielded: one component's stop failing must not skip the
rest (each already holds live sockets or child processes that would otherwise
leak), so failures are routed to an `onError` sink instead of aborting the
loop.

### A dedicated control API, not an extension of MCP or HFP

The `homefleet` CLI talks to the running daemon over a **new, separate,
loopback-only HTTP API** (`control.host`/`control.port`, default
`127.0.0.1:56373`) rather than piggybacking on an existing front:

- **Not the MCP front.** MCP's tools are the *agent-facing* surface
  (`list_nodes`, `delegate_task`, ...) — a different consumer, a different
  trust question (an LLM-driven agent session vs. a human running a CLI), and
  a different lifecycle (MCP tool schemas are part of the public agent
  contract; pairing/status plumbing is not). Folding CLI operations into MCP
  tools would mean either exposing `pair/begin` to the agent (letting an LLM
  open a pairing window) or building a second, parallel tool-registration path
  with different auth — both worse than a small dedicated server.
- **Not the HFP node service.** HFP is the *LAN* protocol between daemons,
  authenticated by mTLS + the paired-device list (ADR-0004). `pair/begin` and
  `status` are **local operator operations on THIS node**, not messages from a
  peer; routing them through HFP would mean either accepting them from
  unpaired peers (a pairing bootstrap problem HFP already solves differently,
  via `POST /hfp/v0/pair`) or inventing a "local peer" fiction. Pairing and
  status are local operator state, not protocol traffic.
- **A dedicated channel keeps each surface's threat model honest.** MCP is
  "local agent, mostly-read, one write path (`delegate_task`) that's already
  scoped by config"; HFP is "authenticated LAN peer"; control is "local
  operator, small surface, two of its four routes mutate live trust state."
  Merging any two blurs a threat model that is otherwise a one-line summary
  per front.

### Control API security posture

The control API reuses the MCP front's loopback discipline outright (same
`LOOPBACK_HOSTS` set, same fail-closed-until-ready guard, same Host-header
DNS-rebinding check built synchronously before the socket can accept a
request) and adds one defense specific to it:

- **CSRF via a required custom header.** Every route rejects a request missing
  `x-homefleet-control: 1` with 403, before any route logic runs. A plain HTML
  form or a cross-origin `fetch()` without custom headers cannot set this
  header; a `fetch()` that does set it triggers a CORS preflight, which this
  server fails (it sends no `Access-Control-Allow-*` headers on any response)
  — so the browser blocks the real request before it is sent. This is on top
  of, not instead of, the Host-header check: Host defends against DNS
  rebinding (an attacker page whose hostname resolves to 127.0.0.1); the
  custom header defends against a same-origin-looking form/script that a
  rebound Host check alone would not catch.

**Explicit sign-off on the write-path posture (not inherited by assumption
from the MCP front's mostly-read rationale):** `pair/begin` opens a pairing
window and `pair/connect` can make this daemon perform an outbound TLS
handshake against a caller-named `host:port` and, on acceptance, write a new
device into the live trust store. `CONTROL_HEADER`'s value is a compile-time
constant, not a per-boot secret — it stops a browser (see above) but not
another process already running as the same OS user, which can read the
constant from source and drive these routes itself. This is accepted for v0:
**local processes are trusted**, the same posture already taken for the MCP
front and the HFP node service's local admin surface. If that boundary is
ever judged insufficient specifically for this write path, the documented
hardening path is a **per-daemon-instance random token** (e.g. written to a
`0600` file only the same OS user can read, checked in addition to the static
header) — not a rewrite of the network/browser defenses above, which hold
independently of it.

## Consequences

- `homefleetd` is a single process an operator starts once; every collaborator
  it needs is wired up in one place (`daemon.ts`), with the ordering rationale
  written down inline rather than left to be reverse-engineered from bugs.
- The CLI is a thin, fully fake-able wrapper (`runCli(argv, deps)`) around
  three things: `setup` (local-only, no daemon needed), and
  `pair`/`nodes`/`status` (all go through the control client) — `homefleet`
  itself never touches the trust store, job manager, or discovery directly.
- A third local HTTP surface (alongside HFP and MCP) is more code than
  reusing an existing one, but each of the three now has a one-sentence threat
  model instead of one surface trying to serve two audiences.
- The per-boot-token hardening path is written down but not implemented in
  v0 — same-OS-user is the accepted trust boundary for now, consistent with
  every other local front in this daemon.
