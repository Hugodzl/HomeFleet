# Devlog 016 — A2: the model catalog, enforced end to end

**2026-07-21**

A2 is done. Through v0.2 a node's `models[]` was purely advertisory — it never
configured anything, each `executors.agent`/`executors.write` bound exactly
one hardcoded endpoint, and write jobs could not target a model at all. A2
turns that into an explicit, startup-validated **catalog**: a node declares
its models (and where each is served) once, executors reference a
`defaultModel` id instead of owning an endpoint, `list_nodes` shows every
model's live `ok | not_served | unreachable` probe status, and `delegate_task`
can target a specific model by id on **both** recon and write — or be cleanly
denied `MODEL_NOT_OFFERED` before the job is ever queued. Ten tasks, HFP
bumped to 0.3.0, and the whole path is proven against two real daemons with
only the model endpoint mocked: a live `/models` probe stamping `ok`, a
requested model actually reaching the mock's request body, and an un-offered
model surfacing as a clean tool error rather than a stack trace.

## What A2 delivered

- **Protocol** (Task 1). Two new HFP error codes (`MODEL_NOT_OFFERED`,
  `NO_MODEL_SPECIFIED`), `ModelInfo` gained optional `label`/`status` (the
  latter one of `ok | not_served | unreachable`), and `WriteJobParams` gained
  an optional `model` — mirroring recon's, closing the asymmetry v0.2 left
  behind. HFP bumped `0.2.0` → `0.3.0`; every change is additive, so the bump
  is interop-safe.
- **Config: the catalog schema** (Task 2). `catalog.defaultEndpoint` +
  `catalog.models[]` (`{ id, label?, contextWindow?, endpoint? }`, per-entry
  `endpoint` overriding the shared default) replace the old
  `executors.{agent,write}.endpoint`; both executors now take a
  `defaultModel` id instead. A `superRefine` rejects duplicate catalog ids, a
  `defaultModel` that doesn't name a catalog entry, and an executor configured
  against an empty catalog — all at config-load, before the daemon ever binds
  a port.
- **Back-compat normalizer** (Task 3). A pure `normalizeLegacyConfig` upgrades
  pre-catalog configs — legacy `executors.{agent,write}.endpoint` and/or a
  top-level advisory `models[]` — into the canonical catalog shape before
  schema validation runs, so every config written against v0.1/v0.2 keeps
  loading and behaving unchanged. A config that mixes the new `catalog` key
  with a legacy form is rejected outright rather than silently merged.
- **Catalog runtime + pure resolver** (Task 4). `buildCatalog` flattens config
  into an id → resolved-endpoint map; `makeModelResolver` is the pure
  submit-time enforcement function — requested model → executor default →
  the catalog's sole entry, in that order, else `NO_MODEL_SPECIFIED`; an
  unknown id is `MODEL_NOT_OFFERED`; a model with no endpoint or a
  below-floor `contextWindow` is `INVALID_REQUEST`. The `≥ 16384` context
  floor moved here from config-load time (see deviation 1, below).
- **Startup validation** (Task 5). A best-effort boot-time probe GETs
  `{baseUrl}/models` once per *distinct* endpoint (never once per model — a
  shared `defaultEndpoint` serving five models is one HTTP call) and maps
  declared ids to `ok`/`not_served`/`unreachable`; a down or slow server (a
  bounded timeout, injectable for tests) never blocks daemon startup, it just
  yields `unreachable` for that endpoint's models.
- **NodeInfo advertisement** (Task 6). `node-info.ts` stopped passing
  `config.models` straight through; it now advertises a caller-supplied,
  status-stamped list the daemon builds from `buildCatalog` →
  `validateCatalog` at startup.
- **Executors take the endpoint per job** (Task 7). `AgentExecutor`/
  `WriteExecutor` no longer own an endpoint or construct their
  `OpenAiClient` in the constructor — they read `context.endpoint` (the
  daemon-resolved endpoint) fresh per job. The context-window floor check
  left the executors entirely; it lives solely in the resolver now.
- **Dispatch: submit-time enforcement** (Task 8). `JobManager.submit()`
  resolves the model **before** the busy/queue check — a bad model name is a
  client error, not a capacity problem, so it must reject the same way
  regardless of load — and stashes the resolved endpoint on the job record
  for `executeJob` to hand into the execution context. This is the task that
  closed the repo-wide typecheck: `buildExecutors` dropping `endpoint` and
  `JobManager` gaining `resolveModel` had to land together.
- **MCP surface** (Task 9). `delegate_task`'s write-task input gained
  `model?`, threaded verbatim into `WriteJobParams` the same way recon's
  already was; `list_nodes`'s `NodeSummary.models` picks up `label`/`status`
  automatically (it was already reusing `ModelInfoSchema`).
- **End-to-end proof + docs** (Task 10, this entry). `MockOpenAiEndpoint`
  learned to answer `GET /models` from a configured list. Three new
  integration tests build a **real** worker daemon whose model resolution
  goes through the actual `buildCatalog` → `validateCatalog` →
  `makeModelResolver` pipeline — genuine `fetch` over loopback to the mock,
  no `fetchImpl` injection — and assert `list_nodes` reports a live `ok`
  status, a requested model actually reaches the mock's request body, and an
  un-offered model comes back as a clean, non-stack-trace tool error.
  `configuration.md` and `README.md` were rewritten for the catalog shape,
  keeping a note that the legacy `endpoint` form still loads.

## Deviations from the spec (flagged in the plan, confirmed as implemented)

1. **`contextWindow` is optional in catalog config**, where the spec said
   required. Config-parse time now accepts a bare `{ id: "llama3" }` entry —
   preserving the old advisory `models[]`'s laxity and leaving room for a
   future non-text catalog entry — and the `≥ 16384` floor moved to
   model-*resolution* time (the resolver, Task 4), exactly where spec §4
   relocated it. Net effect for a real text model is identical; the failure
   mode for a too-small or absent window changed from a config-load error to
   an `INVALID_REQUEST` at dispatch.
2. **`ModelInfo.status` is optional on the wire**, so the protocol change
   stays additive per the HFP minor-bump rule the spec invoked. The daemon
   always sets it when advertising a catalog-derived model; a peer that omits
   it (a pre-A2 daemon) still parses fine and reads as unknown status.
3. **No delegator-side fast-fail.** Worker-side enforcement is authoritative
   — the worker's `MODEL_NOT_OFFERED` already reaches the delegating agent as
   a clean tool error through the existing `describeHfpFailure` plumbing
   (confirmed by Task 10's E2E test, unmodified — see below). The spec called
   the fast-fail "convenience only," and `nodeDirectory.resolve()` holds no
   capability info to check without an extra round-trip. Can be added later.
4. **Legacy advisory `models[]` is auto-migrated** into the catalog by the
   normalizer, where the spec implied removal. Migrating (not dropping) is
   what makes "existing configs run unchanged" actually true.

## The harness question, and why `describeHfpFailure` needed no changes

The plan flagged one open question for Task 10: whether `describeHfpFailure`
(the daemon's non-leaking HFP-error-to-tool-message translator) would need
`MODEL_NOT_OFFERED`/`NO_MODEL_SPECIFIED` added to its per-code switch, or
whether its fallback already covered them. Traced and confirmed by running
the actual E2E test with the message printed: the `default` branch already
interpolates both the code and the worker's message —
`The worker returned an error (MODEL_NOT_OFFERED): this node does not offer
model "ghost"` — because that branch was never code-specific to begin with
(`NO_ARTIFACT`, `CANCELED`, `TIMEOUT`, `BUDGET_EXCEEDED`,
`COMMAND_NOT_ALLOWED`, and `INTERNAL` all already rode the same fallback).
No change was needed; the E2E test asserts the exact message text rather than
a loose pattern, so this isn't an assumption.

The harder question was the E2E harness itself: `tools.integration.test.ts`'s
worker helper (`createDaemon`) hand-assembles a `JobManager` + `NodeServer`
directly — it does not go through the real `Daemon` class in `daemon.ts` (no
MCP/control front, no discovery; the "agent" side supplies its own MCP server
and a static endpoint map instead of live discovery). Rather than switch the
worker role to the full `Daemon` class — which would have dragged in an MCP
front and control server this suite never uses — `createDaemon` gained one
new option, `catalogConfig` (a schema-validated `DaemonConfig` slice), that
makes it run the **actual** `buildCatalog` → `validateCatalog` →
`makeModelResolver` → `createNodeInfoProvider` sequence in the same order
`daemon.ts` does, with genuine `fetch` over loopback to the mock's new
`GET /models` route — no `fetchImpl` injection anywhere in the test. Every
other test in the file that doesn't pass `catalogConfig` is byte-for-byte
unaffected (same canned `NodeInfo`, same permissive `resolveModel` fake).

## Honest state

- **No rig smoke this session.** The final-verification step calls for an
  optional real-hardware smoke (human-gated); this implementation pass was
  code + tests + docs only, no access to the reference rig. `pnpm build &&
  pnpm typecheck && pnpm test && pnpm lint` are all green (831 passed, 2
  skipped — the pre-existing `write-tools.test.ts` symlink tests — 62 files;
  lint reports 4 `noExplicitAny` warnings in `config-normalize.test.ts`, the
  `as any` casts Task 3 added on the normalizer's `unknown` return — new on
  this branch, not pre-existing, and warnings don't fail the command).
  *(Corrected post-review: those casts were later replaced with precise
  types, so `pnpm lint` now reports 0 warnings.)*
- **The E2E recon test's catalog has one model.** It proves a *requested*
  model id reaches the wire end-to-end through a real worker, but with only
  one catalog entry it can't by itself distinguish "used the request" from
  "fell back to the sole-entry default" — that distinction is already
  unit-tested at the resolver level (`catalog.test.ts`), so this test's job
  is narrower and deliberate: prove the wiring, not re-prove precedence.
- **Startup validation is a boot-time snapshot**, not a health check — a
  model that goes `unreachable` after startup is still accepted at dispatch
  (enforcement is on catalog *membership*) and simply fails or times out
  inside the job. This is spec-intended, not a gap, but worth restating since
  it is easy to misread `list_nodes`'s status as live.

## Process notes

Single-session implementation against a pre-written task-by-task plan
(`docs/plans/2026-07-21-model-catalog.md`), TDD per step: write the test,
watch it fail (or, for the harness itself, run it and let a real bug surface
one), then implement. The un-offered-model test was temporarily instrumented
with a `console.log` of the actual tool-error text to confirm the resolver's
message — not just a loose regex — was reaching the agent before locking the
assertion down and removing the debug line.

Next: the deferred rig smoke (human-gated, same posture as v0.2's), and
whatever cluster-A work follows per the backlog-structuring doc's sequencing
now that A2 has landed ahead of it.
