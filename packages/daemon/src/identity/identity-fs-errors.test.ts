/**
 * Failure-mode tests for identity loading that need fs faults injected:
 * a transient stat error (e.g. EPERM under antivirus) must abort loading,
 * never fall through to "file missing" and silently regenerate the
 * identity. Lives in its own file because the node:fs/promises mock applies
 * module-wide.
 */
// tsyringe (used by @peculiar/x509) needs the reflect polyfill loaded first.
import "reflect-metadata";
import { stat } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { makeTempDataDir, removeTempDataDir } from "../test-fixtures.js";
import { loadOrCreateIdentity } from "./identity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.mocked(stat).mockClear();
  await Promise.all(tempDirs.splice(0).map(removeTempDataDir));
});

function epermError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    "EPERM: operation not permitted, stat",
  );
  error.code = "EPERM";
  return error;
}

test("a transient stat failure aborts loading instead of regenerating", async () => {
  const dir = await makeTempDataDir("homefleet-identity-eperm-");
  tempDirs.push(dir);
  const created = await loadOrCreateIdentity(dir);

  // Next stat (cert.pem or key.pem — loadOrCreateIdentity stats both) fails
  // with EPERM. If this were treated as "missing", both files would look
  // absent and a NEW identity would be generated over the existing one.
  vi.mocked(stat).mockRejectedValueOnce(epermError());
  await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/EPERM/);

  // The stored identity survived untouched: a healthy reload matches.
  const reloaded = await loadOrCreateIdentity(dir);
  expect(reloaded.deviceId).toBe(created.deviceId);
  expect(reloaded.certPem).toBe(created.certPem);
  expect(reloaded.keyPem).toBe(created.keyPem);
});
