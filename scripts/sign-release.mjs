#!/usr/bin/env node
/**
 * node scripts/sign-release.mjs <tarball> [--key-file <pem>]
 * node scripts/sign-release.mjs --digest <out-dir> [--key-file <pem>]   (CI)
 *
 * Writes homefleet-<v>.manifest.json + .manifest.sig next to the tarball and
 * prints both paths. The Ed25519 key comes from --key-file or the
 * HOMEFLEET_RELEASE_KEY env var (CI).
 *
 * This script must stay DEPENDENCY-FREE (node: built-ins only). The release
 * workflow's `sign` job is the only place the release key exists, and it
 * installs nothing: a compromised npm dependency there could steal the key
 * every node trusts to auto-install code (docs/specs/2026-11-12-release-
 * candidates-design.md, PR 1). The job checks out only this file and
 * packages/protocol/src/version.ts, which is read as TEXT for the HFP
 * version.
 *
 * The manifest bytes must equal serializeManifest() in
 * packages/daemon/src/upgrade/manifest.ts; scripts/sign-release.test.ts
 * pins that, and `pnpm verify:release` re-checks every signed release.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SEMVER = /^\d+\.\d+\.\d+$/;
const TARBALL = /^homefleet-(\d+\.\d+\.\d+)\.tgz$/;
const HFP_CONSTANT = /^export const HFP_PROTOCOL_VERSION = "([^"]*)";\r?$/m;

async function hfpVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(
    here,
    "..",
    "packages",
    "protocol",
    "src",
    "version.ts",
  );
  const match = HFP_CONSTANT.exec(await readFile(file, "utf8"));
  if (match?.[1] === undefined || !SEMVER.test(match[1])) {
    throw new Error(`no X.Y.Z HFP_PROTOCOL_VERSION constant found in ${file}`);
  }
  return match[1];
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

const USAGE =
  "usage: node scripts/sign-release.mjs <tarball> [--key-file <pem>]\n" +
  "       node scripts/sign-release.mjs --digest <out-dir> [--key-file <pem>]";

/** The largest tarball a node will download (MAX_RELEASE_ASSET_BYTES). */
const MAX_SIZE = 100 * 1024 * 1024;

/**
 * --digest mode (the CI sign job): the tarball's version, sha256 and size
 * come from HOMEFLEET_RELEASE_VERSION / _SHA256 / _SIZE, computed by `pack`.
 * The key-holding job then handles no file at all — nothing downloaded can
 * overwrite this script or the Node it runs on. A lying digest gets signed
 * but fails `verify`, which checks the real tarball before anything ships.
 */
function digestFromEnv() {
  const version = process.env.HOMEFLEET_RELEASE_VERSION ?? "";
  const sha256 = process.env.HOMEFLEET_RELEASE_SHA256 ?? "";
  const sizeText = process.env.HOMEFLEET_RELEASE_SIZE ?? "";
  if (!SEMVER.test(version)) {
    throw new Error(
      `HOMEFLEET_RELEASE_VERSION is not X.Y.Z: ${JSON.stringify(version)}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("HOMEFLEET_RELEASE_SHA256 is not 64 lower-case hex digits");
  }
  // On a tag run (GitHub sets GITHUB_REF), sign only the tag's own version:
  // a compromised pack can't get some other version signed by the approved run.
  const ref = process.env.GITHUB_REF ?? "";
  if (ref.startsWith("refs/tags/v") && ref !== `refs/tags/v${version}`) {
    throw new Error(
      `HOMEFLEET_RELEASE_VERSION ${version} is not the tag ${ref}`,
    );
  }
  const size = Number(sizeText);
  if (!/^[1-9]\d*$/.test(sizeText) || size > MAX_SIZE) {
    throw new Error(
      `HOMEFLEET_RELEASE_SIZE is not a size from 1 to ${MAX_SIZE}: ${JSON.stringify(sizeText)}`,
    );
  }
  return { version, sha256, size };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      "key-file": { type: "string" },
      digest: { type: "string" },
    },
    allowPositionals: true,
  });
  const digestDir = values.digest;
  if (
    digestDir !== undefined
      ? positionals.length !== 0
      : positionals.length !== 1
  ) {
    throw new Error(USAGE);
  }
  let version;
  let sha256;
  let size;
  let dir;
  if (digestDir !== undefined) {
    ({ version, sha256, size } = digestFromEnv());
    dir = digestDir;
  } else {
    const tarballPath = positionals[0];
    version = TARBALL.exec(path.basename(tarballPath))?.[1];
    if (version === undefined) {
      throw new Error(`${tarballPath} is not named homefleet-X.Y.Z.tgz`);
    }
    ({ sha256, size } = await hashFile(tarballPath));
    // ReleaseManifestSchema requires a positive size: never sign what the
    // verifier would reject.
    if (size === 0) {
      throw new Error(`${tarballPath} is empty`);
    }
    dir = path.dirname(tarballPath);
  }
  const file = `homefleet-${version}.tgz`;
  const keyFile = values["key-file"];
  const pem =
    keyFile !== undefined
      ? await readFile(keyFile, "utf8")
      : process.env.HOMEFLEET_RELEASE_KEY;
  if (pem === undefined || pem.trim() === "") {
    throw new Error(
      "no signing key: set HOMEFLEET_RELEASE_KEY or pass --key-file",
    );
  }
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("the release signing key must be an Ed25519 private key");
  }

  // Same fixed key order + trailing newline as serializeManifest().
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ version, file, sha256, size, hfpVersion: await hfpVersion() })}\n`,
    "utf8",
  );
  const signature = sign(null, manifestBytes, key).toString("base64");
  await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, `homefleet-${version}.manifest.json`);
  const signaturePath = path.join(dir, `homefleet-${version}.manifest.sig`);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(signaturePath, `${signature}\n`);
  process.stdout.write(`${manifestPath}\n${signaturePath}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `sign-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
