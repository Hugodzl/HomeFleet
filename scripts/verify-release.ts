/**
 * pnpm verify:release <tarball>
 *
 * Verifies the manifest + signature next to <tarball> against the PINNED
 * public keys compiled into the daemon — the exact check an upgrading node
 * runs, plus a check that the signed HFP version is this source's. CI runs
 * it right after signing so a key mismatch fails the release
 * before anything is published.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  manifestFileName,
  signatureFileName,
  verifyRelease,
} from "../packages/daemon/src/upgrade/manifest.js";
import { HFP_PROTOCOL_VERSION } from "../packages/protocol/src/version.js";
import { checkSignedHfpVersion } from "./lib/hfp-version-check.js";
import { versionFromTarball } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const tarballPath = positionals[0];
  if (tarballPath === undefined || positionals.length !== 1) {
    throw new Error("usage: pnpm verify:release <tarball>");
  }
  const version = versionFromTarball(tarballPath);
  const dir = path.dirname(tarballPath);
  const result = await verifyRelease({
    manifestBytes: await readFile(path.join(dir, manifestFileName(version))),
    signature: await readFile(
      path.join(dir, signatureFileName(version)),
      "utf8",
    ),
    tarballPath,
    expectedVersion: version,
  });
  if (!result.ok) {
    throw new Error(`${result.reason}: ${result.detail}`);
  }
  checkSignedHfpVersion(result.manifest.hfpVersion, HFP_PROTOCOL_VERSION);
  process.stdout.write(`verified ${path.basename(tarballPath)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `verify-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
