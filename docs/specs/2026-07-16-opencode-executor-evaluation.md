# Evaluation: opencode as an optional second write executor

**Status:** paper eval complete; recommendation **PROPOSED — pending Hugo's
ratification** (2026-07-16). This is the decision gate deferred from the v0.2
plan ("Opencode adapter — separate decision gate + bake-off devlog"). It
revisits the prediction in [ADR-0003](../adr/0003-custom-minimal-agent-executor.md)
and is recorded as [ADR-0007](../adr/0007-opencode-optional-executor.md).

No adapter was built and no bake-off was run — by design. A decision gate's job
is to decide whether that spend is warranted *before* making it. This is a
sourced paper evaluation of opencode's current state (mid-July 2026, opencode
`v1.18.3`) against HomeFleet's constraints.

## 1. The question

The decision space was narrowed with Hugo before research (two scoping forks):

- **Gate shape:** paper eval only — no adapter, no bake-off.
- **Decision space:** the custom git-free `WriteExecutor` stays the **default**;
  full replacement is off the table. The only live question is whether to *also*
  offer an **opencode-backed executor behind the same `Executor` interface** for
  harder tasks — with **defer**, **harvest a technique**, or **reject** as the
  other outcomes.

So: **should HomeFleet wrap opencode as an optional second write executor?**

## 2. Recommendation (TL;DR)

**Defer wrapping opencode. Harvest its edit-application technique instead.**

opencode's one material advantage over our naive `edit_file` — robust,
fuzzy-tolerant edit application — is **real but portable**: it is MIT-licensed,
self-contained, and was itself synthesized from two other open agents (Cline and
Gemini CLI). We can lift the *technique* into our own git-free `edit_file` and
capture the entire upside **without** importing the wrapper's costs, which —
uniquely — land on HomeFleet's exact target (small local models on
llama.cpp/llama-server). Wrapping opencode to get an algorithm we can reimplement
in a few hundred lines is a lopsided trade.

This **validates ADR-0003's structure** (a custom loop behind the `Executor`
interface) while **revising its prediction** that "an opencode adapter is the
likely path when code-writing arrives." The edit-robustness gap ADR-0003
correctly foresaw is better closed by harvesting than by wrapping — because
opencode's value assumes frontier models, and its dominant cost is exactly the
local-model tool-calling fragility HomeFleet lives with.

## 3. What opencode is now (disambiguation matters)

There are **two** live projects a reader could conflate:

- ✅ **`anomalyco/opencode`** — TypeScript, MIT, ~187k★, `v1.18.3`, built by
  Anomaly (the company behind SST; Dax Raad et al.). The GitHub org was renamed
  from `sst` → `anomalyco` in 2026 (`sst/opencode` now redirects). **This is the
  one ADR-0003 evaluated and this memo is about.**
- 🚩 **`charmbracelet/crush`** — Go/Bubbletea, the continuation of the *original*
  "opencode" (Kujtim Hoxha's Go TUI, now archived) under the Charm team. A
  different codebase and different maintainers. If anyone says "opencode became
  Crush," that is **not** the project here.

Integration surface (relevant because wrapping means driving it headless):

- Headless via `opencode serve` (HTTP server, live **OpenAPI 3.1** at `/doc`,
  official `@opencode-ai/sdk` in TS, SSE events) or one-shot
  `opencode run --format json`. Reliable non-interactive operation landed only in
  Feb 2026 (PR #11814: `run` now auto-denies anything that would prompt);
  `--auto` auto-approves "ask" permissions while still honoring explicit denies.
- **Light install:** self-contained per-platform binaries (incl. Windows
  x64/arm64), `curl … | bash` / npm / brew / scoop / choco / Docker. No separate
  Node/Bun runtime required at execution time. This is *lighter* than ADR-0003
  feared on the install axis.
- Local models supported via a generic `@ai-sdk/openai-compatible` provider
  entry (`baseURL` → llama-server / Ollama / LM Studio).

## 4. What adding it would let users do (the upside)

**Robust edit application.** opencode's `edit` tool is a strict *superset* of our
`edit_file`. Where ours does exact-match-once (miss → error → model retries),
opencode's `replace()` tries **nine ordered strategies**, stopping at the first
usable match:

1. `SimpleReplacer` (literal exact — our current behavior)
2. `LineTrimmedReplacer` (ignore per-line leading/trailing whitespace)
3. `BlockAnchorReplacer` (anchor on trimmed first/last line, Levenshtein
   similarity ≥ 0.65 on the middle, ±25% block-size tolerance)
4. `WhitespaceNormalizedReplacer` (collapse whitespace runs)
5. `IndentationFlexibleReplacer` (strip common indentation before comparing)
6. `EscapeNormalizedReplacer` (unescape `\n \t \"` … — catches models emitting
   escaped text instead of real newlines)
7. `TrimmedBoundaryReplacer`
8. `ContextAwareReplacer` (anchor ends, accept if ≥50% of middle lines match)
9. `MultiOccurrenceReplacer` (for `replaceAll`)

Plus: line-ending normalization (CRLF/LF mismatches don't break a match), a
**runaway-match guard** (refuses a fuzzy match whose span is disproportionately
larger than `oldText`), and LSP diagnostics fed back into the next turn.

For a user, this means **harder and fuzzier edits land more often** — the single
most common failure when a smaller model reproduces "almost" the right string.
This is precisely the "robust edit application is what mature CLIs sell" thesis
from ADR-0003, and it is genuinely borne out.

(opencode also brings breadth we deliberately don't have — in-loop shell/test
execution, LSP awareness, and an `apply_patch` structured multi-file format. But
`apply_patch` is gated to GPT-5-family model IDs by an undocumented check, so **no
local model ever gets it** — local models are always on the `edit`/`write` path.)

## 5. The drawbacks (why not wrap it)

Mapped to the evaluation gates, hardest-hitting first:

- **Local-model fit (gate #2) — decisive.** The 9-strategy replacer fixes
  "close-but-not-byte-exact" text. But the *dominant documented* local-model
  failure mode is **upstream of the replacer entirely**: the tool call never
  arrives in a form opencode executes — empty `tool_calls` (an open bug hangs
  opencode indefinitely on Qwen via LM Studio, #4255), wrong argument keys/types
  (Qwen3-coder sends objects for `oldString`; `fileContent` instead of `content`,
  #29142), or plain-text calls rendered instead of executed (Qwen2.5-Coder-32B
  via vLLM, #1122). opencode **requires native tool-calling**, ships **no**
  text-protocol fallback, and **closed that feature request as "not planned"**
  (#2917). Its recommended-model list is **100% frontier/hosted**. Worse, one
  reproduction traced the fault to **llama.cpp's own tool-call/JSON streaming**
  (fixed only by a third-party autoparser branch) — i.e. the failure implicates
  **HomeFleet's exact stack**, and opencode's maintainers triage the whole class
  as "model problem." Our custom loop already had to solve llama-server
  tool-calling for the rig smoke; wrapping opencode would re-import a rigid
  assumption that is *demonstrated to break* on our hardware.
- **Git-free operability (gate #1) — conditional.** opencode's core loop doesn't
  touch your repo's git by default (git is only reachable via the generic `bash`
  tool), but it is **git-capable and must be actively muzzled**: its Snapshot
  (undo/redo) subsystem shells the real `git` binary, and an inherited
  `GIT_INDEX_FILE` env var can make it **write into your real repo's index**
  (#22477, closed *not planned*). Achievable-but-configured (`"snapshot": false`
  + `permission.bash: {"git *": "deny"}`) is a real downgrade from our v0.2
  invariant: the executor has **no git code at all**, so the single-auditable
  `HomeFleet Worker` author guarantee holds *by construction*, not by config.
- **Confinement holes.** We'd be trusting opencode's permission layer for the
  containment we currently own first-party (`resolveWritablePath`, `.git`
  refusal, sandbox-violation). That layer has documented, unfixed holes —
  `external_directory` matches absolute paths while `bash`/`edit` rules match
  relative ones, so writes *outside* the working dir have been reported to
  succeed silently despite an "ask" rule (#24429, auto-closed as a "question").
- **Testability (gate #3) — conditional.** opencode can run headless, but as a
  **separate server/binary process**, not an in-process TS module. HomeFleet's
  suite drives the executor in-process against `MockOpenAiEndpoint`; wrapping
  opencode means either spawning a real (version-churning) opencode server in
  tests or mocking at its SDK boundary — a step down from the clean, hermetic
  vitest story, and friction against the hard "testable multi-node on one
  machine" constraint.
- **Coupling & churn (cost).** ~841 releases in ~14.5 months (~58/month), **no
  semver/stability commitment**, and recurring **real** breaking changes: config
  structure (repeatedly), removed storage/`app` concepts, a permissions-system
  overhaul, SDK data-model breaks, and a mandatory SQLite migration whose
  data-loss bugs are **still open this month**. ADR-0003's original objection —
  "we inherit its event schema and release cadence" — is confirmed and amplified.

## 6. The pivotal insight

**The only upside is portable; none of the costs are.** The replacer is MIT,
self-contained, and explicitly documented in opencode's own source as a synthesis
of Cline's diff-apply evals and Gemini CLI's `editCorrector`. HomeFleet can
implement the same strategy ladder in its own git-free `edit_file` and get the
full edit-robustness win while keeping: git-free-by-construction, first-party
containment, in-process testability, zero third-party coupling, and native
control of the llama-server tool-calling layer that opencode won't fix.

One caveat to carry into the harvest: fuzzy matching introduces a failure mode our
naive matcher does **not** have — silently matching the *wrong* block (opencode
#2433: a near-enough anchor produced duplicate closing braces). For a system built
on safety-by-construction, the harvested matcher must keep **exact-match-first
ordering** and port opencode's **runaway-match guard**, so a fuzzy strategy can
never silently swallow an unintended span.

## 7. Criteria scorecard

| # | Criterion | Verdict | Note |
|---|-----------|---------|------|
| 1 | Git-free operability | ⚠️ Conditional | Git-capable; muzzle via `snapshot:false` + bash `git *` deny. `GIT_INDEX_FILE` can corrupt the real index (#22477). Downgrade from git-free-by-construction. |
| 2 | Local-model compatibility | ❌ Weak on our target | Dominant failure = tool-call encoding, upstream of the replacer, unhandled/closed not-planned, implicates llama.cpp. Recommended models 100% frontier. |
| 3 | Single-machine testability | ⚠️ Conditional | Headless-capable but a separate process; step down from the in-process `MockOpenAiEndpoint` story. |
| 4 | Edit robustness (the upside) | ✅ Real — but portable | 9-strategy replacer, strict superset of exact-match-once. MIT, self-contained, itself harvested. |
| 5 | Install / ops burden | ⚠️ Moderate | Light install (single binary, Windows ok); heavy churn (~58 releases/mo, no stability commitment, recurring breaking changes). |
| 6 | License & maintenance coupling | ✅ MIT / ⚠️ coupling | License clean; coupling high; maintainers auto-close exactly our use-case (headless/local/confinement) issues. |
| 7 | Portfolio / career value | ✅ Favors harvest | A first-party fuzzy-replacer is better portfolio *and* zero-coupling vs. wrapping a third-party agent. |

Decision rule (set before research): any gate hard-fails → reject/harvest; gates
pass but upside low → defer; gates pass + upside high + cost bounded →
adapt-as-option. **Result:** gate #2 is weak on our target and the upside is
portable → **defer wrapping + harvest the technique.**

## 8. The harvest follow-up (if ratified)

A scoped, low-risk robustness upgrade to the custom executor — *not* part of this
gate; its own TDD task with spec + quality review:

- Port the strategy ladder (exact → line-trimmed → whitespace-normalized →
  indentation-flexible → escape-normalized → block-anchor) into `edit_file`,
  **exact-match-first**, plus the **runaway-match guard** and CRLF/LF
  normalization.
- Keep it git-free and in-process; extend the existing `write-tools.test.ts` with
  the near-miss cases (whitespace/indentation/escaped-newline/CRLF) and an
  adversarial "wrong-block" case asserting the guard refuses it.
- Measure on the rig against the T1–T3 task set (§9) — this becomes the empirical
  check on whether the harvested matcher closes the gap, and the trigger to
  reopen §Triggers if it doesn't.

## 9. Triggers that would reopen "wrap opencode"

- HomeFleet gains a **frontier/hosted-model** delegation path (opencode's
  recommended models and native-tool-calling assumption then hold).
- A future rig bake-off shows the **harvested matcher still thrashes** on hard
  multi-file tasks — i.e. we need a full editing harness, not a better matcher.
- opencode ships **first-party robust local-model / text-tool-call support** *and*
  a stability commitment.
- HomeFleet needs harness breadth (LSP-aware transactional multi-file edits,
  `apply_patch`) that outgrows a hand-maintained loop.

**Ready-to-run bake-off task set** (dogfooded on this repo, for whenever a trigger
fires): **T1** easy single-file (add a focused unit test — baseline; custom loop
should win on simplicity); **T2** medium multi-file coordinated change (config
field: schema + loader + consumer + test); **T3** hard fuzzy edit (signature
change across call sites, or a large file with near-duplicate lines). Metrics:
task success, edit-application failure/thrash rate, tokens + wall, and — the
binding one — behavior **on a local 35B model**, not a frontier one.

## Evidence & caveats

Primary sources (mid-July 2026): repo `github.com/anomalyco/opencode` (`v1.18.3`,
MIT); `opencode.ai/docs` (server, providers, permissions, config, models); edit
mechanism in `packages/opencode/src/tool/edit.ts` and snapshot git use in
`packages/opencode/src/snapshot/index.ts`. Decisive issues: #2917 (text
tool-call parser, not planned), #4255 (Qwen empty-`tool_calls` hang), #29142 /
#1122 / #6918 (local-model malformed tool calls), #22477 (`GIT_INDEX_FILE` index
corruption), #24429 (permission confinement), #2433 (fuzzy wrong-block match).
Lineage: HN 44488210, `charmbracelet/crush` discussion #360.

Caveats carried from research: the permission/`GIT_INDEX_FILE` bugs were closed
*not-planned/stale* rather than fixed-and-verified against `v1.18.3`, so "still
broken" is inferred from the absence of a fix, not tested. No official statement
guarantees zero phone-home when using only a local provider (plausible from
config, not confirmed). No official opencode benchmark isolates edit-success rate
by model size; local-model evidence is qualitative (issues, blogs) but consistent
across ~a year of the project's life.
