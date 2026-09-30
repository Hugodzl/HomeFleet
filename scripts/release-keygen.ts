/**
 * pnpm release:keygen <private-key-out.pem>
 *
 * One-time: generates the release signing key pair. Writes the PRIVATE key
 * (refusing to overwrite) with owner-only permissions and prints the public
 * key to paste into packages/daemon/src/upgrade/release-keys.ts.
 */
import { writeFile } from "node:fs/promises";
import { generateReleaseKeyPair } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const out = process.argv[2];
  if (out === undefined) {
    throw new Error("usage: pnpm release:keygen <private-key-out.pem>");
  }
  const keys = generateReleaseKeyPair();
  await writeFile(out, keys.privateKeyPem, { flag: "wx", mode: 0o600 });
  process.stdout.write(
    `private key written to ${out}\npublic key (RELEASE_PUBLIC_KEYS entry):\n${keys.publicKeyBase64}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `release-keygen: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
