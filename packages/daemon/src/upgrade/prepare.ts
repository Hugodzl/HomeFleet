/**
 * Gets a VERIFIED copy of a release into the cache, keyed by tarball hash:
 *
 *   <upgradesDir>/releases/<sha256>/homefleet-X.Y.Z.tgz (+ manifest, .sig)
 *   <upgradesDir>/releases/<sha256>/tags.json   GitHub tags it came from
 *
 * Two builds of one version (a release candidate and its successor) never
 * share an entry. A lookup by version alone only reuses an entry fetched
 * under the final tag `v<version>`, so a node holding a candidate or a
 * pushed copy never mistakes it for the final release. Downloads land in a
 * `staging-*` dir and are renamed into place only once they verify, so the
 * cache only ever holds files that passed `verifyRelease` (the tarball route
 * serves from it). Legacy `upgrades/<version>/` dirs are ignored.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

export const RELEASES_DIRNAME = "releases";
export const TAGS_FILE = "tags.json";
const STAGING_PREFIX = "staging-";
const STALE_STAGING_MS = 60 * 60_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PreparedRelease {
  version: string;
  /** The tarball's sha256, which is also the entry's directory name. */
  sha256: string;
  tarballPath: string;
  manifest: ReleaseManifest;
  /** The exact signed manifest bytes. */
  manifestBytes: Buffer;
  /** The base64 detached signature, trimmed. */
  signature: string;
  /** The cache entry: `<upgradesDir>/releases/<sha256>/`. */
  dir: string;
}

export interface PrepareOptions {
  source: ReleaseSource;
  upgradesDir: string;
  version: string;
  /** Only these bytes are acceptable. */
  sha256?: string;
  /**
   * The GitHub tag to fetch, recorded in `tags.json`. Defaults to
   * `v<version>` when `sha256` is absent; with `sha256` and no tag, a fetch
   * records no tag (a pushed or hash-addressed copy).
   */
  tag?: string;
  /** Never fetch; a miss is `fetch-failed`. */
  cacheOnly?: boolean;
  publicKeys?: readonly string[];
}

export interface CacheQuery {
  version: string;
  sha256?: string;
  tag?: string;
}

function releasesDir(upgradesDir: string): string {
  return path.join(upgradesDir, RELEASES_DIRNAME);
}

async function readTags(dir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(dir, TAGS_FILE), "utf8"),
    );
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Records `tag` on an entry, best effort: a missing tag only means a later
 * by-tag lookup fetches again, never that a verified release fails.
 */
async function tryAddTag(dir: string, tag: string): Promise<void> {
  await addTag(dir, tag).catch(() => undefined);
}

/** Per-entry queue so two concurrent tag merges never lose one. */
const tagWrites = new Map<string, Promise<void>>();

function addTag(dir: string, tag: string): Promise<void> {
  const key = path.resolve(dir);
  const run = (tagWrites.get(key) ?? Promise.resolve()).then(async () => {
    const tags = await readTags(dir);
    if (tags.includes(tag)) {
      return;
    }
    await writeTags(dir, [...tags, tag]);
  });
  const settled = run.catch(() => undefined);
  tagWrites.set(key, settled);
  void settled.then(() => {
    if (tagWrites.get(key) === settled) {
      tagWrites.delete(key);
    }
  });
  return run;
}

async function writeTags(dir: string, tags: readonly string[]): Promise<void> {
  const temp = path.join(dir, `${TAGS_FILE}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(tags)}\n`);
  await withRetry(() => rename(temp, path.join(dir, TAGS_FILE)));
}

/** Re-verifies one entry; undefined unless all files are present and verify. */
async function verifyEntry(
  dir: string,
  version: string,
  publicKeys?: readonly string[],
): Promise<PreparedRelease | undefined> {
  const sha256 = path.basename(dir);
  if (!SHA256_HEX.test(sha256)) {
    return undefined;
  }
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
  if (!result.ok || result.manifest.sha256 !== sha256) {
    return undefined;
  }
  return {
    version,
    sha256,
    tarballPath,
    manifest: result.manifest,
    manifestBytes,
    signature: signature.trim(),
    dir,
  };
}

/**
 * The cached, re-verified copy matching `query`, or undefined:
 * - with `sha256`: that entry;
 * - with `tag`: an entry whose `tags.json` includes it;
 * - otherwise: an entry tagged `v<version>` (the final release).
 * The tarball is re-hashed every call; the tarball route serves only this.
 */
export async function readVerifiedCache(
  upgradesDir: string,
  query: CacheQuery,
  publicKeys?: readonly string[],
): Promise<PreparedRelease | undefined> {
  const root = releasesDir(upgradesDir);
  if (query.sha256 !== undefined) {
    if (!SHA256_HEX.test(query.sha256)) {
      return undefined;
    }
    return verifyEntry(
      path.join(root, query.sha256),
      query.version,
      publicKeys,
    );
  }
  const tag = query.tag ?? `v${query.version}`;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    if (!(await readTags(dir)).includes(tag)) {
      continue;
    }
    const entry = await verifyEntry(dir, query.version, publicKeys);
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
}

/**
 * In-flight prepares keyed by what they ask for. Two overlapping prepares of
 * one key share a fetch; different keys that resolve to the same bytes each
 * fetch into their own staging dir and the second one to finish keeps the
 * first one's entry.
 */
const inFlight = new Map<string, Promise<PreparedRelease>>();

/** Single-flight per (cache, version, sha256 ?? tag ?? v<version>). */
export function prepareRelease(
  options: PrepareOptions,
): Promise<PreparedRelease> {
  if (options.sha256 !== undefined && options.tag !== undefined) {
    // A hash hit would gain a tag it was never fetched under: tagging a
    // candidate's bytes "v<version>" would make them the final.
    return Promise.reject(
      new Error(
        "prepareRelease takes a tag or a sha256, not both: tag and sha256 together could tag a candidate as the final",
      ),
    );
  }
  const key = [
    path.resolve(options.upgradesDir),
    options.version,
    options.sha256 ?? options.tag ?? `v${options.version}`,
    options.cacheOnly === true ? "cache-only" : "",
  ].join("|");
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const run = prepareReleaseOnce(options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Windows (antivirus, indexer) briefly locks new files: retry EBUSY/EPERM. */
async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EBUSY" && code !== "EPERM")) {
        throw error;
      }
      await sleep(100);
    }
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function removeStaleStaging(upgradesDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(upgradesDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) {
      continue;
    }
    const dir = path.join(upgradesDir, name);
    const info = await stat(dir).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > STALE_STAGING_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function prepareReleaseOnce(
  options: PrepareOptions,
): Promise<PreparedRelease> {
  const { source, upgradesDir, version, sha256, publicKeys } = options;
  const keys = publicKeys !== undefined ? { publicKeys } : {};
  const tag = options.tag ?? (sha256 === undefined ? `v${version}` : undefined);
  await removeStaleStaging(upgradesDir);

  const cached = await readVerifiedCache(
    upgradesDir,
    {
      version,
      ...(sha256 !== undefined ? { sha256 } : {}),
      ...(tag !== undefined ? { tag } : {}),
    },
    publicKeys,
  );
  if (cached !== undefined) {
    if (tag !== undefined) {
      await tryAddTag(cached.dir, tag);
    }
    return cached;
  }
  if (options.cacheOnly === true) {
    throw new UpgradeError(
      "fetch-failed",
      `release ${version}${sha256 !== undefined ? ` (sha256 ${sha256.slice(0, 12)})` : ""} is not cached`,
    );
  }

  const staging = path.join(upgradesDir, `${STAGING_PREFIX}${randomUUID()}`);
  const cleanup = () =>
    rm(staging, { recursive: true, force: true }).catch(() => undefined);
  let fetched: Awaited<ReturnType<ReleaseSource["fetchRelease"]>>;
  try {
    await mkdir(upgradesDir, { recursive: true });
    fetched = await source.fetchRelease(
      version,
      staging,
      tag !== undefined ? { tag } : {},
    );
  } catch (error) {
    await cleanup();
    throw new UpgradeError(
      "fetch-failed",
      `could not download ${version}: ${messageOf(error)}`,
    );
  }
  const result = await verifyRelease({
    ...fetched,
    expectedVersion: version,
    ...keys,
  });
  if (!result.ok) {
    await cleanup();
    throw new UpgradeError(
      "verify-failed",
      `release ${version} failed verification (${result.reason}): ${result.detail}`,
    );
  }
  if (sha256 !== undefined && result.manifest.sha256 !== sha256) {
    await cleanup();
    throw new UpgradeError(
      "verify-failed",
      `release ${version} is sha256 ${result.manifest.sha256.slice(0, 12)}, not the requested ${sha256.slice(0, 12)}`,
    );
  }
  try {
    await writeTags(staging, tag !== undefined ? [tag] : []);
    const entry = await moveIntoPlace(
      staging,
      path.join(releasesDir(upgradesDir), result.manifest.sha256),
      version,
      publicKeys,
    );
    if (tag !== undefined) {
      await tryAddTag(entry.dir, tag);
    }
    return entry;
  } catch (error) {
    await cleanup();
    if (error instanceof UpgradeError) {
      throw error;
    }
    throw new UpgradeError(
      "fetch-failed",
      `could not cache ${version}: ${messageOf(error)}`,
    );
  }
}

/**
 * Renames the verified staging dir to its entry. If the entry already exists
 * (another prepare of the same bytes won), keep it when it verifies and drop
 * the staging copy; replace it once when it does not.
 */
async function moveIntoPlace(
  staging: string,
  target: string,
  version: string,
  publicKeys?: readonly string[],
): Promise<PreparedRelease> {
  await mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await exists(target)) {
      const existing = await verifyEntry(target, version, publicKeys);
      if (existing !== undefined) {
        await rm(staging, { recursive: true, force: true }).catch(
          () => undefined,
        );
        return existing;
      }
      await withRetry(() => rm(target, { recursive: true, force: true }));
    }
    try {
      await withRetry(() => rename(staging, target));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") &&
        attempt === 0
      ) {
        continue; // lost a race with another prepare: re-check the entry
      }
      throw error;
    }
    const entry = await verifyEntry(target, version, publicKeys);
    if (entry === undefined) {
      throw new UpgradeError(
        "verify-failed",
        `release ${version} no longer verifies after caching`,
      );
    }
    return entry;
  }
  throw new UpgradeError(
    "fetch-failed",
    `could not cache ${version}: ${target} kept changing`,
  );
}
