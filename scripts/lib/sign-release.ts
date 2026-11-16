/**
 * Release-key helpers shared by release-keygen and verify-release. Signing
 * itself lives in scripts/sign-release.mjs, which is dependency-free so the
 * release workflow's key-holding job installs nothing.
 */
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";

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
