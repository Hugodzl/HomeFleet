# Devlog 020: unpair a node

**2026-09-25**

`homefleet unpair <name|deviceId> [--yes]` revokes a pairing on a running
daemon. The peer drops out of `homefleet nodes`, MCP `list_nodes`, and the
dashboard immediately, with no restart and no hand-editing of
`trusted-devices.json`. A new `POST /control/unpair {deviceId}` route calls
`ControlSurface.unpair`, wired in `daemon.ts` to an exported `unpairPeer()`.

Plan: [2026-09-25-unpair-node.md](../docs/plans/2026-09-25-unpair-node.md).
Spec: [unpair a node design](../docs/specs/2026-09-25-unpair-node-design.md).

## Decisions

- **Revocation order: trust first, then clean-up.** `unpairPeer()` removes
  the device from the live `TrustStore` first — it's persisted and
  authoritative, and ADR-0004's per-request fingerprint check means every
  subsequent HFP request from that device gets 401 immediately, even on an
  already-open connection. Only after that does it fire
  `JobManager.cancelOwnedBy(deviceId)` (without awaiting the unwind — queued
  jobs finish synchronously, running jobs get their abort fired, and the
  per-job unwind is already bounded at 30 s) and then remove the device's
  `KnownNodesRegistry` entry, best-effort. If the trust-store persist fails,
  the in-memory delete has already happened, so the device is revoked for
  this run regardless (fail-closed); the wrapped 500 is thrown only after the
  job-cancel and known-nodes steps still run.
- **One-sided, like Syncthing.** No protocol message and no notification to
  the peer. From then on the peer gets 401 from us and its own node
  directory shows us as `reachable: false`. Ending trust both ways means
  running `unpair` on both nodes. Re-pairing afterward is the ordinary `pair
  begin` / `pair connect` flow — entries are keyed by device ID, so a
  leftover entry on the other side is simply replaced, not duplicated.
- **Name, prefix, or full device ID, resolved by the CLI.** The argument
  matches a paired node if it equals its full device ID, is a hex prefix of
  at least 8 characters, or equals its name exactly. Zero matches is an
  error; more than one lists the candidates and asks for the full device ID.
  The control route itself takes only a full 64-hex `deviceId` — name
  resolution is a CLI concern, and a future dashboard control can reuse the
  route as-is.
- **`--yes` required, no prompt.** Without it, the CLI prints what it *would*
  unpair and exits 1 without mutating anything. It never prompts for
  confirmation: the CLI has no stdin dependency today, and it's driven by
  agents as often as by people.

## Accepted bounds

- **A request already past the auth check completes.** The per-request
  fingerprint re-check only blocks requests that start after the removal.
  Uploads, artifact downloads, and job submits already past that check when
  the removal lands will finish; they're bounded by `maxBundleBytes` and the
  idle timeouts anyway.
- **A narrow submit race can leave one job running.** A submit whose body
  was still being read can be accepted just after `cancelOwnedBy` ran, and
  that job then runs to completion. Its owner can never poll, stream, or
  fetch it afterward — every follow-up request gets 401 — so it just holds a
  slot until it finishes or is evicted. Closing this would mean re-checking
  trust inside `JobManager.submit`, which isn't worth a trust dependency in
  the job layer for a two-to-ten-node LAN tool.
- **Discovery may re-record the peer.** If the peer is still announcing
  itself, discovery will write its `known-nodes.json` entry again. Harmless:
  known-nodes is a hint, not trust, and `NodeDirectory` only ever lists
  paired devices.
- **A stale delegation to an unpaired node stays unreachable, even for an
  applied write.** After unpairing a node, `job_result` refuses even an
  already-applied write job delegated to it. The applied `homefleet/<id>`
  branch stays in the local repo; only the tool lookup is refused.

## Rig check (2026-09-25)

Ran on the laptop against the checkout build (`pnpm build`), using two
throwaway daemons with temp data dirs on loopback, alternate ports
56480–56493, and discovery off. The installed 0.4.0 daemon and the
laptop↔tower pairing were not touched.

Paired `scratch-a` with `unpair-scratch` via `pair begin` / `pair connect`.
`homefleet unpair unpair-scratch` (no `--yes`) printed `Would unpair
unpair-scratch (<full id>).`, then `Nothing changed. Re-run with --yes to
confirm.`, and exited 1 — the preview path, no mutation. Then `homefleet
unpair 3fb9e174 --yes` — an 8-character device-ID prefix — printed `Unpaired
unpair-scratch (<full id>).` plus the one-sided hint, and exited 0.

`homefleet nodes` afterward showed "No paired nodes yet."; `GET
/control/nodes` (the dashboard's own data route) returned `{"nodes":[]}`; and
`trusted-devices.json` and `known-nodes.json` were both `[]`. Re-running the
unpair printed `No paired node matches "unpair-scratch"...` and exited 1, as
expected once the entry is gone. On the other side, `unpair-scratch` still
listed `scratch-a` as paired, but with REACHABLE `no` — the one-sided
behavior as designed; it never learns it was unpaired.

Test gate: typecheck and lint clean; 967 tests passed, 3 skipped.

## Out of scope

No dashboard "Unpair" button (needs its own CSRF story), no mutual/notified
unpair, no remote-cancel of our delegations on the unpaired peer, no
`--dry-run` (running without `--yes` already is one), no renaming, and no
per-boot control token. See the spec's "Out of scope" section for the full
list and rationale.

## Follow-ups

- Surface "peer no longer trusts us" as its own directory state instead of
  reusing `reachable: false` — flagged in the backlog as a candidate.
- The dashboard's mutating half (S2 + A1: rename, config edits, GUI pairing,
  cancel, and now a GUI unpair control) is still next per the approved
  sequencing.
- No release was cut for this. Shipping it as v0.5.0 follows
  `docs/reference/releasing.md`, as a separate step.
