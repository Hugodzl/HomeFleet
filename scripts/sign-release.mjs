#!/usr/bin/env node
/**
 * node scripts/sign-release.mjs <tarball> [--key-file <pem>]
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
import { readFile, writeFile } from "node:fs/promises";
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

async function main() {
  const { values, positionals } = parseArgs({
    options: { "key-file": { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    throw new Error(
      "usage: node scripts/sign-release.mjs <tarball> [--key-file <pem>]",
    );
  }
  const tarballPath = positionals[0];
  const file = path.basename(tarballPath);
  const version = TARBALL.exec(file)?.[1];
  if (version === undefined) {
    throw new Error(`${tarballPath} is not named homefleet-X.Y.Z.tgz`);
  }
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

  const { sha256, size } = await hashFile(tarballPath);
  // ReleaseManifestSchema requires a positive size: never sign what the
  // verifier would reject.
  if (size === 0) {
    throw new Error(`${tarballPath} is empty`);
  }
  // Same fixed key order + trailing newline as serializeManifest().
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ version, file, sha256, size, hfpVersion: await hfpVersion() })}\n`,
    "utf8",
  );
  const signature = sign(null, manifestBytes, key).toString("base64");
  const dir = path.dirname(tarballPath);
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
