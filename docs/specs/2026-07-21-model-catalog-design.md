# Per-Node Model Catalog (A2) — Design

**Status:** approved by Hugo 2026-07-21 (model-catalog brainstorm). Specifies
cluster **A2 · Per-node model catalog** from the
[backlog structuring doc](2026-07-12-backlog-structuring.md); implements the
model-catalog portion of seam **S3** (capability-ad schema rev) and the
list-only slice of seam **S4** (model-server adapters). Turns the advisory
`models[]` of `2026-07-06-homefleet-design.md` into an enforced, validated
catalog.

## Context and goal

Today a node advertises a `models[]` array (`packages/protocol/src/node.ts`
`ModelInfoSchema`, `{ id, contextWindow? }`) that is, in the backlog's words,
"purely advertisory — it does not configure the agent executor's endpoint."
Execution is single-model: each `executors.agent` / `executors.write` binds
exactly one `endpoint` (`{ baseUrl, model, contextWindow, apiKey? }`,
`config.ts` `AgentEndpointConfigSchema:246-261`), fixed at daemon startup. A
recon job may override the model *name* against that one endpoint
(`ReconJobParams.model`, `job.ts:55`; `agent-executor.ts:182`); write jobs
cannot (`tools.ts:206-209`, "Deliberately NO `model?` in this milestone").
Targeting is manual by device id and the daemon performs no matching — the
front agent reads `list_nodes` and names the node.

A2 makes the model set an **explicit, enforced allowlist/catalog per node,
surfaced through capability ads so the delegating side can pick a model or be
denied.** Concretely, a caller can (a) enumerate what each node offers with
validated status, (b) target a specific model by id on recon **and** write,
and (c) be cleanly denied a model a node does not offer. The catalog becomes
the node's single source of model truth; executors resolve models from it.

**Relationship to the approved sequence and seams.** This is the model-catalog
half of **S3** and the "list" verb of the **S4** adapter interface
(recommendation #3 of the backlog-structuring doc: "A2 can't advertise an
honest catalog without asking the server what's served"). It deliberately
keeps `config.json` hand-edited and strict-parsed — the daemon-owned
config-mutation API (**S2**) and the GUI (**A1**) stay separate, so A2 has no
hard dependency on cluster A and can land at its `S3 + A2` slot or be pulled
forward. The `pull` / `load` verbs of S4 (for **A3** remote install) are out
of scope here; the validator is shaped as an adapter so they attach later
without rework.

**Locked decisions (Hugo, 2026-07-21):**

| Decision | Choice |
| --- | --- |
| Serving topology | Per-entry endpoint with a node-level default; subsumes one-multi-model-server (entries share the default) and one-server-per-model (entries override) |
| Model identity | Per-node model ids + optional human-readable `label`; **no** fleet-wide alias layer (future-additive; the front agent bridges "same model everywhere") |
| Catalog source | Config-declared allowlist **+ best-effort startup validation** against the live server |
| Integration | **Unified** catalog is the node's single model source; executors carry a `defaultModel` pointer; today's inline `endpoint` normalizes to a one-entry catalog |
| Targeting scope | Model id targetable on recon **and** write (write reaches recon's parity) |
| Enforcement | Worker-side authoritative (catalog membership); delegator-side advisory fast-fail |

**Non-goals for A2:** non-text modalities / image generation (the wire stays
OpenAI `chat/completions`); daemon-side auto-routing (the front agent chooses
the node); HomeFleet-managed model load/unload (lazy-load remains the model
server's job); fleet-wide alias layer; remote model install (A3); continuous
re-validation; the config-mutation API (S2).

## 1. Config (`packages/daemon/src/config/config.ts`)

A new top-level `catalog`; executors reference it by id.

```jsonc
{
  "catalog": {
    "defaultEndpoint": { "baseUrl": "http://127.0.0.1:8080/v1", "apiKey": "…" },   // shared default; apiKey optional
    "models": [
      { "id": "qwen3.5-9b", "label": "Qwen 3.5 9B", "contextWindow": 32768 },      // inherits default
      { "id": "sdxl", "label": "SDXL", "contextWindow": 4096,
        "endpoint": { "baseUrl": "http://127.0.0.1:7860/v1" } }                    // overrides default
    ]
  },
  "executors": {
    "agent": { "defaultModel": "qwen3.5-9b", "commandAllowlist": { "pnpm": {} } },
    "write": { "defaultModel": "qwen3.5-9b" }
  }
}
```

- A catalog entry is `{ id, label?, contextWindow, endpoint? }`. `endpoint`
  (`{ baseUrl, apiKey? }`) defaults to `catalog.defaultEndpoint`; an entry may
  override it to point at a different backend. `id` is what is sent to that
  endpoint's server *and* what is advertised. Ids are unique within a catalog
  (strict-parse conflict otherwise).
- An executor names `defaultModel` (an id into the catalog) **instead of** an
  inline `endpoint`. Specifying both on one executor is a strict-parse error.
  If `defaultModel` is omitted and the catalog holds exactly one entry, that
  entry is the default; omitted with multiple entries → a task without an
  explicit model is rejected (`NO_MODEL_SPECIFIED`, §4).
- **Back-compat normalization at load.** An existing
  `executors.agent.endpoint = { baseUrl, model, contextWindow, apiKey? }` (no
  `catalog` present) is rewritten in-loader into `catalog.defaultEndpoint =
  { baseUrl, apiKey? }`, a one-entry `catalog.models += { id: model,
  contextWindow }`, and `executors.agent.defaultModel = model`; likewise for
  `executors.write.endpoint`. Identical agent/write endpoints collapse to one
  entry. Existing configs run unchanged.
- The top-level advisory `models[]` is **removed** — `NodeInfo.models` is now
  *derived* from the catalog (declared entries + validation status, §3), so it
  can no longer drift from what the node actually offers.
- Config stays hand-edited, strict-parsed, fatal-on-invalid (unchanged posture;
  S2 daemon-owned writes are separate).

## 2. Protocol (`packages/protocol`, RFC `docs/rfc/hfp-v0.md`)

The model-catalog slice of the **S3** capability-ad rev. Shaped to be extended
by a later minor bump (e.g. C1's workspace-needs flags) rather than a one-off.

```ts
// node.ts — ModelInfoSchema grows label + validated status:
ModelInfo = { id, label?, contextWindow?, status: "ok" | "not_served" | "unreachable" }
//   ok          = server serves this id
//   not_served  = server reachable but id absent (typo / drift)
//   unreachable = endpoint could not be probed
//   endpoint/baseUrl is NOT advertised — it is a worker-internal detail.
//   contextWindow stays optional in the ad (future non-text entries may omit it);
//   text catalog entries always carry it per §1, so today's ads always include it.

// job.ts — bring write to recon's parity:
WriteJobParams += model?: string
```

`NodeInfo.models: ModelInfo[]` now carries the validated catalog (RFC node-info
table, `hfp-v0.md:116-131`, updated). HFP takes a minor version bump: both
changes are additive/optional. Version-skew handling (new delegator → old
worker sending `write.model`, and vice-versa) is resolved in the build plan;
pre-alpha runs matched versions.

## 3. Startup validation (`packages/daemon`, list-slice of seam S4)

At daemon start, for each **distinct** endpoint in the catalog, a best-effort
`GET {baseUrl}/models` (OpenAI-compatible; Ollama's native `/api/tags` as a
documented fallback when `baseUrl` is the Ollama root). Declared ids are
matched against served ids to set each entry's `status`. Probes run in
parallel with a short per-probe timeout (implementation constant); a slow or
dead server marks its entries `unreachable` and never delays readiness beyond
the timeout. Failures never block boot.

Semantics work naturally across backends: `llama-server` reports its *loaded*
model(s), Ollama reports all *pulled* models — both map correctly onto "is this
offered id actually available." The result is a **boot-time snapshot**; it can
go stale as models load/unload at runtime (continuous re-validation was the
deliberately-rejected option — clean upgrade path if wanted later). Status is
advertisement only; **enforcement is on catalog membership, not status** (§4).

The probe is the `list` verb of the S4 model-server adapter interface,
structured as an adapter (per-server-type) from day one so A3's `pull` / `load`
verbs attach without rework.

## 4. Dispatch, enforcement, resolution (`packages/daemon/src/mcp`, `jobs`)

- **Worker-side is authoritative.** In `JobManager.submit()`, beside today's
  `UNSUPPORTED_JOB_TYPE` gate (`job-manager.ts:224-234`): resolve the
  requested `model` (or the executor's `defaultModel`) against catalog
  membership. Unknown id → reject **`MODEL_NOT_OFFERED`** (new code).
  Missing/ambiguous default → **`NO_MODEL_SPECIFIED`**.
- **Delegator-side fast-fail (convenience only).** `delegate_task`
  (`tools.ts:602-682`) pre-checks the requested model against the target's
  *advertised* catalog and errors early with a friendly message. Advisory —
  advertisement can be stale; the worker remains the source of truth.
- **Resolution.** The chosen id → catalog entry → concrete `{ baseUrl, model,
  contextWindow, apiKey }`. The `≥ 16384` context floor
  (`MIN_AGENT_CONTEXT_WINDOW`, `agent-executor.ts:41`; check at `:167-176`)
  moves from construction-time to model-resolution-time — same rule, now
  per-model.
- No auto-routing anywhere: the daemon still never *selects* a node.

## 5. Executor plumbing (`packages/executors/src/agent`)

Resolve model → endpoint **in the daemon** and hand the executor a concrete
endpoint **per job**, rather than at construction. Executors stay dumb
"run-against-this-endpoint" units and `openai-client.ts` is unchanged. The
modest refactor: `AgentExecutor` / `WriteExecutor` move `endpoint` from a
`private readonly` construction field to a per-job parameter. All catalog
logic lives in one place (the daemon), not spread across executors.

## 6. MCP surface (`packages/daemon/src/mcp`)

The tool count is unchanged. `NodeSummary.models` (`tools.ts:118-127`) grows
`label` + `status`; `list_nodes`'s description explains that callers target a
model via `task.model` and read `status` to avoid `unreachable` / `not_served`
models. `delegate_task`'s task input accepts `model` on recon and write.
Read-side enrichment only — no routing logic.

## 7. Testing (the autonomy constraint, unchanged)

- **Unit:** back-compat normalization (old inline `endpoint` → catalog,
  including agent/write collapse and conflict detection); catalog validator
  against a faked model server (`ok` / `not_served` / `unreachable`, timeout);
  enforcement (`MODEL_NOT_OFFERED`, default resolution, ambiguous →
  `NO_MODEL_SPECIFIED`); context-floor relocation.
- **Integration (single machine, N daemons over loopback mTLS):** delegate
  recon **and** write targeting a specific model id; target an un-offered model
  → `MODEL_NOT_OFFERED`; a node with a multi-entry catalog and per-entry
  endpoints. No feature here requires two physical machines to test.
- **Rig smoke (human-gated, devlog):** the reference rig's two backends
  (Vulkan `llama-server`, CUDA Ollama) advertise honest catalogs; a job
  targets a named model on each.

## 8. Build order (one reviewed unit each, subagent-driven, TDD)

1. **Config:** `catalog` schema + `executors.*.defaultModel` + back-compat
   normalization + strict-parse rules.
2. **Protocol + RFC:** `ModelInfo` `label`/`status`, `WriteJobParams.model`,
   HFP node-info section + version bump.
3. **Validator:** S4 list-adapter, parallel best-effort probing, status
   mapping — all against a mock server.
4. **Dispatch + executor plumbing:** membership enforcement + resolution in the
   daemon; per-job endpoint into the executors; context-floor relocation.
5. **MCP surface:** `NodeSummary` fields, tool descriptions, recon/write model
   input.
6. **Docs + devlog:** `configuration.md` (catalog, `defaultModel`, validation
   statuses, back-compat), README capability line, RFC; brainstorm/devlog entry.
7. **E2E integration suite** + rig smoke (human-gated).

## Risks, stated

- **Validation adds a startup dependency on the model server.** Mitigated:
  best-effort, parallel, short-timeout, never blocks boot; a down server yields
  `unreachable`, not a failed daemon.
- **Boot-snapshot staleness.** A model unloaded after boot still reads `ok`
  until restart. Accepted — the alternative (continuous validation) was
  explicitly rejected; membership enforcement does not depend on status, so a
  stale `ok` degrades to an honest server-side model-not-found at dispatch.
- **Back-compat normalization must be exact.** Every existing config shape maps
  to an identical runtime; covered by dedicated unit tests before anything
  downstream.
- **Config surface grows.** Kept hand-edited and strict-parsed (fatal on
  unknown keys), consistent with today; the GUI/mutation story is S2/A1, not
  this cluster.
