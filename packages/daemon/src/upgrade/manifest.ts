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
      // Pinned keys must be Ed25519: other key types verify with a null
      // algorithm too (e.g. RSA-512 gives a 64-byte signature).
      if (publicKey.asymmetricKeyType !== "ed25519") {
        return false;
      }
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
    return fail(
      "hash-mismatch",
      "the tarball's sha256 does not match the manifest",
    );
  }
  return { ok: true, manifest };
}
