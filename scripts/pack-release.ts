/**
 * pnpm pack:release [--tag vX.Y.Z] [--out <dir>]
 *
 * Builds the daemon and packs the release tarball into <out> (default
 * `release/`), printing its path as the last stdout line. With --tag, refuses
 * before building when the tag does not name the daemon's version.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packRelease } from "./lib/pack.js";
import { checkTagVersion } from "./lib/tag-version.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const daemonDir = path.join(repoRoot, "packages", "daemon");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      out: { type: "string", default: "release" },
    },
  });
  if (values.tag !== undefined) {
    const { version } = JSON.parse(
      await readFile(path.join(daemonDir, "package.json"), "utf8"),
    ) as { version: string };
    checkTagVersion(values.tag, version);
  }
  const outDir = path.resolve(repoRoot, values.out);
  const result = await packRelease({
    daemonDir,
    licensePath: path.join(repoRoot, "LICENSE"),
    stagingDir: path.join(outDir, "staging"),
    outDir,
    build: true,
  });
  process.stdout.write(`${result.tarballPath}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pack-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
