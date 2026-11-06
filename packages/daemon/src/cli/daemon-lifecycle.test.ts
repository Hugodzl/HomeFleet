import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DAEMON_ERR_LOG_FILE,
  identifyProcess,
  isPackagedApp,
  isPidAlive,
  killPid,
  launchDetached,
  processCommandLine,
  realLifecycleDeps,
  tailFile,
} from "./daemon-lifecycle.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hf-lifecycle-"));
  dirs.push(dir);
  return dir;
}

test("isPackagedApp is true when the probe lands in a package's LocalCache", () => {
  const lad = tempDir();
  const pkgLocal = path.join(
    lad,
    "Packages",
    "Some_app",
    "LocalCache",
    "Local",
  );
  mkdirSync(pkgLocal, { recursive: true });
  mkdirSync(path.join(lad, "Packages", "Other_app"), { recursive: true });
  // Simulate MSIX: the write to %LOCALAPPDATA% is redirected into the package.
  const redirected = isPackagedApp(lad, (probe) =>
    writeFileSync(path.join(pkgLocal, path.basename(probe)), ""),
  );
  expect(redirected).toBe(true);
});

test("isPackagedApp is false when the probe stays where it was written, and removes it", () => {
  const lad = tempDir();
  mkdirSync(path.join(lad, "Packages", "Some_app", "LocalCache", "Local"), {
    recursive: true,
  });
  let written = "";
  expect(
    isPackagedApp(lad, (probe) => {
      written = probe;
      writeFileSync(probe, "");
    }),
  ).toBe(false);
  expect(written).not.toBe("");
  expect(tailFile(written, 1)).toEqual([]); // removed
});

test("isPackagedApp fails open: no Packages dir, no LOCALAPPDATA, a write error", () => {
  expect(isPackagedApp(tempDir())).toBe(false);
  expect(isPackagedApp(undefined)).toBe(false);
  expect(
    isPackagedApp(tempDir(), () => {
      throw new Error("EACCES");
    }),
  ).toBe(false);
});

test("tailFile returns the last lines, ignoring trailing blank lines and CRLF", () => {
  const file = path.join(tempDir(), "log.txt");
  writeFileSync(file, "a\r\nb\r\nc\r\n\r\n");
  expect(tailFile(file, 2)).toEqual(["b", "c"]);
  expect(tailFile(file, 10)).toEqual(["a", "b", "c"]);
  expect(tailFile(path.join(tempDir(), "missing.log"), 5)).toEqual([]);
});

test("realLifecycleDeps reads the data-dir override from the environment", () => {
  expect(realLifecycleDeps({}).defaultDataDir).toBe(true);
  expect(realLifecycleDeps({ HOMEFLEET_DATA_DIR: "" }).defaultDataDir).toBe(
    true,
  );
  expect(
    realLifecycleDeps({ HOMEFLEET_DATA_DIR: "/tmp/x" }).defaultDataDir,
  ).toBe(false);
});

test("launchDetached starts the entry, appends stderr to homefleetd.err.log, and reports the exit", async () => {
  const dataDir = tempDir();
  const entry = path.join(dataDir, "fake-daemon.mjs");
  writeFileSync(entry, 'process.stderr.write("boom\\n"); process.exit(7);\n');
  const launched = launchDetached({
    nodePath: process.execPath,
    entryPath: entry,
    dataDir,
  });
  expect(launched.pid).toBeGreaterThan(0);
  const deadline = Date.now() + 10_000;
  while (launched.exited() === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(launched.exited()).toBe(7);
  expect(isPidAlive(launched.pid)).toBe(false);
  expect(tailFile(path.join(dataDir, DAEMON_ERR_LOG_FILE), 1)).toEqual([
    "boom",
  ]);
});

test("identifyProcess: homefleetd for a live process whose command line names it, other for a different one, gone after exit", async () => {
  const dir = tempDir();
  const entry = path.join(dir, "fake-homefleetd.mjs");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const launched = launchDetached({
    nodePath: process.execPath,
    entryPath: entry,
    dataDir: dir,
  });
  try {
    expect(processCommandLine(launched.pid)).toContain("fake-homefleetd.mjs");
    expect(identifyProcess(launched.pid)).toBe("homefleetd");
    // This test runner is a node process, but not homefleetd.
    expect(identifyProcess(process.pid)).toBe("other");
  } finally {
    killPid(launched.pid);
  }
  const deadline = Date.now() + 10_000;
  while (isPidAlive(launched.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(identifyProcess(launched.pid)).toBe("gone");
  expect(processCommandLine(-1)).toBeUndefined();
});

test("identifyProcess: a live process whose command line can't be read is unknown, never other", () => {
  const unreadable = () => undefined;
  expect(identifyProcess(42, unreadable, () => true)).toBe("unknown");
  expect(identifyProcess(42, unreadable, () => false)).toBe("gone");
  expect(
    identifyProcess(
      42,
      () => "node homefleetd.js",
      () => true,
    ),
  ).toBe("homefleetd");
  expect(
    identifyProcess(
      42,
      () => "notepad.exe",
      () => true,
    ),
  ).toBe("other");
});
