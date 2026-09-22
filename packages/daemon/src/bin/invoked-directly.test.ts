/**
 * `npm i -g` installs each bin on Linux/macOS as a SYMLINK into the package's
 * `dist/bin`. Node resolves an ESM entry's `import.meta.url` to the real path
 * but leaves `process.argv[1]` as the path it was given (the link), so a plain
 * string compare silently skips `main()` and the bin exits 0 doing nothing.
 * These tests pin the realpath-based comparison that fixes that.
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isInvokedDirectly } from "./invoked-directly.js";

let dir: string;
let realFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hf-invoked-"));
  realFile = path.join(dir, "real.js");
  await writeFile(realFile, "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("same file → true", () => {
  expect(isInvokedDirectly(pathToFileURL(realFile).href, realFile)).toBe(true);
});

test("a different file → false (imported by a test, not run)", async () => {
  const other = path.join(dir, "other.js");
  await writeFile(other, "");
  expect(isInvokedDirectly(pathToFileURL(realFile).href, other)).toBe(false);
});

test("no argv[1] → false", () => {
  expect(isInvokedDirectly(pathToFileURL(realFile).href, undefined)).toBe(
    false,
  );
});

test("argv[1] that does not exist → false, never throws", () => {
  expect(
    isInvokedDirectly(
      pathToFileURL(realFile).href,
      path.join(dir, "missing.js"),
    ),
  ).toBe(false);
});

test("argv[1] is a symlink to the module → true (the npm -g layout)", async (ctx) => {
  const link = path.join(dir, "homefleet");
  try {
    await symlink(realFile, link, "file");
  } catch (error) {
    // Windows without Developer Mode can't create symlinks; the Linux CI
    // runner is where this case is actually exercised.
    if ((error as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
    throw error;
  }
  expect(link).not.toBe(realFile); // the naive compare would fail here
  expect(isInvokedDirectly(pathToFileURL(realFile).href, link)).toBe(true);
});
