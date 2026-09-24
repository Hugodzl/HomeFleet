# Read-only Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `homefleetd` serves a read-only web dashboard on its loopback control port. It shows this node, its paired peers, and recent worker and delegated jobs. `homefleet dashboard` opens it.

**Spec:** [`docs/specs/2026-09-24-read-only-dashboard-design.md`](../specs/2026-09-24-read-only-dashboard-design.md) (approved 2026-09-24).

**Architecture:** The page is plain HTML/CSS/ES-module JS under `packages/daemon/src/dashboard/assets/`. The assets are imported as strings with a `?raw` suffix (Vite handles this natively in vitest; a tiny esbuild plugin handles it in tsup) and are served by exact-path lookup from the existing control server. The static routes skip the `x-homefleet-control` header, but keep the Host check and send a strict CSP. A new `GET /control/jobs` joins `JobManager.list()` (worker side) with an extended `DelegationRegistry.list()` (delegator side). The MCP tools update the registry's last-seen status whenever they observe one.

**Tech Stack:** TypeScript 6, Node ≥20 `node:http`, zod 4, vitest 4, tsup 8 / esbuild, Biome 2. The browser side is vanilla JS with no dependencies.

---

## Ground rules for every task

- **Shared checkout.** Another Claude session may commit to this clone at the same time. Before staging, run `git status --short`, then stage **only the files your task lists**, by explicit path. Never use `git add -A`, `git add -u` or `git commit -a`. Unexpected commits on `main` are probably the other session, not corruption.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run commands from the repo root `D:\Git\LocalAgentCoordinator`. Single test file: `pnpm vitest run <path>`. Full gate: `pnpm typecheck && pnpm lint && pnpm test`.
- Match the house style: long "why" doc comments on anything load-bearing, double quotes, 2-space indent. Run `pnpm format` before committing if Biome complains about formatting.
- Commit to `main` and push after each task (`git push`). Never force-push.

## File structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `packages/daemon/tsup.config.ts` | modify | adds the `rawText` esbuild plugin (`?raw` → string) |
| `packages/daemon/src/dashboard/raw.d.ts` | create | ambient `declare module "*?raw"` |
| `packages/daemon/src/dashboard/static.ts` | create | exact-path asset table and the security headers |
| `packages/daemon/src/dashboard/static.test.ts` | create | asset table and header tests |
| `packages/daemon/src/dashboard/assets/index.html` | create | page shell |
| `packages/daemon/src/dashboard/assets/app.css` | create | styles |
| `packages/daemon/src/dashboard/assets/view-model.js` | create | pure API-JSON → display-row functions |
| `packages/daemon/src/dashboard/assets/view-model.d.ts` | create | types for TS tests |
| `packages/daemon/src/dashboard/view-model.test.ts` | create | view-model unit tests |
| `packages/daemon/src/dashboard/assets/app.js` | create | DOM glue: fetch, poll, render |
| `packages/daemon/src/dashboard/assets.scan.test.ts` | create | static scan for forbidden sinks and non-GET requests |
| `scripts/lib/pack.integration.test.ts` | modify | asserts that the built bin embeds the page |
| `packages/daemon/src/config/config.ts` | modify | `control.dashboard` (default `true`) |
| `packages/daemon/src/config/config.test.ts` | modify | defaults and parsing |
| `packages/daemon/src/control/control-server.ts` | modify | static routes, `GET /control/jobs`, `dashboard` option |
| `packages/daemon/src/control/control-server.test.ts` | modify | route and security tests |
| `packages/daemon/src/jobs/job-manager.ts` | modify | `JobListing` + `list()` |
| `packages/daemon/src/jobs/job-manager.test.ts` | modify | `list()` tests |
| `packages/daemon/src/mcp/delegation-registry.ts` | modify | `type`/`recordedAt`/`observeStatus`/`list()` |
| `packages/daemon/src/mcp/delegation-registry.test.ts` | modify | registry tests |
| `packages/daemon/src/mcp/tools.ts` | modify | record `type`; observe status |
| `packages/daemon/src/mcp/tools.integration.test.ts` | modify | the tools update the registry |
| `packages/daemon/src/daemon.ts` | modify | `listJobs` wiring; pass `dashboard` |
| `packages/daemon/src/daemon.control.integration.test.ts` | modify | end-to-end check of the page and jobs |
| `packages/daemon/src/cli/open-url.ts` | create | platform browser opener |
| `packages/daemon/src/cli/open-url.test.ts` | create | opener command mapping |
| `packages/daemon/src/cli/cli.ts` | modify | `homefleet dashboard [--no-open]` |
| `packages/daemon/src/cli/cli.test.ts` | modify | CLI tests |
| `packages/daemon/src/bin/homefleet.ts` | modify | inject the real `openUrl` |
| `docs/reference/configuration.md`, `README.md`, `docs/backlog.md`, `docs/specs/2026-07-12-backlog-structuring.md`, `devlog/2026-09-2x-read-only-dashboard.md` | modify/create | docs |

---

### Task 1: Asset embedding spike (`?raw` in vitest, tsc and tsup)

This task de-risks everything that follows. If any of steps 4, 6 or 8 cannot be made to pass, **stop and report**. The spec's fallback is a generated `assets.generated.ts`, and switching to it needs a decision.

**Files:**
- Create: `packages/daemon/src/dashboard/raw.d.ts`, `packages/daemon/src/dashboard/static.ts`, `packages/daemon/src/dashboard/static.test.ts`, `packages/daemon/src/dashboard/assets/index.html`
- Modify: `packages/daemon/tsup.config.ts`, `scripts/lib/pack.integration.test.ts`

- [ ] **Step 1: Create the page shell** `packages/daemon/src/dashboard/assets/index.html`. The `data-homefleet-dashboard` attribute is the marker the tests look for.

```html
<!doctype html>
<html lang="en" data-homefleet-dashboard>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HomeFleet</title>
    <link rel="stylesheet" href="/dashboard/app.css" />
    <script type="module" src="/dashboard/app.js"></script>
  </head>
  <body>
    <header>
      <h1>HomeFleet</h1>
      <span id="updated" class="muted">Loading…</span>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div id="banner" class="banner" hidden></div>
    <main>
      <section>
        <h2>This node</h2>
        <div id="self"></div>
        <h3>Models</h3>
        <div id="models"></div>
      </section>
      <section>
        <h2>Paired nodes</h2>
        <div id="nodes"></div>
      </section>
      <section>
        <h2>Worker jobs</h2>
        <p class="muted">Jobs this node ran for peers. Kept in memory only; the list resets when the daemon restarts.</p>
        <div id="worker-jobs"></div>
      </section>
      <section>
        <h2>Delegated jobs</h2>
        <p class="muted">Jobs this node sent out. Status is the last one the MCP tools saw; the dashboard never asks the worker itself.</p>
        <div id="delegated-jobs"></div>
      </section>
    </main>
  </body>
</html>
```

- [ ] **Step 2: Create the ambient declaration** `packages/daemon/src/dashboard/raw.d.ts`:

```ts
/**
 * `import text from "./file.ext?raw"` yields the file's contents as a string.
 * Vitest (Vite) implements `?raw` natively; the tsup build implements it with
 * the `rawText` esbuild plugin in packages/daemon/tsup.config.ts. Used only
 * to embed the dashboard's static assets into the daemon bundle.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
```

- [ ] **Step 3: Write the failing test** `packages/daemon/src/dashboard/static.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  DASHBOARD_CSP,
  lookupStaticAsset,
  STATIC_SECURITY_HEADERS,
} from "./static.js";

test("/ serves the embedded index.html as UTF-8 HTML", () => {
  const asset = lookupStaticAsset("/");
  expect(asset?.contentType).toBe("text/html; charset=utf-8");
  expect(asset?.body).toContain("data-homefleet-dashboard");
});

test("lookup is exact-match only (no traversal, no prefix matching)", () => {
  for (const path of [
    "",
    "/index.html",
    "/dashboard/",
    "/dashboard/../control/status",
    "/control/status",
    "//",
  ]) {
    expect(lookupStaticAsset(path)).toBeUndefined();
  }
});

test("security headers carry the strict CSP and anti-framing/sniffing headers", () => {
  expect(STATIC_SECURITY_HEADERS["content-security-policy"]).toBe(
    DASHBOARD_CSP,
  );
  expect(DASHBOARD_CSP).toContain("default-src 'none'");
  expect(DASHBOARD_CSP).toContain("frame-ancestors 'none'");
  expect(DASHBOARD_CSP).not.toContain("unsafe-inline");
  expect(DASHBOARD_CSP).not.toContain("unsafe-eval");
  expect(STATIC_SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
  expect(STATIC_SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
  expect(STATIC_SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
  expect(STATIC_SECURITY_HEADERS["cache-control"]).toBe("no-store");
});
```

- [ ] **Step 4: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/dashboard/static.test.ts`. Expected: FAIL, because `./static.js` cannot be resolved.

- [ ] **Step 5: Implement** `packages/daemon/src/dashboard/static.ts`:

```ts
/**
 * The dashboard's static assets, embedded into the daemon bundle as strings
 * (`?raw` imports — see ./raw.d.ts) and served by the control server by
 * EXACT path lookup. There is no filesystem access and no path derived from
 * the request beyond a Map lookup, so there is no traversal surface.
 *
 * WHY the headers are this strict: the page shares an origin with the
 * control API's mutating `pair/*` routes, so script injection into this
 * page would be a real escalation. The CSP forbids inline script/style and
 * eval, and only lets the page talk to its own origin; the client code's
 * own discipline (textContent-only rendering, GET-only fetches) is enforced
 * separately by assets.scan.test.ts.
 */
import indexHtml from "./assets/index.html?raw";

export interface StaticAsset {
  body: string;
  contentType: string;
}

export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent on every static response (never on the JSON data routes). */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": DASHBOARD_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const ASSETS: ReadonlyMap<string, StaticAsset> = new Map([
  ["/", { body: indexHtml, contentType: "text/html; charset=utf-8" }],
]);

/** The asset served at exactly `pathname`, or `undefined`. */
export function lookupStaticAsset(pathname: string): StaticAsset | undefined {
  return ASSETS.get(pathname);
}
```

- [ ] **Step 6: Run the test and confirm it passes.** Then run `pnpm typecheck`. Expected: PASS, and tsc is clean (the `?raw` import resolves through `raw.d.ts`).

- [ ] **Step 7: Add the esbuild plugin** to `packages/daemon/tsup.config.ts`. Add these imports at the top of the file:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "esbuild";
```

Add this above `export default defineConfig`:

```ts
// WHY: the dashboard's static assets (src/dashboard/assets/*) are imported
// as `./x.html?raw` so the page ships INSIDE homefleetd.js — no runtime file
// lookup that would differ between a checkout and an `npm i -g` install.
// Vitest implements `?raw` natively; esbuild does not, so this resolves any
// `?raw` specifier to its file and loads it with the `text` loader.
const rawText: Plugin = {
  name: "raw-text",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -"?raw".length)),
      namespace: "raw-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};
```

Then add `esbuildPlugins: [rawText],` inside the `defineConfig({ … })` object. If `import type { Plugin } from "esbuild"` fails to typecheck (esbuild is a transitive dependency of tsup), use `type Plugin = NonNullable<Options["esbuildPlugins"]>[number];` with `import { defineConfig, type Options } from "tsup";` instead.

- [ ] **Step 8: Assert that the built bin embeds the page.** In `scripts/lib/pack.integration.test.ts`, add after the existing tests:

```ts
test("the built homefleetd.js embeds the dashboard page (?raw plugin ran)", async () => {
  const bin = await readFile(
    path.join(workDir, "dist-bin", "homefleetd.js"),
    "utf8",
  );
  expect(bin).toContain("data-homefleet-dashboard");
});
```

Run `pnpm vitest run scripts/lib/pack.integration.test.ts`. Expected: every test PASSES, including the unchanged "ships exactly LICENSE, package.json and dist/bin" test. That proves no extra files ship. This test is slow (a real build plus `npm pack`). If this test (not the build) fails because `dist-bin` is not the tsup out dir, read `packRelease`'s `distDir` handling in `scripts/lib/pack.ts` and point the path at wherever `homefleetd.js` is built.

- [ ] **Step 9: Run lint** with `pnpm lint`. If Biome lints `index.html` and complains, fix the markup rather than ignoring the file.

- [ ] **Step 10: Commit.**

```bash
git add packages/daemon/tsup.config.ts packages/daemon/src/dashboard/raw.d.ts packages/daemon/src/dashboard/static.ts packages/daemon/src/dashboard/static.test.ts packages/daemon/src/dashboard/assets/index.html scripts/lib/pack.integration.test.ts
git commit -m "Dashboard: embed static assets via ?raw (vitest + tsup)"
git push
```

---

### Task 2: `control.dashboard` config flag

**Files:**
- Modify: `packages/daemon/src/config/config.ts` (the `ControlConfigSchema`, around line 202), `packages/daemon/src/config/config.test.ts`

- [ ] **Step 1: Write the failing tests.** In `config.test.ts`:
  - In the full-defaults expectation (around line 57), change `control: { host: "127.0.0.1", port: DEFAULT_CONTROL_PORT }` to `control: { host: "127.0.0.1", port: DEFAULT_CONTROL_PORT, dashboard: true }`.
  - In `"partial hfp/mcp/control configs merge with defaults"` (around line 239), add `dashboard: true` to the `config.control` expectation.
  - Search the file for any other `toEqual` on a `control` object and add `dashboard: true` there too.
  - Then append:

```ts
test("control.dashboard defaults to true and can be turned off", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ control: { dashboard: false } }));
  const config = await loadDaemonConfig(dir);
  expect(config.control.dashboard).toBe(false);
});

test("a non-boolean control.dashboard throws (fail closed)", async () => {
  const dir = await newDataDir();
  await writeConfig(dir, JSON.stringify({ control: { dashboard: "yes" } }));
  await expect(loadDaemonConfig(dir)).rejects.toThrow(/Invalid daemon config/);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/config/config.test.ts`. Expected: FAIL. The strict schema rejects the unknown `dashboard` key, and the defaults lack it.

- [ ] **Step 3: Implement.** In `ControlConfigSchema` add:

```ts
  /**
   * Serve the read-only web dashboard at `http://<host>:<port>/`. The JSON
   * data routes stay up either way (the CLI uses them); `false` only 404s
   * the page and its static assets.
   */
  dashboard: z.boolean().default(true),
```

Update the schema's doc comment ("the `homefleet` CLI talks to") so it also mentions the dashboard.

- [ ] **Step 4: Run the tests and confirm they pass.** Run the config test, then `pnpm typecheck`. Other files may build `ControlConfig` literals: if typecheck flags any (for example `cli.test.ts`'s `fakeConfig`, which casts and so may not complain), add `dashboard: true` there. In `packages/daemon/src/cli/cli.test.ts`, change `fakeConfig`'s `control: { host: "127.0.0.1", port: 56373 }` to `control: { host: "127.0.0.1", port: 56373, dashboard: true }` either way.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/config/config.ts packages/daemon/src/config/config.test.ts packages/daemon/src/cli/cli.test.ts
git commit -m "Config: control.dashboard flag (default true)"
git push
```

---

### Task 3: Serve static routes from the control server

**Files:**
- Modify: `packages/daemon/src/control/control-server.ts`, `packages/daemon/src/control/control-server.test.ts`, `packages/daemon/src/daemon.ts` (the `startControlServer({...})` call, around line 553)

- [ ] **Step 1: Write the failing tests.** In `control-server.test.ts`, add `type IncomingHttpHeaders` to the `node:http` import, then add this helper after `postJson`:

```ts
/** Like `send`, but returns raw text + response headers (for static routes). */
function getRaw(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    hostHeader?: string;
  },
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        agent: false,
        headers: {
          host: options.hostHeader ?? `127.0.0.1:${port}`,
          ...options.headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
```

Then add these tests:

```ts
test("GET / serves the dashboard WITHOUT the control header, with security headers", async () => {
  const server = await start();
  const res = await getRaw(server.port, { path: "/" });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(res.headers["content-security-policy"]).toContain(
    "default-src 'none'",
  );
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  expect(res.text).toContain("data-homefleet-dashboard");
});

test("HEAD / returns headers and no body", async () => {
  const server = await start();
  const res = await getRaw(server.port, { method: "HEAD", path: "/" });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(res.text).toBe("");
});

test("static routes still enforce the Host allow-list (DNS rebinding)", async () => {
  const server = await start();
  const res = await getRaw(server.port, {
    path: "/",
    hostHeader: "evil.example:80",
  });
  expect(res.status).toBe(403);
});

test("POST / is not a static route: 403 without the header, 404 with it", async () => {
  const server = await start();
  expect((await getRaw(server.port, { method: "POST", path: "/" })).status).toBe(
    403,
  );
  expect(
    (
      await getRaw(server.port, {
        method: "POST",
        path: "/",
        headers: { [CONTROL_HEADER]: "1" },
      })
    ).status,
  ).toBe(404);
});

test("data routes still require the control header", async () => {
  const server = await start();
  const res = await getRaw(server.port, { path: "/control/status" });
  expect(res.status).toBe(403);
});

test("dashboard: false 404s the page but keeps data routes", async () => {
  const server = await start({ dashboard: false });
  expect((await getRaw(server.port, { path: "/" })).status).toBe(404);
  const status = await getRaw(server.port, {
    path: "/control/status",
    headers: { [CONTROL_HEADER]: "1" },
  });
  expect(status.status).toBe(200);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/control/control-server.test.ts`. Expected: the new tests FAIL (403 on `GET /`, and a type error on `dashboard`).

- [ ] **Step 3: Implement** in `control-server.ts`:
  - Import `import { lookupStaticAsset, type StaticAsset, STATIC_SECURITY_HEADERS } from "../dashboard/static.js";`.
  - Add to `ControlServerOptions`:

```ts
  /**
   * Serve the read-only dashboard's static assets (default `true`; config
   * `control.dashboard`). `false` 404s them; data routes are unaffected.
   */
  dashboard?: boolean;
```

  - Add this helper next to `respondJson`:

```ts
/** Serves an embedded dashboard asset with the static security headers. */
function serveStatic(
  res: ServerResponse,
  asset: StaticAsset,
  headOnly: boolean,
): void {
  const body = Buffer.from(asset.body, "utf8");
  res.writeHead(200, {
    ...STATIC_SECURITY_HEADERS,
    "content-type": asset.contentType,
    "content-length": String(body.length),
  });
  res.end(headOnly ? undefined : body);
}
```

  - In `startControlServer`, read `const dashboardEnabled = options.dashboard ?? true;`.
  - In `handle()`, move the `const method = …` and `const pathname = …` lines up so they run right after the Host check. Insert this **between the Host check and the `CONTROL_HEADER` check**:

```ts
    // Dashboard static assets: exempt from the control header (a browser
    // NAVIGATION cannot set custom headers) but NOT from the Host check
    // above or the readiness guard. They are fixed embedded bytes that
    // never carry live data; the data they render is fetched from the
    // header-protected routes below. See ../dashboard/static.ts.
    if (method === "GET" || method === "HEAD") {
      const asset = lookupStaticAsset(pathname);
      if (asset !== undefined) {
        if (!dashboardEnabled) {
          respondError(res, 404, "not found");
          return;
        }
        serveStatic(res, asset, method === "HEAD");
        return;
      }
    }
```

  - Extend the module header's security-model list with a bullet: "Dashboard static routes (`GET`/`HEAD` of the exact paths in ../dashboard/static.ts) are the ONLY routes exempt from the control header. They still pass the Host check and readiness guard, serve fixed embedded bytes, and carry a strict CSP plus frame/sniff headers. The page's own data fetches are same-origin and send the header, so no CORS headers are ever added."

- [ ] **Step 4: Pass the flag from the daemon.** In `daemon.ts`'s `startControlServer({ … })` call, add `dashboard: config.control.dashboard,`.

- [ ] **Step 5: Run the tests and confirm they pass.** Run the control-server test (new and existing tests PASS), then `pnpm typecheck`.

- [ ] **Step 6: Commit.**

```bash
git add packages/daemon/src/control/control-server.ts packages/daemon/src/control/control-server.test.ts packages/daemon/src/daemon.ts
git commit -m "Control server: serve dashboard static routes (header-exempt, Host-checked, strict CSP)"
git push
```

---

### Task 4: `JobManager.list()`

**Files:**
- Modify: `packages/daemon/src/jobs/job-manager.ts`, `packages/daemon/src/jobs/job-manager.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `job-manager.test.ts`:

```ts
test("list() returns every retained job newest first, metadata only", async () => {
  const manager = makeManager({ maxConcurrentJobs: 1 });
  const first = manager.submit(commandParams(), OWNER);
  const second = manager.submit(commandParams(), OTHER_OWNER);
  await waitUntil(() => isSucceeded(manager, first.jobId));
  await waitUntil(() => {
    try {
      return manager.snapshot(second.jobId, OTHER_OWNER).status === "succeeded";
    } catch {
      return false;
    }
  });

  const listed = manager.list();
  expect(listed.map((job) => job.jobId)).toEqual([second.jobId, first.jobId]);
  const [newest] = listed;
  expect(newest).toMatchObject({
    jobId: second.jobId,
    type: "command",
    owner: OTHER_OWNER,
    repoId: "r",
    status: "succeeded",
  });
  expect(typeof newest?.createdAt).toBe("number");
  expect(typeof newest?.startedAt).toBe("number");
  expect(typeof newest?.terminalAt).toBe("number");
  // Metadata only: no params body, events, or result payload.
  expect(Object.keys(newest ?? {}).sort()).toEqual(
    [
      "createdAt",
      "jobId",
      "owner",
      "repoId",
      "startedAt",
      "status",
      "terminalAt",
      "type",
    ].sort(),
  );
});

test("list() reports a failed job's error code", async () => {
  const manager = makeManager({ executors: [new ThrowingExecutor()] });
  const bad = manager.submit(commandParams(), OWNER);
  await waitUntil(() => {
    try {
      return manager.snapshot(bad.jobId, OWNER).status === "failed";
    } catch {
      return false;
    }
  });
  expect(manager.list()[0]).toMatchObject({
    jobId: bad.jobId,
    status: "failed",
    errorCode: "INTERNAL",
  });
});

test("list() on a fresh manager is empty", () => {
  expect(makeManager().list()).toEqual([]);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/jobs/job-manager.test.ts`. Expected: FAIL (`list` is not a function).

- [ ] **Step 3: Implement** in `job-manager.ts`. Add `HfpErrorCode`, `JobStatus` and `JobType` to the existing `@homefleet/protocol` type import if they are missing. Add the interface above `export class JobManager`:

```ts
/** A metadata-only view of one retained job, for the local control API. */
export interface JobListing {
  jobId: JobId;
  type: JobType;
  /** Device ID of the submitting peer. */
  owner: string;
  repoId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  terminalAt?: number;
  /** The terminal result's error code, when it carries one. */
  errorCode?: HfpErrorCode;
}
```

Add the method after `snapshot()`:

```ts
  /**
   * Every retained job (active + terminal), newest first, as METADATA ONLY
   * (no params body, events, or result payload).
   *
   * NOT owner-scoped, deliberately: this feeds the loopback control API's
   * `/control/jobs` (the local, same-OS-user dashboard). It must never be
   * exposed over HFP, where {@link snapshot}'s owner check is the isolation
   * boundary between peers.
   */
  list(): JobListing[] {
    return [...this.records.values()].reverse().map((record) => ({
      jobId: record.jobId,
      type: record.params.type,
      owner: record.owner,
      repoId: record.params.workspace.repoId,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.startedAt !== undefined
        ? { startedAt: record.startedAt }
        : {}),
      ...(record.terminalAt !== undefined
        ? { terminalAt: record.terminalAt }
        : {}),
      ...(record.result?.error !== undefined
        ? { errorCode: record.result.error.code }
        : {}),
    }));
  }
```

- [ ] **Step 4: Run the tests and confirm they pass.** Then run `pnpm typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/jobs/job-manager.ts packages/daemon/src/jobs/job-manager.test.ts
git commit -m "JobManager: metadata-only list() for the local control API"
git push
```

---

### Task 5: `DelegationRegistry` records type and time, observes status, lists

**Files:**
- Modify: `packages/daemon/src/mcp/delegation-registry.ts`, `packages/daemon/src/mcp/delegation-registry.test.ts`, `packages/daemon/src/mcp/tools.ts` (the `delegations.record(` call only, around line 697)

- [ ] **Step 1: Write the failing tests.** In `delegation-registry.test.ts`:
  - Update **every** existing `registry.record(x, route(n))` call to `registry.record(x, route(n), "command")`. Find them with `grep -n "\.record(" packages/daemon/src/mcp/delegation-registry.test.ts`.
  - Then append inside the `describe`:

```ts
  test("record stamps type, recordedAt and an initial queued status", () => {
    let now = 1_000;
    const registry = new DelegationRegistry({ now: () => now });
    registry.record("job-1", route(1), "write");
    now = 2_000;
    expect(registry.list()).toEqual([
      {
        jobId: "job-1",
        type: "write",
        deviceId: route(1).deviceId,
        repoId: "repo-x",
        recordedAt: 1_000,
        lastStatus: "queued",
        lastStatusAt: 1_000,
      },
    ]);
  });

  test("observeStatus updates lastStatus/lastStatusAt; unknown ids are a no-op", () => {
    let now = 1_000;
    const registry = new DelegationRegistry({ now: () => now });
    registry.record("job-1", route(1), "command");
    now = 5_000;
    registry.observeStatus("job-1", "succeeded");
    registry.observeStatus("never-recorded", "failed");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toMatchObject({
      lastStatus: "succeeded",
      lastStatusAt: 5_000,
    });
  });

  test("list is newest first, includes the applied branch, and honours the limit", () => {
    const registry = new DelegationRegistry();
    registry.record("job-a", route(1), "command");
    registry.record("job-b", route(2), "write");
    registry.recordApplied("job-b", {
      branchName: "homefleet/job-b",
      baseCommit: "c".repeat(40),
    });
    expect(registry.list().map((d) => d.jobId)).toEqual(["job-b", "job-a"]);
    expect(registry.list()[0]?.appliedBranch).toBe("homefleet/job-b");
    expect(registry.list(1).map((d) => d.jobId)).toEqual(["job-b"]);
  });

  test("list defaults to the newest DEFAULT_DELEGATION_LIST_LIMIT entries", () => {
    const registry = new DelegationRegistry();
    for (let i = 0; i < DEFAULT_DELEGATION_LIST_LIMIT + 5; i += 1) {
      registry.record(`job-${i}`, route(i), "command");
    }
    const listed = registry.list();
    expect(listed).toHaveLength(DEFAULT_DELEGATION_LIST_LIMIT);
    expect(listed[0]?.jobId).toBe(`job-${DEFAULT_DELEGATION_LIST_LIMIT + 4}`);
  });
```

  - Add `DEFAULT_DELEGATION_LIST_LIMIT` to the import from `./delegation-registry.js`.

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/mcp/delegation-registry.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** in `delegation-registry.ts`:
  - Add `import type { JobStatus, JobType } from "@homefleet/protocol";`.
  - Below `MAX_TRACKED_DELEGATIONS`, add:

```ts
/** How many delegations `list()` returns by default (newest first). */
export const DEFAULT_DELEGATION_LIST_LIMIT = 100;

export interface DelegationRegistryOptions {
  /** Clock for `recordedAt` / `lastStatusAt`; defaults to `Date.now`. */
  now?: () => number;
}

/** A metadata-only view of one tracked delegation, for the control API. */
export interface DelegationListing {
  jobId: string;
  type: JobType;
  /** The worker's paired device ID. */
  deviceId: string;
  repoId: string;
  recordedAt: number;
  /**
   * The last status an MCP tool (`job_status` / `job_result`) observed from
   * the worker; `queued` until one does. Never fetched by the listing
   * itself — it is "last seen", not live.
   */
  lastStatus: JobStatus;
  lastStatusAt: number;
  appliedBranch?: string;
}
```

  - Change `DelegationEntry` to:

```ts
interface DelegationEntry {
  route: DelegationRoute;
  type: JobType;
  recordedAt: number;
  lastStatus: JobStatus;
  lastStatusAt: number;
  /** Set once the write artifact has been applied into the local repo. */
  applied?: AppliedArtifact;
}
```

  - In the class, add a `private readonly now: () => number;` field and the constructor `constructor(options: DelegationRegistryOptions = {}) { this.now = options.now ?? Date.now; }`.
  - Change `record`'s signature to `record(jobId: string, route: DelegationRoute, type: JobType): void`, and its set to:

```ts
    const at = this.now();
    this.entries.set(jobId, {
      route: { ...route },
      type,
      recordedAt: at,
      lastStatus: "queued",
      lastStatusAt: at,
    });
```

    Also update its doc comment to mention `type` and the initial `queued`.
  - Add after `appliedArtifact`:

```ts
  /**
   * Remembers the latest status an MCP tool observed for `jobId` (fed by
   * `job_status` / `job_result`), so the dashboard can show delegated jobs
   * without making LAN calls of its own. A no-op for an untracked jobId.
   */
  observeStatus(jobId: string, status: JobStatus): void {
    const entry = this.entries.get(jobId);
    if (entry !== undefined) {
      entry.lastStatus = status;
      entry.lastStatusAt = this.now();
    }
  }

  /** The newest `limit` tracked delegations, newest first, metadata only. */
  list(limit = DEFAULT_DELEGATION_LIST_LIMIT): DelegationListing[] {
    const all = [...this.entries.entries()];
    const out: DelegationListing[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const [jobId, entry] = all[i] as [string, DelegationEntry];
      out.push({
        jobId,
        type: entry.type,
        deviceId: entry.route.deviceId,
        repoId: entry.route.repoId,
        recordedAt: entry.recordedAt,
        lastStatus: entry.lastStatus,
        lastStatusAt: entry.lastStatusAt,
        ...(entry.applied !== undefined
          ? { appliedBranch: entry.applied.branchName }
          : {}),
      });
    }
    return out;
  }
```

- [ ] **Step 4: Update the one production call site.** In `tools.ts`, around line 697, change `delegations.record(jobId, { … })` to pass `task.type` as the third argument: `delegations.record(jobId, { deviceId: node, host: resolved.host, port: resolved.port, repoId }, task.type);`. Check that the variable holding the validated task is really named `task` in that scope (the success message uses `task.type`).

- [ ] **Step 5: Run the tests and confirm they pass.** Run the registry test, then `pnpm typecheck` (this catches any other `record(` caller).

- [ ] **Step 6: Commit.**

```bash
git add packages/daemon/src/mcp/delegation-registry.ts packages/daemon/src/mcp/delegation-registry.test.ts packages/daemon/src/mcp/tools.ts
git commit -m "DelegationRegistry: record type/time, observeStatus, list()"
git push
```

---

### Task 6: MCP tools feed `observeStatus`

**Files:**
- Modify: `packages/daemon/src/mcp/tools.ts` (the `job_status` and `job_result` handlers), `packages/daemon/src/mcp/tools.integration.test.ts`

- [ ] **Step 1: Write the failing assertions.** In `tools.integration.test.ts`, in `"delegate_task (command) end-to-end: jobId, then job_status and job_result"`:
  - Right after `expect(delegations.lookup(jobId)).toBeDefined();`, add:

```ts
  expect(delegations.list()[0]).toMatchObject({
    jobId,
    type: "command",
    lastStatus: "queued",
  });
```

  - After the `JobStatusOutputSchema.parse(...)` line, add:

```ts
  expect(delegations.list()[0]?.lastStatus).toBe(parsedStatus.status);
```

  - At the end of the test, add:

```ts
  // job_result observed the terminal status; the dashboard reads it from here.
  expect(delegations.list()[0]?.lastStatus).toBe("succeeded");
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/mcp/tools.integration.test.ts -t "delegate_task \\(command\\) end-to-end"`. Expected: FAIL on the `lastStatus` assertions (the status stays `queued`).

- [ ] **Step 3: Implement.** In `tools.ts`:
  - In the `job_status` handler, right after `const snapshot = await hfpClient.jobSnapshot(targetFor(route), jobId);`, add `delegations.observeStatus(jobId, snapshot.status);`.
  - In the `job_result` handler, add the same line right after its `const snapshot = …` line, before the `result === null` branch, so both queued and terminal observations are recorded.

- [ ] **Step 4: Run the whole file and confirm it passes.** Run `pnpm vitest run packages/daemon/src/mcp/tools.integration.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/mcp/tools.ts packages/daemon/src/mcp/tools.integration.test.ts
git commit -m "MCP tools: record observed job status in the delegation registry"
git push
```

---

### Task 7: `GET /control/jobs` and daemon wiring

**Files:**
- Modify: `packages/daemon/src/control/control-server.ts`, `packages/daemon/src/control/control-server.test.ts`, `packages/daemon/src/daemon.ts`

- [ ] **Step 1: Write the failing tests.** In `control-server.test.ts`:
  - Add `type ControlJobs` to the `./control-server.js` import.
  - In `fakeSurface`, add `listJobs: (): ControlJobs => ({ worker: [], delegated: [] }),` before `...overrides`.
  - Append:

```ts
test("GET /control/jobs returns the surface's listing (header required)", async () => {
  const jobs: ControlJobs = {
    worker: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        type: "command",
        ownerDeviceId: FAKE_PEER_DEVICE_ID,
        ownerName: "peer-node",
        repoId: "repo-x",
        status: "running",
        createdAt: 1,
        startedAt: 2,
      },
    ],
    delegated: [
      {
        jobId: "22222222-2222-4222-8222-222222222222",
        type: "write",
        targetDeviceId: FAKE_PEER_DEVICE_ID,
        targetName: "peer-node",
        repoId: "repo-x",
        recordedAt: 3,
        lastStatus: "succeeded",
        lastStatusAt: 4,
        appliedBranch: "homefleet/222222222222",
      },
    ],
  };
  const server = await start({ surface: fakeSurface({ listJobs: () => jobs }) });
  const ok = await send(server.port, { method: "GET", path: "/control/jobs" });
  expect(ok.status).toBe(200);
  expect(ok.json).toEqual(jobs);
  const denied = await send(server.port, {
    method: "GET",
    path: "/control/jobs",
    headers: { [CONTROL_HEADER]: undefined },
  });
  expect(denied.status).toBe(403);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/control/control-server.test.ts`. Expected: FAIL (a type error for `listJobs`/`ControlJobs`, and a 404).

- [ ] **Step 3: Implement** in `control-server.ts`:
  - Extend the protocol import to `import type { ExecutorKind, HfpErrorCode, JobStatus, JobType, ModelInfo, NodeRole } from "@homefleet/protocol";`.
  - After `ControlStatus`, add:

```ts
/** One worker-side job (this node ran it for a peer), as `/control/jobs` reports it. */
export interface WorkerJobSummary {
  jobId: string;
  type: JobType;
  ownerDeviceId: string;
  /** The owner's paired name, when it is (still) in the trust store. */
  ownerName?: string;
  repoId: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  terminalAt?: number;
  errorCode?: HfpErrorCode;
}

/** One delegated job (this node sent it out), as `/control/jobs` reports it. */
export interface DelegatedJobSummary {
  jobId: string;
  type: JobType;
  targetDeviceId: string;
  targetName?: string;
  repoId: string;
  recordedAt: number;
  /** Last status the MCP tools observed — "last seen", never fetched live. */
  lastStatus: JobStatus;
  lastStatusAt: number;
  appliedBranch?: string;
}

/** The `GET /control/jobs` body: metadata only, newest first. */
export interface ControlJobs {
  worker: WorkerJobSummary[];
  delegated: DelegatedJobSummary[];
}
```

  - Add to `ControlSurface`:

```ts
  /**
   * Recent jobs in both directions, metadata only (no prompts, output, or
   * results) — the dashboard's jobs view. Local-admin only: the worker list
   * is NOT owner-scoped (see JobManager.list).
   */
  listJobs(): ControlJobs;
```

  - Add a handler next to `handleNodes`:

```ts
  async function handleJobs(res: ServerResponse): Promise<void> {
    respondJson(res, 200, surface.listJobs());
  }
```

  - Add the route in `handle()` after `/control/nodes`:

```ts
      if (method === "GET" && pathname === "/control/jobs") {
        await handleJobs(res);
        return;
      }
```

  - Update the module header's opening sentence ("drive pairing, list nodes, and read status") to also mention "list recent jobs, and serve the read-only dashboard".

- [ ] **Step 4: Wire the daemon.** In `daemon.ts`, add `listJobs` to the `controlSurface` object literal after `listNodes`. Use the local `JobManager` instance in `start()`: find the variable the `jobManager` getter returns (`grep -n "new JobManager" packages/daemon/src/daemon.ts`) and use that name in place of `jobManager` below if it differs. Also import `type ControlJobs` alongside `ControlStatus`.

```ts
      listJobs: (): ControlJobs => {
        // Resolve names from the LIVE trust store on every call, so a peer
        // paired or renamed later shows up correctly on the next poll.
        const names = new Map(
          trustStore.list().map((device) => [device.deviceId, device.name]),
        );
        const nameOf = (deviceId: string) => names.get(deviceId);
        return {
          worker: jobManager.list().map(({ owner, ...job }) => {
            const ownerName = nameOf(owner);
            return {
              ...job,
              ownerDeviceId: owner,
              ...(ownerName !== undefined ? { ownerName } : {}),
            };
          }),
          delegated: delegations.list().map(({ deviceId, ...job }) => {
            const targetName = nameOf(deviceId);
            return {
              ...job,
              targetDeviceId: deviceId,
              ...(targetName !== undefined ? { targetName } : {}),
            };
          }),
        };
      },
```

- [ ] **Step 5: Run the tests and confirm they pass.** Run the control-server test, then `pnpm typecheck`. Also run `pnpm vitest run packages/daemon/src/cli` to make sure nothing else constructs a `ControlSurface`.

- [ ] **Step 6: Commit.**

```bash
git add packages/daemon/src/control/control-server.ts packages/daemon/src/control/control-server.test.ts packages/daemon/src/daemon.ts
git commit -m "Control API: GET /control/jobs (worker + delegated, metadata only)"
git push
```

---

### Task 8: Client view model (pure functions)

**Files:**
- Create: `packages/daemon/src/dashboard/assets/view-model.js`, `packages/daemon/src/dashboard/assets/view-model.d.ts`, `packages/daemon/src/dashboard/view-model.test.ts`

- [ ] **Step 1: Write the failing test** `packages/daemon/src/dashboard/view-model.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type {
  ControlJobs,
  ControlStatus,
} from "../control/control-server.js";
import type { NodeDirectoryEntry } from "../mcp/node-directory.js";
import {
  delegatedJobRows,
  modelRows,
  nodeRows,
  relativeTime,
  selfRows,
  shortId,
  workerJobRows,
} from "./assets/view-model.js";

const SELF: ControlStatus = {
  deviceId: "a".repeat(64),
  name: "laptop",
  platform: "win32",
  daemonVersion: "0.3.1",
  protocolVersion: "0.3.0",
  hfpPort: 56370,
  mcpPort: 56372,
  controlPort: 56373,
  roles: ["execution"],
  executors: ["command", "agent"],
  models: [{ id: "qwen3.5:4b", label: "Qwen 4B", status: "ok" }, { id: "bare" }],
  activeJobs: 1,
  maxConcurrentJobs: 2,
};

describe("formatting helpers", () => {
  test("shortId truncates long ids with an ellipsis and leaves short ones", () => {
    expect(shortId("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
    expect(shortId("abc")).toBe("abc");
  });

  test("relativeTime buckets seconds/minutes/hours/days; undefined is a dash", () => {
    const now = 1_000_000_000;
    expect(relativeTime(undefined, now)).toBe("—");
    expect(relativeTime(now - 5_000, now)).toBe("5s ago");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(relativeTime(now + 5_000, now)).toBe("0s ago"); // clock skew clamps
  });
});

test("selfRows renders identity, versions, ports, capabilities and load", () => {
  expect(selfRows(SELF)).toEqual([
    ["Name", "laptop"],
    ["Device ID", "a".repeat(64)],
    ["Platform", "win32"],
    ["Version", "daemon 0.3.1 · protocol 0.3.0"],
    ["Ports", "HFP 56370 · MCP 56372 · control 56373"],
    ["Roles", "execution"],
    ["Executors", "command, agent"],
    ["Load", "1 / 2 jobs running"],
  ]);
  expect(selfRows({ ...SELF, roles: [], executors: [] })[5]).toEqual([
    "Roles",
    "(none)",
  ]);
});

test("modelRows shows label and catalog status, dashing missing fields", () => {
  expect(modelRows(SELF.models)).toEqual([
    { id: "qwen3.5:4b", label: "Qwen 4B", status: "ok" },
    { id: "bare", label: "—", status: "—" },
  ]);
});

test("nodeRows flags version skew and handles unreachable peers", () => {
  const nodes: NodeDirectoryEntry[] = [
    {
      deviceId: "b".repeat(64),
      name: "tower",
      host: "192.168.68.73",
      port: 56370,
      reachable: true,
      nodeInfo: {
        deviceId: "b".repeat(64),
        name: "tower",
        daemonVersion: "0.3.0",
        protocolVersion: "0.3.0",
        platform: "win32",
        roles: ["inference", "execution"],
        executors: ["command", "agent", "write"],
        models: [{ id: "qwen3.6-35b-a3b" }],
        hardware: { cpu: "Ryzen", ramBytes: 1, gpus: [] },
        maxConcurrentJobs: 2,
        activeJobs: 0,
      },
    },
    { deviceId: "c".repeat(64), name: "asleep", reachable: false },
  ];
  expect(nodeRows(nodes, "0.3.1")).toEqual([
    {
      name: "tower",
      deviceId: `${"b".repeat(12)}…`,
      endpoint: "192.168.68.73:56370",
      reachable: "yes",
      version: "0.3.0",
      skew: true,
      executors: "command, agent, write",
      models: "qwen3.6-35b-a3b",
      load: "0 / 2",
    },
    {
      name: "asleep",
      deviceId: `${"c".repeat(12)}…`,
      endpoint: "—",
      reachable: "no",
      version: "—",
      skew: false,
      executors: "—",
      models: "—",
      load: "—",
    },
  ]);
});

test("job rows prefer paired names and format times/status", () => {
  const now = 10_000_000;
  const jobs: ControlJobs = {
    worker: [
      {
        jobId: "11111111-1111-4111-8111-111111111111",
        type: "command",
        ownerDeviceId: "b".repeat(64),
        repoId: "homefleet",
        status: "failed",
        createdAt: now - 120_000,
        startedAt: now - 60_000,
        terminalAt: now - 1_000,
        errorCode: "INTERNAL",
      },
    ],
    delegated: [
      {
        jobId: "22222222-2222-4222-8222-222222222222",
        type: "write",
        targetDeviceId: "b".repeat(64),
        targetName: "tower",
        repoId: "homefleet",
        recordedAt: now - 30_000,
        lastStatus: "succeeded",
        lastStatusAt: now - 2_000,
        appliedBranch: "homefleet/222222222222",
      },
    ],
  };
  expect(workerJobRows(jobs.worker, now)).toEqual([
    {
      jobId: "11111111-111…",
      type: "command",
      owner: `${"b".repeat(12)}…`,
      repoId: "homefleet",
      status: "failed",
      created: "2m ago",
      started: "1m ago",
      finished: "1s ago",
      error: "INTERNAL",
    },
  ]);
  expect(delegatedJobRows(jobs.delegated, now)).toEqual([
    {
      jobId: "22222222-222…",
      type: "write",
      target: "tower",
      repoId: "homefleet",
      sent: "30s ago",
      status: "succeeded",
      seen: "2s ago",
      branch: "homefleet/222222222222",
    },
  ]);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm vitest run packages/daemon/src/dashboard/view-model.test.ts`. Expected: FAIL (the module is not found).

- [ ] **Step 3: Implement** `packages/daemon/src/dashboard/assets/view-model.js`:

```js
/**
 * Pure display helpers for the HomeFleet dashboard: control-API JSON in,
 * plain strings/objects out. NO DOM access here — app.js owns rendering, and
 * this module stays unit-testable under vitest (see ../view-model.test.ts).
 * Shipped to the browser unmodified (served at /dashboard/view-model.js).
 */

const DASH = "—";

/** @param {string} id */
export function shortId(id) {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** @param {string[]} items */
function list(items) {
  return items.length > 0 ? items.join(", ") : "(none)";
}

/**
 * @param {number | undefined} epochMs
 * @param {number} nowMs
 */
export function relativeTime(epochMs, nowMs) {
  if (epochMs === undefined) {
    return DASH;
  }
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** @param {any} status a ControlStatus */
export function selfRows(status) {
  return [
    ["Name", status.name],
    ["Device ID", status.deviceId],
    ["Platform", status.platform],
    [
      "Version",
      `daemon ${status.daemonVersion} · protocol ${status.protocolVersion}`,
    ],
    [
      "Ports",
      `HFP ${status.hfpPort} · MCP ${status.mcpPort} · control ${status.controlPort}`,
    ],
    ["Roles", list(status.roles)],
    ["Executors", list(status.executors)],
    ["Load", `${status.activeJobs} / ${status.maxConcurrentJobs} jobs running`],
  ];
}

/** @param {any[]} models ModelInfo[] */
export function modelRows(models) {
  return models.map((model) => ({
    id: model.id,
    label: model.label ?? DASH,
    status: model.status ?? DASH,
  }));
}

/**
 * @param {any[]} nodes NodeDirectoryEntry[]
 * @param {string} ourVersion this daemon's daemonVersion
 */
export function nodeRows(nodes, ourVersion) {
  return nodes.map((node) => {
    const info = node.reachable ? node.nodeInfo : undefined;
    return {
      name: node.name,
      deviceId: shortId(node.deviceId),
      endpoint:
        node.host !== undefined && node.port !== undefined
          ? `${node.host}:${node.port}`
          : DASH,
      reachable: node.reachable ? "yes" : "no",
      version: info?.daemonVersion ?? DASH,
      skew: info !== undefined && info.daemonVersion !== ourVersion,
      executors: info !== undefined ? list(info.executors) : DASH,
      models:
        info !== undefined ? list(info.models.map((m) => m.id)) : DASH,
      load:
        info !== undefined
          ? `${info.activeJobs} / ${info.maxConcurrentJobs}`
          : DASH,
    };
  });
}

/**
 * @param {any[]} jobs WorkerJobSummary[]
 * @param {number} nowMs
 */
export function workerJobRows(jobs, nowMs) {
  return jobs.map((job) => ({
    jobId: shortId(job.jobId),
    type: job.type,
    owner: job.ownerName ?? shortId(job.ownerDeviceId),
    repoId: job.repoId,
    status: job.status,
    created: relativeTime(job.createdAt, nowMs),
    started: relativeTime(job.startedAt, nowMs),
    finished: relativeTime(job.terminalAt, nowMs),
    error: job.errorCode ?? "",
  }));
}

/**
 * @param {any[]} jobs DelegatedJobSummary[]
 * @param {number} nowMs
 */
export function delegatedJobRows(jobs, nowMs) {
  return jobs.map((job) => ({
    jobId: shortId(job.jobId),
    type: job.type,
    target: job.targetName ?? shortId(job.targetDeviceId),
    repoId: job.repoId,
    sent: relativeTime(job.recordedAt, nowMs),
    status: job.lastStatus,
    seen: relativeTime(job.lastStatusAt, nowMs),
    branch: job.appliedBranch ?? "",
  }));
}
```

Also create `packages/daemon/src/dashboard/assets/view-model.d.ts`:

```ts
/**
 * Types for view-model.js (plain JS so the browser loads it unmodified).
 * Keep in sync with view-model.js; view-model.test.ts exercises both.
 */
import type {
  ControlStatus,
  DelegatedJobSummary,
  WorkerJobSummary,
} from "../../control/control-server.js";
import type { NodeDirectoryEntry } from "../../mcp/node-directory.js";
import type { ModelInfo } from "@homefleet/protocol";

export function shortId(id: string): string;
export function relativeTime(epochMs: number | undefined, nowMs: number): string;
export function selfRows(status: ControlStatus): Array<[string, string]>;
export function modelRows(
  models: ModelInfo[],
): Array<{ id: string; label: string; status: string }>;
export interface NodeRow {
  name: string;
  deviceId: string;
  endpoint: string;
  reachable: "yes" | "no";
  version: string;
  skew: boolean;
  executors: string;
  models: string;
  load: string;
}
export function nodeRows(
  nodes: NodeDirectoryEntry[],
  ourVersion: string,
): NodeRow[];
export function workerJobRows(
  jobs: WorkerJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
export function delegatedJobRows(
  jobs: DelegatedJobSummary[],
  nowMs: number,
): Array<Record<string, string>>;
```

- [ ] **Step 4: Run the tests and confirm they pass.** Then run `pnpm typecheck` and `pnpm lint`.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/dashboard/assets/view-model.js packages/daemon/src/dashboard/assets/view-model.d.ts packages/daemon/src/dashboard/view-model.test.ts
git commit -m "Dashboard: pure view-model for status, nodes and jobs"
git push
```

---

### Task 9: Client page (`app.js`, `app.css`), asset registration, static scan

**Files:**
- Create: `packages/daemon/src/dashboard/assets/app.js`, `packages/daemon/src/dashboard/assets/app.css`, `packages/daemon/src/dashboard/assets.scan.test.ts`
- Modify: `packages/daemon/src/dashboard/static.ts`, `packages/daemon/src/dashboard/static.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - Append to `static.test.ts`:

```ts
test("the page's script, view model and stylesheet are served with exact types", () => {
  expect(lookupStaticAsset("/dashboard/app.js")?.contentType).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/view-model.js")?.contentType).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/app.css")?.contentType).toBe(
    "text/css; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/app.js")?.body).toContain(
    "/control/jobs",
  );
});
```

  - Create `packages/daemon/src/dashboard/assets.scan.test.ts`:

```ts
/**
 * Static enforcement of the dashboard's XSS/CSRF discipline (spec:
 * "XSS discipline"). The page shares an origin with the control API's
 * mutating pair/* routes, so the client must never render data as HTML and
 * must never issue a non-GET request. The CSP is the second layer; this is
 * the first.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const assetsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets",
);

async function assetSources(ext: string): Promise<Array<[string, string]>> {
  const names = (await readdir(assetsDir)).filter((n) => n.endsWith(ext));
  return Promise.all(
    names.map(
      async (n) =>
        [n, await readFile(path.join(assetsDir, n), "utf8")] as [
          string,
          string,
        ],
    ),
  );
}

const FORBIDDEN_JS: RegExp[] = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /insertAdjacentHTML/,
  /document\.write/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /set(?:Timeout|Interval)\(\s*["'`]/,
  /XMLHttpRequest/,
  /sendBeacon/,
  /\bmethod\s*:\s*["'`](?!GET["'`])/,
];

test("client JS contains no HTML/eval sinks and no non-GET request", async () => {
  const sources = await assetSources(".js");
  expect(sources.map(([n]) => n).sort()).toEqual(["app.js", "view-model.js"]);
  for (const [name, source] of sources) {
    for (const pattern of FORBIDDEN_JS) {
      expect({ name, hit: pattern.test(source) }).toEqual({
        name,
        hit: false,
      });
    }
  }
});

test("every fetch in app.js is an explicit GET", async () => {
  const source = await readFile(path.join(assetsDir, "app.js"), "utf8");
  const fetches = source.match(/\bfetch\(/g) ?? [];
  expect(fetches).toHaveLength(1);
  expect(source).toMatch(/method:\s*"GET"/);
});

test("index.html has no inline script, inline handlers, or inline styles", async () => {
  const html = await readFile(path.join(assetsDir, "index.html"), "utf8");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run packages/daemon/src/dashboard`. Expected: FAIL (the assets are missing and `app.js` is not found).

- [ ] **Step 3: Implement** `packages/daemon/src/dashboard/assets/app.js`:

```js
/**
 * Dashboard DOM glue: polls the control API and renders it. READ-ONLY by
 * construction — the only network call is the GET in getJson(), and every
 * value reaches the DOM through textContent (never innerHTML). Both rules
 * are enforced by ../assets.scan.test.ts; the page's CSP backs them up.
 */
import {
  delegatedJobRows,
  modelRows,
  nodeRows,
  selfRows,
  workerJobRows,
} from "./view-model.js";

const POLL_MS = 3000;
let lastSuccessAt;
let timer;

async function getJson(path) {
  const response = await fetch(path, {
    method: "GET",
    headers: { "x-homefleet-control": "1" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.json();
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

function renderKv(container, pairs) {
  const dl = el("dl", undefined, "kv");
  for (const [label, value] of pairs) {
    dl.append(el("dt", label), el("dd", value));
  }
  container.replaceChildren(dl);
}

/**
 * @param columns Array<[key, header]>
 * @param rows objects whose values are strings
 * @param cellClass optional (key, row) => className | undefined
 */
function renderTable(container, columns, rows, emptyText, cellClass) {
  if (rows.length === 0) {
    container.replaceChildren(el("p", emptyText, "muted"));
    return;
  }
  const table = el("table");
  const headRow = el("tr");
  for (const [, header] of columns) {
    headRow.append(el("th", header));
  }
  table.append(el("thead"));
  table.tHead.append(headRow);
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const [key] of columns) {
      tr.append(el("td", String(row[key]), cellClass?.(key, row)));
    }
    body.append(tr);
  }
  table.append(body);
  container.replaceChildren(table);
}

const statusClass = (key, row) =>
  key === "status" ? `status status-${row.status}` : undefined;

function render(status, nodes, jobs, now) {
  renderKv(document.getElementById("self"), selfRows(status));
  renderTable(
    document.getElementById("models"),
    [
      ["id", "Model"],
      ["label", "Label"],
      ["status", "Catalog status"],
    ],
    modelRows(status.models),
    "No models advertised.",
    statusClass,
  );
  const peers = nodeRows(nodes, status.daemonVersion).map((row) => ({
    ...row,
    version: row.skew ? `${row.version} (differs from ours)` : row.version,
  }));
  renderTable(
    document.getElementById("nodes"),
    [
      ["name", "Name"],
      ["deviceId", "Device"],
      ["endpoint", "Endpoint"],
      ["reachable", "Reachable"],
      ["version", "Version"],
      ["executors", "Executors"],
      ["models", "Models"],
      ["load", "Load"],
    ],
    peers,
    "No paired nodes yet. Pair one with `homefleet pair begin` / `pair connect`.",
    (key, row) => {
      if (key === "reachable") {
        return row.reachable === "yes" ? "ok" : "bad";
      }
      if (key === "version" && row.skew) {
        return "warn";
      }
      return undefined;
    },
  );
  renderTable(
    document.getElementById("worker-jobs"),
    [
      ["jobId", "Job"],
      ["type", "Type"],
      ["owner", "From"],
      ["repoId", "Repo"],
      ["status", "Status"],
      ["created", "Created"],
      ["started", "Started"],
      ["finished", "Finished"],
      ["error", "Error"],
    ],
    workerJobRows(jobs.worker, now),
    "No worker jobs since the daemon started.",
    statusClass,
  );
  renderTable(
    document.getElementById("delegated-jobs"),
    [
      ["jobId", "Job"],
      ["type", "Type"],
      ["target", "To"],
      ["repoId", "Repo"],
      ["sent", "Sent"],
      ["status", "Last seen status"],
      ["seen", "Seen"],
      ["branch", "Applied branch"],
    ],
    delegatedJobRows(jobs.delegated, now),
    "No delegated jobs since the daemon started.",
    statusClass,
  );
}

async function refresh() {
  const banner = document.getElementById("banner");
  try {
    const [status, nodes, jobs] = await Promise.all([
      getJson("/control/status"),
      getJson("/control/nodes"),
      getJson("/control/jobs"),
    ]);
    const now = Date.now();
    render(status, nodes.nodes, jobs, now);
    lastSuccessAt = now;
    banner.hidden = true;
    document.getElementById("updated").textContent =
      `Updated ${new Date(now).toLocaleTimeString()}`;
  } catch (error) {
    const last =
      lastSuccessAt === undefined
        ? "never"
        : new Date(lastSuccessAt).toLocaleTimeString();
    banner.textContent = `Daemon unreachable (${error instanceof Error ? error.message : "request failed"}). Last update: ${last}. Retrying…`;
    banner.hidden = false;
  }
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) {
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, POLL_MS);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
  } else {
    refresh().then(schedule);
  }
});
document.getElementById("refresh").addEventListener("click", () => {
  refresh().then(schedule);
});
refresh().then(schedule);
```

Create `packages/daemon/src/dashboard/assets/app.css`:

```css
:root {
  color-scheme: light dark;
  --fg: #1d2330;
  --muted: #66707f;
  --bg: #f6f7f9;
  --card: #ffffff;
  --line: #dde1e7;
  --ok: #1a7f37;
  --bad: #c62828;
  --warn: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6e9ef;
    --muted: #9aa3b2;
    --bg: #14171c;
    --card: #1c2027;
    --line: #2c323c;
    --ok: #4ac26b;
    --bad: #ff7b72;
    --warn: #d29922;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg);
  background: var(--bg);
}
header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--card);
}
header h1 { font-size: 18px; margin: 0; flex: 1; }
main { padding: 16px 20px; display: grid; gap: 16px; }
section {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
}
h2 { font-size: 15px; margin: 0 0 8px; }
h3 { font-size: 13px; margin: 12px 0 6px; color: var(--muted); }
.muted { color: var(--muted); margin: 0 0 8px; }
.banner {
  margin: 12px 20px 0;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--bad);
  color: var(--bad);
}
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; }
.ok, .status-ok, .status-succeeded { color: var(--ok); }
.bad, .status-failed, .status-unreachable { color: var(--bad); }
.warn, .status-canceled { color: var(--warn); }
button {
  font: inherit;
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  cursor: pointer;
}
```

(`.status-unreachable` covers a catalog model status. Check `ModelStatusSchema` in `packages/protocol/src/node.ts` and add a class for every non-`ok` value it defines, mapped to `--bad` or `--warn` as appropriate.)

Register the assets in `static.ts`: add the imports

```ts
import appCss from "./assets/app.css?raw";
import appJs from "./assets/app.js?raw";
import viewModelJs from "./assets/view-model.js?raw";
```

and the entries in `ASSETS`:

```ts
  ["/dashboard/app.js", { body: appJs, contentType: "text/javascript; charset=utf-8" }],
  ["/dashboard/view-model.js", { body: viewModelJs, contentType: "text/javascript; charset=utf-8" }],
  ["/dashboard/app.css", { body: appCss, contentType: "text/css; charset=utf-8" }],
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run packages/daemon/src/dashboard packages/daemon/src/control`, then `pnpm typecheck && pnpm lint`. If Biome flags `app.js` (for example implicit globals), fix the code. Don't disable rules.

- [ ] **Step 5: Smoke-test in a browser.** Build and run a throwaway daemon on ephemeral ports against a temp data dir. Do **not** touch the real `%LOCALAPPDATA%\homefleet` or the running v0.3.1 daemon on 56373. Set `HOMEFLEET_DATA_DIR` if `resolveDataDir` honours it (check `packages/daemon/src/config/paths.ts`); write a `config.json` there with `{"hfp":{"port":0},"mcp":{"port":0},"control":{"port":56390},"discovery":{"mdnsEnabled":false,"udpEnabled":false}}`, build with `pnpm --filter @homefleet/daemon build`, and start `node packages/daemon/dist/bin/homefleetd.js`. Then:
  - Open `http://127.0.0.1:56390/` in the built-in browser.
  - Check that the self section renders, the empty states show, and the browser console reports no CSP violations.
  - Stop the daemon and confirm the unreachable banner appears within about 3 seconds.
  - Restart the daemon and confirm it recovers.

  Record what you saw in the task report. Stop the throwaway daemon afterwards. Note that `pnpm build` overwrites `packages/daemon/dist/bin`, which the S1 rules say another session may rely on: if `git status`/`git log` shows another session active, use `pnpm exec tsup --out-dir <scratch>` from `packages/daemon` instead.

- [ ] **Step 6: Commit.**

```bash
git add packages/daemon/src/dashboard/assets/app.js packages/daemon/src/dashboard/assets/app.css packages/daemon/src/dashboard/assets.scan.test.ts packages/daemon/src/dashboard/static.ts packages/daemon/src/dashboard/static.test.ts
git commit -m "Dashboard: page script, styles, and static XSS/GET-only scan"
git push
```

---

### Task 10: `homefleet dashboard` CLI command

**Files:**
- Create: `packages/daemon/src/cli/open-url.ts`, `packages/daemon/src/cli/open-url.test.ts`
- Modify: `packages/daemon/src/cli/cli.ts`, `packages/daemon/src/cli/cli.test.ts`, `packages/daemon/src/bin/homefleet.ts`

- [ ] **Step 1: Write the failing tests.**
  - Create `packages/daemon/src/cli/open-url.test.ts`:

```ts
import { expect, test } from "vitest";
import { openUrlCommand } from "./open-url.js";

const URL = "http://127.0.0.1:56373/";

test("windows uses rundll32's URL handler (no cmd.exe parsing of the URL)", () => {
  expect(openUrlCommand(URL, "win32")).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", URL],
  });
});

test("macOS uses open, everything else xdg-open", () => {
  expect(openUrlCommand(URL, "darwin")).toEqual({ command: "open", args: [URL] });
  expect(openUrlCommand(URL, "linux")).toEqual({
    command: "xdg-open",
    args: [URL],
  });
});
```

  - In `cli.test.ts`, append (reusing `makeHarness`, `fakeConfig` and `fakeControlClient`):

```ts
describe("dashboard", () => {
  test("prints the URL from the live control port and opens it", async () => {
    const harness = makeHarness({
      controlClient: fakeControlClient({
        status: async () => ({
          ...(await fakeControlClient().status()),
          controlPort: 56399,
        }),
      }),
    });
    const opened: string[] = [];
    harness.deps.openUrl = async (url) => {
      opened.push(url);
    };
    const code = await runCli(["dashboard"], harness.deps);
    expect(code).toBe(0);
    expect(harness.stdoutLines).toContain(
      "HomeFleet dashboard: http://127.0.0.1:56399/",
    );
    expect(opened).toEqual(["http://127.0.0.1:56399/"]);
  });

  test("--no-open prints but does not open", async () => {
    const harness = makeHarness();
    const opened: string[] = [];
    harness.deps.openUrl = async (url) => {
      opened.push(url);
    };
    expect(await runCli(["dashboard", "--no-open"], harness.deps)).toBe(0);
    expect(opened).toEqual([]);
    expect(harness.stdoutLines.join("\n")).toContain("http://127.0.0.1:56373/");
  });

  test("an opener failure is a hint, not a failure", async () => {
    const harness = makeHarness();
    harness.deps.openUrl = async () => {
      throw new Error("no browser");
    };
    expect(await runCli(["dashboard"], harness.deps)).toBe(0);
    expect(harness.stderrLines.join("\n")).toContain("no browser");
  });

  test("IPv6 control host is bracketed in the URL", async () => {
    const harness = makeHarness({
      config: fakeConfig({
        control: { host: "::1", port: 56373, dashboard: true },
      } as Partial<DaemonConfig>),
    });
    expect(await runCli(["dashboard", "--no-open"], harness.deps)).toBe(0);
    expect(harness.stdoutLines.join("\n")).toContain("http://[::1]:56373/");
  });

  test("disabled in config exits 1 with an explanation", async () => {
    const harness = makeHarness({
      config: fakeConfig({
        control: { host: "127.0.0.1", port: 56373, dashboard: false },
      } as Partial<DaemonConfig>),
    });
    expect(await runCli(["dashboard"], harness.deps)).toBe(1);
    expect(harness.stderrLines.join("\n")).toContain("control.dashboard");
  });

  test("daemon not running reports unreachable", async () => {
    const harness = makeHarness({
      controlClient: fakeControlClient({
        status: async () => {
          throw new DaemonUnreachableError("127.0.0.1", 56373, new Error("x"));
        },
      }),
    });
    expect(await runCli(["dashboard"], harness.deps)).toBe(1);
    expect(harness.stderrLines.join("\n")).toContain("Is homefleetd running?");
  });

  test("unknown extra argument is a usage error", async () => {
    const harness = makeHarness();
    expect(await runCli(["dashboard", "--nope"], harness.deps)).toBe(2);
  });
});
```

  (If `DaemonUnreachableError`'s constructor signature differs, check `control-client.ts:45` and adapt the call.)

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run packages/daemon/src/cli`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Create `packages/daemon/src/cli/open-url.ts`:

```ts
/**
 * Opens a URL in the user's default browser for `homefleet dashboard`.
 * The command mapping is pure (unit-tested); `openUrl` spawns it detached
 * and never waits for the browser. Windows uses rundll32's URL handler
 * rather than `cmd /c start`, so cmd.exe never parses the URL.
 */
import { spawn } from "node:child_process";

export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

/** Resolves once the opener process has spawned; rejects if it cannot. */
export function openUrl(url: string): Promise<void> {
  const { command, args } = openUrlCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
```

  - In `cli.ts`, add to `CliDeps`:

```ts
  /**
   * Opens a URL in the default browser (real: ./open-url.js `openUrl`).
   * Optional so tests never launch a browser; absent means print-only.
   */
  openUrl?: (url: string) => Promise<void>;
```

  - Add to `USAGE`, after the `status` entry:

```
  homefleet dashboard [--no-open]
      Print the running daemon's read-only dashboard URL and open it in
      the default browser (--no-open: print only).
```

  - Add the handler before `dispatch`:

```ts
async function runDashboard(args: string[], deps: CliDeps): Promise<number> {
  const noOpen = args.includes("--no-open");
  const extra = args.filter((arg) => arg !== "--no-open");
  if (extra.length > 0) {
    deps.stderr(`dashboard: unexpected argument(s): ${extra.join(" ")}`);
    return 2;
  }
  return withControlClient(deps, async (client, config) => {
    if (!config.control.dashboard) {
      deps.stderr(
        "The dashboard is disabled (control.dashboard is false in config.json).",
      );
      return 1;
    }
    // status() proves the daemon is up AND gives the port it actually bound.
    const status = await client.status();
    const host = config.control.host.includes(":")
      ? `[${config.control.host}]`
      : config.control.host;
    const url = `http://${host}:${status.controlPort}/`;
    deps.stdout(`HomeFleet dashboard: ${url}`);
    if (!noOpen && deps.openUrl !== undefined) {
      try {
        await deps.openUrl(url);
      } catch (error) {
        deps.stderr(
          `Could not open a browser (${
            error instanceof Error ? error.message : String(error)
          }); open the URL above by hand.`,
        );
      }
    }
    return 0;
  });
}
```

  - Add `case "dashboard": return runDashboard(rest, deps);` to the `dispatch` switch.
  - In `bin/homefleet.ts`, add `import { openUrl } from "../cli/open-url.js";` and `openUrl,` to the `deps` literal.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run packages/daemon/src/cli`, then `pnpm typecheck && pnpm lint`.

- [ ] **Step 5: Commit.**

```bash
git add packages/daemon/src/cli/open-url.ts packages/daemon/src/cli/open-url.test.ts packages/daemon/src/cli/cli.ts packages/daemon/src/cli/cli.test.ts packages/daemon/src/bin/homefleet.ts
git commit -m "CLI: homefleet dashboard [--no-open]"
git push
```

---

### Task 11: Assembled-daemon integration test

**Files:**
- Modify: `packages/daemon/src/daemon.control.integration.test.ts`

- [ ] **Step 1: Write the test.** The helpers come from `test-fixtures.ts`: `h.makeSrcRepo`, `h.startDaemon`, `delegatorOverrides`, `h.pair`, `h.connectMcp`, `h.waitUntil`. The flow copies `daemon.integration.test.ts`'s first test. Add `delegatorOverrides` to the `./test-fixtures.js` import and `import { JobResultOutputSchema } from "./mcp/tools.js";` (check where `daemon.integration.test.ts` imports `JobResultOutputSchema` from and use the same module). Then append:

```ts
/** GET against a daemon's control port; `withHeader` adds the CSRF header. */
async function controlGet(
  daemon: Daemon,
  path: string,
  withHeader: boolean,
): Promise<Response> {
  return fetch(`http://${HOST}:${daemon.controlPort}${path}`, {
    headers: withHeader ? { "x-homefleet-control": "1" } : {},
  });
}

test("the assembled daemon serves the dashboard and lists jobs on both sides of a delegation", async () => {
  const src = await h.makeSrcRepo("dashboard integration");
  const { daemon: worker } = await h.startDaemon("worker", {
    executors: {
      command: { allowlist: { node: { executable: process.execPath } } },
    },
    workspace: { allowedRepoIds: ["repo-x"] },
  });
  const { daemon: delegator } = await h.startDaemon(
    "delegator",
    delegatorOverrides(worker, src),
  );
  await h.pair(delegator, worker);

  // The page itself: no control header needed, strict CSP present.
  const page = await controlGet(delegator, "/", false);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  expect(await page.text()).toContain("data-homefleet-dashboard");

  const mcp = await h.connectMcp(delegator);
  const delegated = await mcp.callTool({
    name: "delegate_task",
    arguments: {
      node: worker.deviceId,
      task: {
        type: "command",
        workspace: { repoId: "repo-x" },
        command: "node",
        args: ["-e", "process.stdout.write('ok')"],
      },
    },
  });
  expect(delegated.isError).toBeFalsy();
  const { jobId } = (delegated.structuredContent ?? {}) as { jobId: string };
  await h.waitUntil(async () => {
    const r = await mcp.callTool({ name: "job_result", arguments: { jobId } });
    return JobResultOutputSchema.parse(r.structuredContent).result !== null;
  });

  // Delegator side: the job is listed with the worker's paired name and the
  // terminal status job_result observed.
  const mine = (await (await controlGet(delegator, "/control/jobs", true)).json()) as {
    worker: unknown[];
    delegated: Array<Record<string, unknown>>;
  };
  expect(mine.worker).toEqual([]);
  expect(mine.delegated[0]).toMatchObject({
    jobId,
    type: "command",
    targetDeviceId: worker.deviceId,
    targetName: "worker",
    repoId: "repo-x",
    lastStatus: "succeeded",
  });

  // Worker side: the same job, owned by the delegator, metadata only.
  const theirs = (await (await controlGet(worker, "/control/jobs", true)).json()) as {
    worker: Array<Record<string, unknown>>;
    delegated: unknown[];
  };
  expect(theirs.delegated).toEqual([]);
  expect(theirs.worker[0]).toMatchObject({
    jobId,
    type: "command",
    ownerDeviceId: delegator.deviceId,
    ownerName: "delegator",
    status: "succeeded",
  });
  expect(theirs.worker[0]).not.toHaveProperty("params");
  expect(theirs.worker[0]).not.toHaveProperty("result");

  // The data route still refuses a header-less request.
  expect((await controlGet(worker, "/control/jobs", false)).status).toBe(403);
}, 90_000);
```

If `h.pair` records the paired names differently (for example, the worker records the delegator under another name), check `test-fixtures.ts`'s `pair` and `startDaemon` and assert the actual name. Don't loosen to `expect.any(String)` unless the name is genuinely nondeterministic.

- [ ] **Step 2: Run it.** Run `pnpm vitest run packages/daemon/src/daemon.control.integration.test.ts`. Expected: PASS. Tasks 3–7 already implemented the behaviour, so a failure here is a real wiring bug. Debug it with superpowers:systematic-debugging rather than editing the assertions.

- [ ] **Step 3: Run the full gate** with `pnpm typecheck && pnpm lint && pnpm test`. Expected: all green.

- [ ] **Step 4: Commit.**

```bash
git add packages/daemon/src/daemon.control.integration.test.ts
git commit -m "Integration: assembled daemon serves the dashboard and lists jobs both ways"
git push
```

---

### Task 12: Docs, rig check, devlog

**Files:**
- Modify: `docs/reference/configuration.md`, `README.md`, `docs/backlog.md`, `docs/specs/2026-07-12-backlog-structuring.md`, `docs/specs/2026-09-24-read-only-dashboard-design.md` (status line)
- Create: `devlog/<date>-read-only-dashboard.md` (use the actual date)

- [ ] **Step 1: Update `configuration.md`.** In the `## control` section, add a table row:

`| \`dashboard\` | boolean | \`true\` | Serve the read-only web dashboard at \`http://<host>:<port>/\` (open it with \`homefleet dashboard\`). \`false\` 404s the page; the JSON routes the CLI uses stay up. |`

Also extend the section intro to "the `homefleet` CLI uses for `pair`/`nodes`/`status`, and the read-only dashboard".

- [ ] **Step 2: Update `README.md`.** Find the section that lists the CLI commands (`grep -n "homefleet status" README.md`) and add `homefleet dashboard`, with one line: "opens the read-only web dashboard (this node, paired nodes, recent jobs) served by the local daemon on 127.0.0.1".

- [ ] **Step 3: Update the backlog and sequencing.**
  - In `docs/backlog.md` A1, add a sentence: "The read-only viewing half shipped as the dashboard (spec `specs/2026-09-24-read-only-dashboard-design.md`); A1 now means the mutations."
  - In `2026-07-12-backlog-structuring.md` → "Approved sequencing", annotate the read-only dashboard line as done, with the date.
  - Set the dashboard spec's status to "implemented".

- [ ] **Step 4: Rig check (manual, on the laptop).** This needs a daemon built from this branch. The installed v0.3.1 lacks the dashboard. Either ask Hugo whether to cut a v0.3.2/v0.4.0 release (follow `docs/reference/releasing.md`; releasing is his call, **ask first**) or run the checkout's build on the laptop temporarily. Follow the rig memory's detached-daemon notes and restore the installed daemon afterwards. Then:
  - Run `homefleet dashboard`, open the page, and confirm the tower is listed as reachable with its models.
  - Run one command delegation to the tower (`%LOCALAPPDATA%\homefleet-rig\hf-delegate.mjs`).
  - Watch the delegated row reach `succeeded` after the driver polls `job_result`.

  Record screenshots/observations in the devlog. If a rig check is not possible this session, say so explicitly in the devlog rather than implying it ran.

- [ ] **Step 5: Write the devlog** `devlog/<date>-read-only-dashboard.md`, in the style of `devlog/2026-09-22-s1-packaging.md`. Cover:
  - what shipped
  - the security model (header-exempt static routes, CSP, scan test)
  - the `?raw` embedding decision and the spike result
  - the rig-check result
  - follow-ups: live job events, a tray launcher, a per-boot token if the same-user boundary is ever judged insufficient, and S2 + A1 next

- [ ] **Step 6: Commit.**

```bash
git add docs/reference/configuration.md README.md docs/backlog.md docs/specs/2026-07-12-backlog-structuring.md docs/specs/2026-09-24-read-only-dashboard-design.md devlog/<date>-read-only-dashboard.md
git commit -m "Docs + devlog: read-only dashboard"
git push
```

---

## Execution notes

- **Model tiering:** implementer subagents run on `sonnet`. Run the spec-compliance and code-quality review after each task, and the final whole-branch review, on `opus`. Task 3 (the security boundary) and Task 9 (XSS discipline) warrant a careful review; consider `fable` for the final review of the security-relevant diff (`control-server.ts`, `static.ts`, `app.js`).
- **Order:** tasks 1→12 as written. Task 1 gates everything. Tasks 4 and 5 are independent of 2 and 3, but run them sequentially anyway: this is a shared checkout.
