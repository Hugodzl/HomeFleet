# S1 Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each `v*` tag produces `homefleet-<version>.tgz` on a GitHub Release, installable with `npm i -g <url>`. The install puts `homefleetd`, `homefleet` and `homefleet-mcp-stdio` on PATH on Windows and Linux.

**Spec:** [`docs/specs/2026-07-12-s1-packaging-design.md`](../specs/2026-07-12-s1-packaging-design.md) (approved 2026-07-12, approach A: rewrite the publish manifest of `@homefleet/daemon`).

**Architecture:** A `tsx` script under `scripts/` builds the daemon. It stages `dist/bin`, `LICENSE` and a generated `package.json` (from a pure `buildPublishManifest`), then runs `npm pack`. A tag-triggered workflow reuses the CI gate, packs, installs the real tarball globally on Ubuntu and Windows, then creates the Release. The workflow can also be run by hand, which does everything except create the Release, so the pipeline can be proven before a tag exists.

**Tech Stack:** TypeScript 6, tsx, vitest 4, tsup (existing), npm CLI (`npm pack --json`), GitHub Actions, `gh release`.

---

## Deviations from the spec (found while planning; flag to Hugo in the devlog)

1. **The entry guard fails under a symlink. This is a real bug, and the smoke would have hidden it.** All three bins gate `main()` on `fileURLToPath(import.meta.url) === process.argv[1]`. When Node runs an ESM entry, it resolves the entry's `import.meta.url` to the file's real path but leaves `argv[1]` as the path it was given. On Linux, `npm i -g` installs each bin as a **symlink** (`<prefix>/bin/homefleet → …/dist/bin/homefleet.js`). The comparison is then false, `main()` never runs, and the process **exits 0 while printing nothing**. The spec's smoke ("must exit 0") would pass on that broken install. Task 1 fixes the guard. Task 7's smoke asserts the **exact `--version` output**, not just the exit code. It couldn't be reproduced on the dev box, because creating symlinks on Windows gives `EPERM` without Developer Mode. Task 1's symlink test skips on `EPERM`, and the Linux CI runner is where it actually runs.
2. **The manifest must keep `"type": "module"`.** The spec's keep-list omits it. The bins are ESM `.js` files, and without `type: module` Node loads them as CommonJS and crashes on `import`. `buildPublishManifest` keeps it and refuses a package that lacks it.
3. **`engines` is added to `@homefleet/daemon`.** The spec says to *keep* `engines`, but only the root `package.json` has one (`node >=20`). Task 2 adds the same field to the daemon package so that "keep" holds literally, and the manifest builder refuses a package without it.
4. **Bin paths are normalized.** `./dist/bin/x.js` becomes `dist/bin/x.js`, so `npm pack` doesn't print its "script name was cleaned" warning.
5. **The workflow can be run by hand (`workflow_dispatch`)**, which the spec didn't mention. Without it, the first real test of the workflow would be a public tag.
6. **The tag guard is a `--tag` flag on the pack script**, not a separate script, and it runs before anything is built. The spec's intent ("fails before packing") is kept.

## File structure

| Path | Status | Responsibility |
| --- | --- | --- |
| `packages/daemon/src/bin/invoked-directly.ts` | create | `isInvokedDirectly(moduleUrl, argv1)`: an entry guard that compares both paths after resolving symlinks |
| `packages/daemon/src/bin/invoked-directly.test.ts` | create | unit tests for the guard, including a real symlink |
| `packages/daemon/src/bin/{homefleetd,homefleet,homefleet-mcp-stdio}.ts` | modify | use the new guard |
| `packages/daemon/package.json` | modify | add `engines` |
| `scripts/package.json` | create | `{"type":"module"}`, so `tsx` runs `scripts/*.ts` as ESM (the root package has no `type`) |
| `scripts/tsconfig.json` | create | typecheck scope for `scripts/` |
| `scripts/lib/publish-manifest.ts` | create | pure `buildPublishManifest` |
| `scripts/lib/publish-manifest.test.ts` | create | unit tests |
| `scripts/lib/tag-version.ts` | create | pure `checkTagVersion` |
| `scripts/lib/tag-version.test.ts` | create | unit tests |
| `scripts/lib/pack.ts` | create | `packRelease` (build → check → stage → `npm pack`) + pure `parsePackReport` |
| `scripts/lib/pack.test.ts` | create | unit tests for `parsePackReport` + the fail-loud path |
| `scripts/lib/pack.integration.test.ts` | create | real build + real `npm pack`; asserts the tarball's file list |
| `scripts/pack-release.ts` | create | thin CLI |
| `package.json` (root) | modify | `pack:release` script; `typecheck` covers `scripts/` |
| `vitest.config.ts` | modify | include `scripts/**/*.test.ts` |
| `.gitignore` | modify | ignore `release/` |
| `.github/workflows/ci.yml` | modify | add `workflow_call` so the release workflow can reuse it as its gate |
| `.github/workflows/release.yml` | create | gate → pack → smoke (Ubuntu + Windows) → release |
| `README.md`, `packages/daemon/README.md`, `docs/reference/releasing.md`, `docs/backlog.md`, `devlog/2026-09-22-s1-packaging.md` | modify / create | docs |

Conventions to match: `.js`-suffixed relative imports in TS, double quotes, 2-space indent (biome), `node:`-prefixed builtins, a short `WHY:` comment wherever a choice isn't obvious. Run `pnpm lint`, `pnpm typecheck` **and** `pnpm test` before every commit. The suite has been green while `tsc` was failing before (devlog 016).

---

### Task 1: Symlink-safe entry guard

**Files:**
- Create: `packages/daemon/src/bin/invoked-directly.ts`
- Create: `packages/daemon/src/bin/invoked-directly.test.ts`
- Modify: `packages/daemon/src/bin/homefleetd.ts:91-96`, `packages/daemon/src/bin/homefleet.ts:36-41`, `packages/daemon/src/bin/homefleet-mcp-stdio.ts:107-112`

- [ ] **Step 1: Write the failing test**

`packages/daemon/src/bin/invoked-directly.test.ts`:

```ts
/**
 * `npm i -g` installs each bin on Linux/macOS as a SYMLINK into the package's
 * `dist/bin`. Node resolves an ESM entry's `import.meta.url` to the real path
 * but leaves `process.argv[1]` as the path it was given (the link), so a plain
 * string compare silently skips `main()` and the bin exits 0 doing nothing.
 * These tests pin the realpath-based comparison that fixes that.
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isInvokedDirectly } from "./invoked-directly.js";

let dir: string;
let realFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hf-invoked-"));
  realFile = path.join(dir, "real.js");
  await writeFile(realFile, "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("same file → true", () => {
  expect(isInvokedDirectly(pathToFileURL(realFile).href, realFile)).toBe(true);
});

test("a different file → false (imported by a test, not run)", async () => {
  const other = path.join(dir, "other.js");
  await writeFile(other, "");
  expect(isInvokedDirectly(pathToFileURL(realFile).href, other)).toBe(false);
});

test("no argv[1] → false", () => {
  expect(isInvokedDirectly(pathToFileURL(realFile).href, undefined)).toBe(
    false,
  );
});

test("argv[1] that does not exist → false, never throws", () => {
  expect(
    isInvokedDirectly(
      pathToFileURL(realFile).href,
      path.join(dir, "missing.js"),
    ),
  ).toBe(false);
});

test("argv[1] is a symlink to the module → true (the npm -g layout)", async (ctx) => {
  const link = path.join(dir, "homefleet");
  try {
    await symlink(realFile, link, "file");
  } catch (error) {
    // Windows without Developer Mode can't create symlinks; the Linux CI
    // runner is where this case is actually exercised.
    if ((error as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
    throw error;
  }
  expect(link).not.toBe(realFile); // the naive compare would fail here
  expect(isInvokedDirectly(pathToFileURL(realFile).href, link)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/daemon/src/bin/invoked-directly.test.ts`
Expected: FAIL, "Failed to resolve import ./invoked-directly.js" (or "Cannot find module").

- [ ] **Step 3: Implement**

`packages/daemon/src/bin/invoked-directly.ts`:

```ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `moduleUrl` is the process entry point — i.e. the
 * bin was run, not imported by a test.
 *
 * WHY realpath both sides: `npm i -g` installs bins as symlinks on
 * Linux/macOS. Node gives an ESM entry its REAL path as `import.meta.url` but
 * keeps `process.argv[1]` as the link path, so a plain string compare is
 * false and the bin silently exits 0 without running `main()`.
 */
export function isInvokedDirectly(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (argv1 === undefined) return false;
  const modulePath = canonical(fileURLToPath(moduleUrl));
  const entryPath = canonical(argv1);
  return modulePath !== undefined && modulePath === entryPath;
}

function canonical(filePath: string): string | undefined {
  try {
    return realpathSync(filePath);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/daemon/src/bin/invoked-directly.test.ts`
Expected: 4 passed and 1 skipped on this Windows box (symlink EPERM), 5 passed on Linux.

- [ ] **Step 5: Wire it into the three bins**

In each of `homefleetd.ts`, `homefleet.ts` and `homefleet-mcp-stdio.ts`, replace this block:

```ts
// Only run when invoked directly (e.g. via tsx), never when imported by a test.
const invokedPath = process.argv[1] === undefined ? undefined : process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === invokedPath
) {
```

with:

```ts
// Only run when invoked directly (bare node, tsx, or an npm -g symlink/shim),
// never when imported by a test.
if (isInvokedDirectly(import.meta.url, process.argv[1])) {
```

Add `import { isInvokedDirectly } from "./invoked-directly.js";` to each file's imports. If `fileURLToPath` is then unused in a file, remove its `node:url` import (`pnpm lint` flags it).

- [ ] **Step 6: Verify the built bins still run**

Run:
```bash
pnpm build
node packages/daemon/dist/bin/homefleet.js --version
node packages/daemon/dist/bin/homefleetd.js --version
```
Expected: `homefleet 0.2.0` and `homefleetd 0.2.0`.

- [ ] **Step 7: Full gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`. Expected: all green.

```bash
git add packages/daemon/src/bin
git commit -m "Bins: entry guard survives an npm -g symlink

Node gives an ESM entry its real path as import.meta.url but keeps argv[1] as
the symlink path, so under a Linux global install the plain compare was false
and every bin exited 0 without running main().

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `scripts/` scaffolding + `buildPublishManifest`

**Files:**
- Create: `scripts/package.json`, `scripts/tsconfig.json`, `scripts/lib/publish-manifest.ts`, `scripts/lib/publish-manifest.test.ts`
- Modify: `vitest.config.ts:5`, root `package.json` (`typecheck`), `packages/daemon/package.json` (add `engines`)

- [ ] **Step 1: Scaffolding**

`scripts/package.json`:
```json
{
  "private": true,
  "type": "module"
}
```
(WHY: the root `package.json` has no `type`, so `tsx` would otherwise treat `scripts/*.ts` as CommonJS, where `import.meta` and top-level `await` aren't available. `scripts/` isn't in `pnpm-workspace.yaml`, so this doesn't create a workspace package.)

`scripts/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "include": ["."]
}
```

In `vitest.config.ts`, change the `include` line to:
```ts
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
```

In the root `package.json`, change `"typecheck"` to:
```json
    "typecheck": "pnpm -r typecheck && tsc -p scripts",
```

In `packages/daemon/package.json`, add after `"type": "module",`:
```json
  "engines": {
    "node": ">=20"
  },
```

- [ ] **Step 2: Write the failing test**

`scripts/lib/publish-manifest.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  buildPublishManifest,
  type DaemonPackageJson,
  REPOSITORY_URL,
} from "./publish-manifest.js";

function daemonPkg(
  overrides: Partial<DaemonPackageJson> = {},
): DaemonPackageJson {
  return {
    name: "@homefleet/daemon",
    version: "1.2.3",
    description: "homefleetd",
    license: "Apache-2.0",
    type: "module",
    engines: { node: ">=20" },
    exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
    bin: {
      homefleet: "./dist/bin/homefleet.js",
      "homefleet-mcp-stdio": "./dist/bin/homefleet-mcp-stdio.js",
      homefleetd: "./dist/bin/homefleetd.js",
    },
    scripts: { build: "tsup", typecheck: "tsc --noEmit" },
    dependencies: {
      "@homefleet/executors": "workspace:*",
      "@homefleet/protocol": "workspace:*",
      "@peculiar/x509": "^2.0.0",
      zod: "^4.4.3",
    },
    ...overrides,
  };
}

describe("buildPublishManifest", () => {
  test("renames to homefleet and keeps version/description/license/type/engines", () => {
    const m = buildPublishManifest(daemonPkg());
    expect(m).toMatchObject({
      name: "homefleet",
      version: "1.2.3",
      description: "homefleetd",
      license: "Apache-2.0",
      type: "module",
      engines: { node: ">=20" },
    });
  });

  test("drops workspace deps (bundled by tsup), keeps third-party deps", () => {
    expect(buildPublishManifest(daemonPkg()).dependencies).toEqual({
      "@peculiar/x509": "^2.0.0",
      zod: "^4.4.3",
    });
  });

  test("normalizes bin paths (no leading ./)", () => {
    expect(buildPublishManifest(daemonPkg()).bin).toEqual({
      homefleet: "dist/bin/homefleet.js",
      "homefleet-mcp-stdio": "dist/bin/homefleet-mcp-stdio.js",
      homefleetd: "dist/bin/homefleetd.js",
    });
  });

  test("ships only dist/bin, adds repository, drops exports and scripts", () => {
    const m = buildPublishManifest(daemonPkg());
    expect(m.files).toEqual(["dist/bin"]);
    expect(m.repository).toEqual({ type: "git", url: REPOSITORY_URL });
    expect(m).not.toHaveProperty("exports");
    expect(m).not.toHaveProperty("scripts");
  });

  test("refuses a non-ESM package (the bins are ESM .js)", () => {
    expect(() => buildPublishManifest(daemonPkg({ type: undefined }))).toThrow(
      /"type": "module"/,
    );
  });

  test("refuses a package with no engines.node", () => {
    expect(() =>
      buildPublishManifest(daemonPkg({ engines: undefined })),
    ).toThrow(/engines\.node/);
  });

  test("fails loud on a non-@homefleet workspace dep (it would not be bundled)", () => {
    expect(() =>
      buildPublishManifest(
        daemonPkg({ dependencies: { "some-local-lib": "workspace:*" } }),
      ),
    ).toThrow(/some-local-lib/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run scripts/lib/publish-manifest.test.ts`
Expected: FAIL, the import `./publish-manifest.js` can't be resolved.

- [ ] **Step 4: Implement**

`scripts/lib/publish-manifest.ts`:

```ts
/**
 * Rewrites `@homefleet/daemon`'s package.json into the manifest shipped in
 * the release tarball (S1 spec §2). Pure: no I/O, so every rule is unit-tested.
 */

export const PUBLISH_NAME = "homefleet";
export const REPOSITORY_URL = "git+https://github.com/Hugodzl/HomeFleet.git";

export interface DaemonPackageJson {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  engines?: { node?: string };
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface PublishManifest {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type: "module";
  engines: { node: string };
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  repository: { type: "git"; url: string };
}

export function buildPublishManifest(pkg: DaemonPackageJson): PublishManifest {
  if (pkg.type !== "module") {
    throw new Error(
      `${pkg.name} must declare "type": "module" — its bins are ESM .js files`,
    );
  }
  const node = pkg.engines?.node;
  if (node === undefined) {
    throw new Error(`${pkg.name} must declare engines.node`);
  }

  // WHY drop @homefleet/*: tsup's noExternal bundles every first-party
  // workspace package into the bins, so they are not runtime deps.
  const dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).filter(
      ([name]) => !name.startsWith("@homefleet/"),
    ),
  );
  // Asserted, not assumed: anything still pointing into the workspace would
  // be unresolvable from the registry at install time.
  for (const [name, spec] of Object.entries(dependencies)) {
    if (spec.startsWith("workspace:")) {
      throw new Error(
        `dependency ${name}@${spec} is a workspace dep but not @homefleet/* — tsup does not bundle it`,
      );
    }
  }

  const bin = Object.fromEntries(
    Object.entries(pkg.bin).map(([name, target]) => [
      name,
      target.replace(/^\.\//, ""),
    ]),
  );

  return {
    name: PUBLISH_NAME,
    version: pkg.version,
    ...(pkg.description === undefined ? {} : { description: pkg.description }),
    ...(pkg.license === undefined ? {} : { license: pkg.license }),
    type: "module",
    engines: { node },
    bin,
    files: ["dist/bin"],
    dependencies,
    repository: { type: "git", url: REPOSITORY_URL },
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run scripts/lib/publish-manifest.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Full gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`. Expected: all green, and `typecheck` now also runs `tsc -p scripts`.

```bash
git add scripts vitest.config.ts package.json packages/daemon/package.json
git commit -m "S1: buildPublishManifest + scripts/ scaffolding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `checkTagVersion`

**Files:**
- Create: `scripts/lib/tag-version.ts`, `scripts/lib/tag-version.test.ts`

- [ ] **Step 1: Write the failing test**

`scripts/lib/tag-version.test.ts`:

```ts
import { expect, test } from "vitest";
import { checkTagVersion } from "./tag-version.js";

test("matching tag passes", () => {
  expect(() => checkTagVersion("v0.3.0", "0.3.0")).not.toThrow();
});

test("prerelease tag matching a prerelease version passes", () => {
  expect(() => checkTagVersion("v0.3.0-rc.1", "0.3.0-rc.1")).not.toThrow();
});

test("mismatched tag fails and names both versions", () => {
  expect(() => checkTagVersion("v0.3.0", "0.2.0")).toThrow(
    /v0\.3\.0.*0\.2\.0/,
  );
});

test("a tag that is not v<semver> fails", () => {
  expect(() => checkTagVersion("0.3.0", "0.3.0")).toThrow(/v<semver>/);
  expect(() => checkTagVersion("v0.3", "0.3")).toThrow(/v<semver>/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/lib/tag-version.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`scripts/lib/tag-version.ts`:

```ts
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Release guard (S1 spec §3): the pushed tag must name exactly the version
 * being packed, so a Release can never carry a mislabeled tarball.
 */
export function checkTagVersion(tag: string, version: string): void {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(`release tag "${tag}" is not of the form v<semver>`);
  }
  if (match[1] !== version) {
    throw new Error(
      `release tag ${tag} does not match @homefleet/daemon version ${version} — bump the version (and DAEMON_VERSION) or fix the tag`,
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run scripts/lib/tag-version.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`.

```bash
git add scripts/lib/tag-version.ts scripts/lib/tag-version.test.ts
git commit -m "S1: tag/version release guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `packRelease` core (unit-tested parts)

**Files:**
- Create: `scripts/lib/pack.ts`, `scripts/lib/pack.test.ts`

- [ ] **Step 1: Write the failing test**

`scripts/lib/pack.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { packRelease, parsePackReport } from "./pack.js";

describe("parsePackReport", () => {
  test("reads filename and file paths from npm pack --json", () => {
    const stdout = JSON.stringify([
      {
        filename: "homefleet-1.2.3.tgz",
        files: [{ path: "package.json" }, { path: "dist/bin/homefleet.js" }],
      },
    ]);
    expect(parsePackReport(stdout)).toEqual({
      filename: "homefleet-1.2.3.tgz",
      files: ["package.json", "dist/bin/homefleet.js"],
    });
  });

  test("tolerates noise before the JSON array", () => {
    const stdout = `npm notice something\n${JSON.stringify([
      { filename: "x-1.0.0.tgz", files: [] },
    ])}`;
    expect(parsePackReport(stdout).filename).toBe("x-1.0.0.tgz");
  });

  test("fails loud on an unexpected shape", () => {
    expect(() => parsePackReport("[]")).toThrow(/npm pack/);
    expect(() => parsePackReport("not json")).toThrow(/npm pack/);
  });
});

describe("packRelease fail-loud checks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-pack-unit-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("refuses to stage when a built bin is missing", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@homefleet/daemon",
        version: "1.2.3",
        type: "module",
        engines: { node: ">=20" },
        bin: { homefleet: "./dist/bin/homefleet.js" },
      }),
    );
    await writeFile(path.join(dir, "LICENSE"), "license");
    await expect(
      packRelease({
        daemonDir: dir,
        licensePath: path.join(dir, "LICENSE"),
        stagingDir: path.join(dir, "staging"),
        outDir: path.join(dir, "out"),
        build: false,
      }),
    ).rejects.toThrow(/missing built bin .*homefleet\.js/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run scripts/lib/pack.test.ts`
Expected: FAIL, the module can't be resolved.

- [ ] **Step 3: Implement**

`scripts/lib/pack.ts`:

```ts
/**
 * Build → check → stage → `npm pack` for the release tarball (S1 spec §2).
 */
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPublishManifest,
  type DaemonPackageJson,
  type PublishManifest,
} from "./publish-manifest.js";

export interface PackOptions {
  /** `packages/daemon` */
  daemonDir: string;
  licensePath: string;
  /** Wiped and recreated on every run. */
  stagingDir: string;
  /** Where `homefleet-<version>.tgz` lands. */
  outDir: string;
  /** Run the daemon's tsup build first (off only for unit tests). */
  build: boolean;
}

export interface PackResult {
  tarballPath: string;
  /** Paths inside the tarball, sorted. */
  files: string[];
  manifest: PublishManifest;
}

export async function packRelease(options: PackOptions): Promise<PackResult> {
  const daemonPkg = JSON.parse(
    await readFile(path.join(options.daemonDir, "package.json"), "utf8"),
  ) as DaemonPackageJson;
  const manifest = buildPublishManifest(daemonPkg);

  if (options.build) {
    run("pnpm", ["--filter", daemonPkg.name, "build"], options.daemonDir);
  }

  for (const binPath of Object.values(manifest.bin)) {
    const absolute = path.join(options.daemonDir, binPath);
    try {
      await access(absolute);
    } catch {
      throw new Error(
        `pack-release: missing built bin ${absolute} — run the daemon build first`,
      );
    }
  }

  await rm(options.stagingDir, { recursive: true, force: true });
  await mkdir(path.join(options.stagingDir, "dist"), { recursive: true });
  await cp(
    path.join(options.daemonDir, "dist", "bin"),
    path.join(options.stagingDir, "dist", "bin"),
    { recursive: true },
  );
  await cp(options.licensePath, path.join(options.stagingDir, "LICENSE"));
  await writeFile(
    path.join(options.stagingDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await mkdir(options.outDir, { recursive: true });
  const report = parsePackReport(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", options.outDir],
      options.stagingDir,
    ),
  );
  return {
    tarballPath: path.join(options.outDir, report.filename),
    files: [...report.files].sort(),
    manifest,
  };
}

export function parsePackReport(stdout: string): {
  filename: string;
  files: string[];
} {
  const start = stdout.indexOf("[");
  let parsed: unknown;
  try {
    parsed = JSON.parse(start === -1 ? stdout : stdout.slice(start));
  } catch {
    throw new Error(`npm pack --json produced unparseable output:\n${stdout}`);
  }
  const entry = (Array.isArray(parsed) ? parsed[0] : undefined) as
    | { filename?: unknown; files?: unknown }
    | undefined;
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.filename !== "string" ||
    !Array.isArray(entry.files)
  ) {
    throw new Error(`npm pack --json produced an unexpected shape:\n${stdout}`);
  }
  return {
    filename: entry.filename,
    files: (entry.files as { path: string }[]).map((file) => file.path),
  };
}

/**
 * Runs a package-manager CLI and returns its stdout.
 *
 * WHY a shell on Windows: `npm`/`pnpm` are `.cmd` shims there, and Node ≥20.12
 * refuses to spawn `.cmd` files without one. Args go in one quoted command
 * string rather than as an array with `shell: true` (deprecated, DEP0190).
 */
function run(command: string, args: string[], cwd: string): string {
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync([command, ...args.map(quoteForCmd)].join(" "), {
        cwd,
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
    : spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pack-release: \`${command} ${args.join(" ")}\` exited ${result.status}`,
    );
  }
  return result.stdout;
}

function quoteForCmd(arg: string): string {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
```

(Hand-validated on purpose: don't add a zod dependency to the root just for this.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run scripts/lib/pack.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`.

```bash
git add scripts/lib/pack.ts scripts/lib/pack.test.ts
git commit -m "S1: packRelease core (stage + npm pack, fail-loud bin check)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Real-I/O integration test of the pack

**Files:**
- Create: `scripts/lib/pack.integration.test.ts`

- [ ] **Step 1: Write the test**

`scripts/lib/pack.integration.test.ts`:

```ts
/**
 * Real-I/O tier: runs the actual daemon build and a real `npm pack` against
 * packages/daemon, then asserts exactly what the tarball ships.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type PackResult, packRelease } from "./pack.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const daemonDir = path.join(repoRoot, "packages", "daemon");

let workDir: string;
let result: PackResult;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "hf-pack-int-"));
  result = await packRelease({
    daemonDir,
    licensePath: path.join(repoRoot, "LICENSE"),
    stagingDir: path.join(workDir, "staging"),
    outDir: path.join(workDir, "out"),
    build: true,
  });
}, 180_000); // a tsup build + npm pack; slow on Windows runners

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("tarball is homefleet-<daemon version>.tgz and exists", async () => {
  const daemonPkg = JSON.parse(
    await readFile(path.join(daemonDir, "package.json"), "utf8"),
  ) as { version: string };
  expect(path.basename(result.tarballPath)).toBe(
    `homefleet-${daemonPkg.version}.tgz`,
  );
  await access(result.tarballPath);
});

test("ships exactly LICENSE, package.json and dist/bin — nothing else", () => {
  expect(result.files).toEqual(
    [
      "LICENSE",
      "dist/bin/homefleet-mcp-stdio.js",
      "dist/bin/homefleet-mcp-stdio.js.map",
      "dist/bin/homefleet.js",
      "dist/bin/homefleet.js.map",
      "dist/bin/homefleetd.js",
      "dist/bin/homefleetd.js.map",
      "package.json",
    ].sort(),
  );
});

test("staged manifest has zero @homefleet/* deps", async () => {
  const staged = JSON.parse(
    await readFile(path.join(workDir, "staging", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(
    Object.keys(staged.dependencies).filter((name) =>
      name.startsWith("@homefleet/"),
    ),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run scripts/lib/pack.integration.test.ts`
Expected: 3 passed. If the file list differs (for example, npm adds a `README` it found), the test is right and the staging is wrong. Fix the staging, not the expectation, unless the extra file is one the spec intends to ship.

- [ ] **Step 3: Gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`.

```bash
git add scripts/lib/pack.integration.test.ts
git commit -m "S1: real build + npm pack integration test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `pack-release` CLI + root wiring

**Files:**
- Create: `scripts/pack-release.ts`
- Modify: root `package.json` (`scripts`), `.gitignore`

- [ ] **Step 1: Implement the CLI**

`scripts/pack-release.ts`:

```ts
/**
 * pnpm pack:release [--tag vX.Y.Z] [--out <dir>]
 *
 * Builds the daemon and packs the release tarball into <out> (default
 * `release/`), printing its path as the last stdout line. With --tag, refuses
 * before building when the tag does not name the daemon's version.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packRelease } from "./lib/pack.js";
import { checkTagVersion } from "./lib/tag-version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonDir = path.join(repoRoot, "packages", "daemon");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      out: { type: "string", default: "release" },
    },
  });
  if (values.tag !== undefined) {
    const { version } = JSON.parse(
      await readFile(path.join(daemonDir, "package.json"), "utf8"),
    ) as { version: string };
    checkTagVersion(values.tag, version);
  }
  const outDir = path.resolve(repoRoot, values.out);
  const result = await packRelease({
    daemonDir,
    licensePath: path.join(repoRoot, "LICENSE"),
    stagingDir: path.join(outDir, "staging"),
    outDir,
    build: true,
  });
  process.stdout.write(`${result.tarballPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pack-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
```

Root `package.json` `scripts`: add
```json
    "pack:release": "tsx scripts/pack-release.ts",
```

`.gitignore`: add a line `release/` under `dist/`.

- [ ] **Step 2: Verify by hand**

Run:
```bash
pnpm pack:release
pnpm pack:release --tag v9.9.9
```
Expected: the first prints `…\release\homefleet-0.2.0.tgz`. The second exits 1 with `pack-release: release tag v9.9.9 does not match @homefleet/daemon version 0.2.0 …` and **without** building (no tsup output).

- [ ] **Step 3: Verify the tarball installs into an isolated prefix (Windows `.cmd` shims)**

This doesn't touch the user's real global npm.

Run (PowerShell):
```powershell
$prefix = Join-Path $env:TEMP "hf-prefix-test"
npm i -g --prefix $prefix .\release\homefleet-0.2.0.tgz
& "$prefix\homefleet.cmd" --version
& "$prefix\homefleetd.cmd" --version
Test-Path "$prefix\homefleet-mcp-stdio.cmd"
Remove-Item -Recurse -Force $prefix
```
Expected: `homefleet 0.2.0`, `homefleetd 0.2.0`, `True`. This step needs network access to fetch the third-party deps.

- [ ] **Step 4: Gate + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`. Also run `git status` and confirm that `release/` doesn't show up.

```bash
git add scripts/pack-release.ts package.json .gitignore
git commit -m "S1: pnpm pack:release CLI with --tag guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Release workflow

**Files:**
- Modify: `.github/workflows/ci.yml:3-7`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Make CI reusable**

In `ci.yml`, change the `on:` block to:
```yaml
on:
  push:
    branches: [main]
  pull_request:
  workflow_call:
```

- [ ] **Step 2: Write the release workflow**

`.github/workflows/release.yml`:

```yaml
name: Release

# A v* tag packs, smokes and publishes a GitHub Release. Run it by hand
# (workflow_dispatch) to exercise pack + smoke on the current branch without
# creating a Release.
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  gate:
    uses: ./.github/workflows/ci.yml

  pack:
    needs: gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Pack (tag must match the daemon version)
        run: |
          if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
            pnpm pack:release --tag "$GITHUB_REF_NAME"
          else
            pnpm pack:release
          fi
      - uses: actions/upload-artifact@v4
        with:
          name: homefleet-tarball
          path: release/*.tgz
          if-no-files-found: error

  # Install the REAL artifact the way a user does: no checkout, no pnpm,
  # deps from the registry, npm-generated shims. Node 20 = the documented floor.
  smoke:
    needs: pack
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: actions/download-artifact@v4
        with:
          name: homefleet-tarball
          path: release
      - name: Global install
        run: npm i -g ./release/homefleet-*.tgz
      - name: Bins print their exact version (exit 0 alone is not enough)
        run: |
          version="$(basename release/homefleet-*.tgz .tgz)"
          version="${version#homefleet-}"
          test "$(homefleet --version)" = "homefleet $version"
          test "$(homefleetd --version)" = "homefleetd $version"
          command -v homefleet-mcp-stdio
      - name: Bins via the PowerShell shims
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $name = (Get-Item release/homefleet-*.tgz).BaseName
          $version = $name.Substring("homefleet-".Length)
          if ((homefleet --version) -ne "homefleet $version") { exit 1 }
          if ((homefleetd --version) -ne "homefleetd $version") { exit 1 }

  release:
    needs: smoke
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: homefleet-tarball
          path: release
      - name: Create the GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: >
          gh release create "$GITHUB_REF_NAME" release/*.tgz
          --repo "$GITHUB_REPOSITORY" --generate-notes --verify-tag
```

- [ ] **Step 3: Commit and push, then run it by hand**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "S1: release workflow (gate, pack, Ubuntu+Windows smoke, Release)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
gh workflow run release.yml --ref main
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```
Expected: `gate`, `pack` and both `smoke` legs are green, and `release` is **skipped** (no tag). If Ubuntu smoke fails with empty `--version` output, Task 1's guard isn't in the built bin, so check that `pack` rebuilt it. Before pushing, confirm `gh auth status` shows `Hugodzl`, per the [[homefleet-github-repo]] memory.

---

### Task 8: Docs

**Files:**
- Modify: `README.md` (new `## Install` before `## Quickstart`; Quickstart commands; `## Development`; `## Roadmap`)
- Modify: `packages/daemon/README.md` (`## Bins`)
- Create: `docs/reference/releasing.md`
- Modify: `docs/backlog.md` (debt list)
- Create: `devlog/2026-09-22-s1-packaging.md`

- [ ] **Step 1: README `## Install`** (insert right before `## Quickstart`)

````markdown
## Install

You need **Node ≥ 20** and git. Install the latest release globally:

```bash
npm i -g https://github.com/Hugodzl/HomeFleet/releases/download/v<version>/homefleet-<version>.tgz
```

(the exact URL is on the [Releases page](https://github.com/Hugodzl/HomeFleet/releases)).
That puts `homefleetd`, `homefleet` and `homefleet-mcp-stdio` on your PATH.
To update, install the newer tarball the same way. Then scaffold the machine
with `homefleet setup` (below).

Working on HomeFleet itself? See [Development](#development) for running from
source.
````

- [ ] **Step 2: Quickstart uses the installed commands**

In `## Quickstart` and `## Two-machine demo`:
- Remove the clone / `pnpm install` / `pnpm build` block, the paragraph explaining that `pnpm build` is required, and the `pnpm link --global` aside. Those move to Development.
- Replace every `node packages/daemon/dist/bin/homefleet.js` with `homefleet`, every `node packages/daemon/dist/bin/homefleetd.js` with `homefleetd`, and every `node packages/daemon/dist/bin/homefleet-mcp-stdio.js` with `homefleet-mcp-stdio`. MCP client config snippets that use an absolute path to the stdio shim become `"command": "homefleet-mcp-stdio"`.
- Change the prerequisite sentence to point at `## Install`. Keep the model-server requirement.

Verify: `grep -n "dist/bin" README.md` only matches inside `## Development`.

- [ ] **Step 3: README `## Development`** — replace the section body with:

````markdown
Running from source instead of a release:

```bash
git clone https://github.com/Hugodzl/HomeFleet.git
cd HomeFleet
pnpm install     # pnpm 11 — `corepack enable` is the easiest way
pnpm build       # tsup — required before running any packages/daemon bin
node packages/daemon/dist/bin/homefleet.js --help
```

The bins are plain, bare-`node`-runnable ESM files; substitute
`node packages/daemon/dist/bin/<bin>.js` for the bare commands used above.

```bash
pnpm test          # vitest (includes a real build + npm pack of the release tarball)
pnpm typecheck     # tsc across packages and scripts/
pnpm lint          # biome
pnpm pack:release  # build release/homefleet-<version>.tgz locally
```

Everything is testable on a single machine — integration tests run multiple daemons as local processes with faked capability profiles. Cutting a release: [docs/reference/releasing.md](docs/reference/releasing.md).
````

- [ ] **Step 4: README `## Roadmap`**: change `→ packaging & painless install →` to `→ packaging ([S1](docs/specs/2026-07-12-s1-packaging-design.md) — done) → painless install →`.

- [ ] **Step 5: `packages/daemon/README.md` `## Bins`**: add one paragraph after the table:

```markdown
Installed from a [release tarball](../../README.md#install), the three bins are
on PATH directly (npm generates the Windows `.cmd`/`.ps1` shims and Linux
symlinks). The release manifest is generated from this package.json by
`scripts/lib/publish-manifest.ts` — workspace deps are dropped because tsup
bundles them.
```

- [ ] **Step 6: `docs/reference/releasing.md`**

````markdown
# Releasing

A `v*` tag on `main` runs [`.github/workflows/release.yml`](../../.github/workflows/release.yml):
the CI gate, then `pnpm pack:release --tag <tag>`, then a global install of
the real tarball on Ubuntu and Windows (bins must print their exact version),
then a GitHub Release with `homefleet-<version>.tgz` attached.

## Cutting a release

1. Bump the version in **all four** places — the pack refuses a tag that
   doesn't match, and `version.test.ts` refuses a drifted `DAEMON_VERSION`:
   `packages/{daemon,executors,protocol}/package.json` and
   `packages/daemon/src/version.ts`. Update `docs/rfc/hfp-v0.md`'s example
   `daemonVersion` too.
2. `pnpm lint && pnpm typecheck && pnpm test`, commit, push.
3. Optional dry run: `gh workflow run release.yml --ref main` — everything
   except the Release.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.

## If the tag was wrong

A tag that doesn't match the version fails in `pack` before anything is
built, and no Release is created. Delete the tag (`git push --delete origin
vX.Y.Z && git tag -d vX.Y.Z`), fix, and re-tag.
````

- [ ] **Step 7: `docs/backlog.md`**: replace the npm-packaging bullet with:

```markdown
- ~~npm packaging (v0.1 installs from source only)~~ — **done** (S1,
  2026-09-22): GitHub Releases tarball via `v*` tag; see
  [releasing](reference/releasing.md). Public npm registry publish is still
  deliberately deferred.
```

- [ ] **Step 8: Devlog 017** (`devlog/2026-09-22-s1-packaging.md`): headline `# Devlog 017 — S1: a real install`. Cover what shipped, the six spec deviations from this plan's top section (lead with the symlink guard and why "exit 0" would have hidden it), the dry-run workflow result, and anything that surprised during execution. Match devlog 016's voice: prose, dated, honest about costs.

- [ ] **Step 9: Commit + push**

```bash
git add README.md packages/daemon/README.md docs devlog
git commit -m "Docs: S1 install path, releasing guide, devlog 017

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

---

### Task 9: Cut the first packaged release (v0.3.0), after confirming with Hugo

A tag is public and hard to take back, so **ask before pushing it**. v0.2.0 is already tagged (2026-07-20) and predates A2, and A2 + S1 together are a feature release. Proposal: **v0.3.0**.

- [ ] **Step 1: Bump** `packages/{daemon,executors,protocol}/package.json` `version` and `packages/daemon/src/version.ts` `DAEMON_VERSION` to `0.3.0`. Update the example `daemonVersion` in `docs/rfc/hfp-v0.md:142`. Leave `protocolVersion` alone, because the wire protocol didn't change. Leave test fixtures that hard-code `"0.2.0"` as sample data (for example `node-info.test.ts:225`) unless they assert against `DAEMON_VERSION`.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test`. Commit `Bump packages to 0.3.0 for the first packaged release`, then push.
- [ ] **Step 3: Confirm with Hugo**, then `git tag v0.3.0 && git push origin v0.3.0`.
- [ ] **Step 4:** Watch the run. Expected: all jobs are green and `https://github.com/Hugodzl/HomeFleet/releases/tag/v0.3.0` has `homefleet-0.3.0.tgz`.
- [ ] **Step 5: Real-machine check.** On this PC, in a fresh PowerShell: `npm i -g <release URL>`, `homefleet --version` → `homefleet 0.3.0`. Update the README Install example if the URL shape differs, and add the result to devlog 017.

---

## Self-review against the spec

| Spec section | Covered by |
| --- | --- |
| §1 tarball on a Release, `npm i -g`, 3 bins, `homefleet` name, update story | Tasks 6, 7, 8 (Install), 9 |
| §2 `buildPublishManifest` (rename, keep/drop, `files`, `repository`) | Task 2 (+ `type`, `engines`: deviations 2–3) |
| §2 build → stage → `npm pack` → print path; fail-loud bin + zero-`@homefleet` checks | Tasks 4, 6; the assertion is in Task 2, re-checked in Task 5 |
| §3 workflow: gate, tag guard, pack, smoke, Release `--generate-notes` | Task 7 (guard: Task 3 via `--tag`) |
| §4 smoke on Ubuntu + Windows of the real artifact | Task 7 `smoke` (tightened to exact version output: deviation 1) |
| §5 README Install, from-source → Development, backlog closed | Task 8 |
| §6 unit / real-I/O integration / CI smoke | Tasks 2–4 / 5 / 7 |
| Out of scope (npm registry, single binary, auto-update, S3 version ads) | Not touched |
