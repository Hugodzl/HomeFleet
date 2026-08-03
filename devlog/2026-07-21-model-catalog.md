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

## Rig smoke, part 1: back-compat bug found on real hardware

The rig smoke earned its keep before a single job was delegated. Bringing the
two nodes up on the merged build:

- **Laptop (Ollama, `qwen3.5:4b`)** — started clean on its untouched v0.2
  config and advertised
  `protocolVersion 0.3.0, models [{ id: "qwen3.5:4b", contextWindow: 16384, status: "ok" }]`.
  Legacy auto-migration and the live `/v1/models` probe both worked first try.
- **Tower (llama-server, `qwen3.6-35b-a3b`)** — `homefleetd` **refused to
  start**: `duplicate catalog model id "qwen3.6-35b-a3b"`.

The tower's config is the canonical v0.2 worker shape: one server, one model
id, and a *per-executor* `contextWindow` (agent 16384, write 32768). The
normalizer's conflict test — added in the final-review pass to stop two legacy
endpoints on *different* servers from silently collapsing — also OR'd in
`contextWindow` inequality, so same-server/same-id/different-window tripped it
and produced two same-id entries, which the duplicate-id `superRefine` then
rejected. Every v0.2 rig node with per-executor windows would have hit this.

The structural cause is real, not incidental: A2 moved `contextWindow` from
per-executor to per-model, so v0.2's per-executor windows are not expressible
in a catalog and *must* be reconciled somewhere. Three options were on the
table — migrate the tower's config (hides the regression), add a per-executor
window override (makes v0.2 literally expressible, but the executors do not
read `contextWindow` at all today, so it would be pure ceremony), or fix the
normalizer. Fixed the normalizer: `sameEndpoint` compares the *server* only,
and differing windows on one server reconcile to the larger. Max is safe
because the value gates only the dispatch-time `MIN_AGENT_CONTEXT_WINDOW`
floor and both legacy values already had to clear that floor to parse under
v0.2 — so the merge cannot turn a previously-loading config into a rejection.
The genuine ambiguity (same id, *different* servers) still rejects loudly;
that distinction now has tests on both sides.

Lesson worth keeping: the final-review fix was written from a reasoned hazard
("recon could be silently rerouted to the write server") and reviewed by three
separate agents, and the over-broad conjunct still slipped through every one of
them. No unit test caught it because every test wrote the *new* config shape or
a hand-built legacy one — none used a real v0.2 config off a real machine. The
regression test added here is that literal tower config.

## Rig smoke, part 2: green end to end

Both nodes on `cfaebc6`, both on their **unmodified pre-A2 `config.json`** (the
whole point — auto-migration is what is under test):

| | laptop | tower |
| --- | --- | --- |
| server | Ollama | llama.cpp `llama-server` (`--cpu-moe --jinja`, Q4_K_M) |
| model | `qwen3.5:4b` | `qwen3.6-35b-a3b` |
| legacy config | `agent.endpoint` + advisory `models[]` | `agent.endpoint` (16384) + `write.endpoint` (32768), one server |
| advertised | `contextWindow 16384, status "ok"` | `contextWindow 32768` (reconciled to the larger), `status "ok"` |

**Advertisement, through the real MCP front door.** `list_nodes` from an MCP
client on the laptop returned the tower as
`models=[{"id":"qwen3.6-35b-a3b","contextWindow":32768,"status":"ok"}]` — legacy
config → migrated catalog → live `/v1/models` probe → HFP `hello` across the LAN
→ MCP output, all of it real.

**Targeting.** `delegate_task` recon at the tower with an explicit
`model: "qwen3.6-35b-a3b"`: accepted in 2.2 s (bundle sync + dispatch), terminal
**succeeded** at 82.9 s wall (worker-side `wallMs` 77 199), 5 tool calls,
4 995 prompt / 470 completion tokens. The summary was accurate and cited real
files (`packages/protocol/package.json`, `src/rpc.ts`) — comparable to the
v0.2 recon baseline (~105 s) on the same box.

**Enforcement.** Two models the tower does not serve — `qwen3.5:4b` (the
*laptop's* model, the realistic operator slip) and a typo'd `qwen3.6-35b` — both
came back as
`The worker returned an error (MODEL_NOT_OFFERED): this node does not offer model "…"`
in 0.1 s, `isError: true`, no stack leakage. The exact contract the E2E tests
assert, confirmed against real daemons over the LAN.

One honest note on that 0.1 s: enforcement is worker-side (deviation 3 — no
delegator-side fast-fail), so `delegate_task` still syncs the workspace *before*
the worker rejects. It was instant here only because the repo was already in
sync from the previous job; a first-ever delegation with a bad model id would
transfer the bundle first, then reject. That is the accepted trade-off, now
observed rather than assumed — and a concrete argument for revisiting the
delegator-side pre-check if bundle transfers ever get expensive.

## Rig smoke, part 3: write delegation with an explicit model id

The capability that did not exist before A2 — v0.2's write tasks always used
their endpoint's default model — run against the tower's 35B.

**First attempt failed in 5.5 s, correctly.** The task carried
`verifyCommand: pnpm vitest run <file>` and came back
`COMMAND_NOT_ALLOWED: verifyCommand "pnpm" is not on this worker's allowlist`
with `toolCalls: 0, wallMs: 0` and no artifact. The gate is the **write
executor's own** `commandAllowlist` — not the `command` executor's
`{pnpm,git,node}` — and the tower's unmodified `executors.write` block has
none. Operator error on the driver's part, and a clean demonstration that the
verify gate fires fail-closed *before* model resolution or any tool call. The
tower's config was left alone rather than widened to suit the test.

**Second attempt succeeded in 61.4 s** (worker `wallMs` 58 658, 2 tool calls,
8 519 prompt / 458 completion tokens) with `model: "qwen3.6-35b-a3b"`
explicitly targeted. `artifactStatus: "applied"` — branch
`homefleet/dfeccacbfe7e`, 1 file, +13/−0, authored `HomeFleet Worker
<worker@263d9c76.invalid>`, fetched into the laptop clone with the working
tree and existing branches untouched. The task was deliberately a real gap
this feature's own final review had flagged: no test pinned the legacy
duplicate-advisory-id merge. The model wrote it correctly.

**The finding worth keeping: vitest-green is not typecheck-green here.** The
delivered test passed `vitest` but failed `tsc`:
`TS2532: Object is possibly 'undefined'` — `models[0].id` under this repo's
`noUncheckedIndexedAccess`. Vitest strips types, so the very `verifyCommand`
the first attempt tried (`pnpm vitest run …`) would have reported **green and
hidden it**. For this codebase a worker-side verify wants `pnpm typecheck` (or
both); a test-only verify buys false confidence on exactly the class of defect
a small model is most likely to produce. Fixed with a one-character `?.` and
kept: the worker's commit is merged with its authorship intact, the fix is a
separate follow-up commit.

## Rig smoke, part 4: closing the multi-model gap

Parts 1–3 all ran against nodes serving exactly ONE model, which makes
"targeting works" unfalsifiable — a mis-route would have succeeded identically.
Closing that needed a node with two models.

**The tower could not be it.** A sweep found exactly one GGUF on the machine
(the 20.6 GB primary), no Ollama, and an embedding model in the HF cache in the
wrong format. More decisively: **~0.3 GB of truly free RAM** (2.42 GB
available, 26.3/34.4 GB committed, the 35B's working set 19 GB). A second
llama-server there would thrash even if a model were downloaded.

**The laptop became the multi-model node instead**, and is a better testbed:
Ollama serves many models from one endpoint (the most common real multi-model
setup), and — unlike llama-server, which ignores the request's `model` field
and serves whatever it loaded — Ollama honors it. Pulled `llama3.2:1b`
(deliberately a *different family* from `qwen3.5:4b`, so the tokenizers differ)
and rewrote the laptop's config to an explicit two-entry catalog with
**per-entry endpoints**. Both entries validated in a **single** probe — the
group-by-baseUrl dedup path, on real hardware — and both advertised
`status: "ok"` with their `label`s.

`delegate_task` needs a *paired peer*, so a node cannot delegate to itself.
Rather than expose Ollama on the LAN (elevated firewall rule) or add a `repos`
mapping to the tower, a **second daemon** was run on the laptop as a pure
delegator — its own data dir, ports 56470/56472/56473, `discovery` off with a
`staticNodes` entry pointing at the worker — and paired over real loopback
mTLS. This is the topology the config docs already anticipate ("`udpPort: 0`
… tests, multiple daemons on one machine"), but with real model serving rather
than faked capability profiles.

**Proof method.** All Ollama models are unloaded before each job, so whatever
`/api/ps` reports resident afterwards is definitively what served it:

| case | requested | resident after | result |
| --- | --- | --- | --- |
| A | `llama3.2:1b` | `["llama3.2:1b"]` | routed to the small model |
| B | `qwen3.5:4b` | `["qwen3.5:4b"]` | routed to the big model |
| C | *omitted* | `["qwen3.5:4b"]` | fell back to `executors.agent.defaultModel` |
| D | `mistral:7b` | `[]` | `MODEL_NOT_OFFERED` in 0.1 s, no model ever loaded |

Independent corroboration: `promptTokens` for the **identical** prompt differed
by model — 826 (llama3.2) vs 714 (qwen3.5) — so the two jobs provably reached
two different tokenizers, not merely left different resident state behind. Case
D's empty resident set also confirms rejection happens before any model contact.

That closes the last gap this feature had: per-model targeting, the default
fallback, and denial are now all verified against real model servers on real
hardware, with a *falsifiable* assertion.

Remaining honest caveat: both catalog entries in part 4 share one `baseUrl`, so
per-entry endpoints pointing at two genuinely *distinct* backends is still
unit/E2E-tested only — the tower's RAM ceiling is what blocks it, not the code.
