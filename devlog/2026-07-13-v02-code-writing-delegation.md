# Devlog 013 — v0.2: code-writing delegation, and landing a stranger's commits safely

**2026-07-13**

v0.2 is done. Through v0.1 a worker could *read* a repo (recon) or run
allowlisted commands against it; it could never change it. v0.2 adds the
`write` task kind end to end: you name a repo and describe a change, a worker's
local model makes the edit in an isolated throwaway worktree, the daemon commits
it as `HomeFleet Worker`, bundles it, and the delegating daemon fetch-applies it
into *your* clone as a branch named `homefleet/<jobId12>` — reviewable with the
exact `git diff <base>...homefleet/<id>` command the tool hands back, and your
own branches and working tree are never touched. Twelve tasks; the
single-machine suite went from **620 to 786** tests, all green; and the whole
path is proven by an integration test driving two real daemons, real temp git
repos, and the real MCP SDK client with only the model endpoint mocked.

## What v0.2 delivered

- **Protocol first** (Task 1). A `write` task kind joined `recon`/`command`,
  with `WriteArtifact`/`VerifyReport` schemas, budgets that default to double
  recon's tool budget (an edit burns a read+write pair per file), and the
  `homefleet/<12 hex>` branch-name grammar. `jobId12` derives from the UUID
  *tail* after a review caught that the head is low-entropy. The RFC bumped to
  0.2.0 in the same breath — it was self-contradictory advertising 0.1.0 while
  defining write vocabulary, and capability negotiation rides the executors
  array so the early bump is interop-safe.
- **Write tools with an admin refusal** (Task 2). `write_file`/`edit_file`
  refuse any path under `.git/`, so no delegated edit can install a hook or
  rewrite refs; errors are written to be *model-actionable* (the loop recovers
  rather than thrashes), with a UTF-8 guard on the way in.
- **One tool loop, two executors** (Tasks 3–4). The recon agent's tool loop was
  extracted so the write executor reuses it verbatim; the write executor adds
  `finish_task`, the finalize hand-off, and the report-only verify step.
- **Executors stay git-free** (Tasks 5–7). This is the spine of the design: the
  executor never shells git. It works in an *ephemeral* worktree materialized
  outside the LRU checkout cache (a write job can't evict a cached recon
  checkout, and vice-versa), and git work is injected as a `finalize` op built
  from the WorkspaceStore. Finalize commits as
  `HomeFleet Worker <worker@<deviceId8>.invalid>`, computes the diffstat,
  bundles the branch out, and registers the artifact. Write jobs route through
  the resolver with a job-eviction hook, and a leaked-ref sweep at store init
  cleans `homefleet/*` refs a crash left behind.
- **Artifacts over the wire** (Task 8). An owner-gated HFP route streams the
  bundle back; the client binds integrity three ways — the `x-homefleet-head-commit`
  header, the bundle tip, and `JobResult.artifact.headCommit` must all agree —
  and caps the download at the configured `maxBundleBytes`.
- **The apply gate** (Task 9). The single most dangerous path in the product:
  fetching a remote model's commits into the user's own repository. It is
  layered — schema pin (branch name must match `^homefleet/[0-9a-f]{12}$`) →
  header pre-filter (exactly one advertised ref, correct name, tip ===
  headCommit) → prerequisite verify → a **non-forced** fetch under the git
  lockdown → an authoritative post-fetch backstop that re-reads the ref and
  demands it equal `headCommit`. Everything is capped to the reserved namespace,
  so even a refused apply can only ever touch `refs/heads/homefleet/`.
- **Config, capability, assembly** (Tasks 10–11). `executors.write` is
  fail-closed (absent → write jobs rejected `UNSUPPORTED_JOB_TYPE`) and
  advertised in NodeInfo only when configured. The daemon constructs the
  `WriteExecutor` when it's present, wires the artifact routes and the lazy
  apply that fires on `job_result`, and dedupes overlapping applies with a
  per-jobId single-flight gate so two concurrent `job_result` calls can't
  double-fetch or report contradictory outcomes.
- **Proof and docs** (Task 12). The E2E test asserts the delivered branch sits
  at exactly `artifact.headCommit`, the checked-out content matches the scripted
  edit byte-for-byte, the diffstat agrees with git's own count, the author is
  the worker identity, and the source tree is untouched — plus a hostile set:
  cancel-mid-write leaves no `jobs/` residue, a `.git` write attempt is refused
  while the job still completes, an evicted artifact is gone from disk, and a
  restarted daemon sweeps crash residue clean.

## The theme: the gate is the feature

Every other capability in HomeFleet moves *data* between machines. This one
moves *authority* — it runs a model you don't control and writes the result
into your repo. So the engineering that mattered wasn't the model loop; it was
making the landing safe by construction, and the design leaned on three
structural choices before any single check:

1. **Git-free executors.** The thing running untrusted model output never
   touches refs. Git is a finalize op the daemon owns, so the worker-identity
   guarantee has a single, auditable author.
2. **A reserved namespace.** `homefleet/` is a promise: your branches are not in
   it, so no apply — successful, refused, or buggy — can move a ref you care
   about. The schema enforces the grammar before git runs.
3. **A non-forced fetch with an authoritative recheck.** The fetch refspec can
   only fast-forward or create; the post-fetch backstop then re-reads the ref
   rather than trusting the pre-fetch listing.

Adversarial review earned its cost here, same as M9. It proved a TOCTOU window
between listing the bundle's heads and fetching — a swapped bundle could land
the ref at a wrong tip (still inside the reserved namespace, but not the tip the
result claimed); the fix is the post-fetch backstop, and the regression test
swaps the bundle through a documented test-only seam and asserts the honest
post-state. The same pass caught killed-git being misclassified as
`BAD_BUNDLE` instead of `GIT_FAILURE`, so a shutdown mid-verify no longer looks
like a hostile artifact. And the four-pin lockdown from the M8 two-machine rig
(empty `hooksPath`, `protocol.ext.allow=never`, no submodule recursion,
`core.longpaths` for Windows) now applies to the delegator side too, through one
shared `delegatorConfig` so the two sides can't drift.

Two plan-flagged decisions were made rather than deferred silently: per-edit
progress events **redact write-tool args to path-only** (the loop's
`argsSummary` would otherwise leak file content, breaking the spec's no-content
promise), and per-job **model override was deferred** for write tasks — the
executor uses the endpoint default, and adding `model?` later is a
wire-compatible minor addition, documented as a deliberate asymmetry with recon.

## Honest state

- **The spec's "410 after eviction" is stale.** The ratified design makes an
  evicted artifact indistinguishable from one that never existed — the route
  answers `404 UNKNOWN_JOB`, and the E2E test asserts that, not the 410 the
  design doc still names. The doc text was out of scope for the docs task;
  correcting it is a cheap follow-up.
- **A REF_MISMATCH from the backstop leaves a ref behind.** If the post-fetch
  recheck fails, a ref now exists in the reserved namespace at an *unverified*
  tip. That is surfaced in the failure message (inspect or delete it) and never
  auto-deleted — deleting refs in the user's repo on an error path is riskier
  than reporting. A future task may offer an opt-in cleanup.
- **The two-daemon harness is now hand-copied across three integration files**
  and has already started to drift (this milestone's copy has the better
  `waitUntil` and repo helpers the older two lack). Flagged for a
  shared-fixture extraction; deferred rather than smuggled into a
  milestone-closing change.
- **The restart-mid-write test proves the sweep against *planted* residue.** A
  graceful `stop()` already releases the live worktree, so the test plants the
  exact crash artifacts (a stale `jobs/` dir + a leaked `homefleet/` ref in the
  bare cache) and asserts a fresh assembled daemon purges them on init. A true
  hard-kill isn't reproducible in-process without a child-process harness the
  plan didn't call for.
- **`testHookBeforeFetch` is a documented TEST-SEAM-ONLY field** on the apply
  input; the production applier is asserted never to set it.

## Process notes

Subagent-driven throughout: a fresh implementer per task, then a spec-compliance
review and a code-quality review, fix loops until both approved, one commit per
task, pushed after each close. Two things worth recording for the shared-checkout
playbook. A concurrent session shared this clone the whole time; every
implementer ran `git status` first and staged its own paths explicitly, and
nothing collided. And a background polish agent stopped mid-task without
committing — leaving four half-finished files. Rather than trust its report (it
had none) or discard the work, the diff was read against exactly what had been
asked, confirmed to be the requested edits and not a concurrent session's, and
finished by hand. The 5-hour limit also cut a reviewer off mid-verification
again; resuming it from its transcript picked up where it stopped. Same lessons
as devlog 012, now standing practice.

Next: the deferred rig smoke — a real scoped write task against the tower's
Qwen model on hardware, with a benchmark — and the opencode-adapter decision
gate. Both are human-gated. The autonomous half of v0.2 is finished and on
`main`.
