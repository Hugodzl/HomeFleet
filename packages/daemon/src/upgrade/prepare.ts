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

/**
 * The cached copy of `version` under `<upgradesDir>/<version>/`, or undefined
 * unless all three files are present and fully verify (the tarball is
 * re-hashed every call). Phase 3's tarball route serves only what this returns.
 */
export async function readVerifiedCache(
  upgradesDir: string,
  version: string,
  publicKeys?: readonly string[],
): Promise<PreparedRelease | undefined> {
  const dir = path.join(upgradesDir, version);
  let manifestBytes: Buffer;
  let signature: string;
  try {
    manifestBytes = await readFile(path.join(dir, manifestFileName(version)));
    signature = await readFile(
      path.join(dir, signatureFileName(version)),
      "utf8",
    );
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
  return result.ok
    ? { version, tarballPath, manifest: result.manifest }
    : undefined;
}

/**
 * In-flight prepares keyed by target dir. Two overlapping first-time prepares
 * of one version would both wipe and fetch into the same dir, and the loser's
 * failure cleanup could delete the winner's verified cache.
 */
const inFlight = new Map<string, Promise<PreparedRelease>>();

/** Single-flight per target dir: concurrent callers share one prepare. */
export function prepareRelease(
  options: PrepareOptions,
): Promise<PreparedRelease> {
  const dir = path.resolve(options.upgradesDir, options.version);
  const existing = inFlight.get(dir);
  if (existing !== undefined) {
    return existing;
  }
  const run = prepareReleaseOnce(options).finally(() => {
    inFlight.delete(dir);
  });
  inFlight.set(dir, run);
  return run;
}

async function prepareReleaseOnce(
  options: PrepareOptions,
): Promise<PreparedRelease> {
  const { source, upgradesDir, version, publicKeys } = options;
  const dir = path.join(upgradesDir, version);
  const cached = await readVerifiedCache(upgradesDir, version, publicKeys);
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
  return {
    version,
    tarballPath: fetched.tarballPath,
    manifest: result.manifest,
  };
}
