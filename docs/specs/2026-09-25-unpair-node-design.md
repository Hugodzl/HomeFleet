# Unpair a Node — Design

- **Date:** 2026-09-25
- **Status:** implemented.
- **Backlog:** [A1 → "Unpair a node"](../backlog.md#unpair-a-node). This is
  A1's first mutation, and it ships CLI-first.
- **Trust model:** [ADR-0004](../adr/0004-syncthing-style-trust-model.md).
  This design adds an addendum to it.

## Goal

Let an operator revoke a pairing on a running daemon with one command:

```
homefleet unpair <name|deviceId> [--yes]
```

The peer disappears from `homefleet nodes`, MCP `list_nodes`, and the
dashboard straight away, with no restart and no hand-editing of
`trusted-devices.json`.

Success: on the rig laptop, a stale entry like the 2026-09-25
`laptop-delegator` one is removed with `homefleet unpair laptop-delegator
--yes`. The running daemon rejects that device's next HFP request with 401,
and the entry is still gone after a daemon restart.

## Decisions

| Question | Decision |
| --- | --- |
| What revocation cuts off | **Trust first, then clean-up.** (1) Remove the device from the live `TrustStore`. It is persisted, and it is authoritative. From this point every HFP request from that device gets 401, because the check runs per request (ADR-0004). (2) Cancel every non-terminal job that device owns on this node. That also ends its open SSE event streams. (3) Remove its `known-nodes.json` entry, best-effort. |
| Delegations *to* the unpaired node | **Kept as history and no longer routable.** The `DelegationRegistry` entries stay, so the dashboard's delegated-jobs table keeps its rows; they show the short device ID once the name is gone. `job_status`, `job_result` and `cancel_job` refuse to contact a device that is no longer paired, and say so. There is no remote cancel of those jobs: the node being unpaired is often unreachable or stale, and unpair must not hang on it. |
| One-sided or mutual | **One-sided, like Syncthing.** No protocol change and no notification. From then on the other side gets 401 from us, and its node directory shows us as `reachable: false`. To end trust in both directions, run `unpair` on both nodes. A later re-pair is the normal `pair begin` / `pair connect` flow. The side that still holds the old entry simply has it replaced, because entries are keyed by `deviceId`. |
| Name vs deviceId | **Both, resolved by the CLI.** The argument matches a paired node if it equals its full device ID, or is a hex prefix of at least 8 characters of it, or equals its name exactly. Zero matches: error. More than one: error that lists the candidates and asks for the full device ID. Duplicate names are the realistic case, because the trust store is keyed by device ID, not name. |
| Control route input | **`deviceId` only**, full and 64-hex (`POST /control/unpair {deviceId}`). It is unambiguous, and a future dashboard control can reuse it as-is. Name resolution is a CLI concern. |
| Confirmation | **`--yes` required.** Without it the CLI prints what it *would* unpair and exits 1, without mutating anything. It never prompts: the CLI has no stdin dependency today, and it is driven by agents as often as by people. |
| Dashboard | **No UI change.** It already reads the live trust store on every poll, so the node vanishes by itself. A dashboard "Unpair" button needs its own CSRF story (see backlog A1) and is out of scope. |

Rejected alternatives:
- **Mutual unpair via a new HFP `unpair` message.** This changes the
  protocol and adds a peer-driven trust mutation. It also does nothing in
  the main case, a stale or unreachable peer.
- **Leaving the unpaired peer's worker jobs running.** Its results can never
  be fetched after revocation, so the jobs would only burn this machine's
  slots.
- **Deleting the delegation-registry entries.** This loses the dashboard
  history for no security gain, because the tool guard already stops all
  routing.
- **Interactive `y/N` prompt.** This adds a stdin/TTY surface to the CLI and
  is awkward for agent-driven use. `--yes` covers both kinds of user.

## Architecture

```
homefleet unpair <arg> [--yes]
   ├─ GET  /control/nodes          (existing) → resolve <arg> to one deviceId
   └─ POST /control/unpair {deviceId}          (NEW; requires --yes)
          └─ ControlSurface.unpair(deviceId)   (NEW, wired in daemon.ts)
               1. trustStore.remove(deviceId)          ← authoritative
               2. jobManager.cancelOwnedBy(deviceId)   (NEW)
               3. knownNodes.remove(deviceId)          (NEW, best-effort)
```

Also enforced: MCP `job_status` / `job_result` / `cancel_job` fail closed
when `nodeDirectory.resolve(route.deviceId)` is `undefined`, meaning the
device is no longer paired.

### Units

1. **`KnownNodesRegistry.remove(deviceId): Promise<boolean>`** in
   `discovery/known-nodes.ts`. It mirrors `TrustStore.remove`: it persists
   only when an entry was present, through the existing coalesced persist.
2. **`JobManager.cancelOwnedBy(owner): number`** in `jobs/job-manager.ts`.
   It requests cancellation of every queued or running job `owner`
   submitted, using the existing owner-checked `cancel()`, and returns how
   many it asked to cancel. **It does not await the unwind**: queued jobs
   finish synchronously, and running jobs get their abort fired. The
   per-job unwind is already bounded, at 30 s. Unpair must answer promptly
   even when an executor is stuck.
3. **`unpairPeer()`** in `daemon.ts`. It is an exported, `Pick<>`-narrowed
   function in the style of `pairWithPeer`, and it runs the three steps in
   order:
   - The device must be in the trust store. If it is not, return
     `undefined`; the route turns that into a 404.
   - `trustStore.remove` throws on a persist failure. The in-memory delete
     has already happened by then, so the device is revoked for this run
     (fail-closed). The error is wrapped with `.status = 500` and a message
     saying the removal was not saved: the device will be trusted again
     after a restart, so fix the data dir and run unpair again after
     restarting.
   - `cancelOwnedBy` and `knownNodes.remove` then run, **even when the
     trust persist failed**. The device is revoked in memory either way, so
     its jobs are cut off too. Only after that is the wrapped 500 thrown. A
     known-nodes failure is swallowed, as in `pairWithPeer`, because
     known-nodes is a hint and not trust.
4. **Control route** `POST /control/unpair` in `control/control-server.ts`
   and `control/messages.ts`. The body is `UnpairRequestSchema = { deviceId:
   DeviceIdSchema }`. It reuses the pair/connect body reading and
   validation. Responses:
   - `200` with `UnpairSummary { deviceId, name, canceledJobs }`
   - `404 { error }` when the device is not paired
   - `400` for a malformed body, `413` when the body is too large
   - `500` from a thrown `.status`
5. **Tool guard** in `mcp/tools.ts`. After `delegations.lookup` succeeds,
   `job_status`, `job_result` and `cancel_job` check
   `nodeDirectory.resolve(route.deviceId)`. When the device is no longer
   paired, the tool returns a clean error without making any HFP call.
6. **Control client** in `cli/control-client.ts`: `unpair(deviceId):
   Promise<UnpairSummary>` with minimal response validation, the same as the
   other methods. `ControlClientLike` gains it.
7. **Target resolution** in `cli/unpair-target.ts` (new, pure):
   `resolveUnpairTarget(arg, nodes)` returns one of
   - `{ kind: "match", node }`
   - `{ kind: "none" }`
   - `{ kind: "ambiguous", candidates }`
8. **CLI** in `cli/cli.ts`: the `homefleet unpair <name|deviceId> [--yes]`
   command, plus usage text.
9. **Docs:** an ADR-0004 addendum, the README CLI list, the backlog entry, a
   devlog.

## Behavior details

### Target resolution (`resolveUnpairTarget`)

- Compare device IDs in lowercase. The argument counts as an ID query when
  it matches `/^[0-9a-f]{8,64}$/i`. In that case every node whose `deviceId`
  starts with the lowercased argument is a candidate.
- Every node whose `name === arg` (exact, case-sensitive) is also a
  candidate.
- De-duplicate candidates by `deviceId`. Exactly one candidate is a match.
- The input is the `GET /control/nodes` listing. It lists **only paired**
  devices, so resolution can never pick an unpaired one. That listing does
  a `hello` fan-out, which is bounded by the 2 s per-node timeout, so the
  command is slower when peers are asleep. That is acceptable for an admin
  command.

### CLI output and exit codes

| Case | Output | Exit |
| --- | --- | --- |
| no argument / extra argument / unknown flag | usage error | 2 |
| no match | stderr `No paired node matches "<arg>". Run "homefleet nodes" to list them.` | 1 |
| ambiguous | stderr `"<arg>" matches N paired nodes:`, then `  <name>  <full deviceId>` per candidate, then `Re-run with the full device ID.` | 1 |
| match, no `--yes` | stdout `Would unpair <name> (<full deviceId>).`; stderr `Nothing changed. Re-run with --yes to confirm.` | 1 |
| match, `--yes`, success | stdout `Unpaired <name> (<full deviceId>).`, then `Canceled <n> job(s) it had queued or running here.` when n > 0, then `<name> may still list this node as paired; run "homefleet unpair" there too to end trust both ways.` | 0 |
| route 404 (raced another unpair) | stderr `<name> is no longer paired.` | 1 |
| daemon unreachable | the existing friendly message | 1 |
| other `ControlRequestError` | the existing clean one-liner (`runCli` backstop) | 1 |

The full device ID is printed, not the short one, so that a person can pin
it later with `pair connect --expect`.

### What the other side sees

The other side is not told anything. It sees:

- its `list_nodes` / `homefleet nodes` shows us as `reachable: false`,
  because the `hello` to us gets 401;
- `delegate_task` to us fails with the HFP `UNAUTHORIZED` error, which the
  existing error mapping already turns into a clean tool error;
- any SSE stream it had open for a job we canceled ends with the terminal
  `canceled` event. That one final event is sent to the revoked peer, which
  is accepted: it reveals nothing beyond "your job stopped".

### Known, accepted bounds

- **A request already past the auth check completes.** ADR-0004 checks
  trust per request, at request start. Uploads, artifact downloads and job
  submits that were already past that check when the removal landed will
  finish. Uploads and downloads are bounded by `maxBundleBytes` and the
  idle timeouts.
- **A narrow race can leave one job running.** A submit whose body was
  still being read can be accepted *after* `cancelOwnedBy` ran, and that
  job then runs. Its owner can never poll, stream or fetch it (every
  follow-up request gets 401). It uses a slot until it finishes, and is
  evicted like any other job. Closing this race would mean re-checking
  trust inside `JobManager.submit`. That is not worth a trust dependency in
  the job layer for a two-to-ten-node LAN tool.
- **Discovery may re-record the peer.** If the peer is still announcing,
  discovery writes its `known-nodes.json` entry again. That is harmless:
  known-nodes is not trust, and `NodeDirectory` lists only paired devices.

## Security

The control-server security model is unchanged: loopback bind, Host
allow-list, `x-homefleet-control` header, body cap, and no stack traces.

The module header's explicit sign-off for trust-store writes is extended to
name `unpair`. A co-resident process running as the same OS user can call
it, just as it can call `pair/connect`. The worst it can do is revoke
trust, which is a local denial of service. That is strictly less than what
`pair/connect` already allows, which is adding trust. The same per-boot
token upgrade path applies if that trust boundary is ever tightened.

The route accepts only a schema-valid 64-hex `deviceId` and never touches
the filesystem path space. The dashboard stays GET-only, and the asset scan
test still enforces that.

## ADR-0004 addendum

Append a dated "Addendum (2026-09-25): unpairing" section to ADR-0004. It
records four things:

- unpairing is one-sided and needs no protocol message;
- the order of operations: trust, then owned jobs, then known-nodes;
- the fact that the per-request check is what makes revocation immediate
  for new requests, while in-flight requests complete;
- the fact that re-pairing is the ordinary pairing flow.

## Out of scope

- A dashboard unpair button, or any dashboard mutation.
- Mutual or notified unpair.
- Remote-cancelling our delegations on the unpaired peer.
- A `--dry-run` flag (running without `--yes` already is one).
- Renaming paired nodes.
- A per-boot control token.
- Surfacing "peer no longer trusts us" as a distinct directory state
  instead of `reachable: false`. This is a candidate follow-up.

## Error handling

- Trust-store persist failure: `500`, with the message described in unit 3.
  The CLI prints it as a one-liner and exits 1.
- `cancelOwnedBy` does not throw. Each `cancel()` promise gets a no-op
  `.catch`, because an owner-checked cancel of a record found by iterating
  cannot hit `UNKNOWN_JOB`, but the promise must never go unhandled.
- A known-nodes persist failure is swallowed (see unit 3).

## Testing

- **`known-nodes.test.ts`:** `remove` returns true and persists across
  reload; `remove` of an unknown ID returns false and writes nothing.
- **`job-manager.test.ts`:** `cancelOwnedBy` cancels the owner's queued and
  running jobs, leaves other owners' jobs and terminal jobs alone, returns
  the count, and returns promptly with a `StuckExecutor`.
- **`daemon.unpair.test.ts`** (new, unit, fakes via `Pick`): step order;
  `undefined` when not paired; persist failure becomes `.status = 500`;
  known-nodes failure is swallowed.
- **`control-server.test.ts`:** `POST /control/unpair` gives 200 with a
  summary, 404 when not paired, 400 for a bad or short device ID, 403
  without the header, 500 passed through from `.status`, and 404 for `GET`.
- **`tools.integration.test.ts`:** after the agent removes the worker from
  its trust store, `job_status` / `job_result` / `cancel_job` on an existing
  delegation return the "no longer paired" error, and no HFP call is made.
- **`unpair-target.test.ts`:** full ID, 8-character prefix, a 7-character
  prefix that is treated as a name, uppercase hex, name match, duplicate
  names (ambiguous), a prefix matching two nodes, no match.
- **`cli.test.ts`:** every row of the output/exit-code table above.
- **`control-client.test.ts`:** `unpair` posts the body and validates the
  response.
- **`daemon.control.integration.test.ts`:** two real daemons, paired, with a
  long-running delegated job. Unpairing the delegator on the worker through
  the real control route:
  - cancels the job;
  - makes the delegator's next HFP call get 401;
  - drops the delegator from the worker's `/control/nodes`;
  - leaves the delegator out of `trusted-devices.json` on disk after a
    daemon restart;
  - leaves the worker still listed on the delegator's side (one-sided).
- **Rig check:** a throwaway second daemon on the laptop (temp data dir,
  alternate ports) paired with the laptop daemon, then `unpair` without and
  with `--yes`. It does not touch the laptop↔tower pairing. The result goes
  in the devlog.
