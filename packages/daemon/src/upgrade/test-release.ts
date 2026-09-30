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
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
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
  const signature = sign(null, manifestBytes, keys.privateKey).toString(
    "base64",
  );
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

  async fetchRelease(
    version: string,
    destDir: string,
  ): Promise<FetchedRelease> {
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
      manifestBytes: await readFile(
        path.join(destDir, manifestFileName(version)),
      ),
      signature: await readFile(
        path.join(destDir, signatureFileName(version)),
        "utf8",
      ),
      tarballPath: path.join(destDir, releaseFileName(version)),
    };
  }
}
