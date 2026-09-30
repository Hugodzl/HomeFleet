/**
 * pnpm release:keygen <private-key-out.pem>
 *
 * One-time: generates the release signing key pair. Writes the PRIVATE key
 * (refusing to overwrite) and prints the public key to paste into
 * packages/daemon/src/upgrade/release-keys.ts. Mode 0o600 is owner-only on
 * POSIX; on Windows the file inherits its folder's ACL, so keep it in a
 * user-private folder (and keep an offline backup).
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { generateReleaseKeyPair } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const out = positionals[0];
  if (out === undefined || positionals.length !== 1) {
    throw new Error("usage: pnpm release:keygen <private-key-out.pem>");
  }
  const keys = generateReleaseKeyPair();
  await writeFile(out, keys.privateKeyPem, { flag: "wx", mode: 0o600 });
  process.stdout.write(
    `private key written to ${out}\n` +
      "(owner-only on POSIX; on Windows it inherits the folder's ACL, so keep it in a user-private folder and back it up offline)\n" +
      `public key (RELEASE_PUBLIC_KEYS entry):\n${keys.publicKeyBase64}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `release-keygen: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
