/**
 * Release signing (fleet-upgrade spec, Phase 1). Uses the daemon's own
 * manifest serializer so CI and the verifier can never disagree on the
 * signed bytes.
 */
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
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
  const match = /^homefleet-(\d+\.\d+\.\d+)\.tgz$/.exec(
    path.basename(tarballPath),
  );
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
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKeyBase64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
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
