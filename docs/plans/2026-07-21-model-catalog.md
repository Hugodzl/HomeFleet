# Per-Node Model Catalog (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn HomeFleet's advisory per-node `models[]` into an enforced, startup-validated catalog whose models are targetable by id on recon and write jobs.

**Architecture:** A node declares a `catalog` (models + endpoints) in config; executors reference catalog entries by a `defaultModel` id instead of owning an endpoint. At startup the daemon best-effort probes each endpoint's `/models` to stamp a per-model status, derives the advertised `NodeInfo.models` from the catalog, and builds a pure model resolver. `JobManager.submit()` resolves the requested/default model against the catalog (rejecting `MODEL_NOT_OFFERED` / `NO_MODEL_SPECIFIED` at submit time, like the existing `UNSUPPORTED_JOB_TYPE` gate) and hands the resolved endpoint to the executor per job via `ExecutionContext`.

**Tech Stack:** TypeScript ESM, zod v4 (`z.strictObject`/`z.int()`/`.prefault()`), vitest, pnpm workspace (`@homefleet/protocol`, `@homefleet/daemon`, `@homefleet/executors`). Spec: [docs/specs/2026-07-21-model-catalog-design.md](../specs/2026-07-21-model-catalog-design.md).

---

## Deviations from the spec (flagged for review)

These are planning refinements; the spec is otherwise implemented as written.

1. **Catalog `contextWindow` is optional in config** (spec §1 said required). Keeps back-compat with the legacy advisory `models[]` (which allowed a missing `contextWindow`, e.g. `{ id: "llama3" }`) and forward-compat with future non-text entries. The `≥ MIN_AGENT_CONTEXT_WINDOW` (16384) floor **and presence** are enforced at model-resolution time for agent/write use — exactly where spec §4 relocated the floor. Net effect for text models is identical; a missing/too-small `contextWindow` now surfaces as an `INVALID_REQUEST` at dispatch rather than at config load.
2. **`ModelInfo.status` is optional on the wire** so the protocol change stays additive (the HFP minor-bump rule the spec claimed). The daemon always sets it; a peer that omits it parses fine and is treated as unknown status.
3. **No delegator-side fast-fail.** Worker-side enforcement is authoritative; the worker's `MODEL_NOT_OFFERED` already reaches the delegating agent as a clean tool error through the existing HFP error plumbing (`describeHfpFailure`). Spec §4 called the fast-fail "convenience only," and `nodeDirectory.resolve()` holds no capabilities to check without an extra round-trip. Can be added later.
4. **Legacy advisory `models[]` is auto-migrated** into the catalog by the normalizer (spec implied removal). Migrating preserves the "existing configs run unchanged" promise.

---

## Conventions (read before starting — the codebase assumes these)

- **zod v4.** Use `z.int()` (not `z.number().int()`), `z.url()`, `.optional()`, `.default(x)`, `.prefault({})` (parse-then-default for objects), `z.strictObject` (rejects unknown keys — every daemon config schema uses it), `z.discriminatedUnion("type", [...])`, and `.superRefine((val, ctx) => ctx.addIssue({ code: "custom", path: [...], message }))`. Import as `import { z } from "zod";`.
- **ESM imports** always carry the `.js` extension on relative paths (`./config.js`, `../node/catalog.js`), even from `.ts` sources.
- **Tests are vitest**, bare `import { afterEach, expect, test } from "vitest";` — no `describe` blocks. Config/daemon tests use temp data dirs (`makeTempDataDir`/`removeTempDataDir`); executor tests use `MockOpenAiEndpoint` and clean it up in `afterEach`.
- **`Executor.execute()` never rejects for a job outcome** — success, failure, timeout, cancellation are all a terminal `JobResult` (validated with `JobResultSchema.parse` before return). It rejects only on programmer error.
- **Error idiom for submit-time rejections:** `throw new JobDispatchError(code, message, details?)` where `code` is an `HfpErrorCode`. Route handlers catch it and map via `statusForCode`.
- **Run a single test file:** `pnpm --filter @homefleet/<pkg> test <path>` or from repo root `pnpm vitest run <path>`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Build (required before running bins, not needed for vitest): `pnpm build`.
- **Commit after each task** with the repo's style (imperative subject; the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer per project rule).

## File Structure

**Protocol (`packages/protocol/src/`)**
- Modify `errors.ts` — add `MODEL_NOT_OFFERED`, `NO_MODEL_SPECIFIED` to `HfpErrorCodeSchema`.
- Modify `node.ts` — add `ModelStatusSchema`; add `label?` + `status?` to `ModelInfoSchema`.
- Modify `job.ts` — add `model?: string` to `WriteJobParamsSchema`.
- Modify `version.ts` — bump `HFP_PROTOCOL_VERSION` `0.2.0` → `0.3.0`.
- Modify `test-fixtures.ts` — extend `validNodeInfo.models` with the new fields.

**Config (`packages/daemon/src/config/`)**
- Modify `config.ts` — new `CatalogEndpointConfigSchema` / `CatalogModelConfigSchema` / `CatalogConfigSchema`; `agent`/`write` executor schemas take `defaultModel` instead of `endpoint`; top-level `catalog` replaces advisory `models`; cross-field `superRefine`.
- Create `config-normalize.ts` — `normalizeLegacyConfig(raw): unknown` (pure).
- Modify `config.ts` `loadDaemonConfig` — run the normalizer before `parse`.

**Catalog runtime (`packages/daemon/src/node/`)**
- Create `catalog.ts` — `buildCatalog(config)`, `makeModelResolver(catalog)`, `validateCatalog(catalog, opts)`.
- Modify `node-info.ts` — derive `models` from the catalog + validation statuses.

**Execution (`packages/executors/src/` + `packages/daemon/src/`)**
- Modify `executors/src/executor.ts` — add optional `endpoint?: AgentEndpointOptions` to `ExecutionContext`.
- Modify `executors/src/agent/agent-executor.ts` + `write-executor.ts` — read `context.endpoint`; drop the construction `endpoint` field, the floor check, and the constructor `OpenAiClient`.
- Modify `executors/src/test-fixtures.ts` — `MockOpenAiEndpoint` also answers `GET /models`.
- Modify `daemon/src/jobs/job-manager.ts` — inject a `resolveModel`; enforce at `submit()`; pass the resolved endpoint through `executeJob` into the context.
- Modify `daemon/src/jobs/routes.ts` — `statusForCode` cases for the two new codes.
- Modify `daemon/src/daemon.ts` — `buildExecutors` drops `endpoint`; wire `buildCatalog` + `validateCatalog` + resolver + provider.

**MCP (`packages/daemon/src/mcp/`)**
- Modify `tools.ts` — `WriteTaskInputSchema.model`, `toJobParams` write branch, `toNodeSummary` local type, tool descriptions.

**Docs**
- Modify `docs/rfc/hfp-v0.md`, `docs/reference/configuration.md`, `README.md`; add a `devlog/` entry.

---

## Task 1: Protocol — error codes, model status/label, write `model`, version bump

**Files:**
- Modify: `packages/protocol/src/errors.ts:7-20` (add two codes)
- Modify: `packages/protocol/src/node.ts:43-48` (ModelStatus + ModelInfo fields)
- Modify: `packages/protocol/src/job.ts:89-99` (WriteJobParams.model)
- Modify: `packages/protocol/src/version.ts:7` (version bump)
- Modify: `packages/protocol/src/test-fixtures.ts` (fixture models)
- Test: `packages/protocol/src/node.test.ts`, `job.test.ts`, `version.test.ts`, `errors.test.ts` (create if absent)
- Docs: `docs/rfc/hfp-v0.md` (node-info table, write params, Versioning version)

- [ ] **Step 1: Write the failing test for `ModelInfoSchema` + `ModelStatusSchema`**

Add to `packages/protocol/src/node.test.ts` (import `ModelInfoSchema`, `ModelStatusSchema` from `./node.js`):

```typescript
test("ModelStatusSchema accepts the three validation statuses and rejects others", () => {
  for (const s of ["ok", "not_served", "unreachable"]) {
    expect(ModelStatusSchema.parse(s)).toBe(s);
  }
  expect(ModelStatusSchema.safeParse("degraded").success).toBe(false);
});

test("ModelInfoSchema accepts an optional label and status", () => {
  const parsed = ModelInfoSchema.parse({
    id: "qwen3.5-9b",
    label: "Qwen 3.5 9B",
    contextWindow: 32768,
    status: "ok",
  });
  expect(parsed).toEqual({
    id: "qwen3.5-9b",
    label: "Qwen 3.5 9B",
    contextWindow: 32768,
    status: "ok",
  });
});

test("ModelInfoSchema still accepts the bare legacy shape (label/status absent)", () => {
  expect(ModelInfoSchema.parse({ id: "llama3" })).toEqual({ id: "llama3" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/src/node.test.ts`
Expected: FAIL — `ModelStatusSchema` is not exported; the label/status assertions fail.

- [ ] **Step 3: Implement `node.ts` changes**

Replace `ModelInfoSchema` (`packages/protocol/src/node.ts:43-48`) with:

```typescript
/** Result of the daemon's startup probe of the model's endpoint. */
export const ModelStatusSchema = z.enum(["ok", "not_served", "unreachable"]);
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

/** A model this node offers via its OpenAI-compatible endpoint(s). */
export const ModelInfoSchema = z.object({
  id: z.string(),
  /** Optional human-readable label surfaced in list_nodes. */
  label: z.string().optional(),
  contextWindow: z.int().min(1).optional(),
  /**
   * Startup-probe status; optional on the wire (a peer may omit it) but the
   * daemon always sets it when advertising a catalog-derived model.
   */
  status: ModelStatusSchema.optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/protocol/src/node.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `WriteJobParamsSchema.model`**

Add to `packages/protocol/src/job.test.ts` (`WriteJobParamsSchema` is already imported):

```typescript
test("WriteJobParamsSchema accepts an optional model and defaults it undefined", () => {
  const base = {
    type: "write",
    workspace: validWorkspace,
    instructions: "Add a test for the parser.",
  };
  expect(WriteJobParamsSchema.parse(base).model).toBeUndefined();
  expect(
    WriteJobParamsSchema.parse({ ...base, model: "qwen3.5-9b" }).model,
  ).toBe("qwen3.5-9b");
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run packages/protocol/src/job.test.ts`
Expected: FAIL — `.model` is `undefined` even when provided (unknown key is stripped by `z.object`), so the second assertion fails.

- [ ] **Step 7: Implement `job.ts` change**

In `WriteJobParamsSchema` (`packages/protocol/src/job.ts:89-99`), add the `model` field directly after `type` (mirroring `ReconJobParamsSchema:55`):

```typescript
export const WriteJobParamsSchema = z.object({
  type: z.literal("write"),
  workspace: WorkspaceRefSchema,
  /** Optional model id to target; worker's default if absent. */
  model: z.string().optional(),
  instructions: z.string().min(1).max(16384),
  /** Advisory starting points only — never an access restriction. */
  pathHints: z.array(z.string().min(1).max(1024)).max(32).optional(),
  verifyCommand: VerifyCommandSchema.optional(),
  budgets: WriteBudgetsSchema.prefault({}),
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm vitest run packages/protocol/src/job.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the two error codes with a test**

Append to `HfpErrorCodeSchema` (`packages/protocol/src/errors.ts:7-20`), after `"COMMAND_NOT_ALLOWED",`:

```typescript
  "MODEL_NOT_OFFERED",
  "NO_MODEL_SPECIFIED",
```

Create `packages/protocol/src/errors.test.ts`:

```typescript
import { expect, test } from "vitest";
import { HfpErrorCodeSchema } from "./errors.js";

test("HfpErrorCodeSchema includes the model-catalog codes", () => {
  expect(HfpErrorCodeSchema.parse("MODEL_NOT_OFFERED")).toBe("MODEL_NOT_OFFERED");
  expect(HfpErrorCodeSchema.parse("NO_MODEL_SPECIFIED")).toBe(
    "NO_MODEL_SPECIFIED",
  );
});
```

Run: `pnpm vitest run packages/protocol/src/errors.test.ts` → PASS.

- [ ] **Step 10: Bump the protocol version and fix the pinned test**

`packages/protocol/src/version.ts:7`: change `"0.2.0"` → `"0.3.0"`.

`version.test.ts` asserts only the semver shape and the derived path prefix (major `0`), so it still passes — but grep for other pins first:

Run: `pnpm vitest run` (protocol package) and search **both packages**: `git grep -n "0\.2\.0" packages/protocol/src packages/daemon/src`
Expected: any test that pins `protocolVersion`/`pv` to `"0.2.0"` (protocol fixtures, and daemon tests that assert a peer's `protocolVersion`) is updated to `"0.3.0"`. Leave `DAEMON_VERSION` and `package.json` versions untouched — the protocol version moves independently of them.

- [ ] **Step 11: Update the shared fixture**

In `packages/protocol/src/test-fixtures.ts`, give `validNodeInfo.models` a realistic entry with the new fields so downstream fixtures exercise them:

```typescript
  models: [{ id: "qwen3.5-9b", label: "Qwen 3.5 9B", contextWindow: 32768, status: "ok" }],
```

(Leave the rest of `validNodeInfo` unchanged; bump its `protocolVersion` to `"0.3.0"` if it pins one.)

- [ ] **Step 12: Update the RFC**

In `docs/rfc/hfp-v0.md`: (a) the node-info table row for `models` — note each entry is `{ id, label?, contextWindow?, status? }` where `status ∈ ok|not_served|unreachable` is the daemon's startup probe result; (b) the write-task params — add the optional `model` field beside recon's; (c) the "Versioning" section (`hfp-v0.md:740-756`) — change the stated version to **0.3.0** and add a one-line changelog note ("0.3.0: model-catalog fields on `ModelInfo` (`label`, `status`) and `model` on write params — additive").

- [ ] **Step 13: Typecheck, full protocol tests, commit**

Run: `pnpm typecheck` (PASS) and `pnpm vitest run packages/protocol` (PASS).

```bash
git add packages/protocol docs/rfc/hfp-v0.md
git commit -m "Protocol: model catalog fields + write model + HFP 0.3.0"
```

---

## Task 2: Config — catalog schema, `defaultModel` executors, cross-field validation

Replaces the advisory top-level `models` and the per-executor `endpoint` with a `catalog` + `defaultModel`. **New-mode configs only** — legacy back-compat is Task 3. The existing old-shape tests in `config.test.ts` are converted here (the schema no longer accepts the old shape until Task 3 restores it via normalization).

**Files:**
- Modify: `packages/daemon/src/config/config.ts` (schemas at `:245-300`, root at `:345-363`, imports at `:21-38`)
- Test: `packages/daemon/src/config/config.test.ts`

- [ ] **Step 1: Write failing tests for the new catalog shape**

Add to `config.test.ts`:

```typescript
test("a catalog with a shared default endpoint and per-entry override parses", async () => {
  const dir = await newDataDir();
  const cfg = {
    catalog: {
      defaultEndpoint: { baseUrl: "http://127.0.0.1:8080/v1" },
      models: [
        { id: "qwen3.5-9b", label: "Qwen 3.5 9B", contextWindow: 32768 },
        { id: "sdxl", contextWindow: 4096, endpoint: { baseUrl: "http://127.0.0.1:7860/v1" } },
      ],
    },
    executors: { agent: { defaultModel: "qwen3.5-9b" } },
    repos: [],
  };
  await writeConfig(dir, JSON.stringify(cfg));
  const config = await loadDaemonConfig(dir);
  expect(config.catalog.models).toHaveLength(2);
  expect(config.executors.agent?.defaultModel).toBe("qwen3.5-9b");
});

test("a duplicate catalog model id throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    catalog: { models: [{ id: "m" }, { id: "m" }] },
    repos: [],
  }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("a defaultModel that is not a catalog id throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    catalog: { models: [{ id: "a", contextWindow: 32768 }] },
    executors: { agent: { defaultModel: "b" } },
    repos: [],
  }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an agent executor with an empty catalog throws", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    executors: { agent: { defaultModel: "a" } },
    catalog: { models: [] },
    repos: [],
  }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});

test("an unknown key inside a catalog entry throws (strict)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    catalog: { models: [{ id: "a", contextWindow: 32768, provider: "ollama" }] },
    repos: [],
  }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/daemon/src/config/config.test.ts`
Expected: FAIL — `catalog` is an unknown key (strict root), so all five reject with the generic message but for the wrong reason; the round-trip assertions fail outright.

- [ ] **Step 3: Add the catalog schemas**

In `config.ts`, before `AgentExecutorConfigSchema` (~`:245`), add:

```typescript
/** An OpenAI-compatible endpoint a catalog model is served from. */
export const CatalogEndpointConfigSchema = z.strictObject({
  baseUrl: z.url(),
  apiKey: z.string().min(1).optional(),
});
export type CatalogEndpointConfig = z.infer<typeof CatalogEndpointConfigSchema>;

/**
 * One offered model. `endpoint` overrides `catalog.defaultEndpoint`.
 * `contextWindow` is optional here; the >= MIN_AGENT_CONTEXT_WINDOW floor is
 * enforced at model-resolution time for agent/write use (see node/catalog.ts).
 */
export const CatalogModelConfigSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  contextWindow: z.int().min(1).optional(),
  endpoint: CatalogEndpointConfigSchema.optional(),
});
export type CatalogModelConfig = z.infer<typeof CatalogModelConfigSchema>;

/** The node's model catalog: the single source of model truth. */
export const CatalogConfigSchema = z.strictObject({
  defaultEndpoint: CatalogEndpointConfigSchema.optional(),
  models: z.array(CatalogModelConfigSchema).default([]),
});
export type CatalogConfig = z.infer<typeof CatalogConfigSchema>;
```

- [ ] **Step 4: Convert the agent/write executor schemas to `defaultModel`**

Replace `AgentExecutorConfigSchema` (`:268-273`) and `WriteExecutorConfigSchema` (`:275-287`) with:

```typescript
export const AgentExecutorConfigSchema = z.strictObject({
  /** Catalog model id used when a recon task names no model. Optional; a
   *  single-entry catalog is the implicit default (resolved at dispatch). */
  defaultModel: z.string().min(1).optional(),
  commandAllowlist: CommandAllowlistConfigSchema.optional(),
});
export type AgentExecutorConfig = z.infer<typeof AgentExecutorConfigSchema>;

export const WriteExecutorConfigSchema = z.strictObject({
  defaultModel: z.string().min(1).optional(),
  commandAllowlist: CommandAllowlistConfigSchema.optional(),
});
export type WriteExecutorConfig = z.infer<typeof WriteExecutorConfigSchema>;
```

Delete the now-unused `AgentEndpointConfigSchema` (`:245-266`) and its `_AgentEndpointMirrorGuard` (a runtime endpoint is produced by the resolver, not config). Remove the now-unused imports at `:21-38`: `AgentEndpointOptions`, `MIN_AGENT_CONTEXT_WINDOW`, and `ModelInfoSchema`. Remove `AgentEndpointConfigSchema`/`AgentEndpointConfig` from the package barrel (`packages/daemon/src/index.ts`); export the three new `Catalog*` schemas/types there instead.

- [ ] **Step 5: Swap `models` → `catalog` on the root and add the `superRefine`**

In `DaemonConfigSchema` (`:345-363`), delete the `models: z.array(ModelInfoSchema).default([])` line and add `catalog: CatalogConfigSchema.prefault({}),` in its place. Then wrap the root object with a `superRefine` (append `.superRefine(...)` to the `z.strictObject({...})`):

```typescript
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.catalog.models.forEach((m, i) => {
      if (seen.has(m.id)) {
        ctx.addIssue({ code: "custom", path: ["catalog", "models", i, "id"],
          message: `duplicate catalog model id "${m.id}"` });
      }
      seen.add(m.id);
    });
    for (const kind of ["agent", "write"] as const) {
      const ex = config.executors[kind];
      if (ex === undefined) continue;
      if (config.catalog.models.length === 0) {
        ctx.addIssue({ code: "custom", path: ["executors", kind],
          message: `executors.${kind} is configured but catalog.models is empty` });
      }
      if (ex.defaultModel !== undefined && !seen.has(ex.defaultModel)) {
        ctx.addIssue({ code: "custom", path: ["executors", kind, "defaultModel"],
          message: `executors.${kind}.defaultModel "${ex.defaultModel}" is not a catalog model id` });
      }
    }
  });
```

(`seen` doubles as the id set once populated — the executor loop runs after the id loop in the same callback.)

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pnpm vitest run packages/daemon/src/config/config.test.ts -t catalog`
Expected: the five new tests PASS.

- [ ] **Step 7: Convert the existing old-shape tests to the new shape**

These existing `config.test.ts` cases assert the removed `endpoint`/`models` shape and now fail — convert each to the catalog shape (they become new-mode tests; legacy acceptance returns in Task 3):
- `"a full valid config round-trips every M9 section"` (`:188-223`): move `executors.agent.endpoint` → a `catalog` entry `{ id: "qwen3-coder", contextWindow: 65536 }` + `executors.agent.defaultModel: "qwen3-coder"`; replace top-level `models` with `catalog.models`; drop `apiKey` into `catalog.defaultEndpoint` or the entry's `endpoint`. Update the `toMatchObject` expectation to the new shape.
- `"an agent endpoint contextWindow below the floor throws"` (`:265-282`): delete — the floor is no longer a config-load check (moved to resolution, tested in Task 4).
- `"an agent executor without an endpoint throws"` (`:284`): replace with `"an agent executor without a defaultModel parses"` — `{ executors: { agent: {} }, catalog: { models: [{ id: "m", contextWindow: 32768 }] } }` now parses (single-entry implicit default); assert `config.executors.agent` is `{}`.
- `"a write executor parses endpoint + commandAllowlist"` (`:294-313`): convert to `defaultModel` + a catalog entry.

Run: `pnpm vitest run packages/daemon/src/config/config.test.ts` → all PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck` (fixes may be needed where other daemon code reads `config.models` or `agent.endpoint` — expect breaks in `node-info.ts`, `daemon.ts`; those are addressed in Tasks 6 & 8, so at this point comment them out or stub minimally is NOT allowed — instead, land Task 2 with `pnpm --filter @homefleet/daemon vitest run src/config` green and leave the package typecheck red until Task 8, OR reorder to land 2→3→4→6→8 before a green full typecheck). Note the red typecheck in the commit body.

```bash
git add packages/daemon/src/config packages/daemon/src/index.ts
git commit -m "Config: model catalog schema + defaultModel executors (new-mode)"
```

> **Integration note:** Tasks 2–8 form one compiling unit — `config.ts` removing `endpoint`/`models` breaks `node-info.ts`/`daemon.ts` until Tasks 6 & 8. Land them in order and only assert a green repo-wide `pnpm typecheck` at the end of Task 8. Per-package vitest stays green at each step as written.

---

## Task 3: Config — legacy back-compat normalizer

A pure `normalizeLegacyConfig(raw)` upgrades pre-catalog configs (`executors.{agent,write}.endpoint`, top-level advisory `models[]`) into the canonical catalog shape, run just before schema validation. No-op when `catalog` is already present.

**Files:**
- Create: `packages/daemon/src/config/config-normalize.ts`
- Create: `packages/daemon/src/config/config-normalize.test.ts`
- Modify: `packages/daemon/src/config/config.ts` `loadDaemonConfig` (`:395`, the text-path `parse`)

- [ ] **Step 1: Write failing unit tests for the pure normalizer**

Create `config-normalize.test.ts`:

```typescript
import { expect, test } from "vitest";
import { normalizeLegacyConfig } from "./config-normalize.js";

test("no-op when a catalog is already present", () => {
  const raw = { catalog: { models: [{ id: "a" }] }, executors: {} };
  expect(normalizeLegacyConfig(raw)).toEqual(raw);
});

test("legacy agent endpoint becomes a catalog entry + defaultModel", () => {
  const out = normalizeLegacyConfig({
    executors: {
      agent: {
        endpoint: { baseUrl: "http://h/v1", apiKey: "k", model: "qwen", contextWindow: 32768 },
        commandAllowlist: { pnpm: {} },
      },
    },
  }) as any;
  expect(out.catalog.models).toEqual([
    { id: "qwen", endpoint: { baseUrl: "http://h/v1", apiKey: "k" }, contextWindow: 32768 },
  ]);
  expect(out.executors.agent).toEqual({ defaultModel: "qwen", commandAllowlist: { pnpm: {} } });
});

test("legacy advisory models[] fold in as endpoint-less entries", () => {
  const out = normalizeLegacyConfig({ models: [{ id: "a", contextWindow: 8192 }, { id: "b" }] }) as any;
  expect(out.models).toBeUndefined();
  expect(out.catalog.models).toEqual([{ id: "a", contextWindow: 8192 }, { id: "b" }]);
});

test("an advisory entry and an executor endpoint with the same id merge (endpoint wins)", () => {
  const out = normalizeLegacyConfig({
    models: [{ id: "qwen", contextWindow: 65536 }],
    executors: { agent: { endpoint: { baseUrl: "http://h/v1", model: "qwen", contextWindow: 65536 } } },
  }) as any;
  expect(out.catalog.models).toEqual([
    { id: "qwen", contextWindow: 65536, endpoint: { baseUrl: "http://h/v1" } },
  ]);
});

test("non-object input is returned unchanged", () => {
  expect(normalizeLegacyConfig(null)).toBeNull();
  expect(normalizeLegacyConfig(42)).toBe(42);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/daemon/src/config/config-normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the normalizer**

Create `config-normalize.ts`:

```typescript
/**
 * Upgrades a legacy raw config (pre-catalog) into the canonical catalog shape
 * so old configs keep loading unchanged. Pure; runs on parsed JSON BEFORE
 * schema validation. No-op when `catalog` is already present (new-mode).
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normalizeLegacyConfig(raw: unknown): unknown {
  if (!isRecord(raw) || "catalog" in raw) return raw;
  const clone: Record<string, unknown> = structuredClone(raw);
  const models: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();

  const addEntry = (entry: Record<string, unknown>): void => {
    const id = entry.id as string;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, entry);
      models.push(entry);
    } else {
      Object.assign(existing, entry); // executor endpoint wins over advisory-only
    }
  };

  if (Array.isArray(clone.models)) {
    for (const m of clone.models as unknown[]) {
      if (isRecord(m) && typeof m.id === "string") {
        const e: Record<string, unknown> = { id: m.id };
        if (typeof m.contextWindow === "number") e.contextWindow = m.contextWindow;
        if (typeof m.label === "string") e.label = m.label;
        addEntry(e);
      }
    }
    delete clone.models;
  }

  if (isRecord(clone.executors)) {
    const executors: Record<string, unknown> = { ...clone.executors };
    for (const kind of ["agent", "write"] as const) {
      const ex = executors[kind];
      if (!isRecord(ex) || !isRecord(ex.endpoint)) continue;
      const ep = ex.endpoint;
      const endpoint: Record<string, unknown> = { baseUrl: ep.baseUrl };
      if (typeof ep.apiKey === "string") endpoint.apiKey = ep.apiKey;
      const entry: Record<string, unknown> = { id: ep.model as string, endpoint };
      if (typeof ep.contextWindow === "number") entry.contextWindow = ep.contextWindow;
      addEntry(entry);
      const rewritten: Record<string, unknown> = { defaultModel: ep.model };
      if ("commandAllowlist" in ex) rewritten.commandAllowlist = ex.commandAllowlist;
      executors[kind] = rewritten;
    }
    clone.executors = executors;
  }

  if (models.length > 0) clone.catalog = { models };
  return clone;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/daemon/src/config/config-normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the normalizer into `loadDaemonConfig`**

In `config.ts`, import it (`import { normalizeLegacyConfig } from "./config-normalize.js";`) and change the text-path parse (`:395`) from:

```typescript
    return DaemonConfigSchema.parse(JSON.parse(text));
```
to:
```typescript
    return DaemonConfigSchema.parse(normalizeLegacyConfig(JSON.parse(text)));
```

(Leave the no-file `DaemonConfigSchema.parse({})` path unchanged — it is already canonical.)

- [ ] **Step 6: Add a legacy round-trip test through `loadDaemonConfig`**

Add to `config.test.ts` — this is the regression guard for real rig configs:

```typescript
test("a legacy agent-endpoint config still loads (normalized to a catalog)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    executors: { agent: { endpoint: {
      baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.5-9b", contextWindow: 32768,
    } } },
    workspace: { allowedRepoIds: ["homefleet"] },
    repos: [],
  }));
  const config = await loadDaemonConfig(dir);
  expect(config.catalog.models).toEqual([
    { id: "qwen3.5-9b", endpoint: { baseUrl: "http://127.0.0.1:8080/v1" }, contextWindow: 32768 },
  ]);
  expect(config.executors.agent?.defaultModel).toBe("qwen3.5-9b");
});

test("a config mixing catalog and a legacy endpoint is rejected (no silent merge)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({
    catalog: { models: [{ id: "a", contextWindow: 32768 }] },
    executors: { agent: { endpoint: { baseUrl: "http://h/v1", model: "a", contextWindow: 32768 } } },
    repos: [],
  }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});
```

- [ ] **Step 7: Run, typecheck (config only), commit**

Run: `pnpm vitest run packages/daemon/src/config` → PASS.

```bash
git add packages/daemon/src/config
git commit -m "Config: legacy endpoint/models back-compat normalizer"
```

---

## Task 4: Catalog runtime + pure model resolver

`buildCatalog(config)` flattens the config catalog into an id→entry map with endpoints resolved (per-entry override ?? `defaultEndpoint`) and per-job-type defaults. `makeModelResolver(catalog)` is the pure enforcement function used at submit time.

**Files:**
- Create: `packages/daemon/src/node/catalog.ts`
- Create: `packages/daemon/src/node/catalog.test.ts`

- [ ] **Step 1: Write failing tests for `buildCatalog` + `makeModelResolver`**

Create `catalog.test.ts`:

```typescript
import { MIN_AGENT_CONTEXT_WINDOW } from "@homefleet/executors";
import { expect, test } from "vitest";
import { buildCatalog, type CatalogRuntime, makeModelResolver } from "./catalog.js";

function runtime(
  entries: CatalogRuntime["entries"] extends Map<infer _K, infer V> ? V[] : never,
  defaults: CatalogRuntime["defaults"] = {},
): CatalogRuntime {
  return { entries: new Map(entries.map((e) => [e.id, e])), defaults };
}

const OK = { id: "qwen", contextWindow: 32768, baseUrl: "http://h/v1" };

test("buildCatalog resolves per-entry endpoint over the default", () => {
  const cat = buildCatalog({
    catalog: {
      defaultEndpoint: { baseUrl: "http://default/v1", apiKey: "k" },
      models: [{ id: "a", contextWindow: 32768 }, { id: "b", endpoint: { baseUrl: "http://b/v1" } }],
    },
    executors: { agent: { defaultModel: "a" } },
  });
  expect(cat.entries.get("a")).toEqual({ id: "a", contextWindow: 32768, baseUrl: "http://default/v1", apiKey: "k" });
  expect(cat.entries.get("b")).toEqual({ id: "b", baseUrl: "http://b/v1" });
  expect(cat.defaults).toEqual({ recon: "a", write: undefined });
});

test("resolver returns the endpoint for a requested model in the catalog", () => {
  const resolve = makeModelResolver(runtime([OK]));
  const r = resolve("recon", "qwen");
  expect(r).toEqual({ ok: true, endpoint: { baseUrl: "http://h/v1", model: "qwen", contextWindow: 32768 } });
});

test("resolver uses the executor default when no model is requested", () => {
  const resolve = makeModelResolver(runtime([OK, { id: "other", contextWindow: 32768, baseUrl: "http://o/v1" }], { recon: "qwen" }));
  expect(resolve("recon", undefined)).toMatchObject({ ok: true, endpoint: { model: "qwen" } });
});

test("resolver uses a single-entry catalog as the implicit default", () => {
  const resolve = makeModelResolver(runtime([OK])); // no defaults set
  expect(resolve("recon", undefined)).toMatchObject({ ok: true, endpoint: { model: "qwen" } });
});

test("resolver rejects NO_MODEL_SPECIFIED when multi-entry and no default/request", () => {
  const resolve = makeModelResolver(runtime([OK, { id: "b", contextWindow: 32768, baseUrl: "http://b/v1" }]));
  expect(resolve("recon", undefined)).toMatchObject({ ok: false, code: "NO_MODEL_SPECIFIED" });
});

test("resolver rejects MODEL_NOT_OFFERED for an unknown id", () => {
  const resolve = makeModelResolver(runtime([OK]));
  expect(resolve("recon", "ghost")).toMatchObject({ ok: false, code: "MODEL_NOT_OFFERED", details: { model: "ghost" } });
});

test("resolver rejects INVALID_REQUEST for a model with no endpoint", () => {
  const resolve = makeModelResolver(runtime([{ id: "adv", contextWindow: 32768 }]));
  expect(resolve("recon", "adv")).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
});

test("resolver rejects INVALID_REQUEST for a contextWindow below the floor", () => {
  const resolve = makeModelResolver(runtime([{ id: "small", contextWindow: MIN_AGENT_CONTEXT_WINDOW - 1, baseUrl: "http://h/v1" }]));
  expect(resolve("recon", "small")).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
});

test("resolver returns ok with no endpoint for a command job", () => {
  const resolve = makeModelResolver(runtime([OK]));
  expect(resolve("command", undefined)).toEqual({ ok: true });
});

test("write resolves against the write default, not the agent default", () => {
  const resolve = makeModelResolver(runtime(
    [OK, { id: "writer", contextWindow: 32768, baseUrl: "http://w/v1" }],
    { recon: "qwen", write: "writer" },
  ));
  expect(resolve("write", undefined)).toMatchObject({ ok: true, endpoint: { model: "writer" } });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/daemon/src/node/catalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `catalog.ts` (buildCatalog + makeModelResolver)**

Create `catalog.ts`:

```typescript
/**
 * The node's model catalog at runtime: config flattened into an id→entry map
 * with endpoints resolved, plus a pure resolver used for submit-time
 * enforcement. Startup validation (validateCatalog) lives here too (Task 5).
 */
import {
  type AgentEndpointOptions,
  MIN_AGENT_CONTEXT_WINDOW,
} from "@homefleet/executors";
import type { HfpErrorCode, JobType } from "@homefleet/protocol";
import type { DaemonConfig } from "../config/config.js";

/** A catalog entry with its endpoint resolved (entry.endpoint ?? defaultEndpoint). */
export interface CatalogEntry {
  id: string;
  label?: string;
  contextWindow?: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface CatalogRuntime {
  /** id → resolved entry, insertion-ordered. */
  entries: Map<string, CatalogEntry>;
  /** Default model id per model-bearing job type. */
  defaults: { recon?: string; write?: string };
}

export function buildCatalog(
  config: Pick<DaemonConfig, "catalog" | "executors">,
): CatalogRuntime {
  const def = config.catalog.defaultEndpoint;
  const entries = new Map<string, CatalogEntry>();
  for (const m of config.catalog.models) {
    const ep = m.endpoint ?? def;
    const entry: CatalogEntry = {
      id: m.id,
      ...(m.label !== undefined ? { label: m.label } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(ep !== undefined
        ? { baseUrl: ep.baseUrl, ...(ep.apiKey !== undefined ? { apiKey: ep.apiKey } : {}) }
        : {}),
    };
    entries.set(m.id, entry);
  }
  return {
    entries,
    defaults: {
      ...(config.executors.agent?.defaultModel !== undefined
        ? { recon: config.executors.agent.defaultModel }
        : {}),
      ...(config.executors.write?.defaultModel !== undefined
        ? { write: config.executors.write.defaultModel }
        : {}),
    },
  };
}

export type ModelResolution =
  | { ok: true; endpoint?: AgentEndpointOptions }
  | { ok: false; code: HfpErrorCode; message: string; details?: Record<string, unknown> };

export type ModelResolver = (
  jobType: JobType,
  requestedModel: string | undefined,
) => ModelResolution;

const MODEL_BEARING: ReadonlySet<JobType> = new Set<JobType>(["recon", "write"]);

export function makeModelResolver(catalog: CatalogRuntime): ModelResolver {
  return (jobType, requestedModel): ModelResolution => {
    if (!MODEL_BEARING.has(jobType)) return { ok: true };
    const dflt = jobType === "recon" ? catalog.defaults.recon : catalog.defaults.write;
    const sole = catalog.entries.size === 1 ? [...catalog.entries.keys()][0] : undefined;
    const chosen = requestedModel ?? dflt ?? sole;
    if (chosen === undefined) {
      return {
        ok: false,
        code: "NO_MODEL_SPECIFIED",
        message:
          "no model specified and this node has no single default; name a " +
          "model from this node's catalog (see list_nodes).",
      };
    }
    const entry = catalog.entries.get(chosen);
    if (entry === undefined) {
      return {
        ok: false,
        code: "MODEL_NOT_OFFERED",
        message: `this node does not offer model "${chosen}"`,
        details: { model: chosen },
      };
    }
    if (entry.baseUrl === undefined) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: `model "${chosen}" is advertised but has no configured endpoint`,
        details: { model: chosen },
      };
    }
    if (entry.contextWindow === undefined || entry.contextWindow < MIN_AGENT_CONTEXT_WINDOW) {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message:
          `model "${chosen}" contextWindow ${entry.contextWindow ?? "(unset)"} ` +
          `is below the required minimum of ${MIN_AGENT_CONTEXT_WINDOW}; raise ` +
          "the served context window.",
        details: { model: chosen },
      };
    }
    return {
      ok: true,
      endpoint: {
        baseUrl: entry.baseUrl,
        model: chosen,
        contextWindow: entry.contextWindow,
        ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
      },
    };
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/daemon/src/node/catalog.test.ts`
Expected: PASS (all 10).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/node/catalog.ts packages/daemon/src/node/catalog.test.ts
git commit -m "Catalog: runtime build + pure model resolver"
```

---

## Task 5: Startup validation — `validateCatalog`

Best-effort probe of each distinct endpoint's `/models`, mapping declared ids to `ok | not_served | unreachable`. Takes an injectable `fetchImpl` so unit tests need no server and the daemon points it at global `fetch`.

**Files:**
- Modify: `packages/daemon/src/node/catalog.ts` (add `validateCatalog` + `probeServed`)
- Modify: `packages/daemon/src/node/catalog.test.ts` (add validation tests)

- [ ] **Step 1: Write failing tests for `validateCatalog`**

Add to `catalog.test.ts`:

```typescript
/** A fake fetch mapping baseUrl -> served ids; "THROW" simulates a down server. */
function fakeFetch(byUrl: Record<string, string[] | "THROW">): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const base = url.replace(/\/models$/, "");
    const served = byUrl[base];
    if (served === undefined) return { ok: false, json: async () => ({}) } as Response;
    if (served === "THROW") throw new Error("connection refused");
    return { ok: true, json: async () => ({ data: served.map((id) => ({ id })) }) } as Response;
  }) as unknown as typeof fetch;
}

test("validateCatalog marks served models ok, absent models not_served", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "b", contextWindow: 32768, baseUrl: "http://h/v1" },
  ]);
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: fakeFetch({ "http://h/v1": ["a"] }),
  });
  expect(status.get("a")).toBe("ok");
  expect(status.get("b")).toBe("not_served");
});

test("validateCatalog marks entries on a down server unreachable", async () => {
  const cat = runtime([{ id: "a", contextWindow: 32768, baseUrl: "http://down/v1" }]);
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: fakeFetch({ "http://down/v1": "THROW" }),
  });
  expect(status.get("a")).toBe("unreachable");
});

test("validateCatalog marks an endpoint-less entry unreachable without fetching", async () => {
  const cat = runtime([{ id: "adv", contextWindow: 32768 }]);
  let calls = 0;
  const status = await validateCatalog(cat, {
    timeoutMs: 1000,
    fetchImpl: (async () => { calls++; return { ok: false, json: async () => ({}) } as Response; }) as unknown as typeof fetch,
  });
  expect(status.get("adv")).toBe("unreachable");
  expect(calls).toBe(0);
});

test("validateCatalog probes each distinct endpoint once", async () => {
  const cat = runtime([
    { id: "a", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "b", contextWindow: 32768, baseUrl: "http://h/v1" },
    { id: "c", contextWindow: 32768, baseUrl: "http://other/v1" },
  ]);
  const seen: string[] = [];
  const impl = (async (input: string | URL) => {
    seen.push(String(input));
    return { ok: true, json: async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }) } as Response;
  }) as unknown as typeof fetch;
  await validateCatalog(cat, { timeoutMs: 1000, fetchImpl: impl });
  expect(seen.sort()).toEqual(["http://h/v1/models", "http://other/v1/models"]);
});

test("validateCatalog treats a timeout/abort as unreachable", async () => {
  const cat = runtime([{ id: "a", contextWindow: 32768, baseUrl: "http://slow/v1" }]);
  const impl = ((_input: string | URL, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const status = await validateCatalog(cat, { timeoutMs: 5, fetchImpl: impl });
  expect(status.get("a")).toBe("unreachable");
});
```

Add `validateCatalog` to the imports from `./catalog.js` at the top of the test file.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/daemon/src/node/catalog.test.ts -t validateCatalog`
Expected: FAIL — `validateCatalog` is not exported.

- [ ] **Step 3: Implement `validateCatalog` + `probeServed`**

Append to `catalog.ts` (add `import type { ModelStatus } from "@homefleet/protocol";` to the existing protocol import):

```typescript
export interface ValidateOptions {
  /** Per-endpoint probe timeout in ms. */
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Best-effort startup probe. For each DISTINCT endpoint, GET `{baseUrl}/models`
 * and map declared ids to ok/not_served/unreachable. Never throws — a down or
 * slow server just yields `unreachable` for its models. Endpoint-less entries
 * are `unreachable` without a probe.
 */
export async function validateCatalog(
  catalog: CatalogRuntime,
  opts: ValidateOptions,
): Promise<Map<string, ModelStatus>> {
  const f = opts.fetchImpl ?? fetch;
  const status = new Map<string, ModelStatus>();
  const byBase = new Map<string, { ids: string[]; apiKey?: string }>();
  for (const e of catalog.entries.values()) {
    if (e.baseUrl === undefined) {
      status.set(e.id, "unreachable");
      continue;
    }
    const g = byBase.get(e.baseUrl);
    if (g === undefined) {
      byBase.set(e.baseUrl, { ids: [e.id], ...(e.apiKey !== undefined ? { apiKey: e.apiKey } : {}) });
    } else {
      g.ids.push(e.id);
    }
  }
  await Promise.all(
    [...byBase.entries()].map(async ([baseUrl, { ids, apiKey }]) => {
      const served = await probeServed(f, baseUrl, apiKey, opts.timeoutMs);
      for (const id of ids) {
        status.set(id, served === null ? "unreachable" : served.has(id) ? "ok" : "not_served");
      }
    }),
  );
  return status;
}

async function probeServed(
  f: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<Set<string> | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      signal: controller.signal,
      ...(apiKey !== undefined ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return null;
    return new Set(
      data
        .map((m) => (m as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run packages/daemon/src/node/catalog.test.ts`
Expected: PASS (all validation + resolver tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/node/catalog.ts packages/daemon/src/node/catalog.test.ts
git commit -m "Catalog: best-effort startup validation (/models probe)"
```

---

## Task 6: NodeInfo — advertise the catalog with validation status

`node-info.ts` stops passing `config.models` through and instead advertises a caller-supplied, status-stamped model list derived from the catalog. The daemon builds that list at startup (`buildCatalog` → `validateCatalog` → `advertisedModels`).

**Files:**
- Modify: `packages/daemon/src/node/catalog.ts` (add `advertisedModels` + probe-timeout constant)
- Modify: `packages/daemon/src/node/node-info.ts` (`:31-34` config pick, `:44-72` options, `:133-166` build)
- Modify: `packages/daemon/src/node/node-info.test.ts`
- Modify: `packages/daemon/src/daemon.ts` (`:410-421` wiring)

- [ ] **Step 1: Add `advertisedModels` + a failing node-info test**

Append to `catalog.ts` (extend the protocol import with `type ModelInfo`):

```typescript
export const DEFAULT_CATALOG_PROBE_TIMEOUT_MS = 3000;

/** The catalog as advertised in NodeInfo: entries + their validation status. */
export function advertisedModels(
  catalog: CatalogRuntime,
  statuses: Map<string, ModelStatus>,
): ModelInfo[] {
  return [...catalog.entries.values()].map((e) => ({
    id: e.id,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
    status: statuses.get(e.id) ?? "unreachable",
  }));
}
```

Add to `node-info.test.ts` (adapt the `config` literal to any existing helper the file uses to build a `NodeInfoConfig`):

```typescript
test("the provider advertises the models it is given, verbatim", () => {
  const provider = createNodeInfoProvider({
    deviceId: "a".repeat(64),
    config: { node: {}, executors: { agent: { defaultModel: "qwen" } } } as NodeInfoConfig,
    daemonVersion: "0.2.0",
    hostname: "tower",
    models: [{ id: "qwen", label: "Qwen", contextWindow: 32768, status: "ok" }],
  });
  expect(provider().models).toEqual([
    { id: "qwen", label: "Qwen", contextWindow: 32768, status: "ok" },
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/daemon/src/node/node-info.test.ts -t "given"`
Expected: FAIL — `NodeInfoProviderOptions` has no `models`; the provider still reads `config.models`.

- [ ] **Step 3: Rewire `node-info.ts` to advertise the supplied models**

Four edits:

1. Import — add `type ModelInfo,` to the `@homefleet/protocol` import block (`:11-17`).
2. `NodeInfoConfig` (`:31-34`) — drop `"models"`:
   ```typescript
   export type NodeInfoConfig = Pick<DaemonConfig, "node" | "executors">;
   ```
3. `NodeInfoProviderOptions` (`:44-72`) — add a field:
   ```typescript
     /** The status-stamped catalog to advertise (built by the daemon). */
     models: ModelInfo[];
   ```
4. In `createNodeInfoProvider`, add `models` to the destructure (`:133`) — `const { deviceId, config, daemonVersion, jobs, models } = options;` — and in `build()` (`:152-166`) replace `models: config.models,` with `models,`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/daemon/src/node/node-info.test.ts`
Expected: the new test PASSES. Update any existing node-info test that set `config.models` — remove that key and pass `models: []` (or the expected list) in options instead; those assertions should read `models` from options now.

- [ ] **Step 5: Wire the catalog into daemon startup**

In `daemon.ts`, import from `./node/catalog.js`: `advertisedModels`, `buildCatalog`, `validateCatalog`, `DEFAULT_CATALOG_PROBE_TIMEOUT_MS` (and `makeModelResolver`, used in Task 8). Before the `JobManager` is constructed, add:

```typescript
    const catalog = buildCatalog(config);
```

Then replace the `createNodeInfoProvider({...})` call (`:410-421`) with a validated build (this is inside the already-`async` `start()`):

```typescript
    const modelStatuses = await validateCatalog(catalog, {
      timeoutMs: DEFAULT_CATALOG_PROBE_TIMEOUT_MS,
    });
    const nodeInfoProvider = createNodeInfoProvider({
      deviceId: identity.deviceId,
      config,
      daemonVersion: DAEMON_VERSION,
      jobs: jobManager,
      models: advertisedModels(catalog, modelStatuses),
    });
```

> The daemon package will not fully typecheck yet — `buildExecutors` still reads `agent.endpoint` (removed in Task 2) and `JobManager` does not yet take `resolveModel`. Both are fixed in Tasks 7–8. `node-info.test.ts` and `catalog.test.ts` are green now.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/node packages/daemon/src/daemon.ts
git commit -m "NodeInfo: advertise the startup-validated model catalog"
```

---

## Task 7: Executors — resolved endpoint arrives per-job via `ExecutionContext`

`AgentExecutor`/`WriteExecutor` stop owning an endpoint; they read `context.endpoint` (the daemon-resolved endpoint) per job, construct their `OpenAiClient` from it, and use `endpoint.model`. The floor check leaves the executors (it now lives in the resolver, Task 4). This package typechecks and tests green on its own; the daemon package stays red until Task 8.

**Files:**
- Modify: `packages/executors/src/executor.ts` (move `AgentEndpointOptions` here; add `endpoint?` to `ExecutionContext`)
- Modify: `packages/executors/src/agent/agent-executor.ts` (`:75-122`, `:160-191`)
- Modify: `packages/executors/src/agent/write-executor.ts` (`:229-256`, `:315-348`)
- Modify: `packages/executors/src/index.ts` (barrel export of `AgentEndpointOptions`)
- Test: `packages/executors/src/agent/agent-executor.test.ts`, `write-executor.test.ts`

- [ ] **Step 1: Write the failing "reads context.endpoint" test**

In `agent-executor.test.ts`, replace the existing `"params.model overrides the endpoint's default model"` test (`:637-646`) with:

```typescript
test("uses the model + baseUrl from context.endpoint", async () => {
  const ws = await makeWorkspace();
  const endpoint = await startEndpoint([{ kind: "content", content: "ok" }]);
  const executor = makeExecutor();
  const { context } = harness(ws, {
    endpoint: { baseUrl: endpoint.baseUrl, model: "qwen3.5-9b", contextWindow: 32768 },
  });

  await executor.execute(params(), context);

  expect(body(endpoint, 0).model).toBe("qwen3.5-9b");
});
```

- [ ] **Step 2: Update the executor test helpers so the suite compiles**

In `agent-executor.test.ts`, change `makeExecutor` (`:68-85`) to take no endpoint, and `harness` (`:113-118`) to put an `endpoint` on the context:

```typescript
function makeExecutor(
  overrides: { commandAllowlist?: CommandAllowlist } = {},
): AgentExecutor {
  return new AgentExecutor(
    overrides.commandAllowlist !== undefined
      ? { commandAllowlist: overrides.commandAllowlist }
      : {},
  );
}

function harness(
  workspaceDir: string,
  overrides: Partial<ExecutionContext> = {},
): Harness {
  const events: ExecutorEventPayload[] = [];
  return {
    events,
    context: {
      jobId,
      workspaceDir,
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
      endpoint: { baseUrl: "http://unused/v1", model: "default-model", contextWindow: 32768 },
      ...overrides,
    },
  };
}
```

Every existing call that did `makeExecutor(endpoint, ...)` becomes `makeExecutor(...)`, and every `harness(ws)` that needs to hit the mock passes `{ endpoint: { baseUrl: endpoint.baseUrl, model: "default-model", contextWindow: 32768 } }`. Delete the two context-floor tests (`contextWindow` below `MIN_AGENT_CONTEXT_WINDOW`) — that rule is now covered by `catalog.test.ts`. Apply the mirror changes to `write-executor.test.ts` (its `makeExecutor` at `:107-126` keeps `finalize` but drops `endpoint`).

- [ ] **Step 3: Run to verify the new test fails**

Run: `pnpm vitest run packages/executors/src/agent/agent-executor.test.ts -t "context.endpoint"`
Expected: FAIL — `ExecutionContext` has no `endpoint`; `AgentExecutor` still reads `this.endpoint`.

- [ ] **Step 4: Move `AgentEndpointOptions` and extend `ExecutionContext`**

In `executor.ts`, add the type and the context field:

```typescript
/** The resolved model endpoint an agent/write execution talks to, per job. */
export interface AgentEndpointOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow: number;
}
```

and inside `ExecutionContext` (`:38-53`) add:

```typescript
  /**
   * Resolved model endpoint for this job (agent/write jobs only; the daemon's
   * catalog resolver sets it at submit time). Absent for command jobs.
   */
  endpoint?: AgentEndpointOptions;
```

In `index.ts`, ensure the barrel exports it — if the file does not already `export * from "./executor.js"`, add:
```typescript
export type { AgentEndpointOptions, ExecutionContext, Executor } from "./executor.js";
```
(Consumers import `AgentEndpointOptions` from `@homefleet/executors`; this keeps that path working.)

- [ ] **Step 5: Refactor `AgentExecutor`**

- Delete the local `AgentEndpointOptions` interface (`:75-84`) — it now lives in `executor.ts`; import it if any residual reference needs it (there should be none after this step).
- Change `AgentExecutorOptions` (`:86-93`) to drop `endpoint`:
  ```typescript
  export interface AgentExecutorOptions {
    commandAllowlist?: CommandAllowlist;
  }
  ```
- Class body (`:107-122`): remove the `endpoint` and `client` fields and their constructor initialization; keep `commandAllowlist`. Make the constructor `constructor(options: AgentExecutorOptions = {})`.
- Delete the `MIN_AGENT_CONTEXT_WINDOW` floor block (`:160-176`) entirely. In its place, resolve the endpoint from the context:
  ```typescript
      const endpoint = context.endpoint;
      if (endpoint === undefined) {
        return failed("INTERNAL", "no model endpoint was resolved for this job", {
          toolCalls: 0,
          wallMs: Date.now() - startedAt,
        });
      }
      const client = new OpenAiClient({
        baseUrl: endpoint.baseUrl,
        ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      });
  ```
- In the `runToolLoop({...})` call (`:180-191`): `client: this.client` → `client,` and `model: params.model ?? this.endpoint.model` → `model: endpoint.model`.
- Grep the file for any remaining `this.endpoint` / `this.client` and replace with the per-run `endpoint` / `client`. Keep `MIN_AGENT_CONTEXT_WINDOW` exported (config/tests reference it) — just stop using it here.

- [ ] **Step 6: Refactor `WriteExecutor` identically**

- `WriteExecutorOptions` (`:229-237`): drop `endpoint`, keep `commandAllowlist?` + `finalize`.
- Class/constructor (`:239-256`): remove `endpoint`/`client` fields + init; keep `commandAllowlist`, `finalize`.
- Delete the floor block (`:315-326`); add the same `context.endpoint` guard + per-run `OpenAiClient` as Step 5.
- `runToolLoop` (`:328-348`): `client: this.client` → `client,`; `model: this.endpoint.model` → `model: endpoint.model`.

- [ ] **Step 7: Run executor tests + typecheck the package**

Run: `pnpm vitest run packages/executors` and `pnpm --filter @homefleet/executors typecheck`
Expected: PASS (the executors package is self-contained; green here even though the daemon package is not yet).

- [ ] **Step 8: Commit**

```bash
git add packages/executors/src
git commit -m "Executors: take the resolved model endpoint per-job from context"
```

---

## Task 8: Dispatch — submit-time enforcement + daemon wiring

`JobManager.submit()` resolves the model against the catalog (rejecting `MODEL_NOT_OFFERED` / `NO_MODEL_SPECIFIED` / `INVALID_REQUEST` before queueing), stashes the resolved endpoint on the record, and `executeJob` passes it into the execution context. `buildExecutors` drops the endpoint; the daemon injects the resolver. This closes the repo-wide typecheck.

**Files:**
- Modify: `packages/daemon/src/jobs/job-manager.ts` (options `:130-ish`, ctor `:186-197`, `submit` `:219-263`, `JobRecord`, `executeJob` context build)
- Modify: `packages/daemon/src/jobs/routes.ts` (`statusForCode` `:321-334`)
- Modify: `packages/daemon/src/daemon.ts` (`buildExecutors` `:225-262`, `JobManager` construction)
- Test: `packages/daemon/src/jobs/job-manager.test.ts`

- [ ] **Step 1: Write the failing enforcement tests**

Add to `job-manager.test.ts` (adapt `makeJobManager`/`reconParams` to the file's existing helpers; thread a `resolveModel` into the manager options):

```typescript
test("submit rejects an un-offered model with MODEL_NOT_OFFERED", () => {
  const manager = makeJobManager({
    resolveModel: () => ({ ok: false, code: "MODEL_NOT_OFFERED", message: "not offered", details: { model: "ghost" } }),
  });
  try {
    manager.submit(reconParams({ model: "ghost" }), "owner");
    expect.unreachable("submit should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(JobDispatchError);
    expect((e as JobDispatchError).code).toBe("MODEL_NOT_OFFERED");
  }
});

test("submit rejects when no model resolves (NO_MODEL_SPECIFIED)", () => {
  const manager = makeJobManager({
    resolveModel: () => ({ ok: false, code: "NO_MODEL_SPECIFIED", message: "no default" }),
  });
  expect(() => manager.submit(reconParams(), "owner")).toThrow(JobDispatchError);
});

test("submit accepts a command job without consulting a model", () => {
  const resolveModel = vi.fn(() => ({ ok: true as const }));
  const manager = makeJobManager({ resolveModel });
  expect(() => manager.submit(commandParams(), "owner")).not.toThrow();
});
```

Add `import { vi } from "vitest";` if not present, and ensure `JobDispatchError` is imported (from `./job.js`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run packages/daemon/src/jobs/job-manager.test.ts -t model`
Expected: FAIL — `JobManagerOptions` has no `resolveModel`; `submit` never rejects on model.

- [ ] **Step 3: Thread the resolver into `JobManager`**

In `job-manager.ts`:
- Imports: `import type { AgentEndpointOptions } from "@homefleet/executors";` and `import type { ModelResolver } from "../node/catalog.js";`
- `JobManagerOptions`: add `resolveModel: ModelResolver;`
- Field + ctor: add `private readonly resolveModel: ModelResolver;` and `this.resolveModel = options.resolveModel;`
- `JobRecord` (wherever declared): add `endpoint?: AgentEndpointOptions;`
- In `submit()`, immediately after the `UNSUPPORTED_JOB_TYPE` block (`:234`) and before the `BUSY` check:
  ```typescript
      const requestedModel =
        params.type === "recon" || params.type === "write" ? params.model : undefined;
      const resolution = this.resolveModel(params.type, requestedModel);
      if (!resolution.ok) {
        throw new JobDispatchError(resolution.code, resolution.message, resolution.details);
      }
  ```
- When building the `record` (`:246-256`), add the resolved endpoint:
  ```typescript
      ...(resolution.endpoint !== undefined ? { endpoint: resolution.endpoint } : {}),
  ```
- In `executeJob`, where the `ExecutionContext` is constructed (grep for `workspaceDir:` — the object passed to `executor.execute`), add:
  ```typescript
      ...(record.endpoint !== undefined ? { endpoint: record.endpoint } : {}),
  ```

- [ ] **Step 4: Add the two `statusForCode` cases**

In `routes.ts` `statusForCode` (`:321-334`), before `default:`:

```typescript
    case "MODEL_NOT_OFFERED":
    case "NO_MODEL_SPECIFIED":
      return 400;
```

- [ ] **Step 5: Fix `buildExecutors` and inject the resolver in `daemon.ts`**

`buildExecutors` (`:225-262`) — drop `endpoint` from both constructions:

```typescript
  if (agent !== undefined) {
    executors.push(
      new AgentExecutor(
        agent.commandAllowlist !== undefined
          ? { commandAllowlist: agent.commandAllowlist }
          : {},
      ),
    );
  }
  if (write !== undefined) {
    executors.push(
      new WriteExecutor({
        ...(write.commandAllowlist !== undefined
          ? { commandAllowlist: write.commandAllowlist }
          : {}),
        finalize: finalizeWrite,
      }),
    );
  }
```

In the `JobManager` construction, add `resolveModel: makeModelResolver(catalog),` to the options (the `catalog` const was created in Task 6, before the JobManager). `makeModelResolver` is already imported (Task 6).

- [ ] **Step 6: Run tests + full typecheck (now green)**

Run: `pnpm vitest run packages/daemon/src/jobs/job-manager.test.ts` → PASS. Thread `resolveModel` into every other `makeJobManager` call in the file (a permissive `() => ({ ok: true, endpoint: { baseUrl: mock.baseUrl, model: "m", contextWindow: 32768 } })` for tests that actually run an agent job through the mock).

Run: `pnpm typecheck` → PASS (repo-wide; Tasks 2–8 now form a compiling whole).
Run: `pnpm vitest run packages/daemon` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src
git commit -m "Dispatch: submit-time model enforcement + resolver wiring"
```

---

## Task 9: MCP — write `model` input, catalog passthrough, tool descriptions

Additive tool-surface changes. `NodeSummary.models` already carries `label`/`status` automatically (it uses `ModelInfoSchema`, changed in Task 1); only the internal helper's structural type and the write task input need touching. Behavior is verified end-to-end in Task 10.

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts` (`:203-224` write input, `:276-291` `toJobParams` write branch, `:419-450` `toNodeSummary`, tool descriptions `:559-562`, `:592-598`)
- Test: `packages/daemon/src/mcp/tools.integration.test.ts` (existing suite must stay green)

- [ ] **Step 1: Add `model` to `WriteTaskInputSchema`**

Replace the "Deliberately NO `model?`" comment (`:203-210`) and add the field to `WriteTaskInputSchema` (`:211-224`), mirroring `ReconTaskInputSchema:189`:

```typescript
/**
 * Code-writing delegation. `pathHints` and `verifyCommand` pass through to the
 * protocol fields UNTOUCHED — the worker's write executor incorporates
 * pathHints into the model prompt; this layer never rewrites task content.
 */
const WriteTaskInputSchema = z.object({
  type: z.literal("write"),
  workspace: TaskWorkspaceInputSchema,
  /** Optional catalog model id to target on the worker; its default if absent. */
  model: z.string().optional(),
  instructions: z.string().min(1).max(16384),
  pathHints: z.array(z.string().min(1).max(1024)).max(32).optional(),
  verifyCommand: z
    .object({ name: z.string().min(1), args: z.array(z.string()).optional() })
    .optional(),
  maxToolCalls: z.int().min(1).max(200).optional(),
  maxWallMs: z.int().min(1000).max(3_600_000).optional(),
});
```

- [ ] **Step 2: Carry `model` through `toJobParams`'s write branch**

In `toJobParams` (`:276-291`), in the `task.type === "write"` block, add the model passthrough (matching the recon branch at `:272`) inside the `JobParamsSchema.parse({ ... })`:

```typescript
      type: "write",
      workspace,
      ...(task.model !== undefined ? { model: task.model } : {}),
      instructions: task.instructions,
```

- [ ] **Step 3: Widen the `toNodeSummary` model type**

In `toNodeSummary` (`:420-431`), widen the inline `models` element type so the `{ ...m }` copy carries the new fields:

```typescript
    models: readonly {
      id: string;
      label?: string;
      contextWindow?: number;
      status?: "ok" | "not_served" | "unreachable";
    }[];
```

The mapping body (`models.map((m) => ({ ...m }))`, `:446`) is unchanged — it already copies every field.

- [ ] **Step 4: Update the two tool descriptions**

`list_nodes` description (`:559-562`) — append a sentence:

```
"... Each model carries a startup-probe status (ok | not_served | unreachable); prefer models reported ok."
```

`delegate_task` description (`:592-598`) — append a sentence:

```
"For recon and write tasks you may set task.model to a specific model id from the target's catalog; omit it to use the node's default. An un-offered model is rejected."
```

- [ ] **Step 5: Verify existing MCP tests + typecheck stay green**

Run: `pnpm vitest run packages/daemon/src/mcp` and `pnpm typecheck`
Expected: PASS. The changes are additive: `NodeSummary` gains optional fields; write gains an optional input. Existing recon/command/write integration tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/mcp
git commit -m "MCP: write model targeting + catalog status passthrough in list_nodes"
```

---

## Task 10: End-to-end integration + docs

Prove the whole path against real daemons: catalog advertised with a live `ok` status, delegation targeting a named model, and `MODEL_NOT_OFFERED` surfaced as a clean tool error. Then update the operator docs.

**Files:**
- Modify: `packages/executors/src/test-fixtures.ts` (`MockOpenAiEndpoint` serves `GET /models`)
- Modify: `packages/daemon/src/mcp/tools.integration.test.ts`
- Modify: `docs/reference/configuration.md`, `README.md`; create `devlog/2026-07-21-model-catalog.md`

- [ ] **Step 1: Teach `MockOpenAiEndpoint` to serve `GET /models`**

Add an optional model list to the fixture so a worker's startup validation can reach it. In `test-fixtures.ts`:
- Add `models?: string[]` to `MockOpenAiEndpoint.start(script, options?)`; store it as `private readonly models: string[]` (default `[]`), threaded through the private constructor.
- In the request handler (before the `POST /chat/completions` branch), handle the probe:
  ```typescript
  if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
    const body = JSON.stringify({
      object: "list",
      data: this.models.map((id) => ({ id, object: "model" })),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }
  ```

Add a focused fixture test (in a small `packages/executors/src/test-fixtures.test.ts`):

```typescript
import { expect, test } from "vitest";
import { MockOpenAiEndpoint } from "./test-fixtures.js";

test("MockOpenAiEndpoint serves GET /models from its configured list", async () => {
  const endpoint = await MockOpenAiEndpoint.start([], { models: ["m1", "m2"] });
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`);
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({
      object: "list",
      data: [{ id: "m1", object: "model" }, { id: "m2", object: "model" }],
    });
  } finally {
    await endpoint.close();
  }
});
```

Run: `pnpm vitest run packages/executors` → PASS. Commit executors change:
```bash
git add packages/executors/src/test-fixtures.ts
git commit -m "Test fixture: MockOpenAiEndpoint answers GET /models"
```

- [ ] **Step 2: Write the end-to-end MCP tests**

Add to `tools.integration.test.ts`. These build **real worker daemons configured with a catalog**. The existing `createDaemon` worker helper builds a real daemon; extend it (or add `createWorkerWithCatalog`) so the worker starts through the real `buildCatalog` → `validateCatalog` → `makeModelResolver` path with a caller-supplied `catalog` config. The daemon uses real `fetch` over loopback to the mock's `GET /models`, so no `fetchImpl` injection is needed. Add two small helpers alongside the existing ones:

```typescript
// Starts a real worker daemon whose config carries `catalog` + an agent
// executor defaulting to the first model. Mirrors createDaemon("worker", ...)
// but routes model config through the real config path.
async function createWorkerWithCatalog(catalog: {
  defaultEndpoint?: { baseUrl: string };
  models: { id: string; label?: string; contextWindow?: number }[];
}): Promise<Daemon> {
  return createDaemon("worker", {
    catalog,
    executors: { agent: { defaultModel: catalog.models[0]?.id } },
  });
}

// Polls job_result until the job reaches a terminal status.
async function runToTerminal(client: Client, jobId: string): Promise<CallToolResult> {
  for (let i = 0; i < 50; i++) {
    const r = await call(client, "job_result", { jobId });
    if (r.isError || r.structuredContent !== undefined) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("job did not terminate");
}
```

Then the three behavior tests:

```typescript
test("list_nodes advertises the worker's catalog with live status", async () => {
  const model = await MockOpenAiEndpoint.start([], { models: ["qwen3.5-9b"] });
  const agent = await createDaemon("agent");
  const worker = await createWorkerWithCatalog({
    defaultEndpoint: { baseUrl: model.baseUrl },
    models: [{ id: "qwen3.5-9b", label: "Qwen 3.5 9B", contextWindow: 32768 }],
  });
  await pairAToB(agent, worker);
  const { client } = await connectAgent(
    agent,
    new Map([[worker.identity.deviceId, endpointOf(worker)]]),
  );

  const res = await call(client, "list_nodes", {});
  const nodes = ListNodesOutputSchema.parse(res.structuredContent).nodes;
  const models = nodes.find((n) => n.deviceId === worker.identity.deviceId)?.models ?? [];
  expect(models).toContainEqual({
    id: "qwen3.5-9b", label: "Qwen 3.5 9B", contextWindow: 32768, status: "ok",
  });
});

test("delegate_task recon uses the requested model", async () => {
  const model = await MockOpenAiEndpoint.start(
    [{ kind: "content", content: "done" }],
    { models: ["qwen3.5-9b"] },
  );
  const agent = await createDaemon("agent");
  const worker = await createWorkerWithCatalog({
    defaultEndpoint: { baseUrl: model.baseUrl },
    models: [{ id: "qwen3.5-9b", contextWindow: 32768 }],
  });
  await pairAToB(agent, worker);
  const { client } = await connectAgent(
    agent,
    new Map([[worker.identity.deviceId, endpointOf(worker)]]),
  );

  const res = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: { type: "recon", workspace: WORKSPACE, prompt: "summarize", model: "qwen3.5-9b" },
  });
  const { jobId } = DelegateTaskOutputSchema.parse(res.structuredContent);
  await runToTerminal(client, jobId);
  expect((model.requests[0]?.body as { model: string }).model).toBe("qwen3.5-9b");
});

test("delegate_task with an un-offered model is a clean MODEL_NOT_OFFERED error", async () => {
  const model = await MockOpenAiEndpoint.start([], { models: ["qwen3.5-9b"] });
  const agent = await createDaemon("agent");
  const worker = await createWorkerWithCatalog({
    defaultEndpoint: { baseUrl: model.baseUrl },
    models: [{ id: "qwen3.5-9b", contextWindow: 32768 }],
  });
  await pairAToB(agent, worker);
  const { client } = await connectAgent(
    agent,
    new Map([[worker.identity.deviceId, endpointOf(worker)]]),
  );

  const res = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: { type: "recon", workspace: WORKSPACE, prompt: "x", model: "ghost" },
  });
  expect(res.isError).toBe(true);
  const text = (res.content[0] as { text: string }).text;
  expect(text).toMatch(/MODEL_NOT_OFFERED|does not offer|model/i);
  expect(text).not.toMatch(/\bat .*client\.ts:|Error:.*\n\s+at /); // no raw stack
});
```

> Harness note: `MODEL_NOT_OFFERED` reaches the agent because the worker's `submit()` throws it → HTTP 400 + `HfpError` → `hfpClient.delegate` rejects → `delegate_task` returns `fail(describeHfpFailure(error))`. Confirm `describeHfpFailure` includes the error's `message`/`code` in its text (it does for `BUSY`); if it drops the code for unknown codes, add `MODEL_NOT_OFFERED`/`NO_MODEL_SPECIFIED` to its mapping so the agent sees an actionable message.

Run: `pnpm vitest run packages/daemon/src/mcp/tools.integration.test.ts` → PASS.

- [ ] **Step 3: Update `docs/reference/configuration.md`**

Replace the `executors.agent.endpoint` / `executors.write.endpoint` / top-level `models` sections with:
- A `catalog` section: `defaultEndpoint` (`{ baseUrl, apiKey? }`), `models[]` (`{ id, label?, contextWindow?, endpoint? }`), the per-entry endpoint override rule, and that ids must be unique.
- `executors.agent.defaultModel` / `executors.write.defaultModel` (a catalog id; single-entry catalog is the implicit default; must reference an existing id).
- The startup-validation statuses (`ok` / `not_served` / `unreachable`) surfaced in `list_nodes`, noting it is a boot-time snapshot and enforcement is on catalog membership not status.
- The `≥ 16384` context-window floor is enforced at dispatch for agent/write use.
- A "Back-compatibility" note: legacy `executors.{agent,write}.endpoint` and top-level `models[]` are auto-upgraded to a catalog at load.

- [ ] **Step 4: Update `README.md`**

- Convert the Quickstart worker config JSON (`~:123-137`) to the catalog shape (`catalog` + `executors.agent.defaultModel`); add a one-line note that the old `endpoint` form still loads.
- Roadmap line (`~:244`): mark **per-node model catalog (A2)** as landed with a link to [the spec](docs/specs/2026-07-21-model-catalog-design.md).
- Capability bullet under "Why" (`~:38`): reword to "nodes advertise a validated model catalog; delegate to a specific model or be cleanly denied."

- [ ] **Step 5: Add a devlog entry**

Create `devlog/2026-07-21-model-catalog.md`: what shipped (catalog, per-entry endpoints, startup `/models` validation, per-model targeting on recon+write, submit-time `MODEL_NOT_OFFERED`), the four spec deviations (from the top of this plan), HFP `0.3.0`, and any rig observations if a smoke run was done.

- [ ] **Step 6: Full verification + commit**

Run: `pnpm build && pnpm typecheck && pnpm test && pnpm lint`
Expected: all PASS. Then use the `verify` skill / a real rig smoke if available (human-gated) and record it in the devlog.

```bash
git add packages/daemon docs README.md devlog
git commit -m "Model catalog: end-to-end tests + operator docs (A2)"
```

---

## Final verification (whole feature)

- [ ] `pnpm build && pnpm typecheck && pnpm test && pnpm lint` all green.
- [ ] A legacy `executors.agent.endpoint` config still boots and delegates (Task 3 regression test + a manual smoke).
- [ ] `list_nodes` shows a catalog with statuses; `delegate_task` honors `task.model` on recon and write; an un-offered model returns `MODEL_NOT_OFFERED`.
- [ ] Spec sections §1–§8 each map to a landed task (see coverage table below).

**Spec coverage:** §1 config → Tasks 2–3 · §2 protocol → Task 1 · §3 validation → Tasks 5–6 · §4 dispatch/enforcement/resolution → Tasks 4, 8 · §5 executor plumbing → Task 7 · §6 MCP surface → Task 9 · §7 testing → per-task + Task 10 · §8 build order → this task sequence.
