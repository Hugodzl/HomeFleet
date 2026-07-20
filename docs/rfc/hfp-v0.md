# HomeFleet Protocol (HFP) — Version 0

## Abstract

The HomeFleet Protocol (HFP) is a LAN protocol by which one HomeFleet daemon
(`homefleetd`) delegates coding-oriented jobs — read-only repository
reconnaissance, command execution, and code-writing tasks — to another daemon
on a paired machine.
HFP messages are versioned JSON documents exchanged over HTTPS with mutual
TLS. This document specifies HFP v0: LAN discovery, node identity and
capability exchange, pairing, job delegation, event streaming, results, and
cancellation.

The normative message shapes are the zod schemas in
[`packages/protocol/src`](../../packages/protocol/src); this document
describes them in prose and MUST be kept consistent with them. Where the two
disagree, the schemas win and this document has a bug.

## Status of This Document

Draft. Describes protocol version **0.2.0** as implemented by the
`@homefleet/protocol` package. Everything in a v0.x protocol version is
subject to change until v1.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119.

## Terminology

- **Node** — a machine running `homefleetd`, identified by its device ID. A
  node both offers capabilities to peers and may delegate work to peers.
- **Device ID** — the SHA-256 fingerprint of the node's self-signed TLS
  certificate, encoded as 64 lowercase hex characters (ADR-0004). Device
  identity and transport identity are the same thing.
- **Job** — a unit of delegated work. Job parameters are a tagged union on
  `type`; v0 defines `recon` (read-only repo analysis by the worker's local
  model), `command` (allowlisted command execution), and `write`
  (code-writing by the worker's local model, returning a branch artifact).
- **Executor** — the worker-side component that runs a job. v0 defines three
  executor kinds: `command` (no LLM), `agent` (a minimal tool-calling loop
  against an OpenAI-compatible endpoint), and `write` (the agent loop
  extended with editing tools; see
  [Write tasks and artifacts](#write-tasks-and-artifacts)).
- **Workspace** — a checkout of a repository at a specific commit, identified
  by a `WorkspaceRef` (`repoId` + `headCommit`). Workspace *transfer* (git
  bundles, ADR-0005) is out of scope for this document; HFP v0 only defines
  the reference shape.
- **Delegator / worker** — the node that submits a job / the node that
  executes it. Any node may play either part.

## Transport Binding

HFP is bound to HTTPS with mutual TLS:

- Each daemon presents its self-signed certificate; connections are accepted
  with `requestCert: true` and certificate-chain validation disabled, then
  the peer certificate's SHA-256 fingerprint is checked against the local
  paired-device list (ADR-0004). A peer whose fingerprint is not paired MUST
  be rejected; the only endpoint a not-yet-paired peer may call is
  `POST /hfp/v0/pair`.
- All request and response bodies are JSON (`application/json`), except the
  event stream, which is `text/event-stream` (Server-Sent Events).
- The path prefix encodes the protocol's major version: `/hfp/v0`.

### Endpoints

| Method | Path                       | Request body        | Response body                  |
| ------ | -------------------------- | ------------------- | ------------------------------ |
| POST   | `/hfp/v0/hello`            | `HelloRequest`      | `HelloResponse`                |
| POST   | `/hfp/v0/pair`             | `PairRequest`       | `PairResponse`                 |
| POST   | `/hfp/v0/jobs`             | `DelegateRequest`   | `DelegateResponse`             |
| GET    | `/hfp/v0/jobs/{id}`        | —                   | `JobSnapshot`                  |
| GET    | `/hfp/v0/jobs/{id}/events` | —                   | SSE stream of `JobEvent`       |
| POST   | `/hfp/v0/jobs/{id}/cancel` | —                   | `CancelResponse`               |
| GET    | `/hfp/v0/jobs/{id}/artifact` | —                 | git bundle (binary)            |
| POST   | `/hfp/v0/workspace/have`   | `HaveTipRequest`    | `HaveTipResponse`              |
| POST   | `/hfp/v0/workspace/bundle` | git bundle (binary) | `BundleUploadResponse`         |

`{id}` is the job ID (an RFC 4122 UUID, canonical lowercase) returned by
`POST /hfp/v0/jobs`. On failure,
endpoints respond with an appropriate HTTP status code and an `HfpError`
JSON body.

On the events stream, each SSE `data:` field carries one `JobEvent` encoded
as a single JSON document, and each record's SSE `id:` field carries that
event's `seq`. The stream ends after the terminal `result` event. The worker
MAY interleave SSE comment lines (`:` …) as keep-alives; clients ignore them.
A client MAY resume with the standard `Last-Event-ID` request header: the
worker replays the buffered events with `seq` greater than the supplied id
(i.e. resumes at `Last-Event-ID + 1`) and then continues live. Events for a
job are retained in memory only for the life of the daemon process; resume is
best-effort within that lifetime.

## Messages

### Conventions

- Every message shape is a zod schema named `XxxSchema` with an inferred
  TypeScript type `Xxx`.
- Unknown fields MUST be ignored on read and MUST NOT be sent. This allows
  minor-version additions without breaking older peers.
- Timestamps are ISO 8601 UTC strings with a trailing `Z`
  (e.g. `"2026-07-06T12:00:00Z"`); timezone offsets are rejected.
- Identifiers are canonical lowercase: device IDs, commit hashes, and job
  IDs (RFC 4122 UUIDs, canonical lowercase). Senders MUST emit lowercase
  (`crypto.randomUUID()` already does); receivers reject other casings, and
  reject UUID-shaped strings that are not valid RFC 4122 UUIDs (e.g. the nil
  UUID).
- Fields documented with defaults are optional on the wire; receivers apply
  the default when the field is absent.

### NodeInfo

What a node advertises about itself during `hello` and pairing.

| Field               | Type                                    | Notes                                          |
| ------------------- | --------------------------------------- | ---------------------------------------------- |
| `deviceId`          | string                                  | 64-char lowercase hex SHA-256 cert fingerprint |
| `name`              | string                                  | Human-readable, 1–64 chars, no control characters (C0 or DEL) |
| `daemonVersion`     | string                                  | `homefleetd` semver (`X.Y.Z`)                  |
| `protocolVersion`   | string                                  | HFP semver (`X.Y.Z`), `"0.2.0"` for this document |
| `platform`          | `"win32" \| "linux" \| "darwin"`        |                                                |
| `roles`             | `("inference" \| "execution")[]`        | A weak-GPU machine can still execute           |
| `executors`         | `("command" \| "agent" \| "write")[]`   | Executor kinds this node offers                |
| `models`            | `ModelInfo[]`                           | Models reachable via the node's OpenAI-compatible endpoint(s) |
| `hardware`          | `{ cpu, ramBytes, gpus: GpuInfo[] }`    | `cpu`: string; `ramBytes`: integer ≥ 0         |
| `maxConcurrentJobs` | integer ≥ 1                             |                                                |
| `activeJobs`        | integer ≥ 0                             |                                                |

`ModelInfo` is `{ id: string, contextWindow?: integer ≥ 1 }`; `GpuInfo` is
`{ name: string, vramBytes?: integer ≥ 0 }`.

```json
{
  "deviceId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "name": "tower",
  "daemonVersion": "0.2.0",
  "protocolVersion": "0.2.0",
  "platform": "win32",
  "roles": ["inference", "execution"],
  "executors": ["command", "agent"],
  "models": [{ "id": "qwen3.5-9b", "contextWindow": 32768 }],
  "hardware": {
    "cpu": "AMD Ryzen 5 5600X",
    "ramBytes": 34359738368,
    "gpus": [{ "name": "RX 6700 XT", "vramBytes": 12884901888 }]
  },
  "maxConcurrentJobs": 2,
  "activeJobs": 0
}
```

### Hello — `HelloRequest` / `HelloResponse`

Capability exchange between paired nodes. Both messages have the same shape:
`{ nodeInfo: NodeInfo }`. A node SHOULD call `hello` when it (re)connects to
a peer and MAY call it periodically to refresh capability and load
information (`models`, `activeJobs`, …).

```json
{ "nodeInfo": { "...": "see NodeInfo example above" } }
```

### Pairing — `PairRequest` / `PairResponse`

Pairing establishes mutual trust between two devices (ADR-0004). The user
reads a short code off one machine and enters it on the other; the code
confirms the certificate fingerprints out-of-band.

`PairRequest`: `{ code: string, nodeInfo: NodeInfo }`. The code is 6–10
uppercase alphanumeric characters (`^[A-Z0-9]{6,10}$`).

`PairResponse`: `{ accepted: boolean, nodeInfo?: NodeInfo }`. `nodeInfo` is
present **iff** `accepted` is true. On acceptance, both sides persist the
peer's device ID in their paired-device lists.

```json
{ "code": "7KQ2XM", "nodeInfo": { "...": "..." } }
```

```json
{ "accepted": true, "nodeInfo": { "...": "..." } }
```

### Workspace reference — `WorkspaceRef`

`{ repoId: string, headCommit: string }` where `headCommit` is a 40-char
lowercase hex commit hash. Delegation operates on committed state only
(ADR-0005). How the worker obtains the workspace content is specified in
[Workspace Sync](#workspace-sync) below: the delegator ships the repository as
a git bundle before delegating, and the worker materializes `headCommit` from
its cache.

### Job parameters — `JobParams`

A tagged union on `type`, where `type` is a `JobType`
(`"recon" | "command" | "write"` in this version). This union is the
protocol's extension point: a future job type is added as a new params
schema, a new union variant, and a new `JobType` entry — without redesigning
the job model.

#### `ReconJobParams` (`type: "recon"`)

Read-only repository analysis executed by the worker's local model.

| Field       | Type           | Notes                                     |
| ----------- | -------------- | ----------------------------------------- |
| `type`      | `"recon"`      |                                           |
| `workspace` | `WorkspaceRef` |                                           |
| `prompt`    | string         | 1–16384 chars                             |
| `model`     | string?        | Model ID on the worker; worker's choice if absent |
| `budgets`   | `JobBudgets`   | Defaults applied when absent              |

`JobBudgets`:

| Field          | Type    | Constraints        | Default  |
| -------------- | ------- | ------------------ | -------- |
| `maxToolCalls` | integer | ≥ 1, ≤ 200         | `50`     |
| `maxWallMs`    | integer | ≥ 1000, ≤ 3600000  | `600000` |

In v0, both the agent wall-time budget (`maxWallMs`) and the command timeout
(`timeoutMs`) are capped at one hour.

```json
{
  "type": "recon",
  "workspace": { "repoId": "homefleet", "headCommit": "0123456789abcdef0123456789abcdef01234567" },
  "prompt": "Summarize the repo layout and test strategy.",
  "model": "qwen3.5-9b",
  "budgets": { "maxToolCalls": 50, "maxWallMs": 600000 }
}
```

#### `CommandJobParams` (`type: "command"`)

Command execution (tests, builds) in a workspace. Workers only run commands
on their local allowlist.

| Field       | Type           | Constraints              | Default  |
| ----------- | -------------- | ------------------------ | -------- |
| `type`      | `"command"`    |                          |          |
| `workspace` | `WorkspaceRef` |                          |          |
| `command`   | string         |                          |          |
| `args`      | string[]       |                          | `[]`     |
| `timeoutMs` | integer        | ≥ 1000, ≤ 3600000        | `600000` |

```json
{
  "type": "command",
  "workspace": { "repoId": "homefleet", "headCommit": "0123456789abcdef0123456789abcdef01234567" },
  "command": "pnpm",
  "args": ["test"],
  "timeoutMs": 600000
}
```

#### `WriteJobParams` (`type: "write"`)

A code-writing task executed by the worker's local model in the workspace.
The result of a successful write job is a **branch artifact** — see
[Write tasks and artifacts](#write-tasks-and-artifacts) for the artifact
shape, the delivery endpoint, and the delegator's obligations.

| Field           | Type             | Notes                                          |
| --------------- | ---------------- | ---------------------------------------------- |
| `type`          | `"write"`        |                                                |
| `workspace`     | `WorkspaceRef`   |                                                |
| `instructions`  | string           | The task prompt, 1–16384 chars                 |
| `pathHints`     | string[]?        | ≤ 32 entries, each 1–1024 chars; advisory starting points only, never an access restriction |
| `verifyCommand` | `VerifyCommand`? | Post-commit verification run                   |
| `budgets`       | `WriteBudgets`   | Defaults applied when absent                   |

`VerifyCommand` is `{ name: string, args: string[] (default []) }`. `name`
MUST name an entry in the worker's command allowlist — the same gate as
`command` jobs; a name not on the allowlist is rejected with
`COMMAND_NOT_ALLOWED` and is never spawned. The verify run is
**report-only**: its outcome is returned in `JobResult.verify` and a non-zero
exit does not fail the job.

`WriteBudgets` has the same shape and bounds as `JobBudgets` but defaults
`maxToolCalls` to `100` — double the recon default, since edits burn a
read+write pair per file touched (`maxWallMs` default is unchanged at
`600000`):

| Field          | Type    | Constraints        | Default  |
| -------------- | ------- | ------------------ | -------- |
| `maxToolCalls` | integer | ≥ 1, ≤ 200         | `100`    |
| `maxWallMs`    | integer | ≥ 1000, ≤ 3600000  | `600000` |

```json
{
  "type": "write",
  "workspace": { "repoId": "homefleet", "headCommit": "0123456789abcdef0123456789abcdef01234567" },
  "instructions": "Add a unit test for the config loader's default handling.",
  "pathHints": ["packages/daemon/src/config.ts"],
  "verifyCommand": { "name": "pnpm", "args": ["test"] },
  "budgets": { "maxToolCalls": 100, "maxWallMs": 600000 }
}
```

### Delegation — `DelegateRequest` / `DelegateResponse`

`DelegateRequest`: `{ params: JobParams }`.
`DelegateResponse`: `{ jobId: string }` where `jobId` is an RFC 4122 UUID
(canonical lowercase) minted by the worker. The worker MUST reject job types it does not support with
`UNSUPPORTED_JOB_TYPE` and MAY reject with `BUSY` when at
`maxConcurrentJobs`.

```json
{ "params": { "type": "command", "...": "..." } }
```

```json
{ "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c" }
```

### Job snapshot — `JobSnapshot`

Polling view of a job: `{ jobId, status: JobStatus, result?: JobResult }`.
`result` is present **iff** `status` is terminal. When `result` is present,
`result.jobId` MUST equal the snapshot's `jobId` and `result.status` MUST
equal the snapshot's `status`.

```json
{ "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c", "status": "running" }
```

### Cancellation — `CancelResponse`

`POST /hfp/v0/jobs/{id}/cancel` requests cancellation; it has no request
body. The response is `{ jobId, status: JobStatus }` reflecting the job's
status after the cancel was processed. Canceling an already-terminal job is
not an error: the response simply carries the existing terminal status.

```json
{ "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c", "status": "canceled" }
```

### Job result — `JobResult`

| Field      | Type                     | Notes                                                |
| ---------- | ------------------------ | ---------------------------------------------------- |
| `jobId`    | string (UUID)            |                                                      |
| `type`     | `JobType`                | `"recon" \| "command" \| "write"` — makes results discriminable |
| `status`   | `TerminalJobStatus`      | `"succeeded" \| "failed" \| "canceled"`              |
| `summary`  | string?                  | Model-produced summary (recon and write jobs)        |
| `output`   | `CommandOutput`?         | Captured output (command jobs)                       |
| `stats`    | `JobStats`               |                                                      |
| `error`    | `HfpError`?              | See error-presence rules below                       |
| `artifact` | `WriteArtifact \| null`? | Write jobs only; see [Write tasks and artifacts](#write-tasks-and-artifacts) |
| `verify`   | `VerifyReport`?          | Write jobs only; present iff `verifyCommand` ran     |

Error-presence rules: a `failed` result MUST carry `error`; a `succeeded`
result MUST NOT carry `error`; a `canceled` result MAY carry `error` (if
present, typically code `CANCELED`). The write-only fields have their own
presence rules, specified in
[Write tasks and artifacts](#write-tasks-and-artifacts).

`CommandOutput` is `{ stdout: string, stderr: string, exitCode: integer | null }`;
`exitCode` is `null` when the process was killed by timeout or cancellation
(it may be negative or large — platform exit codes are passed through).

`JobStats` is `{ toolCalls: integer ≥ 0, wallMs: integer ≥ 0, promptTokens?: integer ≥ 0, completionTokens?: integer ≥ 0 }`.

```json
{
  "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c",
  "type": "recon",
  "status": "succeeded",
  "summary": "Repo uses pnpm workspaces with three packages.",
  "stats": { "toolCalls": 7, "wallMs": 42137, "promptTokens": 1500, "completionTokens": 300 }
}
```

### Write tasks and artifacts

A `write` job (params: [`WriteJobParams`](#writejobparams-type-write)) has the
worker's local model edit a synced workspace and, when it completes with
changes, commit them **once** on a dedicated branch. The committed work comes
back to the delegator as a **write artifact**: a branch delivered as a git
bundle, described by the `artifact` block on the job's `JobResult`.

#### The reserved `homefleet/` branch namespace

Write-job result branches live under `refs/heads/homefleet/`, on both sides:
the worker creates the result branch there, and the delegator MUST create
fetched refs only there. The branch name is `homefleet/<jobId12>`, where
`jobId12` is the **last** 12 hex characters of the job UUID — its final
hyphen-group (job ID `0198c2f6-3c4d-7e88-a1b2-c3d4e5f60718` → branch
`homefleet/c3d4e5f60718`). The last 12, not the first: job IDs admit UUID
v1–v8, and a v7's leading 48 bits are a millisecond timestamp, so two
same-millisecond jobs would collide on the first 12 hex; the last 12 are
random in both v4 and v7. The namespace is reserved: nothing else in
HomeFleet writes refs under `refs/heads/homefleet/`, so a fetched artifact
can never clobber a user branch.

#### `WriteArtifact`

| Field           | Type       | Notes                                          |
| --------------- | ---------- | ---------------------------------------------- |
| `branchName`    | string     | `homefleet/<jobId12>` (12 lowercase hex)       |
| `baseCommit`    | string     | 40-hex commit the work started from            |
| `headCommit`    | string     | 40-hex tip of the result branch — the bundle's integrity anchor |
| `diffStat`      | `DiffStat` | `{ filesChanged, insertions, deletions }`, each an integer ≥ 0 |
| `commitMessage` | string     | 1–4096 chars                                   |

Presence rules, enforced by `JobResultSchema`:

- `artifact` and `verify` (even an explicit `artifact: null`) MUST only
  appear on results with `type: "write"`.
- A `succeeded` write result MUST carry `artifact`: `null` when the model
  completed without producing changes, a full `WriteArtifact` otherwise. An
  absent `artifact` is invalid — it would be indistinguishable from "no
  changes" and could silently drop completed work.
- A `failed` or `canceled` write result MUST NOT carry a non-null
  `artifact`: budget exhaustion, failure, and cancellation discard the
  work — partial edits are never committed or delivered.

`VerifyReport` is
`{ name: string, args: string[], exitCode: integer | null, outputTail: string }` —
the outcome of the requested `verifyCommand`, present iff it was requested
and ran. `exitCode` is `null` when the verify run was killed (timeout or
cancellation); `outputTail` is a size-capped tail of its combined output.
A non-zero `exitCode` does not make the job `failed` — the delegator decides
what a red verify run means.

```json
{
  "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c",
  "type": "write",
  "status": "succeeded",
  "summary": "Added a default-handling test for the config loader.",
  "stats": { "toolCalls": 23, "wallMs": 181204, "promptTokens": 21000, "completionTokens": 2400 },
  "artifact": {
    "branchName": "homefleet/2b3c837e2a9c",
    "baseCommit": "0123456789abcdef0123456789abcdef01234567",
    "headCommit": "89abcdef0123456789abcdef0123456789abcdef",
    "diffStat": { "filesChanged": 2, "insertions": 41, "deletions": 3 },
    "commitMessage": "Add config loader default-handling test"
  },
  "verify": { "name": "pnpm", "args": ["test"], "exitCode": 0, "outputTail": "Tests 12 passed (12)" }
}
```

#### Artifact download — `GET /hfp/v0/jobs/{id}/artifact`

Gated exactly like the other job endpoints: mTLS plus job ownership (only
the delegator that submitted the job may fetch its artifact; requests for
non-owned jobs are answered as unknown, so existence never leaks). The
response streams a git bundle (`application/octet-stream`, with the branch
tip echoed in an `x-homefleet-head-commit` response header) containing
**exactly one ref**: `refs/heads/homefleet/<jobId12>`. The endpoint responds
404 `NO_ARTIFACT` when the job exists but has no artifact (not a write job,
not yet terminal, or a result with `artifact: null`). An evicted job (job
retention) is indistinguishable from an unknown one — eviction drops the job
record itself, and existence-hiding beats status precision — so it answers
the same 404 `UNKNOWN_JOB` as a job that never existed. The bundle is
retained for the job's retention window and does not survive a worker
restart.

#### Delegator obligations on fetch-in

The `JobResult` travels over the authenticated mTLS channel and is the
integrity anchor for the artifact bytes. Before applying a downloaded
bundle, the delegator MUST verify:

- `git bundle list-heads` shows exactly one ref, and it is the expected
  `refs/heads/homefleet/<jobId12>` for this job;
- that ref's tip equals `JobResult.artifact.headCommit` — a peer cannot
  later substitute different bytes for the result it reported.

A bundle failing either check MUST be discarded, not applied. Applying is a
plain `git fetch` from the bundle: it creates the ref and MUST NOT touch the
working tree or any branch outside `refs/heads/homefleet/`; if the ref
already exists (re-delivery), the fetch MUST be a fast-forward or fail. The
fetch MUST NOT execute repository hooks; content becomes live only when a
human checks the branch out.

### Events — `JobEvent`

Streamed over `GET /hfp/v0/jobs/{id}/events` (SSE). A tagged union on
`type`; every event carries:

| Field   | Type          | Notes                                 |
| ------- | ------------- | ------------------------------------- |
| `jobId` | string (UUID) |                                       |
| `seq`   | integer ≥ 0   | Total order of events within the job  |
| `ts`    | string        | ISO 8601 UTC timestamp (trailing `Z`) |

Variants:

| `type`        | Additional fields                                              |
| ------------- | -------------------------------------------------------------- |
| `status`      | `status: JobStatus`                                            |
| `log`         | `level: "debug" \| "info" \| "warn" \| "error"`, `message: string` |
| `tool_call`   | `name: string`, `argsSummary: string`                          |
| `tool_result` | `name: string`, `resultSummary: string`, `isError: boolean`    |
| `result`      | `result: JobResult` — terminal, ends the stream                |

On a `result` event, `result.jobId` MUST equal the event's `jobId`.

```json
{ "type": "status", "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c", "seq": 0, "ts": "2026-07-06T12:00:00Z", "status": "running" }
```

```json
{ "type": "tool_call", "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c", "seq": 1, "ts": "2026-07-06T12:00:01Z", "name": "grep", "argsSummary": "pattern=TODO" }
```

```json
{ "type": "result", "jobId": "0b294587-2342-4718-b6bb-2b3c837e2a9c", "seq": 9, "ts": "2026-07-06T12:00:42Z", "result": { "...": "see JobResult example" } }
```

### Errors — `HfpError`

`{ code: HfpErrorCode, message: string, details?: <JSON value> }` —
`details`, when present, is any JSON-serializable value. `HfpErrorCode` is
one of:

| Code                    | Meaning                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `UNAUTHORIZED`          | Peer not paired, or not permitted for this operation        |
| `UNKNOWN_JOB`           | No job with the given ID                                    |
| `NO_ARTIFACT`           | Job exists but has no downloadable artifact                 |
| `UNSUPPORTED_JOB_TYPE`  | Worker does not support this `JobParams` variant            |
| `WORKSPACE_UNAVAILABLE` | Repo not on the worker's allowlist or otherwise unavailable |
| `BUSY`                  | Worker at `maxConcurrentJobs`                               |
| `INVALID_REQUEST`       | Request failed schema validation                            |
| `CANCELED`              | Operation aborted by cancellation                           |
| `TIMEOUT`               | Command killed after exceeding its `timeoutMs`              |
| `BUDGET_EXCEEDED`       | Agent job exceeded a `JobBudgets` limit                     |
| `COMMAND_NOT_ALLOWED`   | Command not on the worker's allowlist; never spawned        |
| `INTERNAL`              | Unexpected worker-side failure                              |

```json
{ "code": "WORKSPACE_UNAVAILABLE", "message": "repo not on allowlist", "details": { "repoId": "homefleet" } }
```

## Workspace Sync

Before delegating a job whose `WorkspaceRef` names a repository, the delegator
transfers that repository's committed content to the worker as **git bundles**
(ADR-0005): a full bundle the first time, an incremental bundle afterwards. The
worker maintains a per-repo cache it unbundles into and materializes checkouts
from. **Committed state only:** uncommitted/dirty working-tree changes are out
of scope for v0 — a bundle carries commits, not the delegator's working tree.

### Authorization and the repo allowlist

Both workspace endpoints require a paired peer (the mTLS chokepoint) AND that
the worker **allowlists** the `repoId`. The allowlist is local worker policy:
being paired does not entitle a peer to sync arbitrary repositories. A worker
with an empty allowlist accepts no repos (fail closed). A non-allowlisted
`repoId` is rejected with `WORKSPACE_UNAVAILABLE` (HTTP 403) — not a silent
"no tip" — so the delegator learns the repo is not accepted.

The worker MUST NOT let `repoId` influence a filesystem path directly (a
`repoId` such as `../../x` must not escape the cache root); implementations key
the per-repo cache by a hash of the `repoId`.

### Have-tip — `HaveTipRequest` / `HaveTipResponse`

`HaveTipRequest` is `{ repoId: string }`. `HaveTipResponse` is
`{ headCommit: string | null }`, where `headCommit` is the worker's current
known commit for the repo (40-char lowercase hex) or `null` if the worker has
never synced it. The delegator uses this to choose a full bundle (worker has
nothing, or the reported commit is not an ancestor of the new head) or an
incremental bundle (`reported..new-head`).

```json
{ "repoId": "homefleet" }
```

```json
{ "headCommit": "0123456789abcdef0123456789abcdef01234567" }
```

### Bundle upload — binary body + `BundleUploadResponse`

`POST /hfp/v0/workspace/bundle` uploads a git bundle. The bundle is **binary
and potentially many megabytes**, so it is NOT encoded into a JSON field: the
request body is the raw bundle bytes (`Content-Type: application/octet-stream`),
and the two small parameters travel in request headers:

| Header                    | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| `x-homefleet-repo-id`     | the `repoId`, URL-encoded (opaque; may contain `/`, `\`) |
| `x-homefleet-head-commit` | the 40-char lowercase hex commit the bundle delivers     |

The worker streams the body to disk under a size cap (`MAX_BUNDLE_BYTES`,
configurable, default 512 MiB — distinct from and much larger than the 1 MiB
JSON body limit). A body exceeding the cap is aborted with HTTP 413 and nothing
is retained. The worker then `git bundle verify`s the file (rejecting a
malformed bundle, or an incremental bundle whose prerequisites it lacks, with
HTTP 400), confirms the bundle actually delivers the header's `headCommit`
(rejecting otherwise — it never checks out a commit a bundle did not deliver),
unbundles it into the per-repo cache, and advances its tip. Received content
MUST NOT be able to execute repository hooks.

On success the response is `BundleUploadResponse`, `{ ok: true, headCommit }`,
echoing the commit the worker now has.

```json
{ "ok": true, "headCommit": "0123456789abcdef0123456789abcdef01234567" }
```

A subsequent job whose `WorkspaceRef.headCommit` equals a synced commit resolves
to a materialized checkout of that commit; a job for a commit the worker has not
been sent fails with `WORKSPACE_UNAVAILABLE`.

## Discovery

Discovery is how daemons find connection candidates on the LAN before any
pairing or connection happens. It runs over two channels — mDNS/DNS-SD and a
UDP multicast fallback — that both carry the same payload,
`DiscoveryAnnouncement`. Discovery is a hint channel, not a capabilities
exchange: a peer learns "there may be a HomeFleet node at host:port", nothing
more. Capabilities travel in `hello`, after pairing.

### Security model: announcements are unauthenticated hints

Discovery announcements are **UNAUTHENTICATED HINTS**. Receivers MUST
validate them (schema validation plus the datagram size cap below) but MUST
NOT let them establish trust or identity: identity is only ever established
by the mTLS certificate-fingerprint pin at connect time (ADR-0004). The
`deviceId` in an announcement is a routing and deduplication hint; a forged
announcement can at worst cause a connection attempt that fails the
fingerprint pin. Invalid, oversized, or otherwise unparseable announcements
MUST be dropped silently — the discovery channels receive untrusted bytes
and never answer garbage.

UDP source addresses are spoofable, so a forged `announce` can direct one
unicast `response` at a victim — a roughly 1:1 reflection vector with
negligible amplification. This is accepted for v0 (the same trade-off
LocalSend ships); response rate-limiting is a possible future hardening.

### `DiscoveryAnnouncement`

| Field             | Type    | Notes                                                        |
| ----------------- | ------- | ------------------------------------------------------------ |
| `deviceId`        | string  | 64-char lowercase hex SHA-256 cert fingerprint (a hint — see above) |
| `name`            | string  | Human-readable, 1–64 chars, no control characters (same constraints as `NodeInfo.name`) |
| `port`            | integer | The node's HFP HTTPS port, 1–65535                           |
| `protocolVersion` | string  | HFP semver (`X.Y.Z`), `"0.2.0"` for this document            |

```json
{
  "deviceId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "name": "tower",
  "port": 47113,
  "protocolVersion": "0.2.0"
}
```

### Constants

Exported by `@homefleet/protocol` so advertisers and listeners cannot drift:

| Constant                       | Value           | Meaning                                  |
| ------------------------------ | --------------- | ---------------------------------------- |
| `DISCOVERY_MDNS_SERVICE_TYPE`  | `homefleet`     | mDNS service type (`_homefleet._tcp`)    |
| `DISCOVERY_MULTICAST_GROUP`    | `239.255.42.98` | Default UDP multicast group              |
| `DISCOVERY_UDP_PORT`           | `56371`         | Default UDP discovery port               |
| `DISCOVERY_MAX_DATAGRAM_BYTES` | `4096`          | Max UDP datagram size; larger is dropped |

### mDNS channel

Nodes advertise a DNS-SD service of type `_homefleet._tcp`:

- The **instance name** is the node's name. mDNS instance labels are limited
  to 63 bytes; longer names are truncated, and implementations SHOULD resolve
  instance-name collisions by renaming (e.g. appending `" (2)"`), keeping the
  result within the 63-byte limit. A probe-time conflict can also kill a
  publication silently (the loser never announces, so browse-based collision
  detection cannot see it); implementations SHOULD treat a publication that is
  never observed back on their own browser within a short deadline as such a
  loss and rename the same way. Peers may therefore observe a node re-announce
  under a new name with no collision visible on the wire; renames SHOULD be
  bounded so two misbehaving nodes cannot rename-storm each other.
- The **SRV port** is the announcement's `port` (the HFP HTTPS port).
- The **TXT record** carries the remaining announcement fields:
  key `id` = `deviceId`, key `pv` = `protocolVersion`.

Browsers reconstruct the announcement from instance name, SRV port, and TXT
record, and MUST drop services whose reconstruction fails validation.

### UDP multicast channel

A fallback for networks where mDNS is filtered. The wire format is
`DiscoveryDatagram`: a `DiscoveryAnnouncement` plus a `kind` field, encoded
as one JSON document per datagram, at most 4096 bytes.

| Field  | Type                        | Notes                        |
| ------ | --------------------------- | ---------------------------- |
| `kind` | `"announce" \| "response"`  | See exchange rules below     |

```json
{ "kind": "announce", "deviceId": "…", "name": "tower", "port": 47113, "protocolVersion": "0.2.0" }
```

Exchange rules:

- On startup — and periodically thereafter (default every 60 s), because UDP
  is lossy — a node sends a `kind: "announce"` datagram to the multicast
  group and port above.
- A node receiving a valid `announce` from another device SHOULD reply with
  a `kind: "response"` datagram, unicast to the sender's address and port,
  so both sides learn each other.
- A node MUST NOT reply to a `response` — the tag exists so replies cannot
  trigger reply storms.
- A node MUST ignore datagrams carrying its own `deviceId` (its own
  multicast echo).
- Datagrams larger than `DISCOVERY_MAX_DATAGRAM_BYTES` MUST be dropped
  without parsing.

## Job Lifecycle

```
                    +-----------> succeeded
                    |
queued ---> running +-----------> failed
   |                |
   |                +-----------> canceled
   +----------------------------> canceled
```

- A job enters `queued` when accepted by `POST /hfp/v0/jobs` and moves to
  `running` when an executor picks it up.
- `succeeded`, `failed`, and `canceled` are the **terminal** states. A
  terminal job never changes status again.
- Events for a job are totally ordered by `seq`: non-negative, starting at
  0, strictly increasing. Subscribers MAY use `seq` to de-duplicate or
  re-order events after a reconnect.
- The `result` event is the last event on the stream. Its embedded
  `JobResult` MUST match the `result` field of subsequent `JobSnapshot`
  responses.
- `JobResult.status` and `JobSnapshot.result` presence are constrained to
  terminal states as specified in Messages above.

## Versioning

- The protocol version is a semver string (this document: **0.2.0**),
  exported as `HFP_PROTOCOL_VERSION`; the HTTP path prefix carries the major
  version (`/hfp/v0`, exported as `HFP_PATH_PREFIX` and derived from the
  protocol version so the two cannot drift).
- Nodes exchange `protocolVersion` inside `NodeInfo` during `hello` and
  pairing. Nodes with the same major version MUST interoperate; a node MAY
  refuse to talk to a peer with a different major version.
- Within a major version, revisions only make backward-compatible changes:
  new optional fields, new `JobParams` variants, new event types. Receivers
  MUST ignore unknown fields and MUST NOT send fields not defined in their
  protocol version. A worker receiving an unknown `JobParams` variant
  rejects it with `UNSUPPORTED_JOB_TYPE`; `INVALID_REQUEST` covers otherwise
  malformed bodies.
- Breaking changes bump the major version and therefore the path prefix.
  v0 as a whole is a draft and makes no long-term stability promises.

## Security Considerations

- **Transport identity is the trust root.** Every HFP request rides on an
  mTLS connection whose peer certificate fingerprint has been checked
  against the paired-device list. Unpaired peers MUST be rejected before any
  HFP handler other than `pair` runs (ADR-0004).
- **Discovery is untrusted input.** Announcements are unauthenticated hints
  (see Discovery): schema-validated and size-capped, but never a basis for
  trust or identity. Identity comes from the fingerprint pin at connect
  time; the worst a forged announcement achieves is a failed connection
  attempt.
- **Pairing is consent.** The pairing code is a short-lived, human-relayed
  secret confirming fingerprints out-of-band. Daemons SHOULD expire codes
  quickly and rate-limit `pair` attempts to resist brute force of the
  6–10-char code space.
- **Authorization sits on top of identity.** Being paired does not grant
  arbitrary execution: workers enforce local allowlists (repos for
  workspaces, commands for `command` jobs) and budgets/timeouts for `agent`
  jobs. Transport identity is necessary, not sufficient.
- **Blast radius of results.** `JobResult`, logs, and event summaries can
  contain repository content; they are only ever sent over the mTLS channel
  to the paired delegator of that job. Daemons MUST NOT expose job data to
  other peers.
- The MCP front door that consumes this protocol is localhost-only and out
  of scope for this document (ADR-0002).

## Future Extensions

- **New job types** extend the `JobParams` discriminated union — e.g.
  model-pool orchestration jobs. Adding one means a new params schema, a new
  union variant, and a new `JobType` entry; each variant comes with its own
  result conventions and error codes as needed (the `write` kind followed
  exactly this path).
- **Dirty-state transfer.** Workspace sync (see [Workspace Sync](#workspace-sync))
  ships committed state only in v0; a post-MVP extension could carry
  uncommitted changes as a patch applied over the materialized checkout
  (ADR-0005).
- **Multi-node fan-out** (delegating one logical task across several
  workers) is expected to compose out of existing primitives rather than new
  message types, but may add batch delegation.

## References

- ADR-0001 — task delegation, not distributed inference
- ADR-0002 — MCP front door (localhost-only)
- ADR-0003 — custom minimal agent executor
- ADR-0004 — Syncthing-style trust model (device ID = cert fingerprint)
- ADR-0005 — git-bundle workspace sync
- `docs/specs/2026-07-06-homefleet-design.md` — HomeFleet v0.1 design
- `docs/specs/2026-07-10-code-writing-delegation-design.md` — code-writing
  delegation (v0.2) design
