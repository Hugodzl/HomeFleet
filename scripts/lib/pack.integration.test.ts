/**
 * Real-I/O tier: runs the actual daemon build and a real `npm pack` against
 * packages/daemon, then asserts exactly what the tarball ships.
 *
 * WHY a private `distDir`: `packRelease` builds with `tsup --out-dir`, whose
 * `clean: true` wipes the target directory first. Building into the real
 * `packages/daemon/dist/bin` here would race a second session sharing this
 * checkout, and `homefleet setup`'s Task Scheduler autostart runs
 * `dist/bin/homefleetd.js` directly — `pnpm test` must never touch it.
 */
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
let outDir: string;
let result: PackResult;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "hf-pack-int-"));
  outDir = path.join(workDir, "out");
  // A stale tarball from a previous version must not survive packing.
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "homefleet-0.0.1.tgz"), "stale");

  result = await packRelease({
    daemonDir,
    licensePath: path.join(repoRoot, "LICENSE"),
    outDir,
    distDir: path.join(workDir, "dist-bin"),
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

test("manifest deps have no @homefleet/* deps, and package.json ships", () => {
  expect(
    Object.keys(result.manifest.dependencies).filter((name) =>
      name.startsWith("@homefleet/"),
    ),
  ).toEqual([]);
  expect(result.files).toContain("package.json");
});

test("stale tarballs in outDir are cleared before packing", async () => {
  const entries = await readdir(outDir);
  expect(entries.filter((name) => name.endsWith(".tgz"))).toEqual([
    path.basename(result.tarballPath),
  ]);
});

test("the built homefleetd.js embeds the dashboard page (?raw plugin ran)", async () => {
  const bin = await readFile(
    path.join(workDir, "dist-bin", "homefleetd.js"),
    "utf8",
  );
  expect(bin).toContain("data-homefleet-dashboard");
});
