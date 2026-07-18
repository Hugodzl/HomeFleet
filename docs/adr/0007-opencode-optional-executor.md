# ADR-0007: Defer wrapping opencode; harvest its edit-application technique

- **Status:** proposed (pending Hugo's ratification)
- **Date:** 2026-07-16

## Context

[ADR-0003](0003-custom-minimal-agent-executor.md) chose a custom minimal agent
loop for v0.1 recon and predicted that "when code-writing delegation arrives
(post-MVP), an **opencode adapter** behind the same Executor interface is the
likely path rather than growing our loop into a full editing harness." v0.2
shipped code-writing on the custom loop anyway (`write_file`/`edit_file`/
`finish_task`), and it works — rig-proven on a small task with a local Qwen 35B.

This is the deferred decision gate: now that a working custom `WriteExecutor`
exists, should HomeFleet **also** offer an opencode-backed executor (behind the
same `Executor` interface) as an optional second executor for harder tasks? Full
replacement of the custom loop is off the table (it is the default and the
first-party portfolio piece). A sourced paper evaluation was run —
`docs/specs/2026-07-16-opencode-executor-evaluation.md` — against seven criteria
(git-free operability, local-model fit, single-machine testability, edit
robustness, install/ops burden, license/coupling, portfolio value). "opencode"
here is `anomalyco/opencode` (TypeScript, MIT), **not** the archived Go project
now continued as Charmbracelet Crush.

## Decision

**Do not wrap opencode as a second executor now. Harvest its edit-application
technique into the custom, git-free `edit_file` instead.**

opencode's one material advantage — a 9-strategy fuzzy-tolerant edit replacer, a
strict superset of our exact-match-once — is **real but portable**: MIT,
self-contained, and itself synthesized from Cline and Gemini CLI. We can lift the
technique and capture the whole upside without the wrapper's costs, which are the
decisive factor: opencode's dominant *local-model* failure mode is upstream
tool-call encoding (malformed/empty/plain-text calls), which it does not handle,
triages as "model problem," closed the fix as *not planned*, and which implicates
llama.cpp's own tool-call streaming — i.e. it lands on **HomeFleet's exact target
stack**. Its recommended models are 100% frontier; it is git-*capable* (must be
actively muzzled, with a `GIT_INDEX_FILE` footgun that can corrupt the real
index); its permission/containment layer has documented unfixed holes; it runs
only as a separate process (a step down from in-process `MockOpenAiEndpoint`
tests); and it ships ~58 releases/month with no stability commitment and
recurring breaking changes.

This **confirms ADR-0003's structure** (custom loop behind the `Executor`
interface) and **revises its prediction**: the edit-robustness gap ADR-0003
correctly foresaw is better closed by harvesting than by wrapping.

## Consequences

- The custom git-free `WriteExecutor` remains the sole write executor,
  preserving the git-free-*by-construction* safety model, first-party
  containment, and hermetic in-process tests. This is the property worth
  defending: HomeFleet crosses a trust boundary — a remote, not-fully-trusted
  local model whose output lands in someone else's repo — and git-free editing
  keeps the untrusted side producing only file *bytes* while the daemon owns
  turning them into one auditable `HomeFleet Worker` commit. That bounds the
  blast radius of untrusted output to "files in a throwaway worktree we diff
  anyway" (not "ran a hook, moved a ref, or pushed"), yields clean provenance,
  and makes reject/crash a trivial `rm`. opencode's git-free-*by-configuration*
  (muzzled by settings, with a `GIT_INDEX_FILE` index-corruption footgun) only
  weakens a property we hold structurally today.
- A **scoped harvest follow-up** is authorized (separate TDD task, not this gate):
  port the strategy ladder into `edit_file` — **exact-match-first**, with
  opencode's **runaway-match guard** and CRLF/LF normalization, so fuzzy matching
  can never silently replace the wrong span (opencode #2433). Measured on the rig
  against the eval's T1–T3 task set.
- The "wrap opencode" question is **deferred, not rejected.** Named triggers to
  reopen it (frontier-model delegation path; harvested matcher still thrashes on
  hard multi-file tasks; opencode gains first-party local-model support + a
  stability commitment; need for full-harness breadth like `apply_patch`/LSP
  transactional edits) and a ready-to-run bake-off spec are recorded in the
  evaluation doc.
