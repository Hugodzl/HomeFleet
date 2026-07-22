# Configuration reference

`homefleetd` reads one file, `config.json`, from its **data directory**. This
document is the full reference: every section, every key, its type, its
default, and what it controls. The normative source is
[`packages/daemon/src/config/config.ts`](../../packages/daemon/src/config/config.ts)
(zod schemas); where the two disagree, the code wins and this document has a
bug.

## Data directory

The data directory holds the daemon's identity (cert + key), trust store,
known-nodes registry, workspace cache, and `config.json` itself.

Resolution order (see
[`packages/daemon/src/config/paths.ts`](../../packages/daemon/src/config/paths.ts)):

1. `HOMEFLEET_DATA_DIR` environment variable, when set and non-empty.
2. Otherwise, a per-OS default:
   - **win32:** `%LOCALAPPDATA%\homefleet`
   - **darwin:** `~/Library/Application Support/homefleet`
   - **linux (and everything else):** `~/.local/share/homefleet`

Setting `HOMEFLEET_DATA_DIR` is also how you run more than one daemon on the
same machine (each instance needs its own data directory).

## Parsing rules (read this before editing `config.json`)

- **A missing `config.json` is fine.** No file yields every default below — a
  fresh install needs no config. A freshly-installed daemon therefore runs
  **no executors** (accepts no jobs) and syncs **no repos** — see
  [`executors`](#executors) and [`repos`](#repos).
- **A present-but-invalid file is fatal.** If `config.json` exists but fails
  to parse as JSON, or fails schema validation, `homefleetd` (and the
  `homefleet` CLI) refuse to start. This is deliberate fail-closed behavior:
  silently falling back to defaults could re-enable a discovery channel,
  executor, or bind address the file was written specifically to disable.
- **Parsing is STRICT.** Every section uses `z.strictObject`: an unknown or
  typo'd key (e.g. `"allowList"` instead of `"allowlist"`) throws instead of
  being silently dropped. A dropped key would otherwise leave the fail-closed
  default active while the file *looks* configured — worse than an outright
  error.
- Every top-level section is optional in the file — an absent section gets
  that section's own field-level defaults, same as an empty `{}` for that
  section.

## Full example

A realistic **worker** config: offers agent (recon), command, and write
executors against a local OpenAI-compatible server through a shared catalog
entry, a small command allowlist, and accepts one repo.

```json
{
  "node": { "name": "tower" },
  "catalog": {
    "defaultEndpoint": { "baseUrl": "http://127.0.0.1:8080/v1" },
    "models": [
      { "id": "qwen3.5-9b", "label": "Qwen 3.5 9B", "contextWindow": 32768 }
    ]
  },
  "executors": {
    "agent": {
      "defaultModel": "qwen3.5-9b",
      "commandAllowlist": {
        "pnpm": {}
      }
    },
    "command": {
      "allowlist": {
        "pnpm": {},
        "git": {}
      }
    },
    "write": {
      "defaultModel": "qwen3.5-9b",
      "commandAllowlist": {
        "pnpm": {}
      }
    }
  },
  "workspace": {
    "allowedRepoIds": ["homefleet"]
  }
}
```

(The pre-catalog shape — `executors.agent.endpoint` / `executors.write.endpoint`
plus a top-level advisory `models[]` — still loads unchanged; see
[Back-compatibility](#catalog) below.)

A realistic **delegator** config: maps a local repoId to its checkout path so
`delegate_task` can sync it to a worker.

```json
{
  "node": { "name": "laptop" },
  "repos": [{ "repoId": "homefleet", "path": "D:\\Git\\HomeFleet" }]
}
```

A node can carry both `executors`/`workspace` (worker role) and `repos`
(delegator role) at once — every daemon can play either part.

## `discovery`

LAN peer discovery (mDNS + UDP multicast). See
[`docs/rfc/hfp-v0.md`](../rfc/hfp-v0.md#discovery) for the wire-level detail.

| Key                 | Type              | Default                          | Meaning |
| ------------------- | ----------------- | --------------------------------- | ------- |
| `mdnsEnabled`       | boolean            | `true`                             | Advertise/browse via mDNS (`bonjour-service`). |
| `udpEnabled`        | boolean            | `true`                             | Advertise/browse via the UDP multicast fallback. |
| `udpPort`           | integer, 0–65535   | `56371`                            | UDP discovery port. `0` binds an ephemeral port (tests/multi-daemon-per-machine); production should keep the default since multicast discovery only works when peers share a port. |
| `multicastGroup`    | string             | `"239.255.42.98"`                  | UDP multicast group address. |
| `announceIntervalMs`| integer ≥ 1        | `60000`                            | Re-announce interval over UDP (UDP is lossy). |
| `bindAddress`       | string, optional   | *(all interfaces)*                 | Interface-selection override for discovery sockets. Useful on Windows when a VPN/virtual adapter is grabbing multicast traffic. |
| `staticNodes`       | array, see below   | `[]`                               | Manually-configured peers, for when mDNS/UDP can't see them (different subnet, discovery disabled, etc). |

Each `staticNodes` entry:

| Key                | Type                        | Default    | Meaning |
| ------------------ | --------------------------- | ---------- | ------- |
| `host`             | string, non-empty            | *(required)* | The peer's LAN address. |
| `port`             | integer, 1–65535             | *(required)* | The peer's HFP port. |
| `expectedDeviceId` | 64-char lowercase hex, optional | *(none)*  | A hint only — trust still comes from pairing + the mTLS fingerprint pin, never from this field. |

mDNS name trouble is reported on stderr, one line per event. A name collision
logs `mDNS name collision on "tower": renamed to "tower (2)"`; a publication
that is never echoed back to the daemon's own browser (a probe conflict the
mDNS library loses silently) logs `mDNS publication "tower" never confirmed by
its own echo (probe conflict?): renamed to "tower (2)"`. Renames are bounded:
after the budget is spent the daemon logs `mDNS rename budget exhausted after
9 renames; staying on "tower (10)" — mDNS discovery may be degraded` once and
stops renaming. Seeing the exhaustion line usually means multicast itself is
broken on that interface (the VPN/virtual-adapter case `bindAddress` exists
for) — peers can still find the node over UDP, remembered known-nodes, or
`staticNodes`.

## `workspace`

Worker-side settings for accepting synced repository content (git bundles
over HFP). See [ADR-0005](../adr/0005-git-bundle-workspace-sync.md).

| Key                  | Type                   | Default                       | Meaning |
| -------------------- | ---------------------- | ------------------------------ | ------- |
| `allowedRepoIds`     | string[]                | `[]`                            | Repo identities this worker will accept sync/job requests for. **Empty means accept nothing — fail closed.** A fresh install syncs no repos until this is set. |
| `cacheDir`           | string, optional        | `<dataDir>/workspaces`          | Override for the per-repo cache root. |
| `maxBundleBytes`     | integer ≥ 1             | `536870912` (512 MiB)           | Hard cap on an uploaded bundle's size (streamed to disk); distinct from and much larger than the 1 MiB JSON request-body cap on other endpoints. |
| `maxCachedCheckouts` | integer ≥ 1             | `32`                            | Cap on the *count* of materialized checkout working trees kept across all repos; the least-recently-used one is evicted past this. |
| `gcAfterFetches`     | integer ≥ 1             | `20`                            | Successful bundle fetches into a repo's bare cache before `git gc --prune=now` runs on it (bounds bare object-store growth). |
| `gitTimeoutMs`       | integer ≥ 1000          | `120000`                        | Per-invocation timeout for workspace git operations (bundle/fetch/checkout). |

Cache layout (v0.1): under the cache root, each repo lives at
`<repoKey>/repo.git` (bare cache) with checkouts at
`<repoKey>/co/<commitKey>`, where both keys are 16-hex truncations of
SHA-256 — deliberately short so checkout paths stay well clear of Windows
MAX_PATH. Pre-0.1 versions used full-hash directory names
(`<64-hex>/checkouts/<40-hex>`). A leftover pre-0.1 directory under the same
cache root is left in place; the daemon just logs a one-line warning at
startup ("legacy workspace cache layout ... not used by this version — safe
to delete").

## `node`

| Key    | Type                          | Default                              | Meaning |
| ------ | ----------------------------- | -------------------------------------- | ------- |
| `name` | string, 1–64 chars, optional   | *(falls back to `os.hostname()` at daemon startup, truncated to 64 chars)* | Human-readable name advertised in discovery, `hello`, and pairing. |

## `hfp`

The LAN-facing, mutual-TLS node service peers connect to (ADR-0004). This
**must** be reachable from other machines on the LAN — the opposite posture
from `mcp`/`control` below.

| Key    | Type                | Default       | Meaning |
| ------ | ------------------- | -------------- | ------- |
| `host` | string, non-empty    | `"0.0.0.0"`    | Bind address. `0.0.0.0` is IPv4-only by design (discovery announces IPv4 addresses); set `"::"` explicitly for a dual-stack bind. |
| `port` | integer, 0–65535     | `56370`        | HFP port. `0` binds an ephemeral port (tests/multi-daemon-per-machine). |

## `mcp`

The local MCP front your agent (Claude Code, etc.) connects to. **Loopback
only, by enforcement as well as default** — the transport refuses to bind a
non-loopback host outright, because this surface carries no per-request auth.

| Key    | Type                                  | Default        | Meaning |
| ------ | -------------------------------------- | --------------- | ------- |
| `host` | one of `127.0.0.1`, `::1`, `localhost`  | `"127.0.0.1"`   | Bind address; validated against the loopback allow-list at config-parse time, not just at bind time. |
| `port` | integer, 0–65535                       | `56372`         | MCP HTTP port. The daemon serves Streamable HTTP at `http://<host>:<port>/mcp`. |

## `control`

The loopback admin API the `homefleet` CLI uses for `pair`/`nodes`/`status`
(see [ADR-0006](../adr/0006-daemon-assembly-and-control-channel.md)). Same
loopback enforcement as `mcp`.

| Key    | Type                                  | Default        | Meaning |
| ------ | -------------------------------------- | --------------- | ------- |
| `host` | one of `127.0.0.1`, `::1`, `localhost`  | `"127.0.0.1"`   | Bind address; same loopback allow-list as `mcp.host`. |
| `port` | integer, 0–65535                       | `56373`         | Control API port. |

## `executors`

Which job executors this node offers. **All sub-keys are optional and absent
by default — a fresh install runs no executors and accepts no jobs** until one
is configured (fail closed, same posture as `workspace.allowedRepoIds`).

| Key       | Type                        | Default    | Meaning |
| --------- | --------------------------- | ---------- | ------- |
| `command` | object, optional (see below) | *(absent)* | Runs allowlisted shell commands (tests, builds). No LLM involved. |
| `agent`   | object, optional (see below) | *(absent)* | Runs a minimal tool-calling agent loop against an OpenAI-compatible endpoint (recon jobs). |
| `write`   | object, optional (see below) | *(absent)* | Runs code-**writing** jobs: the model edits the synced repo in an isolated worktree and the result comes back to the delegator as a reviewable branch. Absent means write jobs are rejected (`UNSUPPORTED_JOB_TYPE`) — fail closed. |

### `executors.command`

| Key         | Type                                          | Default | Meaning |
| ----------- | ---------------------------------------------- | ------- | ------- |
| `allowlist` | map: logical command name → `{ executable? }`  | `{}`    | **Empty means the executor is offered but no command may run** — fail closed. Each entry's `executable` (optional) is the actual binary to spawn; defaults to the logical name itself. |

Example: `{ "allowlist": { "pnpm": {}, "pytest": { "executable": "python -m pytest" } } }`
(illustrative — `executable` is a single path/name, not a shell string; see
`@homefleet/executors` for the exact spawn semantics).

### `executors.agent`

| Key               | Type                        | Default    | Meaning |
| ----------------- | ---------------------------- | ---------- | ------- |
| `defaultModel`     | string, optional              | *(none)*   | The `catalog.models[].id` a recon task uses when it names no `model` of its own. Must reference an existing catalog id — checked at config-load, alongside every other cross-field catalog rule (see [`catalog`](#catalog)). Optional: with exactly one catalog entry, that entry is the implicit default. |
| `commandAllowlist` | same shape as `executors.command.allowlist`, optional | *(absent, tool disabled)* | Allowlist for the agent's own `run_command` tool. Absent disables that tool entirely (the agent can still `read_file`/`grep`/`glob`/`list_dir`). |

Configuring `executors.agent` while `catalog.models` is empty is rejected at
load — an agent executor with nothing to serve is a misconfiguration, not a
silent no-op. See [`catalog`](#catalog) for how `defaultModel` resolves to an
endpoint (including its per-model `contextWindow ≥ 16384` floor, enforced
when a job actually dispatches, not at load).

### `executors.write`

Code-writing delegation (v0.2). The shape is the same as `executors.agent`
today — a catalog `defaultModel` plus an optional command allowlist — but it
is a **separate section on purpose** (the two may diverge), and the default
is the same fail-closed absence: a node without `executors.write` rejects
write jobs outright.

| Key               | Type                        | Default    | Meaning |
| ----------------- | ---------------------------- | ---------- | ------- |
| `defaultModel`     | string, optional              | *(none)*   | The `catalog.models[].id` a write task uses when it names no `model` of its own — a write task can target a specific catalog model, the same as recon (see [`catalog`](#catalog)). Must reference an existing catalog id. |
| `commandAllowlist` | same shape as `executors.command.allowlist`, optional | *(absent, disabled)* | Gates **two** things: the write agent's own `run_command` tool, and the task's optional `verifyCommand` (a job naming a verify command not on this list fails with `COMMAND_NOT_ALLOWED` before any model traffic). Absent disables both. |

The write agent works in a dedicated, throwaway worktree of the synced repo
(never a shared checkout), its `write_file`/`edit_file` tools are contained
to that worktree, and anything at or under `.git` is refused — a model
cannot plant hooks or rewrite git metadata. When the model declares the task
done, the daemon commits **everything changed in the worktree** as author
`HomeFleet Worker <worker@<deviceId8>.invalid>` and bundles the result; the
optional `verifyCommand` then runs **report-only** (its exit code and output
tail ride back in the job result; a failing verify never fails the job).

> **Warning — `git` in the allowlist.** Putting `git` (or any tool that can
> drive git) in `commandAllowlist` lets the model mint **its own commits**
> inside the worktree. Finalize bundles whatever is committed under the job
> branch, so those commits are delivered verbatim — the
> `HomeFleet Worker <worker@<deviceId8>.invalid>` identity guarantee covers
> only the finalize commit, not commits the model made itself. The mirror
> case is just as surprising: if the model commits *everything* itself and
> leaves a clean tree, finalize has nothing to commit, produces no bundle,
> and those commits are dropped rather than delivered. Leave `git` off the
> allowlist unless you have thought this through.

## Write-job artifacts and the `homefleet/` branch namespace

What happens to a write job's output, on both sides:

- **On the worker**, a succeeded write job's artifact (a git bundle) is kept
  on disk until its job record is evicted — retention is governed by
  [`jobs.maxRetainedJobs`](#jobs) — or until the daemon restarts (an
  in-flight write job never survives a restart; startup purges every
  leftover job worktree and bundle, and sweeps any leaked
  `refs/heads/homefleet/*` ref from the worker's cache). After eviction, the
  job — and its artifact download — answers `UNKNOWN_JOB` (HTTP 404),
  indistinguishable from a job that never existed.
- **On the delegator**, the artifact is fetched and applied lazily: the
  first `job_result` call that sees the terminal result downloads the bundle
  and lands it in your mapped repo (`repos`) as the branch
  `homefleet/<jobId12>`. Poll `job_result` reasonably soon after a write job
  finishes — wait past the worker's retention window and the artifact is
  gone with the record.
- **The namespace promise:** HomeFleet only ever writes refs under
  `refs/heads/homefleet/` in your repo, and even there only ever creates or
  fast-forwards a ref (anything else is refused as `NON_FAST_FORWARD`). Your own
  branches, your working tree, and your index are **never touched**. Review
  a delivered change with the exact command `job_result` returns:
  `git diff <baseCommit>...homefleet/<jobId12>` — then merge it, cherry-pick
  it, or delete the branch.
- **A successful apply is remembered** (per daemon process) and never
  re-runs: `job_result` keeps reporting `artifactStatus: "applied"` without
  re-downloading. That means "applied" can be *stale* if you deleted the
  branch afterwards — deleting the branch is how you discard the change, and
  HomeFleet will not resurrect it.
- **A failed apply is not a dead end**: `job_result` reports
  `artifactStatus: "failed"` with an `applyError` reason, and the **next**
  `job_result` call retries the fetch-and-apply. One edge case: a
  `REF_MISMATCH` failure detected *after* the fetch can leave the reserved
  ref pointing at an unverified tip — the error message says so explicitly
  and tells you to inspect or delete that branch; HomeFleet never
  auto-deletes refs in your repo, even on its own error paths.

## `catalog`

The node's model catalog — the single source of truth for which models this
node offers and where they are served from. `executors.agent.defaultModel` /
`executors.write.defaultModel` (above) target a catalog entry by `id`; a
delegated recon or write task may also name a catalog `id` directly
(`delegate_task`'s `task.model`), overriding the executor's default for that
one job.

| Key                       | Type                              | Default | Meaning |
| -------------------------- | ---------------------------------- | ------- | ------- |
| `defaultEndpoint.baseUrl` | URL string, optional                 | *(none)* | OpenAI-compatible base URL shared by every catalog entry that does not set its own `endpoint`. |
| `defaultEndpoint.apiKey`  | string, optional                     | *(none)* | Bearer token sent to `defaultEndpoint`. |
| `models`                  | array, see below                     | `[]`    | The offered models. |

Each `catalog.models[]` entry:

| Key             | Type                              | Default                    | Meaning |
| ---------------- | ---------------------------------- | --------------------------- | ------- |
| `id`             | string, non-empty                    | *(required)*                 | The model id — sent as `model` on chat-completion requests, and shown in `list_nodes`/`homefleet nodes`. **Must be unique across `catalog.models`**; a duplicate id fails config validation. |
| `label`          | string, optional                     | *(none)*                     | Human-readable name shown alongside `id` in `list_nodes`. |
| `contextWindow`  | integer ≥ 1, optional                | *(none)*                     | Context window served, in tokens. Optional at config-parse time — a purely advisory entry with no known window still loads — but agent/write **dispatch** enforces a **≥ 16384 floor** (see below), so a model needs a qualifying `contextWindow` to ever actually run a recon/write job. |
| `endpoint`       | `{ baseUrl, apiKey? }`, optional      | `catalog.defaultEndpoint`    | Per-entry override of the shared default — e.g. a model served from a different local process or port. An entry with neither its own `endpoint` nor a usable `defaultEndpoint` is advertised but never dispatchable. |

**Model resolution, per job:** the task's own `model` (if it named one) →
the executor's `defaultModel` → the catalog's sole entry, if there is
exactly one. A `command` job never consults the catalog at all. If none of
the above apply (multiple models configured, no default, and none
requested), the job is rejected `NO_MODEL_SPECIFIED`; naming an id absent
from `catalog.models` is rejected `MODEL_NOT_OFFERED`; naming one with no
resolvable endpoint or a below-the-floor `contextWindow` is rejected
`INVALID_REQUEST`. All three are **submit-time** errors — the job is never
queued — the same posture as the existing `UNSUPPORTED_JOB_TYPE` gate.

**Startup validation.** At boot, the daemon best-effort probes `GET
{baseUrl}/models` once per *distinct* endpoint in the catalog and stamps
each model id with a status shown in `list_nodes`/`homefleet nodes`: `ok`
(that endpoint's `/models` response lists the id), `not_served` (the
endpoint answered but did not list it), or `unreachable` (no endpoint is
configured for the entry, or the probe failed or timed out). This status is
a **boot-time snapshot** only, informational for choosing a model —
dispatch-time enforcement is on catalog *membership* (`MODEL_NOT_OFFERED`),
never on this status, so a model that goes down mid-run is still accepted at
submit time and simply fails (or times out) inside the job rather than
being pre-emptively refused. Prefer models `list_nodes` reports `ok`.

**Back-compatibility.** Pre-catalog configs — `executors.agent.endpoint` /
`executors.write.endpoint`, and/or a top-level advisory `models[]` — are
auto-upgraded into the equivalent `catalog` + `defaultModel` shape when
`config.json` is loaded (see
[`packages/daemon/src/config/config-normalize.ts`](../../packages/daemon/src/config/config-normalize.ts)):
an old config keeps loading and behaving exactly as it did before. A config
that mixes a `catalog` key with either legacy form is rejected rather than
silently merged — pick one shape.

## `jobs`

Overrides for the in-memory `JobManager`'s limits. **All three keys are
optional**; when absent, the JobManager's own built-in defaults apply (kept as
that module's single source of truth rather than duplicated here).

| Key                 | Type            | Effective default | Meaning |
| ------------------- | ---------------- | ------------------ | ------- |
| `maxConcurrentJobs` | integer ≥ 1, optional | `2`            | Jobs this node runs at once before rejecting new ones with `BUSY`. |
| `maxQueuedJobs`     | integer ≥ 1, optional | `64`           | Jobs held pending a free execution slot before further submissions are rejected. |
| `maxRetainedJobs`   | integer ≥ 1, optional | `256`          | Terminal jobs kept in memory (for `job_status`/`job_result` polling) before the oldest are evicted. Evicting a write job also deletes its artifact bundle from disk — see [Write-job artifacts](#write-job-artifacts-and-the-homefleet-branch-namespace). |

## `repos`

The **delegating** side's repo mapping: local repositories this daemon may
bundle and sync to a worker when `delegate_task` names their `repoId`. This is
independent of (and the mirror image of) the worker-side
`workspace.allowedRepoIds` — pairing does not by itself let either side sync
anything; each side's own allowlist/mapping must agree to it.

| Key      | Type                                          | Default | Meaning |
| -------- | ---------------------------------------------- | ------- | ------- |
| *(array)* | `{ repoId: string (1–1024 chars), path: string }[]` | `[]` | `repoId` is the identifier your agent passes to `delegate_task`; `path` is the local git working copy to bundle from. **Duplicate `repoId`s in the list are rejected at load time** (ambiguous, so the daemon refuses to guess which one wins). A `repoId` not listed here cannot be delegated against from this machine — `delegate_task` fails closed with a clear message. |
