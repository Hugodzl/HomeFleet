/**
 * Real-I/O tier: runs the actual daemon build and a real `npm pack` against
 * packages/daemon, then asserts exactly what the tarball ships.
 */
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type PackResult, packRelease } from "./pack.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const daemonDir = path.join(repoRoot, "packages", "daemon");

let workDir: string;
let result: PackResult;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "hf-pack-int-"));
  result = await packRelease({
    daemonDir,
    licensePath: path.join(repoRoot, "LICENSE"),
    stagingDir: path.join(workDir, "staging"),
    outDir: path.join(workDir, "out"),
    build: true,
  });
}, 180_000); // a tsup build + npm pack; slow on Windows runners

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("tarball is homefleet-<daemon version>.tgz and exists", async () => {
  const daemonPkg = JSON.parse(
    await readFile(path.join(daemonDir, "package.json"), "utf8"),
  ) as { version: string };
  expect(path.basename(result.tarballPath)).toBe(
    `homefleet-${daemonPkg.version}.tgz`,
  );
  await access(result.tarballPath);
});

test("ships exactly LICENSE, package.json and dist/bin — nothing else", () => {
  expect(result.files).toEqual(
    [
      "LICENSE",
      "dist/bin/homefleet-mcp-stdio.js",
      "dist/bin/homefleet-mcp-stdio.js.map",
      "dist/bin/homefleet.js",
      "dist/bin/homefleet.js.map",
      "dist/bin/homefleetd.js",
      "dist/bin/homefleetd.js.map",
      "package.json",
    ].sort(),
  );
});

test("staged manifest has zero @homefleet/* deps", async () => {
  const staged = JSON.parse(
    await readFile(path.join(workDir, "staging", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(
    Object.keys(staged.dependencies).filter((name) =>
      name.startsWith("@homefleet/"),
    ),
  ).toEqual([]);
});
