/**
 * Device identity (ADR-0004): an ECDSA P-256 keypair plus a self-signed
 * certificate, generated on first run and persisted under the data
 * directory. The device ID is the certificate's SHA-256 fingerprint.
 */
// @peculiar/x509 v2 uses tsyringe, which needs a reflect polyfill loaded
// before it. This import must precede the @peculiar/x509 import.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as x509 from "@peculiar/x509";
import { certFingerprint } from "./fingerprint.js";

// @peculiar/x509 needs a WebCrypto provider; Node >= 20 ships one globally.
x509.cryptoProvider.set(globalThis.crypto);

export interface Identity {
  /** SHA-256 fingerprint of the certificate (64 lowercase hex chars). */
  deviceId: string;
  /** Self-signed certificate, PEM-encoded. */
  certPem: string;
  /** Private key, PKCS#8 PEM-encoded. */
  keyPem: string;
}

const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";

const SIGNING_ALGORITHM = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
} as const;

/** Certificate validity: 2026-01-01 UTC plus 50 years. */
const NOT_BEFORE = new Date(Date.UTC(2026, 0, 1));
const NOT_AFTER = new Date(Date.UTC(2076, 0, 1));

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Random, positive certificate serial number as a hex string. */
function randomSerialNumber(): string {
  const bytes = randomBytes(16);
  // Clear the top bit so the DER INTEGER encoding stays positive.
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString("hex");
}

async function generateIdentity(dataDir: string): Promise<Identity> {
  const keys = await globalThis.crypto.subtle.generateKey(
    SIGNING_ALGORITHM,
    true,
    ["sign", "verify"],
  );
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerialNumber(),
    name: "CN=homefleet",
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([
        x509.ExtendedKeyUsage.serverAuth,
        x509.ExtendedKeyUsage.clientAuth,
      ]),
    ],
  });

  const pkcs8 = await globalThis.crypto.subtle.exportKey(
    "pkcs8",
    keys.privateKey,
  );
  const certPem = cert.toString("pem");
  const keyPem = x509.PemConverter.encode(pkcs8, "PRIVATE KEY");

  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, CERT_FILE), certPem, "utf8");
  await writeFile(path.join(dataDir, KEY_FILE), keyPem, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    deviceId: certFingerprint(cert.rawData),
    certPem,
    keyPem,
  };
}

async function loadIdentity(
  certPath: string,
  keyPath: string,
): Promise<Identity> {
  const certPem = await readFile(certPath, "utf8");
  const keyPem = await readFile(keyPath, "utf8");

  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(certPem);
  } catch (cause) {
    throw new Error(
      `Corrupt device identity: ${certPath} is not a valid PEM certificate. ` +
        "Refusing to regenerate — that would change this device's identity. " +
        "Restore the file from backup, or delete BOTH cert.pem and key.pem to " +
        "deliberately create a new identity (peers must then re-pair).",
      { cause },
    );
  }

  try {
    const pkcs8 = x509.PemConverter.decodeFirst(keyPem);
    await globalThis.crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      {
        name: SIGNING_ALGORITHM.name,
        namedCurve: SIGNING_ALGORITHM.namedCurve,
      },
      false,
      ["sign"],
    );
  } catch (cause) {
    throw new Error(
      `Corrupt device identity: ${keyPath} is not a valid PKCS#8 private key. ` +
        "Refusing to regenerate — that would change this device's identity. " +
        "Restore the file from backup, or delete BOTH cert.pem and key.pem to " +
        "deliberately create a new identity (peers must then re-pair).",
      { cause },
    );
  }

  return {
    deviceId: certFingerprint(cert.rawData),
    certPem,
    keyPem,
  };
}

/**
 * Loads the device identity from `dataDir`, generating it on first run.
 *
 * - Neither `cert.pem` nor `key.pem` exists: generates an ECDSA P-256
 *   keypair and a self-signed certificate, persists both, returns them.
 * - Both exist: loads them and recomputes the device ID from the cert.
 * - Exactly one exists, or either file is corrupt: throws. The identity is
 *   never silently regenerated — that would change the device's ID and
 *   orphan every existing pairing.
 */
export async function loadOrCreateIdentity(dataDir: string): Promise<Identity> {
  const certPath = path.join(dataDir, CERT_FILE);
  const keyPath = path.join(dataDir, KEY_FILE);
  const [certExists, keyExists] = await Promise.all([
    fileExists(certPath),
    fileExists(keyPath),
  ]);

  if (certExists && keyExists) {
    return loadIdentity(certPath, keyPath);
  }
  if (certExists !== keyExists) {
    const present = certExists ? certPath : keyPath;
    const missing = certExists ? keyPath : certPath;
    throw new Error(
      `Corrupt device identity: ${present} exists but ${missing} is missing. ` +
        "Refusing to regenerate — that would change this device's identity. " +
        "Restore the missing file from backup, or delete BOTH cert.pem and " +
        "key.pem to deliberately create a new identity (peers must then re-pair).",
    );
  }
  return generateIdentity(dataDir);
}
