/**
 * Drives scripts/sign-release.mjs as a subprocess from a COPY that sits in
 * a temp dir with no node_modules — the same isolation as the release
 * workflow's `sign` job, which installs nothing (spec 2026-11-12, PR 1).
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  hashFile,
  serializeManifest,
  verifyRelease,
} from "../packages/daemon/src/upgrade/manifest.js";
import { HFP_PROTOCOL_VERSION } from "../packages/protocol/src/version.js";
import { generateReleaseKeyPair } from "./lib/sign-release.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Sandbox {
  root: string;
  script: string;
  versionTs: string;
  tarball: string;
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(tmpdir(), "hf-signer-"));
  dirs.push(root);
  const script = path.join(root, "scripts", "sign-release.mjs");
  const versionTs = path.join(
    root,
    "packages",
    "protocol",
    "src",
    "version.ts",
  );
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(path.dirname(versionTs), { recursive: true });
  await copyFile(path.join(repoRoot, "scripts", "sign-release.mjs"), script);
  await copyFile(
    path.join(repoRoot, "packages", "protocol", "src", "version.ts"),
    versionTs,
  );
  const tarball = path.join(root, "out", "homefleet-0.5.0.tgz");
  await mkdir(path.dirname(tarball), { recursive: true });
  await writeFile(tarball, "release bytes");
  return { root, script, versionTs, tarball };
}

function run(
  box: Sandbox,
  args: string[],
  key?: string,
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.HOMEFLEET_RELEASE_KEY;
  if (key !== undefined) env.HOMEFLEET_RELEASE_KEY = key;
  try {
    const stdout = execFileSync(process.execPath, [box.script, ...args], {
      cwd: box.root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

const manifestOf = (box: Sandbox) =>
  path.join(path.dirname(box.tarball), "homefleet-0.5.0.manifest.json");
const sigOf = (box: Sandbox) =>
  path.join(path.dirname(box.tarball), "homefleet-0.5.0.manifest.sig");

async function expectVerifies(box: Sandbox, publicKey: string): Promise<void> {
  const result = await verifyRelease({
    manifestBytes: await readFile(manifestOf(box)),
    signature: await readFile(sigOf(box), "utf8"),
    tarballPath: box.tarball,
    expectedVersion: "0.5.0",
    publicKeys: [publicKey],
  });
  expect(result).toMatchObject({ ok: true });
}

test("signs from a copy with no node_modules, and the daemon verifies it", async () => {
  const box = await sandbox();
  const keys = generateReleaseKeyPair();
  const out = run(box, [box.tarball], keys.privateKeyPem);
  expect(out.code).toBe(0);
  expect(out.stdout.trim().split(/\r?\n/)).toEqual([
    manifestOf(box),
    sigOf(box),
  ]);

  await expectVerifies(box, keys.publicKeyBase64);
  const { sha256, size } = await hashFile(box.tarball);
  expect(await readFile(manifestOf(box), "utf8")).toBe(
    serializeManifest({
      version: "0.5.0",
      file: "homefleet-0.5.0.tgz",
      sha256,
      size,
      hfpVersion: HFP_PROTOCOL_VERSION,
    }),
  );
  expect(await readFile(sigOf(box), "utf8")).toMatch(/^[A-Za-z0-9+/=]+\n$/);
});

test("--key-file works and wins over the env var", async () => {
  const box = await sandbox();
  const fileKeys = generateReleaseKeyPair();
  const envKeys = generateReleaseKeyPair();
  const keyFile = path.join(box.root, "key.pem");
  await writeFile(keyFile, fileKeys.privateKeyPem);
  const out = run(
    box,
    [box.tarball, "--key-file", keyFile],
    envKeys.privateKeyPem,
  );
  expect(out.code).toBe(0);
  await expectVerifies(box, fileKeys.publicKeyBase64);
});

test("refuses a non-Ed25519 key", async () => {
  const box = await sandbox();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const out = run(box, [box.tarball], pem);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/^sign-release: .*Ed25519/);
  expect(existsSync(manifestOf(box))).toBe(false);
});

test("refuses a missing or blank key", async () => {
  const box = await sandbox();
  for (const key of [undefined, "   \n"]) {
    const out = run(box, [box.tarball], key);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/no signing key/);
  }
  expect(existsSync(manifestOf(box))).toBe(false);
});

test("refuses zero or several tarballs", async () => {
  const box = await sandbox();
  const key = generateReleaseKeyPair().privateKeyPem;
  expect(run(box, [], key)).toMatchObject({ code: 1 });
  expect(run(box, [], key).stderr).toMatch(/usage/);
  const two = run(box, [box.tarball, box.tarball], key);
  expect(two.code).toBe(1);
  expect(two.stderr).toMatch(/usage/);
  expect(existsSync(manifestOf(box))).toBe(false);
});

test("refuses a tarball not named homefleet-X.Y.Z.tgz", async () => {
  const box = await sandbox();
  const other = path.join(box.root, "out", "other-0.5.0.tgz");
  await writeFile(other, "x");
  const out = run(box, [other], generateReleaseKeyPair().privateKeyPem);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/homefleet-X\.Y\.Z\.tgz/);
});

test("refuses an empty tarball", async () => {
  const box = await sandbox();
  await writeFile(box.tarball, "");
  const out = run(box, [box.tarball], generateReleaseKeyPair().privateKeyPem);
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/^sign-release: .*empty/);
  expect(existsSync(manifestOf(box))).toBe(false);
});

test("reads the HFP version from a CRLF version.ts", async () => {
  const box = await sandbox();
  const lf = (await readFile(box.versionTs, "utf8")).replaceAll("\r\n", "\n");
  await writeFile(box.versionTs, lf.replaceAll("\n", "\r\n"));
  const out = run(box, [box.tarball], generateReleaseKeyPair().privateKeyPem);
  expect(out.code).toBe(0);
  const manifest = JSON.parse(await readFile(manifestOf(box), "utf8"));
  expect(manifest.hfpVersion).toBe(HFP_PROTOCOL_VERSION);
});

test("refuses a version.ts without a valid HFP_PROTOCOL_VERSION", async () => {
  const box = await sandbox();
  const source = await readFile(box.versionTs, "utf8");
  const key = generateReleaseKeyPair().privateKeyPem;
  for (const broken of [
    source.replace(
      /HFP_PROTOCOL_VERSION = "[^"]*"/,
      'HFP_PROTOCOL_VERSION = "0.4"',
    ),
    source.replaceAll("HFP_PROTOCOL_VERSION", "SOMETHING_ELSE"),
  ]) {
    await writeFile(box.versionTs, broken);
    const out = run(box, [box.tarball], key);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/HFP_PROTOCOL_VERSION/);
  }
  expect(existsSync(manifestOf(box))).toBe(false);
});

// --digest: the CI sign job never receives a file, only three strings that
// pack computed. verify then checks the real tarball against the manifest.
describe("--digest <dir>: sign a version, sha256 and size, no file", () => {
  async function digestOf(box: Sandbox) {
    const { sha256, size } = await hashFile(box.tarball);
    return {
      HOMEFLEET_RELEASE_VERSION: "0.5.0",
      HOMEFLEET_RELEASE_SHA256: sha256,
      HOMEFLEET_RELEASE_SIZE: String(size),
    };
  }

  test("writes the same manifest as signing the file, into <dir>", async () => {
    const box = await sandbox();
    const keys = generateReleaseKeyPair();
    const fromFile = run(box, [box.tarball], keys.privateKeyPem);
    expect(fromFile.code).toBe(0);
    const expected = await readFile(manifestOf(box), "utf8");

    const outDir = path.join(box.root, "signed");
    const out = run(
      box,
      ["--digest", outDir],
      keys.privateKeyPem,
      await digestOf(box),
    );
    expect(out.code).toBe(0);
    const manifest = path.join(outDir, "homefleet-0.5.0.manifest.json");
    expect(await readFile(manifest, "utf8")).toBe(expected);
    const result = await verifyRelease({
      manifestBytes: await readFile(manifest),
      signature: await readFile(
        path.join(outDir, "homefleet-0.5.0.manifest.sig"),
        "utf8",
      ),
      tarballPath: box.tarball,
      expectedVersion: "0.5.0",
      publicKeys: [keys.publicKeyBase64],
    });
    expect(result).toMatchObject({ ok: true });
  });

  test("a digest that does not match the tarball fails verification", async () => {
    const box = await sandbox();
    const keys = generateReleaseKeyPair();
    const outDir = path.join(box.root, "signed");
    const lie = {
      ...(await digestOf(box)),
      HOMEFLEET_RELEASE_SHA256: "a".repeat(64),
    };
    expect(run(box, ["--digest", outDir], keys.privateKeyPem, lie).code).toBe(
      0,
    );
    const result = await verifyRelease({
      manifestBytes: await readFile(
        path.join(outDir, "homefleet-0.5.0.manifest.json"),
      ),
      signature: await readFile(
        path.join(outDir, "homefleet-0.5.0.manifest.sig"),
        "utf8",
      ),
      tarballPath: box.tarball,
      expectedVersion: "0.5.0",
      publicKeys: [keys.publicKeyBase64],
    });
    expect(result.ok).toBe(false);
  });

  test.each([
    [
      "a non-semver version",
      { HOMEFLEET_RELEASE_VERSION: "0.5.0-rc.1" },
      /VERSION/,
    ],
    [
      "a path in the version",
      { HOMEFLEET_RELEASE_VERSION: "../0.5.0" },
      /VERSION/,
    ],
    [
      "an upper-case sha256",
      { HOMEFLEET_RELEASE_SHA256: "A".repeat(64) },
      /SHA256/,
    ],
    ["a short sha256", { HOMEFLEET_RELEASE_SHA256: "a".repeat(63) }, /SHA256/],
    ["a zero size", { HOMEFLEET_RELEASE_SIZE: "0" }, /SIZE/],
    ["a non-integer size", { HOMEFLEET_RELEASE_SIZE: "12.5" }, /SIZE/],
    [
      "a size over 100 MiB",
      { HOMEFLEET_RELEASE_SIZE: String(100 * 1024 * 1024 + 1) },
      /SIZE/,
    ],
    ["a missing value", { HOMEFLEET_RELEASE_SIZE: "" }, /SIZE/],
  ])("refuses %s", async (_label, override, message) => {
    const box = await sandbox();
    const outDir = path.join(box.root, "signed");
    const out = run(
      box,
      ["--digest", outDir],
      generateReleaseKeyPair().privateKeyPem,
      { ...(await digestOf(box)), ...override },
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(message);
    expect(existsSync(outDir)).toBe(false);
  });

  test("refuses --digest with a tarball argument too", async () => {
    const box = await sandbox();
    const out = run(
      box,
      ["--digest", path.join(box.root, "signed"), box.tarball],
      generateReleaseKeyPair().privateKeyPem,
      await digestOf(box),
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/usage/);
  });
});
