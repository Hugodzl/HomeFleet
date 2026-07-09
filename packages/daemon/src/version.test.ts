/**
 * Drift guard: `DAEMON_VERSION` and this package's `package.json` version
 * must always agree. Without this test, bumping one and forgetting the other
 * (as happened before v0.1.0 — see devlog 009) would go unnoticed until
 * someone compared them by hand.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DAEMON_VERSION } from "./version.js";

test("package.json version matches DAEMON_VERSION", async () => {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const packageJson: unknown = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  );
  expect(packageJson).toMatchObject({ version: DAEMON_VERSION });
});
