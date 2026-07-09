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

A realistic **worker** config: offers an agent executor against a local
OpenAI-compatible server, a small command allowlist, and accepts one repo.

```json
{
  "node": { "name": "tower" },
  "executors": {
    "agent": {
      "endpoint": {
        "baseUrl": "http://127.0.0.1:8080/v1",
        "model": "qwen3.5-9b",
        "contextWindow": 32768
      },
      "commandAllowlist": {
        "pnpm": {}
      }
    },
    "command": {
      "allowlist": {
        "pnpm": {},
        "git": {}
      }
    }
  },
  "models": [{ "id": "qwen3.5-9b", "contextWindow": 32768 }],
  "workspace": {
    "allowedRepoIds": ["homefleet"]
  }
}
```

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
(`<64-hex>/checkouts/<40-hex>`); this version never resolves into those. A
leftover pre-0.1 directory is left in place, logs a one-line warning at
daemon startup, and is safe to delete.

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

Which job executors this node offers. **Both sub-keys are optional and absent
by default — a fresh install runs no executors and accepts no jobs** until one
is configured (fail closed, same posture as `workspace.allowedRepoIds`).

| Key       | Type                        | Default    | Meaning |
| --------- | --------------------------- | ---------- | ------- |
| `command` | object, optional (see below) | *(absent)* | Runs allowlisted shell commands (tests, builds). No LLM involved. |
| `agent`   | object, optional (see below) | *(absent)* | Runs a minimal tool-calling agent loop against an OpenAI-compatible endpoint (recon jobs). |

### `executors.command`

| Key         | Type                                          | Default | Meaning |
| ----------- | ---------------------------------------------- | ------- | ------- |
| `allowlist` | map: logical command name → `{ executable? }`  | `{}`    | **Empty means the executor is offered but no command may run** — fail closed. Each entry's `executable` (optional) is the actual binary to spawn; defaults to the logical name itself. |

Example: `{ "allowlist": { "pnpm": {}, "pytest": { "executable": "python -m pytest" } } }`
(illustrative — `executable` is a single path/name, not a shell string; see
`@homefleet/executors` for the exact spawn semantics).

### `executors.agent`

| Key                          | Type                        | Default    | Meaning |
| ---------------------------- | ---------------------------- | ---------- | ------- |
| `endpoint.baseUrl`           | URL string                   | *(required)* | OpenAI-compatible base URL; `/chat/completions` is appended by the executor. |
| `endpoint.apiKey`            | string, optional              | *(none)*   | Sent as a Bearer token when present. |
| `endpoint.model`             | string                        | *(required)* | Default model ID; a job's own `model` param overrides it (same endpoint). |
| `endpoint.contextWindow`     | integer ≥ 16384               | *(required)* | Context window served by the endpoint, in tokens. The 16384 floor is enforced at config-parse time: smaller windows silently break agentic tool use (truncated histories, dropped tool schemas), so the daemon refuses to start rather than fail confusingly mid-job. |
| `commandAllowlist`           | same shape as `executors.command.allowlist`, optional | *(absent, tool disabled)* | Allowlist for the agent's own `run_command` tool. Absent disables that tool entirely (the agent can still `read_file`/`grep`/`glob`/`list_dir`). |

## `models`

| Key      | Type                            | Default | Meaning |
| -------- | -------------------------------- | ------- | ------- |
| *(array)* | `{ id: string, contextWindow?: integer ≥ 1 }[]` | `[]` | Models this node advertises in its `NodeInfo` (shown by `list_nodes` and `homefleet nodes`). Purely advertisory — it does not configure the agent executor's endpoint; set that in `executors.agent.endpoint`. |

## `jobs`

Overrides for the in-memory `JobManager`'s limits. **All three keys are
optional**; when absent, the JobManager's own built-in defaults apply (kept as
that module's single source of truth rather than duplicated here).

| Key                 | Type            | Effective default | Meaning |
| ------------------- | ---------------- | ------------------ | ------- |
| `maxConcurrentJobs` | integer ≥ 1, optional | `2`            | Jobs this node runs at once before rejecting new ones with `BUSY`. |
| `maxQueuedJobs`     | integer ≥ 1, optional | `64`           | Jobs held pending a free execution slot before further submissions are rejected. |
| `maxRetainedJobs`   | integer ≥ 1, optional | `256`          | Terminal jobs kept in memory (for `job_status`/`job_result` polling) before the oldest are evicted. |

## `repos`

The **delegating** side's repo mapping: local repositories this daemon may
bundle and sync to a worker when `delegate_task` names their `repoId`. This is
independent of (and the mirror image of) the worker-side
`workspace.allowedRepoIds` — pairing does not by itself let either side sync
anything; each side's own allowlist/mapping must agree to it.

| Key      | Type                                          | Default | Meaning |
| -------- | ---------------------------------------------- | ------- | ------- |
| *(array)* | `{ repoId: string (1–1024 chars), path: string }[]` | `[]` | `repoId` is the identifier your agent passes to `delegate_task`; `path` is the local git working copy to bundle from. **Duplicate `repoId`s in the list are rejected at load time** (ambiguous, so the daemon refuses to guess which one wins). A `repoId` not listed here cannot be delegated against from this machine — `delegate_task` fails closed with a clear message. |
