# Devlog 015 — the opencode decision gate: defer the wrapper, harvest the technique

**2026-07-16**

The last open item from v0.2 wasn't code — it was a decision. ADR-0003 built the
worker's write path on a custom minimal agent loop but predicted that "when
code-writing delegation arrives, an opencode adapter behind the same Executor
interface is the likely path." v0.2 shipped code-writing on the custom loop
anyway, and it worked — so the deferred question came due: now that a working
git-free `WriteExecutor` exists, should HomeFleet *also* wrap opencode as an
optional second executor for harder tasks?

Ran as a paper evaluation — no adapter, no bake-off. A decision gate's whole job
is to decide whether that spend is warranted *before* making it. Verdict, now
ratified as ADR-0007 (`docs/adr/0007-opencode-optional-executor.md`): **defer the
wrapper; harvest the one technique worth having.**

## What the research actually found

Two things reshaped the answer. (Full sourced write-up in
`docs/specs/2026-07-16-opencode-executor-evaluation.md`.)

First, disambiguation, because it's a trap: the "opencode" ADR-0003 evaluated is
now `anomalyco/opencode` (TypeScript, MIT, ~187k stars) after an org rename from
`sst`. The *original* Go "opencode" was archived and continued as Charmbracelet
**Crush** — a different lineage entirely. Evaluate the wrong one and every
conclusion is wrong.

Second, the upside is real — and that's exactly why wrapping is the wrong way to
get it. opencode's `edit` tool is a genuine strict superset of our
exact-match-once `edit_file`: nine ordered fallback strategies
(whitespace/indentation/escape-tolerant, block-anchor with Levenshtein
similarity, line-ending normalization, a runaway-match guard). That's the "robust
edit application is what mature CLIs sell" thesis from ADR-0003, borne out. But
the replacer is MIT, self-contained, and — per opencode's own source header —
itself lifted from Cline and Gemini CLI. **The upside is portable.**

The costs are not. On HomeFleet's exact target — small local models on
llama.cpp/llama-server — opencode's dominant documented failure mode isn't the
near-miss text its clever replacer fixes; it's *upstream* of the replacer
entirely: malformed, empty, or plain-text tool calls that never execute. opencode
requires native tool-calling, ships no text-protocol fallback, closed that
feature request "not planned," and its recommended-model list is 100% frontier.
One reproduction traced the fault to llama.cpp's own tool-call streaming — our
stack. Wrapping opencode would re-import fragility on the very hardware we run on.

## The theme: harvest the technique, not the dependency

The gate collapsed to a lopsided trade. The only thing opencode offers HomeFleet
is an edit-application algorithm we can reimplement in a few hundred lines — and
to get it by wrapping, we'd take on a git-*capable* agent that must be muzzled by
config (with a `GIT_INDEX_FILE` footgun that corrupts the real index), a
permission layer with documented confinement holes, a separate-process test story
that breaks our in-process mock-endpoint suite, and ~58 releases a month with no
stability commitment. High, permanent coupling for an algorithm that's free to
lift.

So the decision isn't "opencode is bad" — it's well-built and genuinely
impressive. It's that *wrapping is the wrong integration shape* when the value is
a portable technique and the cost lands on your exact stack. Harvest the
9-strategy replacer into our own git-free `edit_file`, keep everything v0.2 got
right, and skip the dependency.

That last part matters more than it looks, and the eval spells it out: git-free
editing isn't a detail, it's the invariant the whole write path defends. HomeFleet
crosses a trust boundary — a remote worker runs a local model we don't fully
control, and the result lands in someone else's repo. Git-free-*by-construction*
keeps the untrusted side producing only file bytes while the daemon owns turning
them into one auditable `HomeFleet Worker` commit; it bounds the blast radius of
untrusted output to "files in a throwaway worktree we diff anyway." opencode's
git-free-*by-configuration* — muzzled, not incapable — trades a structural
guarantee for a settings file. That's the difference "conditional" hides on a
scorecard.

## This revises ADR-0003, and validates it

ADR-0003 got the *structure* right — a pluggable Executor interface, so this was a
clean swap-or-don't decision instead of a rewrite. It got the *prediction* wrong:
the edit-robustness gap it correctly foresaw is better closed by harvesting than
by wrapping, because opencode's value assumes frontier models and its cost is
dominated by the local-model tool-calling fragility we live with. A prediction
made before the constraint — local models on consumer hardware — was fully felt.

## Honest state

- **Paper eval, not a bake-off.** No opencode adapter was built and nothing ran
  head-to-head; the decision rests on sourced research against seven criteria, not
  measured task success. A ready-to-run bake-off task set (T1–T3, on a local 35B)
  is recorded for whenever a reopen trigger fires.
- **Some opencode bugs are inferred, not tested.** The `GIT_INDEX_FILE` and
  permission-confinement issues were closed *not-planned/stale* rather than
  fixed-and-verified against v1.18.3, so "still broken" is read from the absence
  of a fix.
- **Deferred, not rejected.** Named triggers (a frontier-model delegation path;
  the harvested matcher still thrashing on hard multi-file tasks; opencode gaining
  first-party local-model support) would reopen the wrap question.

## Process notes

Run autonomously end to end: two sourced research subagents (integration surface;
edit mechanism + local-model fit) fanned out on opencode's current state, then
synthesis against a criteria framework scoped with Hugo up front — custom loop
stays default, opencode as optional second executor only, paper eval only. The
scoping forks mattered: narrowing "should we adopt opencode" to "should we wrap it
as an *optional* executor, given a working default" is what made the gate
answerable in a memo instead of a build.

With this ratified, **v0.2 is fully closed.** The authorized follow-up is the
harvest — port the strategy ladder into `edit_file`, exact-match-first, with the
runaway-match guard, kept git-free and in-process — its own TDD task.
