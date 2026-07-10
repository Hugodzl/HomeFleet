# Code-Writing Delegation (v0.2) — Design

**Status:** approved by Hugo 2026-07-10 (brainstorm session 5). Supersedes the
one-line roadmap entry in `2026-07-06-homefleet-design.md` ("code-writing
delegation: diffs/branches back; consider opencode adapter here").

## Context and goal

v0.1 delegates read-only recon and command execution. v0.2 adds the headline
capability: an MCP client on one machine delegates a *code-writing* task, a
worker's local model edits code in a synced workspace, and the changes come
back as a reviewable branch in the delegator's repository.

**Locked decisions (Hugo, 2026-07-10):**

| Decision | Choice |
| --- | --- |
| Use-case shape | Both small tasks and long jobs fit the rails; v0.2 ships and optimizes the small, well-specified task path |
| Result path | Git bundle back → local branch in the source repo (mirror of sync-in, ADR-0005 machinery) |
| Executor | Extend the custom minimal loop (ADR-0003); opencode adapter is a post-v0.2 stretch experiment behind the same Executor interface |

**Non-goals for v0.2:** multi-commit shaping, interactive mid-course
correction, delegator-side auto-merge, fan-out to multiple workers,
long-running checkpointing (rails only: budgets and streaming already
accommodate longer jobs).

## 1. Protocol changes (`packages/protocol`, RFC section)

- **Task kind `write`** joins `recon` and `command` (the extension axis the
  job model kept open for Product A):

  ```
  {
    kind: "write",
    repoId: string,             // worker-side allowlist applies, as today
    baseRef: string,            // commit/ref the work starts from (synced in)
    instructions: string,       // the task prompt
    pathHints?: string[],       // optional starting points, advisory only
    verifyCommand?: { name, args }, // from the worker's command allowlist
    budgets?: { maxToolCalls?, wallTimeMs? }  // clamped by worker caps
  }
  ```

- **`JobResult` artifact block** (present only for `write` jobs):

  ```
  {
    artifact: null | {          // null = model finished with no changes
      branchName: string,       // "homefleet/<jobId12>"
      baseCommit: string,       // 40-hex
      headCommit: string,       // 40-hex — integrity anchor for the bundle
      diffStat: { filesChanged, insertions, deletions },
      commitMessage: string
    },
    verify?: { name, args, exitCode, outputTail }  // present iff requested
  }
  ```

- **RFC** (`docs/rfc/hfp-v0.md`) gains a "Write tasks and artifacts" section:
  task kind, artifact endpoint, the delegator's expected-ref discipline, and
  the headCommit integrity binding (below). Version bump per RFC conventions.

## 2. Worker-side execution (`packages/executors`, daemon dispatch)

**Ephemeral job worktree, not the LRU cache.** Write jobs never touch the
shared checkout cache: the dispatcher materializes a dedicated worktree from
the bare cache at `baseRef` under `<repoKey>/jobs/<jobId12>` — a sibling of
`co/`, invisible to `registerExistingCheckouts` by construction. Removed
after bundle-out; `<repoKey>/jobs/*` is purged at daemon startup (in-flight
jobs do not survive restarts, so leftovers are always garbage).

**Agent loop extension.** The minimal loop gains two tools beside the
existing read set and allowlisted `run_command`:

- `write_file(path, content)` — create or replace.
- `edit_file(path, oldText, newText)` — exact-match replace, fails on
  zero or multiple matches (same contract Claude-style editors use; cheap
  for small models to reason about).

Both resolve paths with the same realpath/containment discipline as the read
tools (fail-closed; the `0f61548` absolute-path resolution fix applies), and
additionally refuse any path whose resolved target is the worktree's `.git`
gitlink or inside the admin area — a model must not be able to plant hooks
or rewrite git metadata.

**Commit.** On loop completion with changes present, the executor stages all
changes and commits once. The model is asked for a commit message as its
final structured output (fallback: first line of `instructions`). Author and
committer: `HomeFleet Worker <worker@<deviceId8>.invalid>`. All executor git
operations run with hooks neutralized (the M7 `.no-hooks` pattern) — repo
content never gets code execution via commit.

**Verify (report, don't fail).** If `verifyCommand` was given, it must name
an entry in the worker's command allowlist (same gate as the command
executor); it runs in the job worktree after the commit, within the job's
remaining wall-time budget. Exit code and a size-capped output tail go into
`JobResult.verify`. A failing verify does not fail the job — the delegator
decides what a red test run means.

**Outcomes.** The commit happens only when the model declares done — budget
exhaustion (tool calls or wall time) always fails the job and discards the
worktree, partial edits included; no half-finished work is ever committed or
returned. Model declares done with no changes → success, `artifact: null`.
Changes + verify failure → success with `verify.exitCode ≠ 0` reported.
Cancellation behaves like budget exhaustion: discard, no artifact.

**Node opt-in.** Write execution is a per-node capability: off by default in
worker config, advertised in capabilities when enabled (a weak or cautious
node stays recon/command-only). Fail-closed like `allowedRepoIds`.

**Events.** Write jobs stream the existing SSE event types plus per-edit
progress events (`{ tool, path }` — no content), inside the existing event
budget model.

**Budgets.** Defaults derive from the recon constants at implementation
time: `maxToolCalls` = 2× recon's default, `wallTimeMs` default 10 minutes;
worker-side caps clamp both, exactly as today.

## 3. Return path (workspace routes, both daemons)

**Bundle-out (worker).** After the commit, the worker creates an incremental
bundle covering `baseCommit..headCommit` containing exactly one ref:
`refs/heads/homefleet/<jobId12>` (`jobId12` = first 12 hex of the job UUID,
hyphens stripped). The bundle is retained beside the job record until the
job is evicted (`maxRetainedJobs`) or the daemon restarts; the worktree is
removed immediately after bundling. Size is capped by the existing
`maxBundleBytes`.

**Artifact endpoint.** New route `GET /jobs/:id/artifact` on the node
service: mTLS + owner-gated exactly like `result`, streams the bundle,
404 when the job has no artifact, 410 after eviction.

**Fetch-in (delegator, automatic).** On job completion the delegating daemon
fetches the artifact and applies it in one attempt:

1. Download with the size cap; verify with the M7 hardening pattern —
   `git bundle list-heads` pre-filter must show exactly the one expected
   ref, and its tip must equal `JobResult.headCommit` (the result JSON over
   mTLS is the integrity anchor; a peer cannot later substitute different
   bytes).
2. `git fetch <bundle>` into the **source repo** (`repos[].path`) with the
   same protocol/hook lockdown flags as sync-in. Fetch creates refs only —
   the user's working tree and existing branches are never touched.
3. Refs are created only under `refs/heads/homefleet/`; if the ref already
   exists (re-delivery), fetch must be a fast-forward or fail.

`job_result` (MCP) then reports `artifactStatus: "applied" | "failed"` with
a reason on failure; the artifact endpoint stays available for the job's
retention window, and re-requesting `job_result` retries a failed apply.
No new MCP tool.

Note: fetch executes no hooks and applies no smudge filters; content becomes
"live" only when the user checks the branch out, under their own git config.

## 4. MCP surface (`packages/daemon/src/mcp`)

The 5-tool surface is unchanged. `delegate_task`'s input schema becomes a
discriminated union on `task.kind` (recon | command | write). `job_result`'s
structured content for write jobs carries the artifact block, verify
summary, `artifactStatus`, and a ready-to-paste review command built from the
stable anchor: `git diff <baseCommit>...homefleet/<jobId12>` (`baseCommit`,
not `baseRef` — the ref may have moved locally since delegation).

## 5. Testing (the autonomy constraint, unchanged)

- Mock OpenAI endpoint scripts deterministic write/edit tool-call sequences
  (including: edit-miss retry, budget exhaustion, no-changes completion,
  a scripted attempt to write into `.git/hooks` → refused).
- Unit: write tools' path containment (symlink escape, absolute path, .git
  refusal), commit/authorship, bundle-out ref discipline, fetch-in
  expected-ref + headCommit binding, jobs-dir startup purge.
- Integration (single machine, N daemons): delegate a write task → branch
  appears in the source repo with the expected content and diffstat; cancel
  mid-write leaves no worktree behind; verify-command reporting; artifact
  410 after eviction.
- Real-model smoke on the rig (human-gated, benchmark devlog): tower's
  Qwen3.6-35B on a scoped task in this repo; success/failure rates recorded
  honestly.

## 6. Build order (one reviewed unit each, subagent-driven, TDD)

1. **Protocol:** `write` task kind + artifact/verify schemas + RFC section.
2. **Write executor:** tools, ephemeral worktree, commit, verify, outcomes —
   all against the mock endpoint.
3. **Return path:** bundle-out + artifact endpoint + delegator fetch-in with
   hardening + jobs-dir purge.
4. **MCP front:** schema union + result surfacing.
5. **E2E integration suite + docs (configuration.md, README capability
   line) + devlog.**
6. **Rig smoke** (human-gated) + benchmark devlog.
7. **Stretch (separate decision gate):** opencode adapter behind the
   Executor interface + bake-off devlog.

## Risks, stated

- **Local-model capability** is the honest unknown: a 35B MoE may need
  tight, well-hinted tasks to produce useful diffs. The small-first shape,
  `edit_file`'s strict contract, and report-only verify are all chosen to
  maximize its odds; the rig smoke tells us the truth and the devlog
  publishes it.
- **Write-capable loops enlarge the attack surface**: mitigations are the
  `.git` write refusal, hook neutralization on all executor git ops, the
  expected-ref + headCommit binding on the return path, and the reserved
  `homefleet/` ref namespace on the delegator side.
- **Ephemeral worktrees cost a checkout per job** — accepted; they buy
  isolation from the entire shared-cache hazard class by construction.
