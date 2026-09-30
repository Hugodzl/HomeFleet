/**
 * pnpm sign:release <tarball> [--key-file <pem>]
 *
 * Writes homefleet-<v>.manifest.json + .manifest.sig next to the tarball.
 * The key comes from the HOMEFLEET_RELEASE_KEY env var (CI) or --key-file
 * (a local, hand-signed build — e.g. the rig's rollback test).
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { signRelease } from "./lib/sign-release.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { "key-file": { type: "string" } },
    allowPositionals: true,
  });
  const tarballPath = positionals[0];
  if (tarballPath === undefined || positionals.length !== 1) {
    throw new Error("usage: pnpm sign:release <tarball> [--key-file <pem>]");
  }
  const keyFile = values["key-file"];
  const privateKeyPem =
    keyFile !== undefined
      ? await readFile(keyFile, "utf8")
      : process.env.HOMEFLEET_RELEASE_KEY;
  if (privateKeyPem === undefined || privateKeyPem.trim() === "") {
    throw new Error(
      "no signing key: set HOMEFLEET_RELEASE_KEY or pass --key-file",
    );
  }
  const { manifestPath, signaturePath } = await signRelease({
    tarballPath,
    privateKeyPem,
  });
  process.stdout.write(`${manifestPath}\n${signaturePath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `sign-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
