# Unpair a Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `homefleet unpair <name|deviceId> [--yes]` revokes a pairing on the running daemon. The peer drops out of `homefleet nodes`, `list_nodes` and the dashboard with no restart.

**Spec:** [`docs/specs/2026-09-25-unpair-node-design.md`](../specs/2026-09-25-unpair-node-design.md) (awaiting review).

**Architecture:** A new `POST /control/unpair {deviceId}` route calls `ControlSurface.unpair`. `daemon.ts` wires that to an exported `unpairPeer()`, which does three things in order:
1. removes the device from the live `TrustStore` (authoritative; ADR-0004's per-request check makes this immediate);
2. fires `JobManager.cancelOwnedBy(deviceId)`, without awaiting the unwind;
3. removes the device's `KnownNodesRegistry` entry, best-effort.

The MCP job tools refuse to route to a device that is no longer paired. The CLI resolves a name, an ID prefix or a full ID against `GET /control/nodes`, and mutates only with `--yes`. Unpair is one-sided, and there is no protocol change.

**Tech Stack:** TypeScript 6, Node ≥20 `node:http`, zod 4, vitest 4, Biome 2.

---

## Ground rules for every task

- **Shared checkout.** Another Claude session may commit to this clone at the same time. Before staging, run `git status --short`, then stage **only the files your task lists**, by explicit path. Never use `git add -A`, `git add -u` or `git commit -a`. An unexpected commit on the branch is probably the other session, not corruption; check `git log` before you react.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run commands from the repo root. Single test file: `pnpm vitest run <path>`. Full gate: `pnpm typecheck && pnpm lint && pnpm test`.
- Match the house style: long "why" doc comments on anything load-bearing, double quotes, 2-space indent. If Biome complains about formatting, run `pnpm format` before committing.
- Commit and push after each task (`git push`) on the branch you are executing on. Never force-push.

## File structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `packages/daemon/src/discovery/known-nodes.ts` | modify | `remove(deviceId)` |
| `packages/daemon/src/discovery/known-nodes.test.ts` | modify | `remove` tests |
| `packages/daemon/src/jobs/job-manager.ts` | modify | `cancelOwnedBy(owner)` |
| `packages/daemon/src/jobs/job-manager.test.ts` | modify | `cancelOwnedBy` tests |
| `packages/daemon/src/control/messages.ts` | modify | `UnpairRequestSchema` |
| `packages/daemon/src/control/control-server.ts` | modify | `UnpairSummary`, `ControlSurface.unpair`, `POST /control/unpair`, shared JSON-body helper, security sign-off text |
| `packages/daemon/src/control/control-server.test.ts` | modify | route tests; fake surface gains `unpair` |
| `packages/daemon/src/daemon.ts` | modify | `unpairPeer()`; `controlSurface.unpair` wiring |
| `packages/daemon/src/daemon.unpair.test.ts` | create | `unpairPeer` unit tests (fakes) |
| `packages/daemon/src/mcp/tools.ts` | modify | "no longer paired" guard on `job_status` / `job_result` / `cancel_job` |
| `packages/daemon/src/mcp/tools.integration.test.ts` | modify | guard test |
| `packages/daemon/src/cli/control-client.ts` | modify | `unpair()`, `ControlClientLike.unpair`, response validation |
| `packages/daemon/src/cli/control-client.test.ts` | modify | `unpair` round-trip; fake surface gains `unpair` |
| `packages/daemon/src/cli/unpair-target.ts` | create | pure `resolveUnpairTarget` |
| `packages/daemon/src/cli/unpair-target.test.ts` | create | resolution tests |
| `packages/daemon/src/cli/cli.ts` | modify | `homefleet unpair` command and usage |
| `packages/daemon/src/cli/cli.test.ts` | modify | CLI tests; fake client gains `unpair` |
| `packages/daemon/src/daemon.control.integration.test.ts` | modify | end-to-end unpair across two real daemons |
| `docs/adr/0004-syncthing-style-trust-model.md`, `README.md`, `docs/backlog.md`, `devlog/2026-09-2x-unpair-node.md` | modify/create | docs |

---

### Task 1: `KnownNodesRegistry.remove`

**Files:**
- Modify: `packages/daemon/src/discovery/known-nodes.ts`
- Test: `packages/daemon/src/discovery/known-nodes.test.ts`

- [ ] **Step 1: Write the failing tests.** Append them to `packages/daemon/src/discovery/known-nodes.test.ts`, which already has the `newDataDir()` and `entry(seed)` helpers:

```ts
test("remove drops the entry and persists the removal", async () => {
  const dir = await newDataDir();
  const registry = await KnownNodesRegistry.load(dir);
  await registry.record(entry("a"));
  await registry.record(entry("b"));

  expect(await registry.remove(entry("a").deviceId)).toBe(true);
  expect(registry.list().map((n) => n.deviceId)).toEqual([
    entry("b").deviceId,
  ]);

  const reloaded = await KnownNodesRegistry.load(dir);
  expect(reloaded.list().map((n) => n.deviceId)).toEqual([
    entry("b").deviceId,
  ]);
});

test("remove of an unknown deviceId returns false and writes nothing", async () => {
  const registry = await KnownNodesRegistry.load(await newDataDir());
  await registry.record(entry("a"));
  const writesBefore = registry.writeCount;

  expect(await registry.remove(entry("c").deviceId)).toBe(false);
  expect(registry.writeCount).toBe(writesBefore);
  expect(registry.list()).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/discovery/known-nodes.test.ts`
Expected: the 2 new tests FAIL with `registry.remove is not a function`.

- [ ] **Step 3: Implement.** In `packages/daemon/src/discovery/known-nodes.ts`, add this method directly after `record()`:

```ts
  /**
   * Forgets a node (unpair's clean-up step) and persists. Returns whether it
   * was present; an unknown id writes nothing. Mirrors `TrustStore.remove`.
   * Note that live discovery may re-record a node that is still announcing —
   * harmless, since knowing a node is not trusting it (see the file doc).
   */
  async remove(deviceId: string): Promise<boolean> {
    const removed = this.entries.delete(deviceId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/discovery/known-nodes.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/discovery/known-nodes.ts packages/daemon/src/discovery/known-nodes.test.ts
git commit -m "Known nodes: remove(deviceId) for unpair" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 2: `JobManager.cancelOwnedBy`

**Files:**
- Modify: `packages/daemon/src/jobs/job-manager.ts`
- Test: `packages/daemon/src/jobs/job-manager.test.ts`

- [ ] **Step 1: Write the failing tests.** Append them to `packages/daemon/src/jobs/job-manager.test.ts`. They use the file's existing `OWNER`, `OTHER_OWNER`, `commandParams()`, `makeManager()`, `waitUntil()`, `SucceedingExecutor`, `AbortAwareExecutor` and `StuckExecutor`.

```ts
test("cancelOwnedBy cancels the owner's queued and running jobs and leaves other owners alone", async () => {
  const manager = makeManager({
    executors: [new AbortAwareExecutor()],
    maxConcurrentJobs: 1,
  });
  const running = manager.submit(commandParams(), OWNER).jobId;
  await waitUntil(
    () => manager.snapshot(running, OWNER).status === "running",
  );
  const queued = manager.submit(commandParams(), OWNER).jobId;
  const other = manager.submit(commandParams(), OTHER_OWNER).jobId;

  expect(manager.cancelOwnedBy(OWNER)).toBe(2);

  // Queued jobs finish synchronously; running ones as soon as they unwind.
  expect(manager.snapshot(queued, OWNER).status).toBe("canceled");
  await waitUntil(
    () => manager.snapshot(running, OWNER).status === "canceled",
  );
  // The other owner's job takes the freed slot and is untouched by cancel.
  expect(manager.snapshot(other, OTHER_OWNER).status).not.toBe("canceled");
});

test("cancelOwnedBy skips terminal jobs and returns 0 for an owner with none active", async () => {
  const manager = makeManager({ executors: [new SucceedingExecutor()] });
  const done = manager.submit(commandParams(), OWNER).jobId;
  await waitUntil(
    () => manager.snapshot(done, OWNER).status === "succeeded",
  );

  expect(manager.cancelOwnedBy(OWNER)).toBe(0);
  expect(manager.cancelOwnedBy("never-submitted")).toBe(0);
  expect(manager.snapshot(done, OWNER).status).toBe("succeeded");
});

test("cancelOwnedBy returns promptly even when an executor ignores its abort", async () => {
  const manager = makeManager({
    executors: [new StuckExecutor()],
    cancelUnwindTimeoutMs: 50,
  });
  const stuck = manager.submit(commandParams(), OWNER).jobId;
  await waitUntil(() => manager.snapshot(stuck, OWNER).status === "running");

  const startedAt = Date.now();
  expect(manager.cancelOwnedBy(OWNER)).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(25);
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/jobs/job-manager.test.ts`
Expected: the 3 new tests FAIL with `manager.cancelOwnedBy is not a function`.

- [ ] **Step 3: Implement.** In `packages/daemon/src/jobs/job-manager.ts`, add this method directly after `cancel()`:

```ts
  /**
   * Requests cancellation of every queued or running job `owner` submitted —
   * unpair's "cut the peer's work off" step. Returns how many jobs it asked
   * to cancel.
   *
   * Deliberately does NOT await the unwinds: a queued job finishes
   * synchronously inside `cancel()` (no await on that path), and a running
   * job's abort fires synchronously; the unwind itself is already bounded by
   * `cancelUnwindTimeoutMs`. Unpair must answer promptly even when an
   * executor is stuck. Each `cancel()` promise gets a no-op catch: iterating
   * the records we own cannot hit UNKNOWN_JOB, but the promise must never
   * go unhandled.
   *
   * Like {@link list}, this is for the loopback control API only.
   */
  cancelOwnedBy(owner: string): number {
    let requested = 0;
    for (const record of [...this.records.values()]) {
      if (record.owner !== owner || isTerminalJobStatus(record.status)) {
        continue;
      }
      requested += 1;
      void this.cancel(record.jobId, owner).catch(() => {});
    }
    return requested;
  }
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/jobs/job-manager.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/jobs/job-manager.ts packages/daemon/src/jobs/job-manager.test.ts
git commit -m "JobManager: cancelOwnedBy(owner) for unpair" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 3: `POST /control/unpair`, `unpairPeer()`, and daemon wiring

This is one task because adding `unpair` to `ControlSurface` breaks `tsc` until both the daemon and the two test fakes implement it.

**Files:**
- Modify: `packages/daemon/src/control/messages.ts`, `packages/daemon/src/control/control-server.ts`, `packages/daemon/src/daemon.ts`
- Modify (fakes): `packages/daemon/src/control/control-server.test.ts`, `packages/daemon/src/cli/control-client.test.ts`
- Create: `packages/daemon/src/daemon.unpair.test.ts`

- [ ] **Step 1: Write the failing `unpairPeer` unit tests** in the new file `packages/daemon/src/daemon.unpair.test.ts`:

```ts
/**
 * `unpairPeer` (the control API's unpair step list) against minimal fakes:
 * step order, not-paired, and the two failure postures (trust persist
 * failure -> revoked in memory + status 500; known-nodes failure swallowed).
 * The HTTP route is covered in control-server.test.ts; the assembled
 * behavior in daemon.control.integration.test.ts.
 */
import { expect, test } from "vitest";
import { unpairPeer } from "./daemon.js";

const PEER = "b".repeat(64);

function fakes(options: { removeThrows?: boolean; forgetThrows?: boolean } = {}) {
  const calls: string[] = [];
  const devices = [
    { deviceId: PEER, name: "peer", addedAt: "2026-09-25T00:00:00.000Z" },
  ];
  return {
    calls,
    trustStore: {
      list: () => devices.map((d) => ({ ...d })),
      remove: async (id: string) => {
        calls.push(`trust.remove:${id}`);
        if (options.removeThrows) {
          throw new Error("EPERM: disk says no");
        }
        return true;
      },
    },
    jobManager: {
      cancelOwnedBy: (id: string) => {
        calls.push(`jobs.cancelOwnedBy:${id}`);
        return 2;
      },
    },
    knownNodes: {
      remove: async (id: string) => {
        calls.push(`known.remove:${id}`);
        if (options.forgetThrows) {
          throw new Error("known-nodes write failed");
        }
        return true;
      },
    },
  };
}

test("revokes trust first, then cancels owned jobs, then forgets the node", async () => {
  const f = fakes();
  const summary = await unpairPeer({ ...f, deviceId: PEER });
  expect(summary).toEqual({ deviceId: PEER, name: "peer", canceledJobs: 2 });
  expect(f.calls).toEqual([
    `trust.remove:${PEER}`,
    `jobs.cancelOwnedBy:${PEER}`,
    `known.remove:${PEER}`,
  ]);
});

test("a device that is not paired resolves undefined and touches nothing", async () => {
  const f = fakes();
  expect(await unpairPeer({ ...f, deviceId: "c".repeat(64) })).toBeUndefined();
  expect(f.calls).toEqual([]);
});

test("a trust persist failure still cuts the peer off, then throws status 500", async () => {
  const f = fakes({ removeThrows: true });
  const failure = await unpairPeer({ ...f, deviceId: PEER }).catch((e) => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { status?: number }).status).toBe(500);
  expect((failure as Error).message).toMatch(/not saved/);
  expect((failure as Error).message).toMatch(/restart/);
  expect(f.calls).toEqual([
    `trust.remove:${PEER}`,
    `jobs.cancelOwnedBy:${PEER}`,
    `known.remove:${PEER}`,
  ]);
});

test("a known-nodes failure does not fail the unpair", async () => {
  const f = fakes({ forgetThrows: true });
  const summary = await unpairPeer({ ...f, deviceId: PEER });
  expect(summary?.canceledJobs).toBe(2);
});
```

- [ ] **Step 2: Write the failing route tests.** In `packages/daemon/src/control/control-server.test.ts`:

  1. Add `type UnpairSummary` to the import from `./control-server.js`.
  2. In `fakeSurface`, add this entry before `...overrides`:

```ts
    unpair: async (deviceId: string): Promise<UnpairSummary | undefined> =>
      deviceId === FAKE_PEER_DEVICE_ID
        ? { deviceId, name: "peer-node", canceledJobs: 0 }
        : undefined,
```

  3. Append these tests:

```ts
test("POST /control/unpair returns the summary for a paired device", async () => {
  let received: string | undefined;
  const server = await start({
    surface: fakeSurface({
      unpair: async (deviceId) => {
        received = deviceId;
        return { deviceId, name: "peer-node", canceledJobs: 3 };
      },
    }),
  });
  const res = await postJson(server.port, "/control/unpair", {
    deviceId: FAKE_PEER_DEVICE_ID,
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer-node",
    canceledJobs: 3,
  });
  expect(received).toBe(FAKE_PEER_DEVICE_ID);
});

test("POST /control/unpair for a device that is not paired is 404", async () => {
  const server = await start();
  const res = await postJson(server.port, "/control/unpair", {
    deviceId: "c".repeat(64),
  });
  expect(res.status).toBe(404);
  expect(res.json).toEqual({
    error: `no paired node with deviceId ${"c".repeat(64)}`,
  });
});

test.each([
  ["a short deviceId", { deviceId: "abcd1234" }],
  ["an uppercase deviceId", { deviceId: "B".repeat(64) }],
  ["a missing deviceId", {}],
])("POST /control/unpair rejects %s with 400", async (_label, body) => {
  let called = false;
  const server = await start({
    surface: fakeSurface({
      unpair: async () => {
        called = true;
        return undefined;
      },
    }),
  });
  const res = await postJson(server.port, "/control/unpair", body);
  expect(res.status).toBe(400);
  expect((res.json as { error: string }).error).toMatch(
    /^invalid unpair request: deviceId/,
  );
  expect(called).toBe(false);
});

test("POST /control/unpair passes a thrown .status through, never a stack", async () => {
  const server = await start({
    surface: fakeSurface({
      unpair: async () => {
        throw Object.assign(new Error("removal not saved"), { status: 500 });
      },
    }),
  });
  const res = await postJson(server.port, "/control/unpair", {
    deviceId: FAKE_PEER_DEVICE_ID,
  });
  expect(res.status).toBe(500);
  expect(res.json).toEqual({ error: "removal not saved" });
});

test("POST /control/unpair requires the control header", async () => {
  const server = await start();
  const res = await postJson(
    server.port,
    "/control/unpair",
    { deviceId: FAKE_PEER_DEVICE_ID },
    { [CONTROL_HEADER]: "" },
  );
  expect(res.status).toBe(403);
});

test("GET /control/unpair is not a route (404)", async () => {
  const server = await start();
  const res = await send(server.port, { method: "GET", path: "/control/unpair" });
  expect(res.status).toBe(404);
});
```

> Note: `send` and `postJson` set the control header by default, which is why the 403 test passes an empty value. If Biome's formatter rewraps any line, that is fine.

  4. In `packages/daemon/src/cli/control-client.test.ts`, the fake surface must also satisfy the widened interface. Add `type UnpairSummary` to its `../control/control-server.js` import, and add the same `unpair` entry to its `fakeSurface` before `...overrides`:

```ts
    unpair: async (deviceId: string): Promise<UnpairSummary | undefined> =>
      deviceId === FAKE_PEER_DEVICE_ID
        ? { deviceId, name: "peer-node", canceledJobs: 0 }
        : undefined,
```

- [ ] **Step 3: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/daemon.unpair.test.ts packages/daemon/src/control/control-server.test.ts`
Expected: FAIL. `unpairPeer` is not exported, and `/control/unpair` returns 404.

- [ ] **Step 4: Add the request schema.** Append to `packages/daemon/src/control/messages.ts`, and add `import { DeviceIdSchema } from "@homefleet/protocol";` above the existing zod import:

```ts
/**
 * Body of `POST /control/unpair`: the FULL device ID to revoke (64 lowercase
 * hex, the protocol's own DeviceIdSchema). Deliberately no name or prefix
 * matching here — resolving a human-typed name is the CLI's job
 * (../cli/unpair-target.ts); the route stays unambiguous so a future
 * dashboard control can reuse it as-is.
 */
export const UnpairRequestSchema = z.object({
  deviceId: DeviceIdSchema,
});
export type UnpairRequest = z.infer<typeof UnpairRequestSchema>;
```

- [ ] **Step 5: Extend the control server.** In `packages/daemon/src/control/control-server.ts`:

  **5a.** Import the schema:

```ts
import {
  type PairConnectRequest,
  PairConnectRequestSchema,
  UnpairRequestSchema,
} from "./messages.js";
```

  **5b.** Add the summary type after `PairConnectSummary`:

```ts
/** The outcome of `POST /control/unpair`. */
export interface UnpairSummary {
  deviceId: string;
  /** The name the device was paired under (read before removal). */
  name: string;
  /** How many of its queued/running jobs on THIS node cancellation was requested for. */
  canceledJobs: number;
}
```

  **5c.** Add this to `ControlSurface`, after `listJobs()`:

```ts
  /**
   * Revokes a pairing on the LIVE daemon: removes `deviceId` from the trust
   * store (authoritative — every later HFP request from it gets 401), cancels
   * its queued/running jobs here, and forgets its known-nodes entry.
   * Resolves `undefined` when the device is not paired (the route's 404).
   * A thrown error carrying `.status` (e.g. 500 when the trust-store write
   * failed) passes through; see `unpairPeer` in ../daemon.js. One-sided: the
   * peer is not told (ADR-0004 addendum).
   */
  unpair(deviceId: string): Promise<UnpairSummary | undefined>;
```

  **5d.** Rename `pairingErrorStatus` to a general helper with a fallback. Replace the whole function, including its doc comment, with:

```ts
/**
 * Maps a thrown surface error to an HTTP status. Errors that carry a numeric
 * `.status` in the 4xx/5xx range (e.g. `HfpRequestError`, or unpair's
 * trust-persist failure) pass it through; anything else becomes `fallback`
 * — 502 for pairing (the honest "the peer/attempt failed, not this server"
 * code), 500 for unpair (a purely local operation).
 */
function errorStatus(error: unknown, fallback: number): number {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return fallback;
}
```

  Then update its one call site in `handlePairConnect` to `respondError(res, errorStatus(error, 502), errorMessage(error));`.

  **5e.** Share the body plumbing. Add these two helpers directly after `readCappedBody`:

```ts
/**
 * Reads, caps, and JSON-parses a control request body. On failure it has
 * ALREADY responded (413 / 400) and returns `{ ok: false }`; an empty body
 * parses as `{}` so schema validation produces the error message.
 */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const read = await readCappedBody(req);
  if (read.status === "too_large") {
    respondError(
      res,
      413,
      `request body exceeds the ${MAX_CONTROL_REQUEST_BYTES}-byte limit`,
    );
    return { ok: false };
  }
  if (read.status === "read_error") {
    respondError(res, 400, "failed to read request body");
    return { ok: false };
  }
  try {
    return {
      ok: true,
      value: read.text.trim() === "" ? {} : JSON.parse(read.text),
    };
  } catch {
    respondError(res, 400, "invalid JSON body");
    return { ok: false };
  }
}

/**
 * A short, one-line summary of schema issues, instead of zod's
 * multi-line pretty-printed `.message` (meant for a developer console, not
 * a CLI user's terminal).
 */
function describeIssues(issues: ReadonlyArray<{
  path: ReadonlyArray<PropertyKey>;
  message: string;
}>): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
}
```

  Rewrite the start of `handlePairConnect` to use them. Everything from `const read = await readCappedBody(req);` through the `respondError(res, 400, \`invalid pair/connect request: ${issues}\`); return; }` block becomes:

```ts
    const body = await readJsonBody(req, res);
    if (!body.ok) {
      return;
    }
    const parsed = PairConnectRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      // cli.ts's parsePairConnectArgs rejects an empty host client-side, so
      // this path is normally unreachable from the CLI — but a future
      // caller of this route should still get a clean message.
      respondError(
        res,
        400,
        `invalid pair/connect request: ${describeIssues(parsed.error.issues)}`,
      );
      return;
    }
```

  The rest of the handler (`const input: PairConnectRequest = parsed.data;` onward) is unchanged.

  **5f.** Add the handler after `handleJobs`:

```ts
  async function handleUnpair(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(req, res);
    if (!body.ok) {
      return;
    }
    const parsed = UnpairRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      respondError(
        res,
        400,
        `invalid unpair request: ${describeIssues(parsed.error.issues)}`,
      );
      return;
    }
    const { deviceId } = parsed.data;
    let summary: UnpairSummary | undefined;
    try {
      summary = await surface.unpair(deviceId);
    } catch (error) {
      respondError(res, errorStatus(error, 500), errorMessage(error));
      return;
    }
    if (summary === undefined) {
      respondError(res, 404, `no paired node with deviceId ${deviceId}`);
      return;
    }
    respondJson(res, 200, summary);
  }
```

  **5g.** Route it. In `handle()`, after the `/control/pair/connect` branch:

```ts
      if (method === "POST" && pathname === "/control/unpair") {
        await handleUnpair(req, res);
        return;
      }
```

  **5h.** Update the module header comment. In the opening paragraph, change "drive pairing, list nodes" to "drive pairing and unpairing, list nodes". In the "Security model" bullet's lead-in, after "`pair/connect` can add a trusted device to the live trust store", add ", and `unpair` removes one". Append this paragraph at the end of the "EXPLICIT SIGN-OFF" section, before the closing `*/`:

```
 *
 * `unpair` (the inverse trust-store write) is covered by the same sign-off:
 * a same-OS-user co-resident process can call it just as it can call
 * `pair/connect`. The worst it can do is REVOKE trust (a local denial of
 * service), which is strictly less than `pair/connect`'s ADD. The same
 * per-boot-token upgrade path applies to both.
```

- [ ] **Step 6: Implement `unpairPeer` and wire it.** In `packages/daemon/src/daemon.ts`:

  **6a.** Add `type UnpairSummary` to the `./control/control-server.js` import.

  **6b.** Add this function directly after `pairWithPeer`:

```ts
/**
 * The control API's unpair (`POST /control/unpair`): revokes a pairing on
 * the LIVE daemon. Order is load-bearing (spec 2026-09-25, ADR-0004
 * addendum):
 *
 * 1. `trustStore.remove` — authoritative. NodeServer re-checks the trust
 *    store on EVERY request, so from here on every HFP request from the
 *    device gets 401, including over already-open keep-alive sockets.
 *    Requests already past that check (an in-flight upload/download/submit)
 *    complete — the spec's accepted bound.
 * 2. `jobManager.cancelOwnedBy` — its queued/running jobs here can never be
 *    fetched again, so they only burn slots; cancelling also ends their SSE
 *    streams. Fire-and-forget (see cancelOwnedBy).
 * 3. `knownNodes.remove` — a discovery hint, not trust: best-effort and
 *    swallowed, exactly like the seeding in {@link pairWithPeer}.
 *
 * Not paired -> `undefined` (the route's 404), touching nothing. The name is
 * read BEFORE removal so the summary can still report it.
 *
 * A trust-store PERSIST failure leaves the device already deleted in memory
 * (TrustStore.remove deletes, then persists): revoked for this run, but back
 * after a restart. Steps 2–3 still run — fail closed, the device is cut off
 * either way — and then a `.status = 500` error says so, so the operator
 * knows to fix the data dir and unpair again after restarting.
 *
 * Narrowed via `Pick` so tests pass minimal fakes (daemon.unpair.test.ts).
 */
export async function unpairPeer(options: {
  trustStore: Pick<TrustStore, "list" | "remove">;
  jobManager: Pick<JobManager, "cancelOwnedBy">;
  knownNodes: Pick<KnownNodesRegistry, "remove">;
  deviceId: string;
}): Promise<UnpairSummary | undefined> {
  const { trustStore, jobManager, knownNodes, deviceId } = options;
  const device = trustStore.list().find((d) => d.deviceId === deviceId);
  if (device === undefined) {
    return undefined;
  }
  let persistFailure: unknown;
  try {
    await trustStore.remove(deviceId);
  } catch (cause) {
    persistFailure = cause;
  }
  const canceledJobs = jobManager.cancelOwnedBy(deviceId);
  try {
    await knownNodes.remove(deviceId);
  } catch {
    // Swallowed deliberately — see step 3 above.
  }
  if (persistFailure !== undefined) {
    const message =
      persistFailure instanceof Error ? persistFailure.message : "unknown error";
    throw Object.assign(
      new Error(
        `${device.name} is revoked on the running daemon, but the removal was ` +
          "not saved to trusted-devices.json, so it will be trusted again " +
          "after a restart. Fix the data directory, restart homefleetd, and " +
          `run unpair again: ${message}`,
        { cause: persistFailure },
      ),
      { status: 500 },
    );
  }
  return { deviceId, name: device.name, canceledJobs };
}
```

  **6c.** In `startComponents`, add this entry to `controlSurface`, after `listJobs`:

```ts
      unpair: (deviceId) =>
        unpairPeer({ trustStore, jobManager, knownNodes, deviceId }),
```

- [ ] **Step 7: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/daemon.unpair.test.ts packages/daemon/src/control/control-server.test.ts packages/daemon/src/cli/control-client.test.ts`
Expected: all PASS. That includes the existing pair/connect tests, which prove the `readJsonBody` refactor kept their 400/413 behavior.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit.**

```bash
git status --short
git add packages/daemon/src/control/messages.ts packages/daemon/src/control/control-server.ts packages/daemon/src/control/control-server.test.ts packages/daemon/src/cli/control-client.test.ts packages/daemon/src/daemon.ts packages/daemon/src/daemon.unpair.test.ts
git commit -m "Control API: POST /control/unpair (trust, owned jobs, known-nodes)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 4: MCP job tools refuse to route to an unpaired node

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts`
- Test: `packages/daemon/src/mcp/tools.integration.test.ts`

- [ ] **Step 1: Write the failing test.** Append it to `packages/daemon/src/mcp/tools.integration.test.ts`. It uses the file's existing `createDaemon`, `pairAToB`, `connectAgent`, `endpointOf`, `nodeAllowlist`, `call`, `WORKSPACE` and `DelegateTaskOutputSchema`.

```ts
test("job_status / job_result / cancel_job refuse a job whose node is no longer paired, without any HFP call", async () => {
  const agent = await createDaemon("agent");
  const worker = await createDaemon("worker", { executors: [nodeAllowlist()] });
  await pairAToB(agent, worker);
  const endpoints = new Map([[worker.identity.deviceId, endpointOf(worker)]]);
  let followUpCalls = 0;
  const countingClient: DelegationClient = {
    delegate: (target, params) => agent.client.delegate(target, params),
    jobSnapshot: (target, jobId) => {
      followUpCalls += 1;
      return agent.client.jobSnapshot(target, jobId);
    },
    cancelJob: (target, jobId) => {
      followUpCalls += 1;
      return agent.client.cancelJob(target, jobId);
    },
  };
  const { client } = await connectAgent(agent, endpoints, {
    hfpClient: countingClient,
  });

  const delegated = await call(client, "delegate_task", {
    node: worker.identity.deviceId,
    task: {
      type: "command",
      workspace: WORKSPACE,
      command: "node",
      args: ["-e", "setTimeout(()=>{},30000)"],
    },
  });
  const { jobId } = DelegateTaskOutputSchema.parse(delegated.structuredContent);

  // The agent unpairs the worker (the trust store is what the directory reads).
  await agent.trustStore.remove(worker.identity.deviceId);
  followUpCalls = 0;

  for (const name of ["job_status", "job_result", "cancel_job"]) {
    const result = await call(client, name, { jobId });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /no longer paired/,
    );
  }
  expect(followUpCalls).toBe(0);
}, 20_000);
```

- [ ] **Step 2: Run the test and watch it fail.**

Run: `pnpm vitest run packages/daemon/src/mcp/tools.integration.test.ts -t "no longer paired"`
Expected: FAIL. The tools still call the worker, and `followUpCalls` is greater than 0.

- [ ] **Step 3: Implement.** In `packages/daemon/src/mcp/tools.ts`, add this helper after `unknownJob`:

```ts
/**
 * The delegation-registry entry still exists (kept as dashboard history),
 * but its node was unpaired since: fail closed WITHOUT contacting it. The
 * unpaired node may still trust us (unpair is one-sided), so without this
 * guard the tools would keep talking to a node the operator revoked.
 */
function noLongerPaired(jobId: string, deviceId: string): CallToolResult {
  return fail(
    `Job ${jobId} was delegated to node ${deviceId.slice(0, 12)}…, which is ` +
      "no longer paired with this node, so it cannot be queried or " +
      "canceled from here. Pair with it again to reach it.",
  );
}
```

In each of the `job_status`, `job_result` and `cancel_job` handlers, insert this block directly after the existing `if (route === undefined) { return unknownJob(jobId); }` block:

```ts
      if (nodeDirectory.resolve(route.deviceId) === undefined) {
        return noLongerPaired(jobId, route.deviceId);
      }
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/mcp/tools.integration.test.ts`
Expected: all PASS, the existing tool tests included.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/tools.integration.test.ts
git commit -m "MCP tools: refuse job follow-ups to a node that is no longer paired" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 5: `ControlClient.unpair`

**Files:**
- Modify: `packages/daemon/src/cli/control-client.ts`, `packages/daemon/src/cli/cli.test.ts` (fake client)
- Test: `packages/daemon/src/cli/control-client.test.ts`

- [ ] **Step 1: Write the failing tests.** Append them to `packages/daemon/src/cli/control-client.test.ts`. The fake surface already gained `unpair` in Task 3.

```ts
test("unpair() posts the deviceId and round-trips the summary", async () => {
  let received: string | undefined;
  const server = await start({
    surface: fakeSurface({
      unpair: async (deviceId) => {
        received = deviceId;
        return { deviceId, name: "peer-node", canceledJobs: 1 };
      },
    }),
  });
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const summary = await client.unpair(FAKE_PEER_DEVICE_ID);
  expect(summary).toEqual({
    deviceId: FAKE_PEER_DEVICE_ID,
    name: "peer-node",
    canceledJobs: 1,
  });
  expect(received).toBe(FAKE_PEER_DEVICE_ID);
});

test("unpair() of a device that is not paired throws ControlRequestError 404", async () => {
  const server = await start();
  const client = new ControlClient({ host: "127.0.0.1", port: server.port });
  const failure = await client.unpair("c".repeat(64)).catch((e) => e);
  expect(failure).toBeInstanceOf(ControlRequestError);
  expect((failure as ControlRequestError).status).toBe(404);
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/cli/control-client.test.ts`
Expected: FAIL with `client.unpair is not a function`.

- [ ] **Step 3: Implement.** In `packages/daemon/src/cli/control-client.ts`:

  Add `type UnpairSummary` to the `../control/control-server.js` import.

  Add this to `ControlClientLike`:

```ts
  unpair(deviceId: string): Promise<UnpairSummary>;
```

  Add this validator after `validateNodesResponse`:

```ts
function validateUnpairSummary(json: unknown): UnpairSummary {
  assertIsObject(json, "unpair");
  assertString(json.deviceId, "deviceId", "unpair");
  assertString(json.name, "name", "unpair");
  assertNumber(json.canceledJobs, "canceledJobs", "unpair");
  return {
    deviceId: json.deviceId,
    name: json.name,
    canceledJobs: json.canceledJobs,
  };
}
```

  Add this method to `ControlClient`, after `nodes()`:

```ts
  async unpair(deviceId: string): Promise<UnpairSummary> {
    const json = await controlRequest(
      this.options,
      "POST",
      "/control/unpair",
      { deviceId },
    );
    return validateUnpairSummary(json);
  }
```

  In `packages/daemon/src/cli/cli.test.ts`, add this to `fakeControlClient` before `...overrides`, so the fake still satisfies the widened interface:

```ts
    unpair: async (deviceId: string) => ({
      deviceId,
      name: "peer-node",
      canceledJobs: 0,
    }),
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/cli/control-client.test.ts packages/daemon/src/cli/cli.test.ts && pnpm typecheck`
Expected: all PASS; no type errors.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/cli/control-client.ts packages/daemon/src/cli/control-client.test.ts packages/daemon/src/cli/cli.test.ts
git commit -m "Control client: unpair(deviceId)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 6: `resolveUnpairTarget` (pure)

**Files:**
- Create: `packages/daemon/src/cli/unpair-target.ts`
- Test: `packages/daemon/src/cli/unpair-target.test.ts`

- [ ] **Step 1: Write the failing tests** in `packages/daemon/src/cli/unpair-target.test.ts`:

```ts
import { expect, test } from "vitest";
import { resolveUnpairTarget } from "./unpair-target.js";

const TOWER = { deviceId: `263d9c76${"1".repeat(56)}`, name: "tower" };
const LAPTOP = { deviceId: `6842f1f3${"2".repeat(56)}`, name: "laptop" };
const STALE = { deviceId: `6842f1f4${"3".repeat(56)}`, name: "laptop" };
const NODES = [TOWER, LAPTOP, STALE];

test("a full deviceId matches", () => {
  expect(resolveUnpairTarget(TOWER.deviceId, NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("a unique 8-char prefix matches, case-insensitively", () => {
  expect(resolveUnpairTarget("263D9C76", NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("an 8-char prefix shared by two nodes is ambiguous", () => {
  const twinA = { deviceId: `abcdef01${"4".repeat(56)}`, name: "twin-a" };
  const twinB = { deviceId: `abcdef01${"5".repeat(56)}`, name: "twin-b" };
  expect(resolveUnpairTarget("abcdef01", [twinA, twinB])).toEqual({
    kind: "ambiguous",
    candidates: [twinA, twinB],
  });
  // A longer prefix disambiguates.
  expect(resolveUnpairTarget("abcdef014", [twinA, twinB])).toEqual({
    kind: "match",
    node: twinA,
  });
});

test("fewer than 8 hex chars is not an id query (only a name match)", () => {
  // LAPTOP and STALE share the 7-char prefix "6842f1f"; it is not treated
  // as an id prefix, and no node is named that.
  expect(resolveUnpairTarget("6842f1f", NODES)).toEqual({ kind: "none" });
  // One more char picks exactly one of them.
  expect(resolveUnpairTarget("6842f1f4", NODES)).toEqual({
    kind: "match",
    node: STALE,
  });
});

test("an exact name matches", () => {
  expect(resolveUnpairTarget("tower", NODES)).toEqual({
    kind: "match",
    node: TOWER,
  });
});

test("names are case-sensitive", () => {
  expect(resolveUnpairTarget("Tower", NODES)).toEqual({ kind: "none" });
});

test("a duplicated name is ambiguous and lists every candidate", () => {
  expect(resolveUnpairTarget("laptop", NODES)).toEqual({
    kind: "ambiguous",
    candidates: [LAPTOP, STALE],
  });
});

test("an id prefix hit on one node and a name hit on another is ambiguous", () => {
  const hexNamed = { deviceId: "f".repeat(64), name: "263d9c76" };
  expect(resolveUnpairTarget("263d9c76", [TOWER, hexNamed])).toEqual({
    kind: "ambiguous",
    candidates: [TOWER, hexNamed],
  });
});

test("the same node hit by both id and name is one match", () => {
  const self = { deviceId: `abcdef12${"0".repeat(56)}`, name: "abcdef12" };
  expect(resolveUnpairTarget("abcdef12", [self])).toEqual({
    kind: "match",
    node: self,
  });
});

test("nothing matching is none", () => {
  expect(resolveUnpairTarget("desktop", NODES)).toEqual({ kind: "none" });
  expect(resolveUnpairTarget("tower", [])).toEqual({ kind: "none" });
});

test("extra fields on directory entries are not carried into the result", () => {
  const entry = { ...TOWER, reachable: true, host: "192.168.68.73" };
  expect(resolveUnpairTarget("tower", [entry])).toEqual({
    kind: "match",
    node: TOWER,
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/cli/unpair-target.test.ts`
Expected: FAIL. The module is not found.

- [ ] **Step 3: Implement** `packages/daemon/src/cli/unpair-target.ts`:

```ts
/**
 * Resolves what an operator typed after `homefleet unpair` to exactly one
 * paired node (spec 2026-09-25). The argument matches a node when it is:
 *
 * - a hex string of 8–64 chars that PREFIXES the node's device ID
 *   (case-insensitive — people copy the dashboard's / `nodes`' short ids),
 * - or EXACTLY the node's name (case-sensitive).
 *
 * Every hit counts; hits are de-duplicated by device ID. Duplicate names are
 * the realistic ambiguity (the trust store is keyed by device ID, so a
 * re-installed machine can leave a stale same-named entry), and an id-prefix
 * hit on one node plus a name hit on another is ambiguous too — never guess
 * which one a revocation meant.
 *
 * Input is the `/control/nodes` listing, which holds ONLY paired devices, so
 * this can never select an unpaired one. Pure: no I/O.
 */
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";

export type UnpairTarget = Pick<NodeDirectoryEntry, "deviceId" | "name">;

export type UnpairResolution =
  | { kind: "match"; node: UnpairTarget }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: UnpairTarget[] };

/** At least 8 hex chars: the shortest id prefix we accept as an id query. */
const DEVICE_ID_QUERY = /^[0-9a-f]{8,64}$/i;

export function resolveUnpairTarget(
  arg: string,
  nodes: readonly UnpairTarget[],
): UnpairResolution {
  const idQuery = DEVICE_ID_QUERY.test(arg) ? arg.toLowerCase() : undefined;
  const hits = new Map<string, UnpairTarget>();
  for (const node of nodes) {
    const idHit =
      idQuery !== undefined && node.deviceId.toLowerCase().startsWith(idQuery);
    if (idHit || node.name === arg) {
      hits.set(node.deviceId, { deviceId: node.deviceId, name: node.name });
    }
  }
  const candidates = [...hits.values()];
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length === 1) {
    return { kind: "match", node: candidates[0] as UnpairTarget };
  }
  return { kind: "ambiguous", candidates };
}
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/cli/unpair-target.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/cli/unpair-target.ts packages/daemon/src/cli/unpair-target.test.ts
git commit -m "CLI: resolveUnpairTarget (name, id prefix, full id)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 7: `homefleet unpair` command

**Files:**
- Modify: `packages/daemon/src/cli/cli.ts`
- Test: `packages/daemon/src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing tests.** Append a `describe` block to `packages/daemon/src/cli/cli.test.ts`. It uses the file's existing `makeHarness`, `fakeControlClient`, `FAKE_PEER_DEVICE_ID`, `ControlRequestError` and `DaemonUnreachableError`.

```ts
describe("unpair", () => {
  const PEER = { deviceId: FAKE_PEER_DEVICE_ID, name: "peer-node", reachable: true };
  const STALE = { deviceId: "c".repeat(64), name: "peer-node", reachable: false };

  function clientWith(
    nodes: Array<{ deviceId: string; name: string; reachable: boolean }>,
    overrides: Partial<ControlClientLike> = {},
  ): { client: ControlClientLike; unpaired: string[] } {
    const unpaired: string[] = [];
    const client = fakeControlClient({
      nodes: async () => nodes,
      unpair: async (deviceId) => {
        unpaired.push(deviceId);
        return { deviceId, name: "peer-node", canceledJobs: 0 };
      },
      ...overrides,
    });
    return { client, unpaired };
  }

  test("no argument is a usage error (exit 2), no control client built", async () => {
    const h = makeHarness();
    expect(await runCli(["unpair"], h.deps)).toBe(2);
    expect(h.stderrLines.join("\n")).toMatch(/usage: homefleet unpair/);
    expect(h.makeControlClientCalls).toEqual([]);
  });

  test("two positional arguments is a usage error (exit 2)", async () => {
    const h = makeHarness();
    expect(await runCli(["unpair", "a", "b", "--yes"], h.deps)).toBe(2);
    expect(h.makeControlClientCalls).toEqual([]);
  });

  test("an unknown option is a usage error (exit 2)", async () => {
    const h = makeHarness();
    expect(await runCli(["unpair", "peer-node", "--force"], h.deps)).toBe(2);
    expect(h.stderrLines.join("\n")).toMatch(/unknown option.*--force/);
  });

  test("without --yes it previews, changes nothing, and exits 1", async () => {
    const { client, unpaired } = clientWith([PEER]);
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node"], h.deps)).toBe(1);
    expect(h.stdoutLines).toEqual([
      `Would unpair peer-node (${FAKE_PEER_DEVICE_ID}).`,
    ]);
    expect(h.stderrLines).toEqual([
      "Nothing changed. Re-run with --yes to confirm.",
    ]);
    expect(unpaired).toEqual([]);
  });

  test("with --yes it unpairs the resolved full deviceId and explains one-sidedness", async () => {
    const { client, unpaired } = clientWith([PEER]);
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "--yes", "bbbbbbbb"], h.deps)).toBe(0);
    expect(unpaired).toEqual([FAKE_PEER_DEVICE_ID]);
    expect(h.stdoutLines).toEqual([
      `Unpaired peer-node (${FAKE_PEER_DEVICE_ID}).`,
      'peer-node may still list this node as paired; run "homefleet unpair" there too to end trust both ways.',
    ]);
  });

  test("reports canceled jobs when there were any", async () => {
    const { client } = clientWith([PEER], {
      unpair: async (deviceId) => ({ deviceId, name: "peer-node", canceledJobs: 2 }),
    });
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node", "--yes"], h.deps)).toBe(0);
    expect(h.stdoutLines).toContain(
      "Canceled 2 job(s) it had queued or running here.",
    );
  });

  test("no match exits 1 with a pointer to `homefleet nodes`", async () => {
    const { client, unpaired } = clientWith([PEER]);
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "desktop", "--yes"], h.deps)).toBe(1);
    expect(h.stderrLines).toEqual([
      'No paired node matches "desktop". Run "homefleet nodes" to list them.',
    ]);
    expect(unpaired).toEqual([]);
  });

  test("an ambiguous name exits 1 listing every candidate with its full id", async () => {
    const { client, unpaired } = clientWith([PEER, STALE]);
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node", "--yes"], h.deps)).toBe(1);
    expect(h.stderrLines).toEqual([
      '"peer-node" matches 2 paired nodes:',
      `  peer-node  ${FAKE_PEER_DEVICE_ID}`,
      `  peer-node  ${"c".repeat(64)}`,
      "Re-run with the full device ID.",
    ]);
    expect(unpaired).toEqual([]);
  });

  test("a 404 from the daemon (raced another unpair) exits 1 with a clear line", async () => {
    const { client } = clientWith([PEER], {
      unpair: async () => {
        throw new ControlRequestError(404, "no paired node with deviceId …");
      },
    });
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node", "--yes"], h.deps)).toBe(1);
    expect(h.stderrLines).toEqual(["peer-node is no longer paired."]);
  });

  test("a 500 from the daemon is reported cleanly (no stack) and exits 1", async () => {
    const { client } = clientWith([PEER], {
      unpair: async () => {
        throw new ControlRequestError(500, "removal was not saved");
      },
    });
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node", "--yes"], h.deps)).toBe(1);
    expect(h.stderrLines.join("\n")).toMatch(/removal was not saved/);
    expect(h.stderrLines.join("\n")).not.toMatch(/\bat .*\.ts:\d+/);
  });

  test("DaemonUnreachableError yields the friendly message and exit 1", async () => {
    const { client } = clientWith([], {
      nodes: async () => {
        throw new DaemonUnreachableError("127.0.0.1", 56373, new Error("ECONNREFUSED"));
      },
    });
    const h = makeHarness({ controlClient: client });
    expect(await runCli(["unpair", "peer-node", "--yes"], h.deps)).toBe(1);
    expect(h.stderrLines.join("\n")).toMatch(/Is homefleetd running\?/);
  });

  test("usage text lists the command", async () => {
    const h = makeHarness();
    await runCli(["--help"], h.deps);
    expect(h.stdoutLines.join("\n")).toMatch(
      /homefleet unpair <name\|deviceId> \[--yes\]/,
    );
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.**

Run: `pnpm vitest run packages/daemon/src/cli/cli.test.ts -t unpair`
Expected: FAIL. `unpair` falls through to usage and exits 2.

- [ ] **Step 3: Implement.** In `packages/daemon/src/cli/cli.ts`:

  Add the import:

```ts
import { resolveUnpairTarget } from "./unpair-target.js";
```

  In `USAGE`, insert this after the `homefleet nodes` entry:

```
  homefleet unpair <name|deviceId> [--yes]
      Revoke THIS node's trust in a paired peer, on the running daemon: the
      peer's requests are refused from now on and its jobs here are
      canceled. <deviceId> may be a unique prefix (8+ hex chars). Without
      --yes, prints what it would unpair and changes nothing. One-sided:
      run it on the peer too to end trust both ways.
```

  Add the command after `runNodes`:

```ts
/**
 * `homefleet unpair <name|deviceId> [--yes]` (spec 2026-09-25). Resolves the
 * argument against the LIVE paired list (`/control/nodes`) with
 * {@link resolveUnpairTarget}, then — only with `--yes` — revokes the FULL
 * device ID through `/control/unpair`. Without `--yes` it is a preview that
 * exits 1 having changed nothing: the CLI never prompts (no stdin
 * dependency; agents drive it as often as people). Full ids are printed, not
 * short ones, so they can be pinned later with `pair connect --expect`.
 */
async function runUnpair(args: string[], deps: CliDeps): Promise<number> {
  const confirmed = args.includes("--yes");
  const rest = args.filter((arg) => arg !== "--yes");
  const unknownOptions = rest.filter((arg) => arg.startsWith("--"));
  if (unknownOptions.length > 0) {
    deps.stderr(`unpair: unknown option(s): ${unknownOptions.join(" ")}`);
    return 2;
  }
  if (rest.length !== 1) {
    deps.stderr("usage: homefleet unpair <name|deviceId> [--yes]");
    return 2;
  }
  const query = rest[0] as string;
  return withControlClient(deps, async (client) => {
    const resolution = resolveUnpairTarget(query, await client.nodes());
    if (resolution.kind === "none") {
      deps.stderr(
        `No paired node matches "${query}". Run "homefleet nodes" to list them.`,
      );
      return 1;
    }
    if (resolution.kind === "ambiguous") {
      deps.stderr(
        `"${query}" matches ${resolution.candidates.length} paired nodes:`,
      );
      for (const candidate of resolution.candidates) {
        deps.stderr(`  ${candidate.name}  ${candidate.deviceId}`);
      }
      deps.stderr("Re-run with the full device ID.");
      return 1;
    }
    const { node } = resolution;
    if (!confirmed) {
      deps.stdout(`Would unpair ${node.name} (${node.deviceId}).`);
      deps.stderr("Nothing changed. Re-run with --yes to confirm.");
      return 1;
    }
    let summary: Awaited<ReturnType<ControlClientLike["unpair"]>>;
    try {
      summary = await client.unpair(node.deviceId);
    } catch (error) {
      // 404: someone else unpaired it between our listing and this call.
      if (error instanceof ControlRequestError && error.status === 404) {
        deps.stderr(`${node.name} is no longer paired.`);
        return 1;
      }
      throw error;
    }
    deps.stdout(`Unpaired ${summary.name} (${summary.deviceId}).`);
    if (summary.canceledJobs > 0) {
      deps.stdout(
        `Canceled ${summary.canceledJobs} job(s) it had queued or running here.`,
      );
    }
    deps.stdout(
      `${summary.name} may still list this node as paired; run ` +
        '"homefleet unpair" there too to end trust both ways.',
    );
    return 0;
  });
}
```

  In `dispatch`, add this after the `"nodes"` case:

```ts
    case "unpair":
      return runUnpair(rest, deps);
```

  A `ControlRequestError` 500 is rethrown and reaches `runCli`'s outer catch, which prints `homefleet: <message>` and returns 1. That is the clean no-stack path the test expects.

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `pnpm vitest run packages/daemon/src/cli/cli.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit.**

```bash
git status --short
git add packages/daemon/src/cli/cli.ts packages/daemon/src/cli/cli.test.ts
git commit -m "CLI: homefleet unpair <name|deviceId> [--yes]" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 8: Assembled-daemon integration test

**Files:**
- Test: `packages/daemon/src/daemon.control.integration.test.ts`

- [ ] **Step 1: Write the test.** Append it to `packages/daemon/src/daemon.control.integration.test.ts`. It uses the file's existing `h`, `controlClientFor`, `delegatorOverrides` and `HOST`. Add `import { ControlRequestError } from "./cli/control-client.js";` to the existing `ControlClient` import line.

```ts
test("unpair through the real control route: trust revoked live, the peer's job canceled, persisted across restart, other side untouched", async () => {
  const src = await h.makeSrcRepo("unpair integration");
  const workerConfig = {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  };
  const { daemon: worker, dataDir: workerDataDir } = await h.startDaemon(
    "worker",
    workerConfig,
  );
  const { daemon: delegator } = await h.startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await h.pair(delegator, worker);

  // A long-running job the delegator owns on the worker.
  const mcp = await h.connectMcp(delegator);
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: "repo-x" },
        command: "node",
        args: ["-e", "setTimeout(()=>{},30000)"],
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  const workerJobStatus = () =>
    worker.jobManager.list().find((job) => job.jobId === jobId)?.status;
  await h.waitUntil(
    () => workerJobStatus() === "running",
    undefined,
    "job running",
  );

  // The worker unpairs the delegator through its real control API.
  const workerControl = controlClientFor(worker);
  expect(await workerControl.unpair(delegator.deviceId)).toEqual({
    deviceId: delegator.deviceId,
    name: "delegator",
    canceledJobs: 1,
  });
  await h.waitUntil(
    () => workerJobStatus() === "canceled",
    undefined,
    "job canceled",
  );

  // Gone from the worker's live directory (what nodes/list_nodes/dashboard read).
  expect(
    (await workerControl.nodes()).map((node) => node.deviceId),
  ).not.toContain(delegator.deviceId);

  // Revocation is live: the delegator's next HFP call to the worker is refused.
  const followUp = await mcp.callTool({
    name: "job_status",
    arguments: { jobId },
  });
  expect(followUp.isError).toBe(true);

  // One-sided: the delegator still lists the worker, now unreachable (its
  // hello gets 401).
  const theirView = await controlClientFor(delegator).nodes();
  expect(
    theirView.find((node) => node.deviceId === worker.deviceId)?.reachable,
  ).toBe(false);

  // A second unpair is a clean 404.
  const again = await workerControl.unpair(delegator.deviceId).catch((e) => e);
  expect(again).toBeInstanceOf(ControlRequestError);
  expect((again as ControlRequestError).status).toBe(404);

  // Persisted: a daemon restarted over the same data dir still does not trust it.
  await worker.stop();
  const { daemon: restarted } = await h.startDaemon(
    "worker",
    workerConfig,
    workerDataDir,
  );
  expect(restarted.trustStore.has(delegator.deviceId)).toBe(false);
}, 90_000);
```

- [ ] **Step 2: Run the test.**

Run: `pnpm vitest run packages/daemon/src/daemon.control.integration.test.ts`
Expected: all PASS. Tasks 1–5 already implement the behavior. If the test fails, debug it with superpowers:systematic-debugging. Do not weaken the assertions.

- [ ] **Step 3: Run the full gate.**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit.**

```bash
git status --short
git add packages/daemon/src/daemon.control.integration.test.ts
git commit -m "Integration: unpair across two assembled daemons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 9: Docs, rig check, devlog

**Files:**
- Modify: `docs/adr/0004-syncthing-style-trust-model.md`, `README.md`, `docs/backlog.md`, `docs/specs/2026-09-25-unpair-node-design.md` (status line)
- Create: `devlog/2026-09-2x-unpair-node.md` (use the actual date)

- [ ] **Step 1: Add the ADR-0004 addendum.** Append to `docs/adr/0004-syncthing-style-trust-model.md`:

```markdown
## Addendum (2026-09-25): unpairing

`homefleet unpair` / `POST /control/unpair` revokes a pairing on the running
daemon ([spec](../specs/2026-09-25-unpair-node-design.md)):

- **One-sided, no protocol message.** Only this node's trust list changes;
  the peer is not told. It sees 401s from us and lists us as unreachable. To
  end trust both ways, unpair on both nodes. Re-pairing is the ordinary
  pairing flow (entries are keyed by device ID, so a leftover entry on the
  other side is simply replaced).
- **Order:** trust store first (authoritative), then cancel the peer's
  queued/running jobs here, then forget its known-nodes entry (a hint, not
  trust).
- **"Immediate" means per request.** The per-request fingerprint re-check
  refuses every request that starts after the removal, even on an
  already-open connection. A request already past the check (an upload,
  artifact download, or job submit in flight) completes.
- **Delegating side:** the MCP job tools stop contacting a node that is no
  longer paired, even though its delegation records are kept as history.
```

- [ ] **Step 2: Update the README.** In `README.md`'s CLI walkthrough block (next to `homefleet nodes` / `homefleet dashboard`, around line 207), add:

```
   homefleet unpair <name|deviceId> --yes   # revoke a pairing on the running daemon (one-sided; run it on the peer too)
```

  If the README's status/roadmap section lists shipped CLI commands, add `unpair` there too (see memory `release-doc-refresh`).

- [ ] **Step 3: Update the backlog.** In `docs/backlog.md`, replace the body of `### Unpair a node` with:

```markdown
**Shipped (2026-09-2x)** as `homefleet unpair <name|deviceId> [--yes]` backed
by `POST /control/unpair` — spec
`specs/2026-09-25-unpair-node-design.md`. One-sided, CLI-first; no dashboard
control yet (that needs the A1 mutation CSRF story). Follow-up candidate:
surface "peer no longer trusts us" as its own directory state instead of
`reachable: false`.
```

  In the spec, change `- **Status:** proposed (awaiting review).` to `- **Status:** implemented.`

- [ ] **Step 4: Rig check.** This runs on the laptop against the checkout build, and it does **not** touch the laptop↔tower pairing.
  1. Run `pnpm build`.
  2. Start a throwaway second daemon. Give it a temp data dir and a `config.json` with `node.name: "unpair-scratch"`, `hfp.port: 56470`, `mcp.port: 56472`, `control.port: 56473`, and discovery off. Launch it with `node packages/daemon/dist/bin/homefleetd.js`, with `HOMEFLEET_DATA_DIR` set to the temp dir (see `config/paths.ts`).
  3. Pair them. Run `homefleet pair begin` with `HOMEFLEET_DATA_DIR` set to the temp dir, so the CLI reads the scratch daemon's config and talks to its control port. Then, with the variable unset, run `homefleet pair connect 127.0.0.1 56470 <code>` from the laptop daemon.
  4. Run `homefleet unpair unpair-scratch` and confirm it previews and exits 1.
  5. Run `homefleet unpair unpair-scratch --yes`.
  6. Confirm `homefleet nodes` and the dashboard no longer show it, and that `trusted-devices.json` in `%LOCALAPPDATA%\homefleet\` no longer has it. Read the file with node, not PowerShell, to avoid BOM trouble.
  7. Stop the scratch daemon and delete its temp dir.

  The laptop daemon here is the *installed* 0.4.0, which has no `/control/unpair`. For this check, either restart the laptop daemon from the checkout's `dist` with `hf-daemon.ps1 restart` (its `$Bin` points at the checkout; see memory `homefleet-rig-coordination`), or run both daemons from the checkout with temp data dirs. Afterwards, restore the installed daemon with the `npm root -g` Start-Process line.

- [ ] **Step 5: Write the devlog.** Create `devlog/2026-09-2x-unpair-node.md` ("Devlog 020: unpair a node"). Cover:
  - what shipped;
  - the four settled decisions (revocation order, one-sided, name/prefix/ID resolution, `--yes`);
  - the accepted bounds (in-flight requests, the submit race, discovery re-recording);
  - the rig-check result.

  Match the tone and structure of `devlog/2026-09-24-read-only-dashboard.md`.

- [ ] **Step 6: Commit.**

```bash
git status --short
git add docs/adr/0004-syncthing-style-trust-model.md README.md docs/backlog.md docs/specs/2026-09-25-unpair-node-design.md devlog/2026-09-2x-unpair-node.md
git commit -m "Docs: unpair a node (ADR-0004 addendum, README, backlog, devlog 020)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

## Execution notes

- **Task order:** Tasks 1, 2 and 6 are independent. Task 3 needs 1 and 2. Task 5 needs 3. Task 7 needs 5 and 6. Task 8 needs everything before it. Task 4 needs nothing, but run it before Task 8, whose `job_status` assertion is satisfied either way (by the guard or by the worker's 401).
- **Subagent model tier:** implementers use `sonnet`, and reviewers use `opus`. Before merging, run one final `security-review`-style pass over Task 3's diff, because it is a new trust-store write surface.
- **Pass the shared-checkout rule** (ground rules above) into every implementer subagent's prompt.
- **Not in this plan:** a release. Shipping it as v0.5.0 follows `docs/reference/releasing.md` and the `release-doc-refresh` memory, as a separate step.
