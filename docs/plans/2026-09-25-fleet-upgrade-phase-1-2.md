# Fleet Upgrade, Phases 1–2 (Signed Releases + Local Upgrade) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.5.0 with signed release manifests and a `homefleet upgrade` command that verifies, installs and restarts the local node, rolling back on failure.

**Architecture:** CI signs a small JSON manifest (version, sha256, size, HFP version) with an Ed25519 key; the daemon pins the public key. A new `packages/daemon/src/upgrade/` module downloads and verifies a release, checks guards, writes an upgrade-state file, and hands off to a zero-dependency `updater.mjs` that it copies into the data dir and runs detached. The updater then waits for the daemon to exit, runs `npm i -g`, relaunches, health-checks and rolls back if needed. The CLI triggers the flow via a new `POST /control/upgrade` route on the existing loopback control API and polls `/control/status` until the new version answers.

**Tech Stack:** TypeScript (ESM), Node ≥ 20 `node:crypto` Ed25519, zod v4, vitest, tsup (`?raw` embedding), GitHub Actions.

**Spec:** [docs/specs/2026-09-25-fleet-upgrade-design.md](../specs/2026-09-25-fleet-upgrade-design.md), Phases 1 and 2. Phases 3–4 get their own plan later.

---

## Ground rules for every task

- **Shared checkout:** another Claude session may be committing to this clone at the same time. Before staging, run `git status --short`. Stage **only the files the task lists**, by name. Never use `git add -A`, `git add -u` or `git commit -a`.
- **Commands:** run from the repo root. `pnpm test -- <path>` runs one test file; `pnpm typecheck`, `pnpm lint` and `pnpm build` cover everything.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **House style:** match the surrounding code. That means module header comments that explain *why*, `node:` imports, `.js` import specifiers, and error messages built from `.message` and never from stacks.
- **Deviations from the spec**, recorded in Task 16:
  - Signature verification before publishing runs in the `pack` job with the source tree, not in `smoke`. The smoke runner has no pnpm install.
  - The upgrade state doesn't record env vars. The detached updater and the relaunched daemon inherit the daemon's environment.
  - A new `not-installed` guard refuses upgrades for a daemon running from a git checkout, such as the rig's `hf-daemon.ps1`.
  - `ControlStatus.lastUpgrade` lands in Phase 2 because the CLI needs it; `NodeInfo.lastUpgrade` stays in Phase 3.

## File map

| File | Responsibility |
| --- | --- |
| `packages/daemon/src/upgrade/semver.ts` | Strict `X.Y.Z` parse / compare / major |
| `packages/daemon/src/upgrade/release-keys.ts` | Pinned Ed25519 public keys (SPKI DER, base64) |
| `packages/daemon/src/upgrade/manifest.ts` | Manifest schema, canonical serialization, file names, `verifyRelease` |
| `packages/daemon/src/upgrade/test-release.ts` | Test-only: key pairs, signed fake releases, `FakeReleaseSource` |
| `packages/daemon/src/upgrade/errors.ts` | `UpgradeError` + codes |
| `packages/daemon/src/upgrade/release-source.ts` | `ReleaseSource` interface + `GitHubReleaseSource` |
| `packages/daemon/src/upgrade/prepare.ts` | Download-or-reuse + verify into `upgrades/<v>/` |
| `packages/daemon/src/upgrade/guards.ts` | Pure pre-flight checks |
| `packages/daemon/src/upgrade/files.ts` | Upgrade dir layout, lock, state, result |
| `packages/daemon/src/upgrade/updater.mjs` | Detached install/relaunch/health/rollback script |
| `packages/daemon/src/upgrade/coordinator.ts` | `UpgradeCoordinator`: `check()`, `upgradeSelf()` |
| `packages/daemon/src/control/messages.ts` | + `UpgradeRequestSchema` |
| `packages/daemon/src/control/control-server.ts` | + `/control/upgrade`, `/control/upgrade/check`, `ControlStatus.lastUpgrade` |
| `packages/daemon/src/cli/control-client.ts` | + `checkUpgrade()`, `upgrade()`, `ControlRequestError.code` |
| `packages/daemon/src/daemon.ts` | Wires the coordinator into the control surface |
| `packages/daemon/src/bin/homefleetd.ts` | Passes `requestShutdown` to the daemon |
| `packages/daemon/src/cli/cli.ts`, `bin/homefleet.ts` | `homefleet upgrade` |
| `scripts/lib/sign-release.ts`, `scripts/sign-release.ts`, `scripts/verify-release.ts`, `scripts/release-keygen.ts` | Key generation, signing, pre-publish verification |
| `.github/workflows/release.yml`, `package.json` | Sign + verify in CI; publish the extra assets |
| `docs/reference/releasing.md`, `README.md`, the spec | Docs |

---

### Task 1: Strict semver helpers

**Files:**
- Create: `packages/daemon/src/upgrade/semver.ts`
- Test: `packages/daemon/src/upgrade/semver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { compareSemver, isSemver, majorOf } from "./semver.js";

describe("semver", () => {
  test("isSemver accepts only X.Y.Z", () => {
    expect(isSemver("0.5.0")).toBe(true);
    expect(isSemver("10.20.30")).toBe(true);
    expect(isSemver("v0.5.0")).toBe(false);
    expect(isSemver("0.5")).toBe(false);
    expect(isSemver("0.5.0-rc.1")).toBe(false);
  });

  test("compareSemver orders numerically, not lexically", () => {
    expect(compareSemver("0.5.0", "0.5.0")).toBe(0);
    expect(compareSemver("0.5.1", "0.5.0")).toBe(1);
    expect(compareSemver("0.4.9", "0.5.0")).toBe(-1);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  test("compareSemver throws on invalid input", () => {
    expect(() => compareSemver("latest", "0.5.0")).toThrow(/not a semver/);
  });

  test("majorOf", () => {
    expect(majorOf("0.3.0")).toBe(0);
    expect(majorOf("2.1.0")).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/semver.test.ts`
Expected: FAIL, because `./semver.js` can't be resolved.

- [ ] **Step 3: Implement**

```ts
/**
 * Strict `X.Y.Z` semver helpers for the upgrade flow. HomeFleet versions
 * (daemon and HFP) never carry pre-release or build suffixes — see
 * `SemverSchema` in @homefleet/protocol — so anything else is rejected
 * rather than half-supported.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new Error(`"${version}" is not a semver string (X.Y.Z)`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/** -1 / 0 / 1 like a sort comparator. Throws on a non-`X.Y.Z` input. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l > r ? 1 : -1;
    }
  }
  return 0;
}

export function majorOf(version: string): number {
  return parse(version)[0];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/semver.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/upgrade/semver.ts packages/daemon/src/upgrade/semver.test.ts
git commit -m "Upgrade: strict semver helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Release manifest + signature verification

**Files:**
- Create: `packages/daemon/src/upgrade/release-keys.ts`
- Create: `packages/daemon/src/upgrade/manifest.ts`
- Create: `packages/daemon/src/upgrade/test-release.ts` (test helper, not exported from the package)
- Test: `packages/daemon/src/upgrade/manifest.test.ts`

- [ ] **Step 1: Create the pinned-key module (empty until Task 4)**

```ts
/**
 * Ed25519 public keys that may sign HomeFleet release manifests, as base64
 * SPKI DER (the output of `pnpm release:keygen`). A LIST so a key can be
 * rotated: ship the new key alongside the old one for at least one release
 * before signing with it. The matching private key lives only in the
 * `HOMEFLEET_RELEASE_KEY` GitHub secret (see docs/reference/releasing.md).
 *
 * Empty until the real key is generated (plan Task 4) — with no pinned key
 * every verification fails closed.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];
```

- [ ] **Step 2: Create the test helper**

```ts
/**
 * Test-only helpers for the upgrade suite: throwaway Ed25519 keys, signed
 * fake releases on disk, and an in-memory ReleaseSource. Not exported from
 * the package.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hashFile,
  manifestFileName,
  releaseFileName,
  serializeManifest,
  signatureFileName,
} from "./manifest.js";
import type { FetchedRelease, ReleaseSource } from "./release-source.js";

export interface TestKeys {
  /** base64 SPKI DER, the RELEASE_PUBLIC_KEYS format. */
  publicKey: string;
  privateKey: KeyObject;
}

export function makeTestKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey,
  };
}

export interface WrittenRelease extends FetchedRelease {
  manifestPath: string;
  signaturePath: string;
}

/** Writes `homefleet-<v>.tgz` + a signed manifest + signature into `dir`. */
export async function writeSignedRelease(
  dir: string,
  version: string,
  keys: TestKeys,
  options: { content?: string; hfpVersion?: string } = {},
): Promise<WrittenRelease> {
  await mkdir(dir, { recursive: true });
  const tarballPath = path.join(dir, releaseFileName(version));
  await writeFile(tarballPath, options.content ?? `fake tarball ${version}`);
  const { sha256, size } = await hashFile(tarballPath);
  const manifestBytes = Buffer.from(
    serializeManifest({
      version,
      file: releaseFileName(version),
      sha256,
      size,
      hfpVersion: options.hfpVersion ?? "0.3.0",
    }),
    "utf8",
  );
  const signature = sign(null, manifestBytes, keys.privateKey).toString("base64");
  const manifestPath = path.join(dir, manifestFileName(version));
  const signaturePath = path.join(dir, signatureFileName(version));
  await writeFile(manifestPath, manifestBytes);
  await writeFile(signaturePath, `${signature}\n`);
  return { manifestBytes, signature, tarballPath, manifestPath, signaturePath };
}

/**
 * A ReleaseSource that "downloads" by copying from `originDir`, where tests
 * put releases with {@link writeSignedRelease}. `latest` is mutable.
 */
export class FakeReleaseSource implements ReleaseSource {
  fetchCount = 0;

  constructor(
    private readonly originDir: string,
    public latest: string,
  ) {}

  async latestVersion(): Promise<string> {
    return this.latest;
  }

  async fetchRelease(version: string, destDir: string): Promise<FetchedRelease> {
    this.fetchCount++;
    await mkdir(destDir, { recursive: true });
    const names = [
      releaseFileName(version),
      manifestFileName(version),
      signatureFileName(version),
    ];
    for (const name of names) {
      await copyFile(path.join(this.originDir, name), path.join(destDir, name));
    }
    return {
      manifestBytes: await readFile(path.join(destDir, manifestFileName(version))),
      signature: await readFile(path.join(destDir, signatureFileName(version)), "utf8"),
      tarballPath: path.join(destDir, releaseFileName(version)),
    };
  }
}
```

(`release-source.ts` doesn't exist yet. Create it now with only the interface so this helper typechecks; Task 6 adds the GitHub class:)

```ts
/**
 * Where upgrade tarballs come from (fleet-upgrade spec, Phase 2). Phase 3
 * adds a peer source; everything downstream only sees this interface.
 */
export interface FetchedRelease {
  manifestBytes: Buffer;
  /** base64 detached Ed25519 signature over `manifestBytes`. */
  signature: string;
  tarballPath: string;
}

export interface ReleaseSource {
  /** The newest published version (`X.Y.Z`, no leading `v`). */
  latestVersion(): Promise<string>;
  /** Downloads the three release files for `version` into `destDir`. Unverified. */
  fetchRelease(version: string, destDir: string): Promise<FetchedRelease>;
}
```

Save that as `packages/daemon/src/upgrade/release-source.ts`.

- [ ] **Step 3: Write the failing test**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { serializeManifest, verifyRelease } from "./manifest.js";
import { makeTestKeys, writeSignedRelease } from "./test-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-manifest-"));
  dirs.push(dir);
  return dir;
}

describe("verifyRelease", () => {
  test("accepts a correctly signed release", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.hfpVersion).toBe("0.3.0");
  });

  test("accepts a signature from any pinned key (rotation)", async () => {
    const oldKeys = makeTestKeys();
    const newKeys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", newKeys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [oldKeys.publicKey, newKeys.publicKey],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown key", async () => {
    const release = await writeSignedRelease(await tempDir(), "0.5.1", makeTestKeys());
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [makeTestKeys().publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects with no pinned keys at all", async () => {
    const release = await writeSignedRelease(await tempDir(), "0.5.1", makeTestKeys());
    const result = await verifyRelease({ ...release, expectedVersion: "0.5.1", publicKeys: [] });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects a tampered manifest", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const tampered = Buffer.from(
      release.manifestBytes.toString("utf8").replace('"size":', '"size": '),
      "utf8",
    );
    const result = await verifyRelease({
      ...release,
      manifestBytes: tampered,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  test("rejects a tampered tarball (same size)", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys, {
      content: "aaaa",
    });
    await writeFile(release.tarballPath, "bbbb");
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" });
  });

  test("rejects a size mismatch", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    await writeFile(release.tarballPath, "short");
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "size-mismatch" });
  });

  test("rejects a manifest for a different version", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.2",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "version-mismatch" });
  });

  test("rejects a missing tarball", async () => {
    const keys = makeTestKeys();
    const release = await writeSignedRelease(await tempDir(), "0.5.1", keys);
    await rm(release.tarballPath);
    const result = await verifyRelease({
      ...release,
      expectedVersion: "0.5.1",
      publicKeys: [keys.publicKey],
    });
    expect(result).toMatchObject({ ok: false, reason: "missing-tarball" });
  });
});

test("serializeManifest has a fixed key order and trailing newline", () => {
  expect(
    serializeManifest({
      hfpVersion: "0.3.0",
      size: 3,
      sha256: "a".repeat(64),
      file: "homefleet-0.5.0.tgz",
      version: "0.5.0",
    }),
  ).toBe(
    `{"version":"0.5.0","file":"homefleet-0.5.0.tgz","sha256":"${"a".repeat(64)}","size":3,"hfpVersion":"0.3.0"}\n`,
  );
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/manifest.test.ts`
Expected: FAIL, because `./manifest.js` can't be resolved.

- [ ] **Step 5: Implement `manifest.ts`**

```ts
/**
 * Signed release manifests (fleet-upgrade spec, Phase 1).
 *
 * CI publishes three assets per release: the tarball, a tiny JSON manifest
 * naming its version/sha256/size/HFP version, and a detached Ed25519
 * signature over the manifest's EXACT bytes. A node trusts a tarball iff the
 * signature verifies under a pinned key (./release-keys.ts) AND the tarball
 * matches the manifest — the same check whether the bytes came from GitHub
 * or (Phase 3) a peer, online or offline.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RELEASE_PUBLIC_KEYS } from "./release-keys.js";

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const ReleaseManifestSchema = z.strictObject({
  version: VersionSchema,
  file: z.string().regex(/^homefleet-\d+\.\d+\.\d+\.tgz$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().positive(),
  hfpVersion: VersionSchema,
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function releaseFileName(version: string): string {
  return `homefleet-${version}.tgz`;
}
export function manifestFileName(version: string): string {
  return `homefleet-${version}.manifest.json`;
}
export function signatureFileName(version: string): string {
  return `homefleet-${version}.manifest.sig`;
}

/** Canonical bytes: fixed key order + trailing newline. The signature covers exactly this. */
export function serializeManifest(manifest: ReleaseManifest): string {
  const { version, file, sha256, size, hfpVersion } = manifest;
  return `${JSON.stringify({ version, file, sha256, size, hfpVersion })}\n`;
}

export async function hashFile(
  filePath: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    size += buffer.length;
  }
  return { sha256: hash.digest("hex"), size };
}

export type VerifyFailure =
  | "bad-signature"
  | "bad-manifest"
  | "version-mismatch"
  | "file-mismatch"
  | "size-mismatch"
  | "hash-mismatch"
  | "missing-tarball";

export type VerifyResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; reason: VerifyFailure; detail: string };

export interface VerifyReleaseInput {
  manifestBytes: Buffer;
  /** base64 detached Ed25519 signature (surrounding whitespace ignored). */
  signature: string;
  tarballPath: string;
  expectedVersion: string;
  /** Defaults to the pinned RELEASE_PUBLIC_KEYS; tests pass their own. */
  publicKeys?: readonly string[];
}

function fail(reason: VerifyFailure, detail: string): VerifyResult {
  return { ok: false, reason, detail };
}

function signatureValid(
  bytes: Buffer,
  signature: string,
  publicKeys: readonly string[],
): boolean {
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64) {
    return false;
  }
  return publicKeys.some((key) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key, "base64"),
        format: "der",
        type: "spki",
      });
      return verify(null, bytes, publicKey, sig);
    } catch {
      return false;
    }
  });
}

/** Never throws on bad input — every failure is a typed result. */
export async function verifyRelease(
  input: VerifyReleaseInput,
): Promise<VerifyResult> {
  const publicKeys = input.publicKeys ?? RELEASE_PUBLIC_KEYS;
  if (!signatureValid(input.manifestBytes, input.signature, publicKeys)) {
    return fail(
      "bad-signature",
      "the manifest signature does not match any pinned release key",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(input.manifestBytes.toString("utf8"));
  } catch {
    return fail("bad-manifest", "the manifest is not valid JSON");
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) {
    return fail("bad-manifest", "the manifest has an unexpected shape");
  }
  const manifest = parsed.data;
  if (manifest.version !== input.expectedVersion) {
    return fail(
      "version-mismatch",
      `the manifest is for ${manifest.version}, expected ${input.expectedVersion}`,
    );
  }
  if (
    manifest.file !== releaseFileName(manifest.version) ||
    path.basename(input.tarballPath) !== manifest.file
  ) {
    return fail(
      "file-mismatch",
      `the manifest names ${manifest.file}, got ${path.basename(input.tarballPath)}`,
    );
  }
  let actual: { sha256: string; size: number };
  try {
    actual = await hashFile(input.tarballPath);
  } catch {
    return fail("missing-tarball", `cannot read ${input.tarballPath}`);
  }
  if (actual.size !== manifest.size) {
    return fail(
      "size-mismatch",
      `the tarball is ${actual.size} bytes, the manifest says ${manifest.size}`,
    );
  }
  if (actual.sha256 !== manifest.sha256) {
    return fail("hash-mismatch", "the tarball's sha256 does not match the manifest");
  }
  return { ok: true, manifest };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/manifest.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 7: Typecheck + lint, then commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean. If lint complains only about formatting, run `pnpm format`.

```bash
git add packages/daemon/src/upgrade/release-keys.ts packages/daemon/src/upgrade/manifest.ts packages/daemon/src/upgrade/manifest.test.ts packages/daemon/src/upgrade/test-release.ts packages/daemon/src/upgrade/release-source.ts
git commit -m "Upgrade: signed release manifest + verifyRelease

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Signing scripts (keygen, sign, verify)

**Files:**
- Create: `scripts/lib/sign-release.ts`
- Create: `scripts/sign-release.ts`, `scripts/verify-release.ts`, `scripts/release-keygen.ts`
- Modify: `package.json` (root `scripts`)
- Test: `scripts/lib/sign-release.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { verifyRelease } from "../../packages/daemon/src/upgrade/manifest.js";
import {
  generateReleaseKeyPair,
  signRelease,
  versionFromTarball,
} from "./sign-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("a signed tarball verifies under the generated public key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-sign-"));
  dirs.push(dir);
  const tarballPath = path.join(dir, "homefleet-0.5.0.tgz");
  await writeFile(tarballPath, "release bytes");
  const keys = generateReleaseKeyPair();

  const { manifestPath, signaturePath } = await signRelease({
    tarballPath,
    privateKeyPem: keys.privateKeyPem,
    hfpVersion: "0.3.0",
  });

  const result = await verifyRelease({
    manifestBytes: await readFile(manifestPath),
    signature: await readFile(signaturePath, "utf8"),
    tarballPath,
    expectedVersion: "0.5.0",
    publicKeys: [keys.publicKeyBase64],
  });
  expect(result.ok).toBe(true);
  expect(path.basename(manifestPath)).toBe("homefleet-0.5.0.manifest.json");
  expect(path.basename(signaturePath)).toBe("homefleet-0.5.0.manifest.sig");
});

test("versionFromTarball", () => {
  expect(versionFromTarball("/x/homefleet-1.2.3.tgz")).toBe("1.2.3");
  expect(() => versionFromTarball("/x/other-1.2.3.tgz")).toThrow(/homefleet-X.Y.Z.tgz/);
});

test("signRelease refuses a non-Ed25519 key", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const dir = await mkdtemp(path.join(tmpdir(), "hf-sign-"));
  dirs.push(dir);
  const tarballPath = path.join(dir, "homefleet-0.5.0.tgz");
  await writeFile(tarballPath, "x");
  await expect(
    signRelease({
      tarballPath,
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    }),
  ).rejects.toThrow(/Ed25519/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- scripts/lib/sign-release.test.ts`
Expected: FAIL, because `./sign-release.js` can't be resolved.

- [ ] **Step 3: Implement `scripts/lib/sign-release.ts`**

```ts
/**
 * Release signing (fleet-upgrade spec, Phase 1). Uses the daemon's own
 * manifest serializer so CI and the verifier can never disagree on the
 * signed bytes.
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hashFile,
  manifestFileName,
  releaseFileName,
  serializeManifest,
  signatureFileName,
} from "../../packages/daemon/src/upgrade/manifest.js";
import { HFP_PROTOCOL_VERSION } from "../../packages/protocol/src/version.js";

export function versionFromTarball(tarballPath: string): string {
  const match = /^homefleet-(\d+\.\d+\.\d+)\.tgz$/.exec(path.basename(tarballPath));
  if (match?.[1] === undefined) {
    throw new Error(`${tarballPath} is not named homefleet-X.Y.Z.tgz`);
  }
  return match[1];
}

export function generateReleaseKeyPair(): {
  privateKeyPem: string;
  publicKeyBase64: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export async function signRelease(options: {
  tarballPath: string;
  privateKeyPem: string;
  hfpVersion?: string;
}): Promise<{ manifestPath: string; signaturePath: string }> {
  const version = versionFromTarball(options.tarballPath);
  const key = createPrivateKey(options.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("the release signing key must be an Ed25519 private key");
  }
  const { sha256, size } = await hashFile(options.tarballPath);
  const manifestBytes = Buffer.from(
    serializeManifest({
      version,
      file: releaseFileName(version),
      sha256,
      size,
      hfpVersion: options.hfpVersion ?? HFP_PROTOCOL_VERSION,
    }),
    "utf8",
  );
  const signature = sign(null, manifestBytes, key).toString("base64");
  const dir = path.dirname(options.tarballPath);
  const manifestPath = path.join(dir, manifestFileName(version));
  const signaturePath = path.join(dir, signatureFileName(version));
  await writeFile(manifestPath, manifestBytes);
  await writeFile(signaturePath, `${signature}\n`);
  return { manifestPath, signaturePath };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- scripts/lib/sign-release.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the three CLI entry points**

`scripts/sign-release.ts`:

```ts
/**
 * pnpm sign:release <tarball> [--key-file <pem>]
 *
 * Writes homefleet-<v>.manifest.json + .manifest.sig next to the tarball.
 * The key comes from the HOMEFLEET_RELEASE_KEY env var (CI) or --key-file
 * (a local, hand-signed build — e.g. the rig's rollback test).
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { signRelease } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { "key-file": { type: "string" } },
    allowPositionals: true,
  });
  const tarballPath = positionals[0];
  if (tarballPath === undefined || positionals.length !== 1) {
    throw new Error("usage: pnpm sign:release <tarball> [--key-file <pem>]");
  }
  const keyFile = values["key-file"];
  const privateKeyPem =
    keyFile !== undefined
      ? await readFile(keyFile, "utf8")
      : process.env.HOMEFLEET_RELEASE_KEY;
  if (privateKeyPem === undefined || privateKeyPem.trim() === "") {
    throw new Error("no signing key: set HOMEFLEET_RELEASE_KEY or pass --key-file");
  }
  const { manifestPath, signaturePath } = await signRelease({
    tarballPath,
    privateKeyPem,
  });
  process.stdout.write(`${manifestPath}\n${signaturePath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `sign-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
```

`scripts/verify-release.ts`:

```ts
/**
 * pnpm verify:release <tarball>
 *
 * Verifies the manifest + signature next to <tarball> against the PINNED
 * public keys compiled into the daemon — the exact check an upgrading node
 * runs. CI runs it right after signing so a key mismatch fails the release
 * before anything is published.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  manifestFileName,
  signatureFileName,
  verifyRelease,
} from "../packages/daemon/src/upgrade/manifest.js";
import { versionFromTarball } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const tarballPath = process.argv[2];
  if (tarballPath === undefined) {
    throw new Error("usage: pnpm verify:release <tarball>");
  }
  const version = versionFromTarball(tarballPath);
  const dir = path.dirname(tarballPath);
  const result = await verifyRelease({
    manifestBytes: await readFile(path.join(dir, manifestFileName(version))),
    signature: await readFile(path.join(dir, signatureFileName(version)), "utf8"),
    tarballPath,
    expectedVersion: version,
  });
  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.detail}`);
  }
  process.stdout.write(`verified ${path.basename(tarballPath)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `verify-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
```

`scripts/release-keygen.ts`:

```ts
/**
 * pnpm release:keygen <private-key-out.pem>
 *
 * One-time: generates the release signing key pair. Writes the PRIVATE key
 * (refusing to overwrite) with owner-only permissions and prints the public
 * key to paste into packages/daemon/src/upgrade/release-keys.ts.
 */
import { writeFile } from "node:fs/promises";
import { generateReleaseKeyPair } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const out = process.argv[2];
  if (out === undefined) {
    throw new Error("usage: pnpm release:keygen <private-key-out.pem>");
  }
  const keys = generateReleaseKeyPair();
  await writeFile(out, keys.privateKeyPem, { flag: "wx", mode: 0o600 });
  process.stdout.write(
    `private key written to ${out}\npublic key (RELEASE_PUBLIC_KEYS entry):\n${keys.publicKeyBase64}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `release-keygen: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
```

Root `package.json`: add these entries to `"scripts"`, after `pack:release`:

```json
    "sign:release": "tsx scripts/sign-release.ts",
    "verify:release": "tsx scripts/verify-release.ts",
    "release:keygen": "tsx scripts/release-keygen.ts"
```

- [ ] **Step 6: Typecheck + lint, then commit**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. The root `typecheck` runs `tsc -p scripts`, which now also checks the cross-package imports.

```bash
git add scripts/lib/sign-release.ts scripts/lib/sign-release.test.ts scripts/sign-release.ts scripts/verify-release.ts scripts/release-keygen.ts package.json
git commit -m "Release: keygen, sign and verify scripts for signed manifests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Generate the real release key and pin it

This task has a human-in-the-loop step. Setting a repository secret is a persistent change to GitHub configuration.

- [ ] 🔵 **Step 1: Generate the key pair outside the repo**

Run (PowerShell):
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.homefleet-release" | Out-Null
pnpm release:keygen "$env:USERPROFILE\.homefleet-release\release-key.pem"
```
Expected: `private key written to …` followed by one base64 line (starts with `MCowBQYDK2Vw`).

- [ ] 🟡 **Step 2: Ask Hugo before setting the secret**

Tell Hugo that the next command stores the private key as the `HOMEFLEET_RELEASE_KEY` secret on `Hugodzl/HomeFleet`. Tell him to also keep an offline backup of the PEM, for example in a password manager. If the key is lost, nodes can't upgrade automatically to anything signed by a replacement key until a release that pins the new key is installed by hand. Proceed only after an explicit yes:

```powershell
Get-Content -Raw "$env:USERPROFILE\.homefleet-release\release-key.pem" | gh secret set HOMEFLEET_RELEASE_KEY --repo Hugodzl/HomeFleet
```
Expected: `✓ Set Actions secret HOMEFLEET_RELEASE_KEY for Hugodzl/HomeFleet`.

- [ ] 🔵 **Step 3: Pin the public key**

In `packages/daemon/src/upgrade/release-keys.ts`, replace the empty array and fix the doc comment:

```ts
 * The first key was generated 2026-09-25 (plan Task 4).
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "<the base64 line printed in Step 1>",
];
```

(Delete the "Empty until the real key is generated" sentence.)

- [ ] 🟢 **Step 4: Verify locally end to end**

```powershell
pnpm pack:release --out "$env:TEMP\hf-sign-check"
pnpm sign:release (Get-Item "$env:TEMP\hf-sign-check\homefleet-*.tgz").FullName --key-file "$env:USERPROFILE\.homefleet-release\release-key.pem"
pnpm verify:release (Get-Item "$env:TEMP\hf-sign-check\homefleet-*.tgz").FullName
```
Expected: the last line is `verified homefleet-0.4.0.tgz`.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/upgrade/release-keys.ts
git commit -m "Upgrade: pin the release signing public key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sign and publish the manifest in the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Sign + verify in the `pack` job**

Insert after the `Pack (tag must match the daemon version)` step:

```yaml
      # Signed manifest + detached Ed25519 signature (fleet-upgrade spec,
      # Phase 1). Verified straight away against the key PINNED in the
      # daemon source, so a secret/key mismatch fails here, before publish.
      - name: Sign the tarball
        env:
          HOMEFLEET_RELEASE_KEY: ${{ secrets.HOMEFLEET_RELEASE_KEY }}
        run: pnpm sign:release release/homefleet-*.tgz
      - name: Verify the signature against the pinned public key
        run: pnpm verify:release release/homefleet-*.tgz
```

Then change the artifact upload path from `release/*.tgz` to:

```yaml
          path: release/homefleet-*
```

- [ ] **Step 2: Publish all three assets**

In the `release` job's `gh release create` line, replace `release/*.tgz` with `release/homefleet-*`:

```yaml
          gh release create "$GITHUB_REF_NAME" release/homefleet-* \
```

The smoke job's `homefleet-*.tgz` globs still match exactly one tarball, so they stay as they are.

- [ ] 🟢 **Step 3: Dry-run the workflow on the branch**

Push, then run `gh workflow run release.yml --ref main` and `gh run watch`.
Expected: `pack` shows `verified homefleet-0.4.0.tgz`; `smoke` passes on both OSes; `release` is skipped (not a tag). If `Sign the tarball` fails with "no signing key", the secret from Task 4 is missing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "Release: sign, verify and publish the release manifest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GitHub release source

**Files:**
- Modify: `packages/daemon/src/upgrade/release-source.ts`
- Test: `packages/daemon/src/upgrade/release-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { GitHubReleaseSource, ReleaseFetchError } from "./release-source.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fakeFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, urls };
}

describe("GitHubReleaseSource", () => {
  test("latestVersion strips the v from tag_name", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Hugodzl/HomeFleet/releases/latest": () =>
        Response.json({ tag_name: "v0.5.1" }),
    });
    await expect(new GitHubReleaseSource({ fetch }).latestVersion()).resolves.toBe("0.5.1");
  });

  test("latestVersion rejects a non-semver tag", async () => {
    const { fetch } = fakeFetch({
      "https://api.github.com/repos/Hugodzl/HomeFleet/releases/latest": () =>
        Response.json({ tag_name: "nightly" }),
    });
    await expect(new GitHubReleaseSource({ fetch }).latestVersion()).rejects.toThrow(
      ReleaseFetchError,
    );
  });

  test("fetchRelease downloads the three assets", async () => {
    const base = "https://github.com/Hugodzl/HomeFleet/releases/download/v0.5.1/";
    const { fetch, urls } = fakeFetch({
      [`${base}homefleet-0.5.1.tgz`]: () => new Response("tgz"),
      [`${base}homefleet-0.5.1.manifest.json`]: () => new Response("{}"),
      [`${base}homefleet-0.5.1.manifest.sig`]: () => new Response("c2ln\n"),
    });
    const dir = await mkdtemp(path.join(tmpdir(), "hf-src-"));
    dirs.push(dir);
    const fetched = await new GitHubReleaseSource({ fetch }).fetchRelease(
      "0.5.1",
      path.join(dir, "0.5.1"),
    );
    expect(urls).toHaveLength(3);
    expect(await readFile(fetched.tarballPath, "utf8")).toBe("tgz");
    expect(fetched.manifestBytes.toString()).toBe("{}");
    expect(fetched.signature).toBe("c2ln\n");
  });

  test("an HTTP error becomes a ReleaseFetchError naming the URL", async () => {
    const { fetch } = fakeFetch({});
    const dir = await mkdtemp(path.join(tmpdir(), "hf-src-"));
    dirs.push(dir);
    await expect(
      new GitHubReleaseSource({ fetch }).fetchRelease("0.5.1", dir),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("a network failure becomes a ReleaseFetchError", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(new GitHubReleaseSource({ fetch }).latestVersion()).rejects.toThrow(
      /could not reach api.github.com/,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/release-source.test.ts`
Expected: FAIL, because `GitHubReleaseSource` isn't exported.

- [ ] **Step 3: Implement by appending to `release-source.ts`**

Add these imports at the top of the file:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAEMON_VERSION } from "../version.js";
import {
  manifestFileName,
  releaseFileName,
  signatureFileName,
} from "./manifest.js";
import { isSemver } from "./semver.js";
```

and append:

```ts
/** The public repo releases are published from. */
export const RELEASES_REPO = "Hugodzl/HomeFleet";

/** No release asset is anywhere near this; bounds a hostile or broken server. */
export const MAX_RELEASE_ASSET_BYTES = 100 * 1024 * 1024;

export class ReleaseFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseFetchError";
  }
}

export class GitHubReleaseSource implements ReleaseSource {
  private readonly fetchImpl: typeof fetch;
  private readonly repo: string;

  constructor(options: { fetch?: typeof fetch; repo?: string } = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.repo = options.repo ?? RELEASES_REPO;
  }

  async latestVersion(): Promise<string> {
    const response = await this.get(
      `https://api.github.com/repos/${this.repo}/releases/latest`,
      "application/vnd.github+json",
    );
    const body = (await response.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (!isSemver(version)) {
      throw new ReleaseFetchError(`the latest release tag "${tag}" is not vX.Y.Z`);
    }
    return version;
  }

  async fetchRelease(version: string, destDir: string): Promise<FetchedRelease> {
    await mkdir(destDir, { recursive: true });
    const base = `https://github.com/${this.repo}/releases/download/v${version}/`;
    const names = {
      tarball: releaseFileName(version),
      manifest: manifestFileName(version),
      signature: signatureFileName(version),
    };
    const files: Record<keyof typeof names, Buffer> = {
      tarball: await this.download(base + names.tarball),
      manifest: await this.download(base + names.manifest),
      signature: await this.download(base + names.signature),
    };
    for (const key of Object.keys(names) as Array<keyof typeof names>) {
      await writeFile(path.join(destDir, names[key]), files[key]);
    }
    return {
      manifestBytes: files.manifest,
      signature: files.signature.toString("utf8"),
      tarballPath: path.join(destDir, names.tarball),
    };
  }

  private async get(url: string, accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept, "user-agent": `homefleet/${DAEMON_VERSION}` },
        redirect: "follow",
      });
    } catch (error) {
      throw new ReleaseFetchError(
        `could not reach ${new URL(url).host}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new ReleaseFetchError(`GET ${url} returned HTTP ${response.status}`);
    }
    return response;
  }

  private async download(url: string): Promise<Buffer> {
    const response = await this.get(url, "application/octet-stream");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RELEASE_ASSET_BYTES) {
      throw new ReleaseFetchError(`${url} is larger than the ${MAX_RELEASE_ASSET_BYTES}-byte cap`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_ASSET_BYTES) {
      throw new ReleaseFetchError(`${url} is larger than the ${MAX_RELEASE_ASSET_BYTES}-byte cap`);
    }
    return bytes;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/release-source.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/upgrade/release-source.ts packages/daemon/src/upgrade/release-source.test.ts
git commit -m "Upgrade: GitHub release source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: UpgradeError + prepareRelease (download-or-reuse, verify)

**Files:**
- Create: `packages/daemon/src/upgrade/errors.ts`
- Create: `packages/daemon/src/upgrade/prepare.ts`
- Test: `packages/daemon/src/upgrade/prepare.test.ts`

- [ ] **Step 1: Create `errors.ts`**

```ts
/**
 * Every refusal or failure the upgrade flow reports, as a machine-readable
 * code plus an operator-facing message. The control API maps codes to HTTP
 * statuses (control-server.ts `upgradeErrorStatus`) and forwards both.
 */
export type UpgradeErrorCode =
  | "not-newer"
  | "hfp-major-mismatch"
  | "busy"
  | "locked"
  | "not-installed"
  | "unsupported"
  | "fetch-failed"
  | "verify-failed";

export class UpgradeError extends Error {
  readonly code: UpgradeErrorCode;

  constructor(code: UpgradeErrorCode, message: string) {
    super(message);
    this.name = "UpgradeError";
    this.code = code;
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { UpgradeError } from "./errors.js";
import { releaseFileName } from "./manifest.js";
import { prepareRelease } from "./prepare.js";
import { FakeReleaseSource, makeTestKeys, writeSignedRelease } from "./test-release.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "hf-prepare-"));
  dirs.push(root);
  const origin = path.join(root, "origin");
  const upgradesDir = path.join(root, "upgrades");
  const keys = makeTestKeys();
  await writeSignedRelease(origin, "0.5.1", keys);
  const source = new FakeReleaseSource(origin, "0.5.1");
  return { root, origin, upgradesDir, keys, source };
}

test("downloads, verifies and returns the prepared release", async () => {
  const { upgradesDir, keys, source } = await setup();
  const prepared = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [keys.publicKey],
  });
  expect(prepared.tarballPath).toBe(path.join(upgradesDir, "0.5.1", releaseFileName("0.5.1")));
  expect(prepared.manifest.version).toBe("0.5.1");
  expect(source.fetchCount).toBe(1);
});

test("reuses a verified cached copy without downloading", async () => {
  const { upgradesDir, keys, source } = await setup();
  const opts = { source, upgradesDir, version: "0.5.1", publicKeys: [keys.publicKey] };
  await prepareRelease(opts);
  await prepareRelease(opts);
  expect(source.fetchCount).toBe(1);
});

test("re-downloads when the cached tarball was tampered with", async () => {
  const { upgradesDir, keys, source } = await setup();
  const opts = { source, upgradesDir, version: "0.5.1", publicKeys: [keys.publicKey] };
  const first = await prepareRelease(opts);
  await writeFile(first.tarballPath, "tampered");
  await prepareRelease(opts);
  expect(source.fetchCount).toBe(2);
});

test("a release that fails verification is deleted and reported", async () => {
  const { upgradesDir, source } = await setup();
  const error = await prepareRelease({
    source,
    upgradesDir,
    version: "0.5.1",
    publicKeys: [makeTestKeys().publicKey],
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  expect((error as UpgradeError).code).toBe("verify-failed");
  expect(await readdir(upgradesDir)).toEqual([]);
});

test("a download failure is fetch-failed", async () => {
  const { upgradesDir, keys, source } = await setup();
  const error = await prepareRelease({
    source,
    upgradesDir,
    version: "0.9.9",
    publicKeys: [keys.publicKey],
  }).catch((e: unknown) => e);
  expect((error as UpgradeError).code).toBe("fetch-failed");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/prepare.test.ts`
Expected: FAIL, because `./prepare.js` can't be resolved.

- [ ] **Step 4: Implement `prepare.ts`**

```ts
/**
 * Gets a VERIFIED copy of a release into `<upgradesDir>/<version>/`: reuse a
 * cached copy if it still verifies, otherwise download and verify. Anything
 * that fails verification is deleted, so the cache only ever holds files
 * that passed `verifyRelease` (Phase 3's tarball route serves from it).
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { UpgradeError } from "./errors.js";
import {
  manifestFileName,
  type ReleaseManifest,
  releaseFileName,
  signatureFileName,
  verifyRelease,
} from "./manifest.js";
import type { ReleaseSource } from "./release-source.js";

export interface PreparedRelease {
  version: string;
  tarballPath: string;
  manifest: ReleaseManifest;
}

export interface PrepareOptions {
  source: ReleaseSource;
  upgradesDir: string;
  version: string;
  publicKeys?: readonly string[];
}

async function verifyCached(
  dir: string,
  version: string,
  publicKeys: readonly string[] | undefined,
): Promise<PreparedRelease | undefined> {
  let manifestBytes: Buffer;
  let signature: string;
  try {
    manifestBytes = await readFile(path.join(dir, manifestFileName(version)));
    signature = await readFile(path.join(dir, signatureFileName(version)), "utf8");
  } catch {
    return undefined;
  }
  const tarballPath = path.join(dir, releaseFileName(version));
  const result = await verifyRelease({
    manifestBytes,
    signature,
    tarballPath,
    expectedVersion: version,
    ...(publicKeys !== undefined ? { publicKeys } : {}),
  });
  return result.ok ? { version, tarballPath, manifest: result.manifest } : undefined;
}

export async function prepareRelease(options: PrepareOptions): Promise<PreparedRelease> {
  const { source, upgradesDir, version, publicKeys } = options;
  const dir = path.join(upgradesDir, version);
  const cached = await verifyCached(dir, version, publicKeys);
  if (cached !== undefined) {
    return cached;
  }
  await rm(dir, { recursive: true, force: true });
  let fetched: Awaited<ReturnType<ReleaseSource["fetchRelease"]>>;
  try {
    fetched = await source.fetchRelease(version, dir);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new UpgradeError(
      "fetch-failed",
      `could not download ${version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = await verifyRelease({
    ...fetched,
    expectedVersion: version,
    ...(publicKeys !== undefined ? { publicKeys } : {}),
  });
  if (!result.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new UpgradeError(
      "verify-failed",
      `release ${version} failed verification (${result.reason}): ${result.detail}`,
    );
  }
  return { version, tarballPath: fetched.tarballPath, manifest: result.manifest };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/prepare.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/upgrade/errors.ts packages/daemon/src/upgrade/prepare.ts packages/daemon/src/upgrade/prepare.test.ts
git commit -m "Upgrade: UpgradeError + verified release cache

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Pre-flight guards

**Files:**
- Create: `packages/daemon/src/upgrade/guards.ts`
- Test: `packages/daemon/src/upgrade/guards.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { checkNewer, checkUpgradeGuards, isInstalledEntry } from "./guards.js";

const INSTALLED_WIN =
  "C:\\Users\\hugo\\AppData\\Roaming\\npm\\node_modules\\homefleet\\dist\\bin\\homefleetd.js";
const base = {
  current: "0.5.0",
  target: "0.5.1",
  targetHfpVersion: "0.3.0",
  localHfpVersion: "0.3.0",
  activeJobs: 0,
  force: false,
  entryPath: INSTALLED_WIN,
};

describe("checkUpgradeGuards", () => {
  test("passes a normal upgrade", () => {
    expect(checkUpgradeGuards(base)).toBeUndefined();
  });

  test.each([
    ["0.5.0", "equal"],
    ["0.4.9", "older"],
  ])("refuses a %s target (%s)", (target) => {
    expect(checkUpgradeGuards({ ...base, target })?.code).toBe("not-newer");
  });

  test("refuses an HFP major change", () => {
    expect(checkUpgradeGuards({ ...base, targetHfpVersion: "1.0.0" })?.code).toBe(
      "hfp-major-mismatch",
    );
  });

  test("allows an HFP minor change", () => {
    expect(checkUpgradeGuards({ ...base, targetHfpVersion: "0.4.0" })).toBeUndefined();
  });

  test("refuses a checkout-run daemon", () => {
    expect(
      checkUpgradeGuards({
        ...base,
        entryPath: "D:\\Git\\LocalAgentCoordinator\\packages\\daemon\\dist\\bin\\homefleetd.js",
      })?.code,
    ).toBe("not-installed");
  });

  test("refuses while jobs run, unless forced", () => {
    expect(checkUpgradeGuards({ ...base, activeJobs: 2 })?.code).toBe("busy");
    expect(checkUpgradeGuards({ ...base, activeJobs: 2, force: true })).toBeUndefined();
  });
});

test("isInstalledEntry handles posix and windows paths", () => {
  expect(isInstalledEntry("/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js")).toBe(true);
  expect(isInstalledEntry(INSTALLED_WIN)).toBe(true);
  expect(isInstalledEntry("/home/h/HomeFleet/packages/daemon/dist/bin/homefleetd.js")).toBe(false);
});

test("checkNewer alone", () => {
  expect(checkNewer("0.5.0", "0.5.1")).toBeUndefined();
  expect(checkNewer("0.5.1", "0.5.1")?.message).toMatch(/downgrades are refused/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/guards.test.ts`
Expected: FAIL, because `./guards.js` can't be resolved.

- [ ] **Step 3: Implement `guards.ts`**

```ts
/**
 * Pure pre-flight checks, run BEFORE anything stops: a refused upgrade
 * leaves the node exactly as it was.
 */
import { UpgradeError } from "./errors.js";
import { compareSemver, majorOf } from "./semver.js";

export interface GuardInput {
  current: string;
  target: string;
  /** From the verified manifest. */
  targetHfpVersion: string;
  localHfpVersion: string;
  activeJobs: number;
  force: boolean;
  /** `process.argv[1]` of the running daemon. */
  entryPath: string;
}

/**
 * True when the daemon runs from an `npm i -g` install — the only layout
 * `npm i -g <tgz>` + relaunch can replace. A checkout's dist/bin would be
 * relaunched unchanged and fail the health check every time.
 */
export function isInstalledEntry(entryPath: string): boolean {
  return entryPath.replaceAll("\\", "/").includes("/node_modules/homefleet/dist/bin/");
}

export function checkNewer(current: string, target: string): UpgradeError | undefined {
  return compareSemver(target, current) > 0
    ? undefined
    : new UpgradeError(
        "not-newer",
        `${target} is not newer than the running ${current} (downgrades are refused)`,
      );
}

export function checkUpgradeGuards(input: GuardInput): UpgradeError | undefined {
  const notNewer = checkNewer(input.current, input.target);
  if (notNewer !== undefined) {
    return notNewer;
  }
  if (majorOf(input.targetHfpVersion) !== majorOf(input.localHfpVersion)) {
    return new UpgradeError(
      "hfp-major-mismatch",
      `release ${input.target} speaks HFP ${input.targetHfpVersion}, this node speaks ` +
        `${input.localHfpVersion}; a major protocol change needs a manual upgrade`,
    );
  }
  if (!isInstalledEntry(input.entryPath)) {
    return new UpgradeError(
      "not-installed",
      `this daemon runs from ${input.entryPath}, not an npm-installed HomeFleet; ` +
        "update a checkout with git + pnpm build instead",
    );
  }
  if (input.activeJobs > 0 && !input.force) {
    return new UpgradeError(
      "busy",
      `${input.activeJobs} job(s) running; wait for them to finish or pass --force`,
    );
  }
  return undefined;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/guards.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/upgrade/guards.ts packages/daemon/src/upgrade/guards.test.ts
git commit -m "Upgrade: pre-flight guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Upgrade files (layout, lock, state, result)

**Files:**
- Create: `packages/daemon/src/upgrade/files.ts`
- Test: `packages/daemon/src/upgrade/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  acquireLock,
  LOCK_FILE,
  RESULT_FILE,
  readUpgradeResultSync,
  releaseLock,
  STALE_LOCK_MS,
} from "./files.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-files-"));
  dirs.push(dir);
  return dir;
}

/** A PID that is certainly not running. */
const DEAD_PID = 2_147_483_000;

test("acquire, refuse while held, release, re-acquire", async () => {
  const dir = await tempDir();
  expect(await acquireLock(dir, { pid: process.pid, now: 1_000 })).toBe(true);
  expect(await acquireLock(dir, { pid: process.pid, now: 2_000 })).toBe(false);
  await releaseLock(dir);
  expect(await acquireLock(dir, { pid: process.pid, now: 3_000 })).toBe(true);
});

test("a lock older than STALE_LOCK_MS whose pid is dead is taken over", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: DEAD_PID, at: 0 }));
  expect(await acquireLock(dir, { pid: process.pid, now: STALE_LOCK_MS + 1 })).toBe(true);
  const held = JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8"));
  expect(held.pid).toBe(process.pid);
});

test("an old lock whose pid is ALIVE is respected", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, at: 0 }));
  expect(await acquireLock(dir, { pid: process.pid, now: STALE_LOCK_MS + 1 })).toBe(false);
});

test("a corrupt lock is treated as stale", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, LOCK_FILE), "not json");
  expect(await acquireLock(dir, { pid: process.pid, now: 1 })).toBe(true);
});

test("readUpgradeResultSync: absent, valid, corrupt", async () => {
  const dataDir = await tempDir();
  expect(readUpgradeResultSync(dataDir)).toBeUndefined();
  await writeFile(
    path.join(dataDir, RESULT_FILE),
    JSON.stringify({ from: "0.5.0", to: "0.5.1", outcome: "rolled-back", reason: "x", at: 5 }),
  );
  expect(readUpgradeResultSync(dataDir)).toEqual({
    from: "0.5.0",
    to: "0.5.1",
    outcome: "rolled-back",
    reason: "x",
    at: 5,
  });
  await writeFile(path.join(dataDir, RESULT_FILE), "{");
  expect(readUpgradeResultSync(dataDir)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/files.test.ts`
Expected: FAIL, because `./files.js` can't be resolved.

- [ ] **Step 3: Implement `files.ts`**

```ts
/**
 * On-disk layout of an upgrade, shared by the daemon (this module) and the
 * detached updater (./updater.mjs, which hardcodes the SAME names —
 * updater.test.ts drives it through these constants so they cannot drift):
 *
 *   <dataDir>/upgrade-result.json          last outcome (read by status)
 *   <dataDir>/upgrades/<version>/…         verified release cache
 *   <dataDir>/upgrades/updater.mjs         the copied updater
 *   <dataDir>/upgrades/upgrade-state.json  the updater's only input
 *   <dataDir>/upgrades/upgrade.lock        one upgrade at a time
 *   <dataDir>/upgrades/updater.log         the updater's own log
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const UPGRADES_DIRNAME = "upgrades";
export const STATE_FILE = "upgrade-state.json";
export const LOCK_FILE = "upgrade.lock";
export const RESULT_FILE = "upgrade-result.json";
export const UPDATER_FILE = "updater.mjs";
export const UPDATER_LOG = "updater.log";
export const STALE_LOCK_MS = 10 * 60_000;

export function upgradesDir(dataDir: string): string {
  return path.join(dataDir, UPGRADES_DIRNAME);
}

export interface UpgradeState {
  from: string;
  to: string;
  tarballPath: string;
  /** The verified tarball of `from`; absent when it could not be cached. */
  rollbackTarballPath?: string;
  /** The daemon being replaced; the updater waits for it to exit. */
  daemonPid: number;
  /** Relaunch = `nodePath ...argv` (argv[0] is the daemon entry script). */
  nodePath: string;
  argv: string[];
  controlHost: string;
  controlPort: number;
  /** e.g. `["npm.cmd", "i", "-g"]`; the tarball path is appended. */
  installCommand: string[];
  dataDir: string;
  exitTimeoutMs: number;
  healthTimeoutMs: number;
}

export type UpgradeOutcome = "succeeded" | "rolled-back" | "failed";

export interface UpgradeResult {
  from: string;
  to: string;
  outcome: UpgradeOutcome;
  reason?: string;
  /** Epoch ms when the updater finished. */
  at: number;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive create; takes over only a corrupt lock or an old one whose pid is dead. */
export async function acquireLock(
  dir: string,
  holder: { pid: number; now: number },
): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const body = JSON.stringify({ pid: holder.pid, at: holder.now });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, body, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    let held: { pid: number; at: number } | undefined;
    try {
      held = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; at: number };
    } catch {
      held = undefined;
    }
    const stale =
      held === undefined ||
      typeof held.pid !== "number" ||
      typeof held.at !== "number" ||
      (holder.now - held.at > STALE_LOCK_MS && !isPidAlive(held.pid));
    if (!stale) {
      return false;
    }
    await rm(lockPath, { force: true });
  }
  return false;
}

export async function releaseLock(dir: string): Promise<void> {
  await rm(path.join(dir, LOCK_FILE), { force: true });
}

/** Writes the updater's input; returns its path. */
export async function writeUpgradeState(dir: string, state: UpgradeState): Promise<string> {
  await mkdir(dir, { recursive: true });
  const statePath = path.join(dir, STATE_FILE);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

/** Sync on purpose: read from the synchronous control `status()`. Absent/corrupt → undefined. */
export function readUpgradeResultSync(dataDir: string): UpgradeResult | undefined {
  try {
    const json = JSON.parse(readFileSync(path.join(dataDir, RESULT_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof json.from !== "string" ||
      typeof json.to !== "string" ||
      typeof json.at !== "number" ||
      !["succeeded", "rolled-back", "failed"].includes(json.outcome as string)
    ) {
      return undefined;
    }
    return {
      from: json.from,
      to: json.to,
      outcome: json.outcome as UpgradeOutcome,
      ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
      at: json.at,
    };
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/files.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/upgrade/files.ts packages/daemon/src/upgrade/files.test.ts
git commit -m "Upgrade: on-disk layout, lock, state and result files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The detached updater script

**Files:**
- Create: `packages/daemon/src/upgrade/updater.mjs`
- Test: `packages/daemon/src/upgrade/updater.test.ts`

The test drives the real script with a fake `npm` and a fake daemon, both tiny `.mjs` files written into a temp dir:
- **Fake npm:** records the "installed" version (parsed from the tarball name) in a file.
- **Fake daemon:** reads that file and serves `/control/status` with it. If the version equals `FAKE_BROKEN`, it exits at once instead.

- [ ] **Step 1: Write the failing test**

```ts
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  LOCK_FILE,
  RESULT_FILE,
  type UpgradeResult,
  type UpgradeState,
  UPDATER_LOG,
  upgradesDir,
  writeUpgradeState,
} from "./files.js";

const UPDATER = fileURLToPath(new URL("./updater.mjs", import.meta.url));

const FAKE_NPM = `import { writeFileSync } from "node:fs";
import path from "node:path";
const tgz = process.argv.at(-1);
const m = /homefleet-(\\d+\\.\\d+\\.\\d+)\\.tgz$/.exec(path.basename(tgz));
if (!m || process.env.FAKE_NPM_FAIL === m[1]) process.exit(1);
writeFileSync(process.env.FAKE_INSTALLED, m[1]);
`;

const FAKE_DAEMON = `import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
appendFileSync(process.env.FAKE_PIDS, process.pid + "\\n");
const version = readFileSync(process.env.FAKE_INSTALLED, "utf8");
if (process.env.FAKE_BROKEN === version) process.exit(1);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ daemonVersion: version }));
}).listen(Number(process.argv[2]), "127.0.0.1");
setTimeout(() => process.exit(0), 20000);
`;

const roots: string[] = [];
const pidFiles: string[] = [];
afterEach(async () => {
  for (const file of pidFiles.splice(0)) {
    const pids = await readFile(file, "utf8").catch(() => "");
    for (const pid of pids.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid));
      } catch {}
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

async function runUpdater(scenario: {
  rollback: boolean;
  env?: Record<string, string>;
}): Promise<{ result: UpgradeResult; installed: string; log: string; lockGone: boolean }> {
  const root = await mkdtemp(path.join(tmpdir(), "hf-updater-"));
  roots.push(root);
  const dir = upgradesDir(root);
  await mkdir(path.join(dir, "0.5.1"), { recursive: true });
  await mkdir(path.join(dir, "0.5.0"), { recursive: true });
  const tarball = path.join(dir, "0.5.1", "homefleet-0.5.1.tgz");
  const rollback = path.join(dir, "0.5.0", "homefleet-0.5.0.tgz");
  await writeFile(tarball, "new");
  await writeFile(rollback, "old");
  const fakeNpm = path.join(root, "fake-npm.mjs");
  const fakeDaemon = path.join(root, "fake-daemon.mjs");
  await writeFile(fakeNpm, FAKE_NPM);
  await writeFile(fakeDaemon, FAKE_DAEMON);
  const installed = path.join(root, "installed.txt");
  await writeFile(installed, "0.5.0");
  const pids = path.join(root, "pids.txt");
  pidFiles.push(pids);

  // The "old daemon": exits on its own shortly, like a graceful stop would.
  const oldDaemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const port = await freePort();
  const state: UpgradeState = {
    from: "0.5.0",
    to: "0.5.1",
    tarballPath: tarball,
    ...(scenario.rollback ? { rollbackTarballPath: rollback } : {}),
    daemonPid: oldDaemon.pid ?? 0,
    nodePath: process.execPath,
    argv: [fakeDaemon, String(port)],
    controlHost: "127.0.0.1",
    controlPort: port,
    installCommand: [process.execPath, fakeNpm],
    dataDir: root,
    exitTimeoutMs: 5_000,
    healthTimeoutMs: 3_000,
  };
  const statePath = await writeUpgradeState(dir, state);
  await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }));

  const child = spawn(process.execPath, [UPDATER, statePath], {
    env: { ...process.env, FAKE_INSTALLED: installed, FAKE_PIDS: pids, ...scenario.env },
    stdio: "ignore",
  });
  await once(child, "exit");

  const lockGone = await readFile(path.join(dir, LOCK_FILE)).then(
    () => false,
    () => true,
  );
  return {
    result: JSON.parse(await readFile(path.join(root, RESULT_FILE), "utf8")) as UpgradeResult,
    installed: await readFile(installed, "utf8"),
    log: await readFile(path.join(dir, UPDATER_LOG), "utf8"),
    lockGone,
  };
}

test("success: installs, relaunches, sees the new version, releases the lock", async () => {
  const run = await runUpdater({ rollback: true });
  expect(run.result).toMatchObject({ from: "0.5.0", to: "0.5.1", outcome: "succeeded" });
  expect(run.installed).toBe("0.5.1");
  expect(run.lockGone).toBe(true);
});

test("a new daemon that never answers is rolled back", async () => {
  const run = await runUpdater({ rollback: true, env: { FAKE_BROKEN: "0.5.1" } });
  expect(run.result.outcome).toBe("rolled-back");
  expect(run.result.reason).toMatch(/did not report its version/);
  expect(run.installed).toBe("0.5.0");
});

test("a failed npm install is rolled back", async () => {
  const run = await runUpdater({ rollback: true, env: { FAKE_NPM_FAIL: "0.5.1" } });
  expect(run.result.outcome).toBe("rolled-back");
  expect(run.result.reason).toMatch(/npm install of 0.5.1 failed/);
  expect(run.installed).toBe("0.5.0");
});

test("without a rollback tarball the outcome is failed", async () => {
  const run = await runUpdater({ rollback: false, env: { FAKE_BROKEN: "0.5.1" } });
  expect(run.result.outcome).toBe("failed");
  expect(run.result.reason).toMatch(/rollback unavailable/);
  expect(run.lockGone).toBe(true);
});

test("logs what it did", async () => {
  const run = await runUpdater({ rollback: true });
  expect(run.log).toMatch(/installing .*homefleet-0\.5\.1\.tgz/);
  expect(run.log).toMatch(/result: succeeded/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/updater.test.ts`
Expected: FAIL. The updater script doesn't exist, so the child exits with an error and reading `upgrade-result.json` throws ENOENT.

- [ ] **Step 3: Implement `updater.mjs`**

```js
#!/usr/bin/env node
/**
 * HomeFleet's detached upgrade helper (fleet-upgrade spec, Phase 2).
 *
 * The daemon writes upgrades/upgrade-state.json, COPIES this file into
 * <dataDir>/upgrades/ (so `npm i -g` never replaces the script that is
 * running), starts it detached and shuts itself down. This script then:
 * waits for the old daemon to exit → installs the new tarball → relaunches
 * the daemon → waits for /control/status to report the new version → on any
 * failure reinstalls the cached previous tarball and relaunches that →
 * writes <dataDir>/upgrade-result.json and removes the lock.
 *
 * Zero dependencies, plain JS: it runs from the data dir, outside any
 * node_modules. File names mirror ./files.ts (updater.test.ts drives this
 * script through those constants, so they cannot drift silently).
 *
 * Usage: node updater.mjs <path to upgrade-state.json>
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const statePath = process.argv[2];
const state = JSON.parse(readFileSync(statePath, "utf8"));
const upgradesDir = path.dirname(statePath);

function log(line) {
  appendFileSync(
    path.join(upgradesDir, "updater.log"),
    `${new Date().toISOString()} ${line}\n`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function kill(pid) {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      log(`pid ${pid} still running after ${timeoutMs} ms; killing it`);
      kill(pid);
      await sleep(1000);
      return;
    }
    await sleep(200);
  }
}

function install(tarballPath) {
  const [command, ...args] = state.installCommand;
  const all = [...args, tarballPath];
  log(`installing ${tarballPath}`);
  // npm's Windows launcher is a .cmd shim, which Node only spawns via a shell.
  const result = command.endsWith(".cmd")
    ? spawnSync([command, ...all.map((arg) => `"${arg}"`)].join(" "), {
        shell: true,
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync(command, all, { encoding: "utf8", windowsHide: true });
  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) log(result.stderr.trimEnd());
  if (result.status !== 0) {
    log(`install exited with ${result.status ?? result.error?.message}`);
    return false;
  }
  return true;
}

function launch() {
  const errFd = openSync(path.join(state.dataDir, "homefleetd.err.log"), "a");
  try {
    const child = spawn(state.nodePath, state.argv, {
      detached: true,
      stdio: ["ignore", "ignore", errFd],
      windowsHide: true,
    });
    child.unref();
    log(`launched daemon pid ${child.pid}`);
    return child.pid;
  } finally {
    closeSync(errFd);
  }
}

async function reportsVersion(version, timeoutMs) {
  const host = state.controlHost.includes(":")
    ? `[${state.controlHost}]`
    : state.controlHost;
  const url = `http://${host}:${state.controlPort}/control/status`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { "x-homefleet-control": "1" },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body.daemonVersion === version) return true;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  return false;
}

async function recover(reason) {
  if (state.rollbackTarballPath && install(state.rollbackTarballPath)) {
    const pid = launch();
    if (await reportsVersion(state.from, state.healthTimeoutMs)) {
      return { outcome: "rolled-back", reason };
    }
    kill(pid);
    return {
      outcome: "failed",
      reason: `${reason}; the rolled-back ${state.from} daemon did not come up either`,
    };
  }
  // No rollback copy: start whatever is installed rather than leave the
  // node with no daemon at all.
  launch();
  return { outcome: "failed", reason: `${reason}; rollback unavailable` };
}

async function run() {
  await waitForExit(state.daemonPid, state.exitTimeoutMs);
  if (!install(state.tarballPath)) {
    return recover(`npm install of ${state.to} failed (see updater.log)`);
  }
  const pid = launch();
  if (await reportsVersion(state.to, state.healthTimeoutMs)) {
    return { outcome: "succeeded" };
  }
  kill(pid);
  await waitForExit(pid, state.exitTimeoutMs);
  return recover(
    `the ${state.to} daemon did not report its version within ${state.healthTimeoutMs} ms`,
  );
}

let result;
try {
  result = await run();
} catch (error) {
  result = {
    outcome: "failed",
    reason: `updater crashed: ${error instanceof Error ? error.message : String(error)}`,
  };
}
writeFileSync(
  path.join(state.dataDir, "upgrade-result.json"),
  `${JSON.stringify({ from: state.from, to: state.to, ...result, at: Date.now() })}\n`,
);
log(`result: ${result.outcome}${result.reason ? ` — ${result.reason}` : ""}`);
rmSync(path.join(upgradesDir, "upgrade.lock"), { force: true });
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/updater.test.ts`
Expected: PASS (5 tests). The rollback cases take about 3 s each because of the health-check timeout.

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`. Biome covers `.mjs`, so fix anything it flags.

```bash
git add packages/daemon/src/upgrade/updater.mjs packages/daemon/src/upgrade/updater.test.ts
git commit -m "Upgrade: detached updater (install, relaunch, health check, rollback)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: UpgradeCoordinator

**Files:**
- Create: `packages/daemon/src/upgrade/coordinator.ts`
- Test: `packages/daemon/src/upgrade/coordinator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { UpgradeCoordinator, type UpgradeCoordinatorOptions } from "./coordinator.js";
import { UpgradeError } from "./errors.js";
import { STATE_FILE, type UpgradeState, UPDATER_FILE, upgradesDir } from "./files.js";
import { FakeReleaseSource, makeTestKeys, writeSignedRelease } from "./test-release.js";

const INSTALLED_ENTRY = "/usr/lib/node_modules/homefleet/dist/bin/homefleetd.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(overrides: Partial<UpgradeCoordinatorOptions> = {}, releases = ["0.5.0", "0.5.1"]) {
  const root = await mkdtemp(path.join(tmpdir(), "hf-coord-"));
  roots.push(root);
  const origin = path.join(root, "origin");
  const keys = makeTestKeys();
  for (const version of releases) await writeSignedRelease(origin, version, keys);
  const source = new FakeReleaseSource(origin, "0.5.1");
  const spawned: Array<{ updaterPath: string; statePath: string }> = [];
  const shutdowns: string[] = [];
  const coordinator = new UpgradeCoordinator({
    dataDir: root,
    currentVersion: "0.5.0",
    localHfpVersion: "0.3.0",
    source,
    activeJobs: () => 0,
    controlEndpoint: () => ({ host: "127.0.0.1", port: 56373 }),
    requestShutdown: (reason) => shutdowns.push(reason),
    spawnUpdater: (updaterPath, statePath) => spawned.push({ updaterPath, statePath }),
    runtime: { pid: 4242, execPath: "/usr/bin/node", argv: ["/usr/bin/node", INSTALLED_ENTRY, "--x"], platform: "linux" },
    publicKeys: [keys.publicKey],
    shutdownDelayMs: 0,
    ...overrides,
  });
  return { root, source, coordinator, spawned, shutdowns };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UpgradeError);
  return (error as UpgradeError).code;
}

test("check reports an available upgrade", async () => {
  const { coordinator } = await setup();
  await expect(coordinator.check()).resolves.toEqual({
    current: "0.5.0",
    latest: "0.5.1",
    available: true,
  });
});

test("upgradeSelf prepares, writes state, spawns the updater, then requests shutdown", async () => {
  const { root, coordinator, spawned, shutdowns } = await setup();
  await expect(coordinator.upgradeSelf({})).resolves.toEqual({ from: "0.5.0", to: "0.5.1" });

  const dir = upgradesDir(root);
  expect(spawned).toEqual([
    { updaterPath: path.join(dir, UPDATER_FILE), statePath: path.join(dir, STATE_FILE) },
  ]);
  expect((await stat(path.join(dir, UPDATER_FILE))).size).toBeGreaterThan(0);
  const state = JSON.parse(await readFile(path.join(dir, STATE_FILE), "utf8")) as UpgradeState;
  expect(state).toMatchObject({
    from: "0.5.0",
    to: "0.5.1",
    daemonPid: 4242,
    nodePath: "/usr/bin/node",
    argv: [INSTALLED_ENTRY, "--x"],
    controlHost: "127.0.0.1",
    controlPort: 56373,
    installCommand: ["npm", "i", "-g"],
    dataDir: root,
  });
  expect(state.tarballPath).toBe(path.join(dir, "0.5.1", "homefleet-0.5.1.tgz"));
  expect(state.rollbackTarballPath).toBe(path.join(dir, "0.5.0", "homefleet-0.5.0.tgz"));
  await vi.waitFor(() => expect(shutdowns).toEqual(["upgrading to 0.5.1"]));
});

test("an explicit version wins over latest", async () => {
  const { coordinator, source } = await setup({}, ["0.5.0", "0.5.1", "0.5.2"]);
  source.latest = "0.5.2";
  await expect(coordinator.upgradeSelf({ version: "0.5.1" })).resolves.toMatchObject({ to: "0.5.1" });
});

test("no rollback tarball available → state has none", async () => {
  const { root, coordinator } = await setup({}, ["0.5.1"]);
  await coordinator.upgradeSelf({});
  const state = JSON.parse(await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8")) as UpgradeState;
  expect(state.rollbackTarballPath).toBeUndefined();
});

test("windows uses npm.cmd", async () => {
  const { root, coordinator } = await setup({
    runtime: {
      pid: 1,
      execPath: "C:\\node.exe",
      argv: ["C:\\node.exe", "C:\\Users\\h\\AppData\\Roaming\\npm\\node_modules\\homefleet\\dist\\bin\\homefleetd.js"],
      platform: "win32",
    },
  });
  await coordinator.upgradeSelf({});
  const state = JSON.parse(await readFile(path.join(upgradesDir(root), STATE_FILE), "utf8")) as UpgradeState;
  expect(state.installCommand).toEqual(["npm.cmd", "i", "-g"]);
});

test("refuses without a shutdown hook", async () => {
  const { coordinator } = await setup({ requestShutdown: undefined });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("unsupported");
});

test("already current → not-newer, without downloading", async () => {
  const { coordinator, source } = await setup();
  source.latest = "0.5.0";
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("not-newer");
  expect(source.fetchCount).toBe(0);
});

test("busy unless forced", async () => {
  const busy = await setup({ activeJobs: () => 1 });
  expect(await codeOf(busy.coordinator.upgradeSelf({}))).toBe("busy");
  const forced = await setup({ activeJobs: () => 1 });
  await expect(forced.coordinator.upgradeSelf({ force: true })).resolves.toMatchObject({ to: "0.5.1" });
});

test("checkout-run daemon → not-installed, nothing spawned", async () => {
  const { coordinator, spawned } = await setup({
    runtime: { pid: 1, execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/src/packages/daemon/dist/bin/homefleetd.js"], platform: "linux" },
  });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("not-installed");
  expect(spawned).toEqual([]);
});

test("untrusted release → verify-failed", async () => {
  const { coordinator } = await setup({ publicKeys: [makeTestKeys().publicKey] });
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("verify-failed");
});

test("a second upgrade in the same process → locked", async () => {
  const { coordinator } = await setup();
  await coordinator.upgradeSelf({});
  expect(await codeOf(coordinator.upgradeSelf({}))).toBe("locked");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/upgrade/coordinator.test.ts`
Expected: FAIL, because `./coordinator.js` can't be resolved.

- [ ] **Step 3: Implement `coordinator.ts`**

```ts
/**
 * The daemon-side owner of the upgrade flow (fleet-upgrade spec, Phase 2).
 *
 * `upgradeSelf` does everything that can fail WITHOUT disturbing the node —
 * resolve the target, download + verify, run the guards, cache a rollback
 * copy, take the lock — and only then writes the updater's state, starts
 * the detached updater and asks the daemon to shut down gracefully. From
 * that point ./updater.mjs owns the node until the new daemon answers.
 *
 * Phase 3 (fleet push over HFP) and Phase 4 (dashboard) call the same
 * method; they add peers, not a second code path.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UpgradeError } from "./errors.js";
import {
  acquireLock,
  releaseLock,
  UPDATER_FILE,
  upgradesDir,
  writeUpgradeState,
} from "./files.js";
import { checkNewer, checkUpgradeGuards } from "./guards.js";
import { type PreparedRelease, prepareRelease } from "./prepare.js";
import type { ReleaseSource } from "./release-source.js";
import { compareSemver } from "./semver.js";
import UPDATER_SOURCE from "./updater.mjs?raw";

export interface UpgradeCheck {
  current: string;
  latest: string;
  available: boolean;
}

export interface UpgradeStarted {
  from: string;
  to: string;
}

export interface UpgradeSelfInput {
  version?: string;
  force?: boolean;
}

export interface UpgradeRuntime {
  pid: number;
  execPath: string;
  argv: readonly string[];
  platform: NodeJS.Platform;
}

export interface UpgradeCoordinatorOptions {
  dataDir: string;
  currentVersion: string;
  localHfpVersion: string;
  source: ReleaseSource;
  activeJobs: () => number;
  /** The control API's bound host/port — what the updater health-checks. */
  controlEndpoint: () => { host: string; port: number };
  /**
   * Graceful shutdown (homefleetd's signal path). Absent when the daemon
   * was not started by the homefleetd bin (tests, embedders) — upgrades
   * are then refused, since nothing would restart it.
   */
  requestShutdown?: (reason: string) => void;
  /** Test seam; the default spawns `node updater.mjs state.json` detached. */
  spawnUpdater?: (updaterPath: string, statePath: string) => void;
  /** Test seam; defaults to the live `process`. */
  runtime?: UpgradeRuntime;
  /** Test seam; defaults to the pinned RELEASE_PUBLIC_KEYS. */
  publicKeys?: readonly string[];
  /** Delay before shutdown so the 202 reaches the caller. Default 250 ms. */
  shutdownDelayMs?: number;
}

const EXIT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 60_000;

export function defaultInstallCommand(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["npm.cmd", "i", "-g"] : ["npm", "i", "-g"];
}

export class UpgradeCoordinator {
  private inProgress = false;

  constructor(private readonly options: UpgradeCoordinatorOptions) {}

  async check(): Promise<UpgradeCheck> {
    const current = this.options.currentVersion;
    const latest = await this.resolveTarget(undefined);
    return { current, latest, available: compareSemver(latest, current) > 0 };
  }

  async upgradeSelf(input: UpgradeSelfInput): Promise<UpgradeStarted> {
    const { requestShutdown } = this.options;
    if (requestShutdown === undefined) {
      throw new UpgradeError(
        "unsupported",
        "this daemon was not started by homefleetd, so it cannot restart itself",
      );
    }
    if (this.inProgress) {
      throw new UpgradeError("locked", "an upgrade is already in progress");
    }
    const runtime = this.options.runtime ?? {
      pid: process.pid,
      execPath: process.execPath,
      argv: process.argv,
      platform: process.platform,
    };
    const from = this.options.currentVersion;
    const to = await this.resolveTarget(input.version);
    const notNewer = checkNewer(from, to);
    if (notNewer !== undefined) {
      throw notNewer; // before downloading anything
    }

    const dir = upgradesDir(this.options.dataDir);
    const prepared = await prepareRelease(this.prepareOptions(dir, to));
    const refusal = checkUpgradeGuards({
      current: from,
      target: to,
      targetHfpVersion: prepared.manifest.hfpVersion,
      localHfpVersion: this.options.localHfpVersion,
      activeJobs: this.options.activeJobs(),
      force: input.force ?? false,
      entryPath: runtime.argv[1] ?? "",
    });
    if (refusal !== undefined) {
      throw refusal;
    }
    // Best effort: pre-0.5 releases are unsigned, and GitHub may be down.
    const rollback: PreparedRelease | undefined = await prepareRelease(
      this.prepareOptions(dir, from),
    ).catch(() => undefined);

    if (!(await acquireLock(dir, { pid: runtime.pid, now: Date.now() }))) {
      throw new UpgradeError("locked", "another upgrade holds upgrades/upgrade.lock");
    }
    try {
      const updaterPath = path.join(dir, UPDATER_FILE);
      await writeFile(updaterPath, UPDATER_SOURCE);
      const { host, port } = this.options.controlEndpoint();
      const statePath = await writeUpgradeState(dir, {
        from,
        to,
        tarballPath: prepared.tarballPath,
        ...(rollback !== undefined ? { rollbackTarballPath: rollback.tarballPath } : {}),
        daemonPid: runtime.pid,
        nodePath: runtime.execPath,
        argv: runtime.argv.slice(1),
        controlHost: host,
        controlPort: port,
        installCommand: defaultInstallCommand(runtime.platform),
        dataDir: this.options.dataDir,
        exitTimeoutMs: EXIT_TIMEOUT_MS,
        healthTimeoutMs: HEALTH_TIMEOUT_MS,
      });
      const spawnUpdater =
        this.options.spawnUpdater ??
        ((updater: string, state: string) => {
          spawn(runtime.execPath, [updater, state], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
        });
      spawnUpdater(updaterPath, statePath);
    } catch (error) {
      await releaseLock(dir);
      throw error;
    }
    this.inProgress = true;
    setTimeout(
      () => requestShutdown(`upgrading to ${to}`),
      this.options.shutdownDelayMs ?? 250,
    );
    return { from, to };
  }

  private prepareOptions(dir: string, version: string) {
    return {
      source: this.options.source,
      upgradesDir: dir,
      version,
      ...(this.options.publicKeys !== undefined ? { publicKeys: this.options.publicKeys } : {}),
    };
  }

  private async resolveTarget(version: string | undefined): Promise<string> {
    if (version !== undefined) {
      return version;
    }
    try {
      return await this.options.source.latestVersion();
    } catch (error) {
      throw new UpgradeError(
        "fetch-failed",
        `could not look up the latest release: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/upgrade/coordinator.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Confirm the `?raw` embed builds**

Run: `pnpm build`
Then check that the bundle contains the updater:

```bash
grep -c "HomeFleet's detached upgrade helper" packages/daemon/dist/bin/homefleetd.js
```
Expected: `pnpm build` succeeds, but grep prints `0`, because nothing imports the coordinator until Task 14. That's fine. Repeat this check after Task 14, when it must print `1`.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/upgrade/coordinator.ts packages/daemon/src/upgrade/coordinator.test.ts
git commit -m "Upgrade: UpgradeCoordinator (check + upgradeSelf)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Control API routes

**Files:**
- Modify: `packages/daemon/src/control/messages.ts`
- Modify: `packages/daemon/src/control/control-server.ts`
- Test: `packages/daemon/src/control/control-server.test.ts`

- [ ] **Step 1: Add the request schema to `messages.ts`**

Append:

```ts
/**
 * Body of `POST /control/upgrade` (fleet-upgrade spec). `targets` only
 * accepts "self" until Phase 3 adds peer device IDs.
 */
export const UpgradeRequestSchema = z.strictObject({
  targets: z.literal("self").default("self"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "must be X.Y.Z")
    .optional(),
  force: z.boolean().optional(),
});
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;
```

- [ ] **Step 2: Write the failing tests**

In `control-server.test.ts`, add these imports:

```ts
import { UpgradeError } from "../upgrade/errors.js";
```

and extend `fakeSurface`'s returned object, before `...overrides`, with:

```ts
    checkUpgrade: async () => ({ current: "0.5.0", latest: "0.5.1", available: true }),
    upgrade: async () => ({ from: "0.5.0", to: "0.5.1" }),
```

Then append these tests. They reuse the file's existing `start()` and `send()` helpers, and `send()` adds the control header and a valid Host by default:

```ts
test("GET /control/upgrade/check returns the surface's answer", async () => {
  const server = await start();
  const response = await send(server.port, { method: "GET", path: "/control/upgrade/check" });
  expect(response.status).toBe(200);
  expect(response.json).toEqual({ current: "0.5.0", latest: "0.5.1", available: true });
});

test("POST /control/upgrade starts an upgrade and returns 202", async () => {
  const calls: unknown[] = [];
  const server = await start({
    surface: fakeSurface({
      upgrade: async (input) => {
        calls.push(input);
        return { from: "0.5.0", to: "0.5.2" };
      },
    }),
  });
  const response = await send(server.port, {
    method: "POST",
    path: "/control/upgrade",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "0.5.2", force: true }),
  });
  expect(response.status).toBe(202);
  expect(response.json).toEqual({ from: "0.5.0", to: "0.5.2" });
  expect(calls).toEqual([{ targets: "self", version: "0.5.2", force: true }]);
});

test("POST /control/upgrade rejects a bad version with 400", async () => {
  const server = await start();
  const response = await send(server.port, {
    method: "POST",
    path: "/control/upgrade",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "latest" }),
  });
  expect(response.status).toBe(400);
});

test.each([
  ["busy", 409],
  ["not-newer", 409],
  ["verify-failed", 422],
  ["fetch-failed", 502],
] as const)("an UpgradeError %s maps to %i with its code", async (code, status) => {
  const server = await start({
    surface: fakeSurface({
      upgrade: async () => {
        throw new UpgradeError(code, `refused: ${code}`);
      },
    }),
  });
  const response = await send(server.port, {
    method: "POST",
    path: "/control/upgrade",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(status);
  expect(response.json).toEqual({ error: `refused: ${code}`, code });
});

test("POST /control/upgrade still requires the control header", async () => {
  const server = await start();
  const response = await send(server.port, {
    method: "POST",
    path: "/control/upgrade",
    headers: { [CONTROL_HEADER]: undefined },
    body: "{}",
  });
  expect(response.status).toBe(403);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/control/control-server.test.ts`
Expected: FAIL at typecheck/runtime, because `checkUpgrade`/`upgrade` aren't on `ControlSurface` and the routes return 404.

- [ ] **Step 4: Implement in `control-server.ts`**

(a) Add these imports:

```ts
import type {
  UpgradeCheck,
  UpgradeStarted,
} from "../upgrade/coordinator.js";
import { UpgradeError } from "../upgrade/errors.js";
import type { UpgradeResult } from "../upgrade/files.js";
```

and extend the `./messages.js` import with `type UpgradeRequest, UpgradeRequestSchema`.

(b) In `ControlStatus`, after `maxConcurrentJobs: number;`:

```ts
  /** The last upgrade's outcome on this node, if one ever ran (upgrade-result.json). */
  lastUpgrade?: UpgradeResult;
```

(c) In `ControlSurface`, after `listJobs(): ControlJobs;`:

```ts
  /** Compares the running version with the latest published release. */
  checkUpgrade(): Promise<UpgradeCheck>;
  /**
   * Starts an upgrade of THIS node (see ../upgrade/coordinator.ts). Resolves
   * once the updater has been started — the daemon shuts down right after.
   * Refusals throw {@link UpgradeError}.
   */
  upgrade(input: UpgradeRequest): Promise<UpgradeStarted>;
```

(d) Update the module header's route list and security paragraph. Add this sentence to the "EXPLICIT SIGN-OFF" paragraph:

```
 * `POST /control/upgrade` joins that same same-OS-user trust boundary: it
 * can only install a release whose manifest verifies under a PINNED key
 * (../upgrade/manifest.ts), never caller-supplied bytes. Phase 4 of the
 * fleet-upgrade spec adds the per-boot token before a browser page may
 * trigger it.
```

(e) Replace the body-reading/JSON-parsing part of `handlePairConnect` with a shared helper, and use it in both handlers. Add this above `startControlServer`:

```ts
/**
 * Reads + JSON-parses a capped body, writing the 413/400 response itself on
 * failure (returns `undefined` then). An empty body parses as `{}`.
 */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | undefined> {
  const read = await readCappedBody(req);
  if (read.status === "too_large") {
    respondError(res, 413, `request body exceeds the ${MAX_CONTROL_REQUEST_BYTES}-byte limit`);
    return undefined;
  }
  if (read.status === "read_error") {
    respondError(res, 400, "failed to read request body");
    return undefined;
  }
  try {
    return read.text.trim() === "" ? {} : JSON.parse(read.text);
  } catch {
    respondError(res, 400, "invalid JSON body");
    return undefined;
  }
}

/** Short human-readable zod issues (never zod's multi-line JSON `.message`). */
function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "(body)"}: ${issue.message}`)
    .join("; ");
}

function upgradeErrorStatus(error: UpgradeError): number {
  switch (error.code) {
    case "fetch-failed":
      return 502;
    case "verify-failed":
      return 422;
    default:
      return 409;
  }
}
```

In `handlePairConnect`, replace everything from `const read = await readCappedBody(req);` down to the `respondError(res, 400, \`invalid pair/connect request: ${issues}\`); return; }` block with:

```ts
    const parsedJson = await readJsonBody(req, res);
    if (parsedJson === undefined) {
      return;
    }
    const parsed = PairConnectRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // See formatIssues: a CLI user's terminal, not a developer console.
      respondError(
        res,
        400,
        `invalid pair/connect request: ${formatIssues(parsed.error.issues)}`,
      );
      return;
    }
```

(The existing pair/connect tests must still pass unchanged. They prove the refactor kept behavior.)

Add the new handlers next to `handleJobs`:

```ts
  async function handleUpgradeCheck(res: ServerResponse): Promise<void> {
    try {
      respondJson(res, 200, await surface.checkUpgrade());
    } catch (error) {
      if (error instanceof UpgradeError) {
        respondJson(res, upgradeErrorStatus(error), { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  }

  async function handleUpgrade(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedJson = await readJsonBody(req, res);
    if (parsedJson === undefined) {
      return;
    }
    const parsed = UpgradeRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      respondError(res, 400, `invalid upgrade request: ${formatIssues(parsed.error.issues)}`);
      return;
    }
    try {
      respondJson(res, 202, await surface.upgrade(parsed.data));
    } catch (error) {
      if (error instanceof UpgradeError) {
        respondJson(res, upgradeErrorStatus(error), { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  }
```

and route them in `handle`, before the final 404:

```ts
      if (method === "GET" && pathname === "/control/upgrade/check") {
        await handleUpgradeCheck(res);
        return;
      }
      if (method === "POST" && pathname === "/control/upgrade") {
        await handleUpgrade(req, res);
        return;
      }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/control/control-server.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/control/messages.ts packages/daemon/src/control/control-server.ts packages/daemon/src/control/control-server.test.ts
git commit -m "Control API: upgrade check + start routes, lastUpgrade in status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`pnpm typecheck` fails at this point, because `daemon.ts` doesn't implement the new surface methods yet. Task 14 fixes it. Don't push between Tasks 12 and 14.

---

### Task 13: Control client

**Files:**
- Modify: `packages/daemon/src/cli/control-client.ts`
- Test: `packages/daemon/src/cli/control-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `control-client.test.ts`. It already starts real control servers against a fake surface. Build one with the same helper the file uses, or copy this minimal inline one:

```ts
import { startControlServer, type ControlSurface } from "../control/control-server.js";
import { UpgradeError } from "../upgrade/errors.js";
import { ControlClient, ControlRequestError } from "./control-client.js";

async function upgradeServer(upgrade: ControlSurface["upgrade"]) {
  return startControlServer({
    surface: {
      beginPairing: () => ({ code: "ABCDEFGH" }),
      pairWith: async () => ({ accepted: false }),
      status: () => {
        throw new Error("unused");
      },
      listNodes: async () => [],
      listJobs: () => ({ worker: [], delegated: [] }),
      checkUpgrade: async () => ({ current: "0.5.0", latest: "0.5.1", available: true }),
      upgrade,
    },
    port: 0,
  });
}

test("checkUpgrade + upgrade round-trip", async () => {
  const server = await upgradeServer(async () => ({ from: "0.5.0", to: "0.5.1" }));
  try {
    const client = new ControlClient({ host: "127.0.0.1", port: server.port });
    await expect(client.checkUpgrade()).resolves.toEqual({
      current: "0.5.0",
      latest: "0.5.1",
      available: true,
    });
    await expect(client.upgrade({ targets: "self" })).resolves.toEqual({
      from: "0.5.0",
      to: "0.5.1",
    });
  } finally {
    await server.close();
  }
});

test("an upgrade refusal surfaces as ControlRequestError with status + code", async () => {
  const server = await upgradeServer(async () => {
    throw new UpgradeError("busy", "1 job(s) running");
  });
  try {
    const client = new ControlClient({ host: "127.0.0.1", port: server.port });
    const error = await client.upgrade({ targets: "self" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlRequestError);
    expect(error).toMatchObject({ status: 409, code: "busy", message: "1 job(s) running" });
  } finally {
    await server.close();
  }
});
```

(If the file already imports some of these names, merge the imports instead of duplicating them.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/cli/control-client.test.ts`
Expected: FAIL, because `checkUpgrade`/`upgrade` aren't on `ControlClient`.

- [ ] **Step 3: Implement**

(a) `ControlRequestError` gains an optional code:

```ts
export class ControlRequestError extends Error {
  readonly status: number;
  /** The daemon's machine-readable `code`, when the error body carried one (upgrade routes). */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ControlRequestError";
    this.status = status;
    if (code !== undefined) {
      this.code = code;
    }
  }
}
```

(b) In `controlRequest`, replace the `if (!response.ok) { … }` block with:

```ts
  if (!response.ok) {
    const body =
      json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const message =
      typeof body.error === "string"
        ? body.error
        : `control API request failed with status ${response.status}`;
    throw new ControlRequestError(
      response.status,
      message,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
```

(c) Add the imports `import type { UpgradeRequest } from "../control/messages.js";` and `import type { UpgradeCheck, UpgradeStarted } from "../upgrade/coordinator.js";`, then extend `ControlClientLike`:

```ts
  checkUpgrade(): Promise<UpgradeCheck>;
  upgrade(input: UpgradeRequest): Promise<UpgradeStarted>;
```

(d) Add validators next to the others:

```ts
function validateUpgradeCheck(json: unknown): UpgradeCheck {
  assertIsObject(json, "upgrade/check");
  assertString(json.current, "current", "upgrade/check");
  assertString(json.latest, "latest", "upgrade/check");
  assertBoolean(json.available, "available", "upgrade/check");
  return json as unknown as UpgradeCheck;
}

function validateUpgradeStarted(json: unknown): UpgradeStarted {
  assertIsObject(json, "upgrade");
  assertString(json.from, "from", "upgrade");
  assertString(json.to, "to", "upgrade");
  return json as unknown as UpgradeStarted;
}
```

and in `validateControlStatus`, before the return:

```ts
  if (json.lastUpgrade !== undefined) {
    assertIsObject(json.lastUpgrade, "status.lastUpgrade");
  }
```

(e) Add the methods to `ControlClient`:

```ts
  async checkUpgrade(): Promise<UpgradeCheck> {
    const json = await controlRequest(this.options, "GET", "/control/upgrade/check");
    return validateUpgradeCheck(json);
  }

  async upgrade(input: UpgradeRequest): Promise<UpgradeStarted> {
    const json = await controlRequest(this.options, "POST", "/control/upgrade", input);
    return validateUpgradeStarted(json);
  }
```

(f) In `packages/daemon/src/cli/cli.test.ts`, add defaults to `fakeControlClient` before `...overrides`, so the existing CLI tests keep compiling:

```ts
    checkUpgrade: async () => ({ current: "0.5.0", latest: "0.5.0", available: false }),
    upgrade: async () => ({ from: "0.5.0", to: "0.5.1" }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/cli/control-client.test.ts packages/daemon/src/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/cli/control-client.ts packages/daemon/src/cli/control-client.test.ts packages/daemon/src/cli/cli.test.ts
git commit -m "Control client: checkUpgrade, upgrade, error codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Wire the coordinator into the daemon and homefleetd

**Files:**
- Modify: `packages/daemon/src/daemon.ts`
- Modify: `packages/daemon/src/bin/homefleetd.ts`
- Test: `packages/daemon/src/daemon.control.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Append to `daemon.control.integration.test.ts`:

```ts
import { ControlRequestError } from "./cli/control-client.js";

test("a daemon without a shutdown hook refuses upgrades cleanly (409 unsupported) and reports no lastUpgrade", async () => {
  const { daemon } = await h.startDaemon("solo");
  const control = controlClientFor(daemon);

  const error = await control.upgrade({ targets: "self" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ControlRequestError);
  expect(error).toMatchObject({ status: 409, code: "unsupported" });

  const status = await control.status();
  expect(status.lastUpgrade).toBeUndefined();
});
```

(If `ControlRequestError` is already imported, merge it into the existing import.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/daemon.control.integration.test.ts`
Expected: FAIL. It won't typecheck, since the daemon's surface lacks `upgrade`, or it gets a 500 at runtime.

- [ ] **Step 3: Implement in `daemon.ts`**

(a) Imports:

```ts
import { UpgradeCoordinator } from "./upgrade/coordinator.js";
import { readUpgradeResultSync } from "./upgrade/files.js";
import { GitHubReleaseSource, type ReleaseSource } from "./upgrade/release-source.js";
```

(`HFP_PROTOCOL_VERSION` and `DAEMON_VERSION` are already imported.)

(b) `DaemonOptions`, after `onDiagnostic`:

```ts
  /**
   * Asks the hosting process for its normal graceful shutdown — homefleetd
   * passes its signal handler. The upgrade flow calls it after starting the
   * detached updater. Absent (tests, embedders) → upgrades are refused with
   * `unsupported`, since nothing would restart the daemon.
   */
  requestShutdown?: (reason: string) => void;
  /** Where upgrades come from; defaults to GitHub Releases. Tests inject a fake. */
  releaseSource?: ReleaseSource;
```

(c) Class fields + constructor:

```ts
  private readonly requestShutdown: ((reason: string) => void) | undefined;
  private readonly releaseSource: ReleaseSource | undefined;
```

```ts
    this.requestShutdown = options.requestShutdown;
    this.releaseSource = options.releaseSource;
```

(d) In `startComponents`, right before `const controlSurface: ControlSurface = {` (after `let controlPort = 0;`):

```ts
    const upgrades = new UpgradeCoordinator({
      dataDir,
      currentVersion: DAEMON_VERSION,
      localHfpVersion: HFP_PROTOCOL_VERSION,
      source: this.releaseSource ?? new GitHubReleaseSource(),
      activeJobs: () => jobManager.activeJobs,
      controlEndpoint: () => ({ host: config.control.host, port: controlPort }),
      ...(this.requestShutdown !== undefined ? { requestShutdown: this.requestShutdown } : {}),
    });
```

(e) In `controlSurface.status()`, add this to the returned object after `maxConcurrentJobs`:

```ts
          ...(() => {
            const lastUpgrade = readUpgradeResultSync(dataDir);
            return lastUpgrade !== undefined ? { lastUpgrade } : {};
          })(),
```

(f) After `listJobs: …,` in `controlSurface`:

```ts
      checkUpgrade: () => upgrades.check(),
      upgrade: (input) =>
        upgrades.upgradeSelf({
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(input.force !== undefined ? { force: input.force } : {}),
        }),
```

- [ ] **Step 4: Implement in `homefleetd.ts`**

Restructure `main()` so the shutdown function exists before the daemon is constructed, and pass it in. Replace the body from `const daemon = new Daemon({` through the two `process.on(...)` lines with:

```ts
  // Graceful shutdown: the first request stops once and exits 0; a second
  // one while teardown is still running force-exits 1 (the operator's
  // escape hatch from a hung stop). Signals AND the upgrade flow use it —
  // declared first so the Daemon can be handed it.
  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) {
      writeStderrLine("homefleetd: forced exit");
      process.exit(1);
    }
    stopping = true;
    writeStderrLine(`homefleetd: ${reason}, shutting down`);
    daemon.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        writeStderrLine(
          `homefleetd: shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      },
    );
  };

  const daemon = new Daemon({
    dataDir,
    config,
    onError: (error) => {
      writeStderrLine(
        `homefleetd background error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
    // Informational component diagnostics (e.g. the WorkspaceStore's
    // legacy-cache-layout warning) — operator-facing, so they go to stderr
    // like every other line this bin emits.
    onDiagnostic: (message) => {
      writeStderrLine(`homefleetd: ${message}`);
    },
    requestShutdown: shutdown,
  });
  process.on("SIGINT", () => shutdown("SIGINT received"));
  process.on("SIGTERM", () => shutdown("SIGTERM received"));
  await daemon.start();

  const info = daemon.nodeInfo();
  writeStderrLine(
    `homefleetd started: "${info.name}" (${daemon.deviceId.slice(0, 12)}…) ` +
      `hfp ${config.hfp.host}:${daemon.hfpPort} ` +
      `mcp http://${config.mcp.host}:${daemon.mcpPort}/mcp ` +
      `control http://${config.control.host}:${daemon.controlPort} ` +
      `data ${dataDir}`,
  );
```

(The startup log line is unchanged, only moved. Signal handlers are now registered before `start()`, which is harmless: `stop()` is idempotent.)

- [ ] **Step 5: Run the tests, typecheck, build**

Run: `pnpm test -- packages/daemon/src/daemon.control.integration.test.ts packages/daemon/src/bin/homefleetd.test.ts && pnpm typecheck && pnpm build`
Expected: all green.

Then check that the updater is embedded:

```bash
grep -c "HomeFleet's detached upgrade helper" packages/daemon/dist/bin/homefleetd.js
```
Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/bin/homefleetd.ts packages/daemon/src/daemon.control.integration.test.ts
git commit -m "Daemon: wire the upgrade coordinator into the control API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: `homefleet upgrade` CLI

**Files:**
- Modify: `packages/daemon/src/cli/cli.ts`
- Modify: `packages/daemon/src/bin/homefleet.ts`
- Test: `packages/daemon/src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `cli.test.ts`. They use the file's `makeHarness`/`fakeControlClient`; add `import type { ControlStatus } from "../control/control-server.js";` if it isn't already there.

```ts
describe("upgrade", () => {
  function statusAt(daemonVersion: string, extra: Partial<ControlStatus> = {}): ControlStatus {
    return {
      deviceId: FAKE_DEVICE_ID,
      name: "n",
      platform: "win32",
      daemonVersion,
      protocolVersion: "0.3.0",
      hfpPort: 1,
      mcpPort: 2,
      controlPort: 3,
      roles: [],
      executors: [],
      models: [],
      activeJobs: 0,
      maxConcurrentJobs: 1,
      ...extra,
    };
  }

  /** Harness with a fake clock: every sleep advances it. */
  function upgradeHarness(client: ControlClientLike) {
    const h = makeHarness({ controlClient: client });
    let clock = 1_000;
    h.deps.now = () => clock;
    h.deps.sleep = async (ms) => {
      clock += ms;
    };
    return h;
  }

  test("--check reports an available upgrade", async () => {
    const h = makeHarness({
      controlClient: fakeControlClient({
        checkUpgrade: async () => ({ current: "0.5.0", latest: "0.5.1", available: true }),
      }),
    });
    expect(await runCli(["upgrade", "--check"], h.deps)).toBe(0);
    expect(h.stdoutLines).toEqual(["Upgrade available: 0.5.0 → 0.5.1"]);
  });

  test("--check when up to date", async () => {
    const h = makeHarness();
    expect(await runCli(["upgrade", "--check"], h.deps)).toBe(0);
    expect(h.stdoutLines[0]).toMatch(/^Up to date \(0\.5\.0/);
  });

  test("passes --to and --force, waits through the restart, reports success", async () => {
    const calls: unknown[] = [];
    const statuses = [
      () => Promise.reject(new DaemonUnreachableError("127.0.0.1", 56373, undefined)),
      () => Promise.resolve(statusAt("0.5.1")),
    ];
    const h = upgradeHarness(
      fakeControlClient({
        upgrade: async (input) => {
          calls.push(input);
          return { from: "0.5.0", to: "0.5.1" };
        },
        status: () => (statuses.shift() ?? (() => Promise.resolve(statusAt("0.5.1"))))(),
      }),
    );
    expect(await runCli(["upgrade", "--to", "0.5.1", "--force"], h.deps)).toBe(0);
    expect(calls).toEqual([{ targets: "self", version: "0.5.1", force: true }]);
    expect(h.stdoutLines.at(-1)).toBe("Upgraded to 0.5.1.");
  });

  test("a rollback is reported with its reason and exit 1", async () => {
    const h = upgradeHarness(
      fakeControlClient({
        status: async () =>
          statusAt("0.5.0", {
            lastUpgrade: {
              from: "0.5.0",
              to: "0.5.1",
              outcome: "rolled-back",
              reason: "health check failed",
              at: 5_000,
            },
          }),
      }),
    );
    expect(await runCli(["upgrade"], h.deps)).toBe(1);
    expect(h.stderrLines.at(-1)).toBe(
      "Upgrade to 0.5.1 failed and was rolled back to 0.5.0: health check failed",
    );
  });

  test("an old lastUpgrade from a previous run is ignored", async () => {
    const statuses = [
      statusAt("0.5.0", {
        lastUpgrade: { from: "0.4.9", to: "0.5.1", outcome: "failed", at: 10 },
      }),
      statusAt("0.5.1"),
    ];
    const h = upgradeHarness(
      fakeControlClient({ status: async () => statuses.shift() ?? statusAt("0.5.1") }),
    );
    expect(await runCli(["upgrade"], h.deps)).toBe(0);
  });

  test("a refusal prints the daemon's reason", async () => {
    const h = makeHarness({
      controlClient: fakeControlClient({
        upgrade: async () => {
          throw new ControlRequestError(409, "1 job(s) running; wait or pass --force", "busy");
        },
      }),
    });
    expect(await runCli(["upgrade"], h.deps)).toBe(1);
    expect(h.stderrLines).toEqual(["Upgrade refused: 1 job(s) running; wait or pass --force"]);
  });

  test("times out when the daemon never comes back", async () => {
    const h = upgradeHarness(
      fakeControlClient({
        status: () => Promise.reject(new DaemonUnreachableError("127.0.0.1", 56373, undefined)),
      }),
    );
    expect(await runCli(["upgrade"], h.deps)).toBe(1);
    expect(h.stderrLines.at(-1)).toMatch(/^Timed out waiting for homefleetd to come back on 0\.5\.1/);
  });

  test("the timeout path reads the result file when there is one", async () => {
    const h = upgradeHarness(
      fakeControlClient({
        status: () => Promise.reject(new DaemonUnreachableError("127.0.0.1", 56373, undefined)),
      }),
    );
    h.deps.readUpgradeResult = () => ({
      from: "0.5.0",
      to: "0.5.1",
      outcome: "failed",
      reason: "rollback unavailable",
      at: 999_999_999,
    });
    expect(await runCli(["upgrade"], h.deps)).toBe(1);
    expect(h.stderrLines.at(-1)).toBe("Upgrade to 0.5.1 failed: rollback unavailable");
  });

  test.each([[["--to"]], [["--to", "latest"]], [["--bogus"]]])("bad args %j → exit 2", async (args) => {
    const h = makeHarness();
    expect(await runCli(["upgrade", ...args], h.deps)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- packages/daemon/src/cli/cli.test.ts`
Expected: FAIL. `deps.now`/`deps.sleep`/`deps.readUpgradeResult` don't exist, and `upgrade` falls through to USAGE (exit 2).

- [ ] **Step 3: Implement in `cli.ts`**

(a) Imports:

```ts
import path from "node:path";
import type { UpgradeStarted } from "../upgrade/coordinator.js";
import { UPDATER_LOG, type UpgradeResult, upgradesDir } from "../upgrade/files.js";
import { isSemver } from "../upgrade/semver.js";
```

(`ControlRequestError` and `DaemonUnreachableError` are already imported.)

(b) `CliDeps`, after `openUrl`:

```ts
  /** Clock for `upgrade`'s wait loop; defaults to `Date.now`. */
  now?: () => number;
  /** Sleep for `upgrade`'s wait loop; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Reads `<dataDir>/upgrade-result.json` (real: `readUpgradeResultSync`) —
   * `upgrade`'s last resort when the daemon never came back to report it.
   */
  readUpgradeResult?: (dataDir: string) => UpgradeResult | undefined;
```

(c) USAGE, after the `dashboard` entry:

```
  homefleet upgrade [--to <version>] [--check] [--force]
      Upgrade THIS node's running daemon to the latest signed release (or
      --to <version>), restart it in the background, and wait until it is
      back. Rolls back automatically if the new version fails to start.
      --check only reports whether an upgrade is available; --force
      upgrades even while jobs are running.
```

(d) The command:

```ts
/** How long `upgrade` waits for the restarted daemon (spec: 3 minutes). */
export const UPGRADE_WAIT_MS = 180_000;
const UPGRADE_POLL_MS = 2_000;

interface UpgradeArgs {
  check: boolean;
  force: boolean;
  version?: string;
}

function parseUpgradeArgs(args: string[], deps: CliDeps): UpgradeArgs | undefined {
  const parsed: UpgradeArgs = { check: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") {
      parsed.check = true;
    } else if (arg === "--force") {
      parsed.force = true;
    } else if (arg === "--to") {
      const version = args[++i];
      if (version === undefined || !isSemver(version)) {
        deps.stderr("upgrade: --to requires a version like 0.5.1");
        return undefined;
      }
      parsed.version = version;
    } else {
      deps.stderr(`upgrade: unexpected argument "${arg}"`);
      return undefined;
    }
  }
  return parsed;
}

function reportUpgradeFailure(last: UpgradeResult, deps: CliDeps): number {
  const reason = last.reason ?? "no reason recorded";
  deps.stderr(
    last.outcome === "rolled-back"
      ? `Upgrade to ${last.to} failed and was rolled back to ${last.from}: ${reason}`
      : `Upgrade to ${last.to} failed: ${reason}`,
  );
  return 1;
}

/**
 * Polls status until the daemon answers on the new version (success), or
 * reports a fresh failed/rolled-back result for this target. Unreachable
 * while restarting is expected and simply retried.
 */
async function waitForUpgrade(
  client: ControlClientLike,
  started: UpgradeStarted,
  deps: CliDeps,
): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const isFresh = (last: UpgradeResult | undefined): last is UpgradeResult =>
    last !== undefined && last.to === started.to && last.at >= startedAt;

  while (now() - startedAt < UPGRADE_WAIT_MS) {
    await sleep(UPGRADE_POLL_MS);
    let status: Awaited<ReturnType<ControlClientLike["status"]>>;
    try {
      status = await client.status();
    } catch (error) {
      if (error instanceof DaemonUnreachableError) {
        continue;
      }
      throw error;
    }
    if (isFresh(status.lastUpgrade) && status.lastUpgrade.outcome !== "succeeded") {
      return reportUpgradeFailure(status.lastUpgrade, deps);
    }
    if (status.daemonVersion === started.to) {
      deps.stdout(`Upgraded to ${started.to}.`);
      return 0;
    }
  }
  const last = deps.readUpgradeResult?.(deps.dataDir);
  if (isFresh(last)) {
    if (last.outcome === "succeeded") {
      deps.stdout(`Upgraded to ${started.to}.`);
      return 0;
    }
    return reportUpgradeFailure(last, deps);
  }
  deps.stderr(
    `Timed out waiting for homefleetd to come back on ${started.to}. ` +
      `See ${path.join(upgradesDir(deps.dataDir), UPDATER_LOG)}.`,
  );
  return 1;
}

async function runUpgrade(args: string[], deps: CliDeps): Promise<number> {
  const parsed = parseUpgradeArgs(args, deps);
  if (parsed === undefined) {
    return 2;
  }
  return withControlClient(deps, async (client) => {
    if (parsed.check) {
      const check = await client.checkUpgrade();
      deps.stdout(
        check.available
          ? `Upgrade available: ${check.current} → ${check.latest}`
          : `Up to date (${check.current}; latest release ${check.latest}).`,
      );
      return 0;
    }
    let started: UpgradeStarted;
    try {
      started = await client.upgrade({
        targets: "self",
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        ...(parsed.force ? { force: true } : {}),
      });
    } catch (error) {
      if (error instanceof ControlRequestError) {
        deps.stderr(`Upgrade refused: ${error.message}`);
        return 1;
      }
      throw error;
    }
    deps.stdout(
      `Upgrading ${started.from} → ${started.to}. homefleetd is restarting ` +
        "and will come back in the background (not in this terminal).",
    );
    return waitForUpgrade(client, started, deps);
  });
}
```

(e) `dispatch`, before `default:`:

```ts
    case "upgrade":
      return runUpgrade(rest, deps);
```

- [ ] **Step 4: Wire the real reader in `bin/homefleet.ts`**

Import it:

```ts
import { readUpgradeResultSync } from "../upgrade/files.js";
```

and add it to `deps`:

```ts
    readUpgradeResult: readUpgradeResultSync,
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test -- packages/daemon/src/cli/cli.test.ts`
Expected: PASS, including every pre-existing CLI test.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/cli/cli.ts packages/daemon/src/cli/cli.test.ts packages/daemon/src/bin/homefleet.ts
git commit -m "CLI: homefleet upgrade [--to] [--check] [--force]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Docs

**Files:**
- Modify: `docs/reference/releasing.md`
- Modify: `README.md`
- Modify: `docs/specs/2026-09-25-fleet-upgrade-design.md`

- [ ] **Step 1: `releasing.md`: add a "Release signing" section after "Cutting a release"**

```markdown
## Release signing

Every release publishes three assets: `homefleet-X.Y.Z.tgz`,
`homefleet-X.Y.Z.manifest.json` (version, sha256, size, HFP version) and
`homefleet-X.Y.Z.manifest.sig` (a detached Ed25519 signature over the
manifest bytes). `homefleet upgrade` installs only a tarball whose manifest
verifies under a key pinned in
`packages/daemon/src/upgrade/release-keys.ts`.

- The private key is the `HOMEFLEET_RELEASE_KEY` Actions secret; an offline
  backup lives with Hugo. The `pack` job signs, then verifies against the
  pinned key, before anything is published.
- To sign a local build by hand (for example the rig rollback test):
  `pnpm sign:release <tgz> --key-file <pem>`, then
  `pnpm verify:release <tgz>`.
- **Rotating the key:** generate a new pair with `pnpm release:keygen`, ADD
  the new public key to `RELEASE_PUBLIC_KEYS` (keep the old one), ship a
  release still signed with the old key, and only then switch the secret.
  Nodes that never installed a release pinning the new key must be upgraded
  by hand.
```

In step 1 of "Cutting a release", the four version locations are unchanged. Add a line to step 5 (the dry run): "the `pack` job must print `verified homefleet-X.Y.Z.tgz`."

- [ ] **Step 2: `README.md`: replace the "To update, install the newer tarball the same way." sentence in Install**

```markdown
To update an installed node (v0.5.0 or later), run `homefleet upgrade`: it
downloads the latest release, checks its signature, installs it, restarts
the daemon in the background and rolls back automatically if the new
version fails to start. `homefleet upgrade --check` only reports what is
available. Upgrading *to* v0.5.0 is the last manual `npm i -g`.
```

(The status blurb and roadmap get their v0.5 refresh at release time, per the release checklist. Don't change them here.)

- [ ] **Step 3: Spec: record the deviations**

Under "## Decisions", add a row:

```markdown
| Plan-time adjustments (Phase 1–2 plan) | Pre-publish verification runs in the `pack` job (the smoke runner has no source tree). The updater inherits the daemon's environment instead of recording env vars. A `not-installed` guard refuses daemons run from a git checkout. `ControlStatus.lastUpgrade` ships in Phase 2 for the CLI; `NodeInfo.lastUpgrade` stays in Phase 3. |
```

In "## Phase 1", change the "Smoke test addition" bullet to:

```markdown
- **Pre-publish verification:** the `pack` job runs `pnpm verify:release`
  against the key pinned in the source tree right after signing, so a key
  mismatch fails the release before anything is published.
```

In "## Phase 2 → Flow (daemon)" step 6, replace `env: { HOMEFLEET_DATA_DIR?, … }, ` and the sentence after it with: "The updater and the relaunched daemon inherit the daemon's environment."

In "## Phase 2 → Flow (daemon)" step 3, append: "This includes `not-installed`: the daemon's entry script must live under `node_modules/homefleet/`."

- [ ] **Step 4: Commit**

```bash
git add docs/reference/releasing.md README.md docs/specs/2026-09-25-fleet-upgrade-design.md
git commit -m "Docs: release signing, homefleet upgrade, spec plan-time adjustments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Full verification + push

- [ ] 🟢 **Step 1: Everything green**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass. Report the test count honestly; if anything fails, fix it before pushing.

- [ ] 🟢 **Step 2: Upgrade code is in the packed bundle**

```bash
pnpm pack:release --out release-check
tar -xzOf release-check/homefleet-*.tgz package/dist/bin/homefleetd.js | grep -c "HomeFleet's detached upgrade helper"
```
Expected: `1`. Then delete `release-check/`.

- [ ] **Step 3: Push, then check CI**

`git push`, then `gh run watch` on the CI run. Expected: green on both OSes.

- [ ] **Step 4: Hand off to the release**

The v0.5.0 release itself follows `docs/reference/releasing.md`: version bump in four places, `docs/releases/v0.5.0.md`, the README status refresh, the tag. On both rig machines, upgrading 0.4.0 → 0.5.0 is manual (`npm i -g`). **The first real end-to-end proof of `homefleet upgrade` is 0.5.0 → 0.5.1.** Plan that as a small follow-up release, plus the rollback test on the tower (a locally built, hand-signed 0.5.2 whose daemon exits at startup, installed with `homefleet upgrade --to 0.5.2` from a local `upgrades/0.5.2/` cache). Record both in a devlog.
