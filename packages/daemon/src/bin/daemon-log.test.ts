import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAEMON_LOG_FILE,
  type DaemonLog,
  installExitLogging,
  openDaemonLog,
} from "./daemon-log.js";

describe("daemon log file", () => {
  let dir: string;
  let file: string;
  let log: DaemonLog | undefined;
  const fixed = () => new Date("2026-11-03T12:34:56.789Z");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-daemon-log-"));
    file = path.join(dir, DAEMON_LOG_FILE);
  });
  afterEach(async () => {
    log?.close();
    log = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("is named homefleetd.log", () => {
    expect(DAEMON_LOG_FILE).toBe("homefleetd.log");
  });

  it("appends each line prefixed with an ISO timestamp", async () => {
    log = openDaemonLog({ path: file, now: fixed });
    log.line("homefleetd: hello");
    log.line("second");
    expect(await readFile(file, "utf8")).toBe(
      "2026-11-03T12:34:56.789Z homefleetd: hello\n" +
        "2026-11-03T12:34:56.789Z second\n",
    );
  });

  it("appends to an existing file rather than truncating it", async () => {
    await writeFile(file, "old line\n");
    log = openDaemonLog({ path: file, now: fixed });
    log.line("new");
    expect(await readFile(file, "utf8")).toBe(
      "old line\n2026-11-03T12:34:56.789Z new\n",
    );
  });

  it("creates a missing data dir", async () => {
    const nested = path.join(dir, "a", "b", DAEMON_LOG_FILE);
    log = openDaemonLog({ path: nested, now: fixed });
    log.line("x");
    expect(await readFile(nested, "utf8")).toContain(" x\n");
  });

  it("rotates once to .1 at open when the file is already past the limit", async () => {
    await writeFile(file, "x".repeat(200));
    log = openDaemonLog({ path: file, maxBytes: 100, now: fixed });
    log.line("fresh");
    expect(await readFile(`${file}.1`, "utf8")).toBe("x".repeat(200));
    expect(await readFile(file, "utf8")).toBe(
      "2026-11-03T12:34:56.789Z fresh\n",
    );
  });

  it("rotates when a write would cross the limit, replacing an older .1", async () => {
    await writeFile(`${file}.1`, "ancient");
    log = openDaemonLog({ path: file, maxBytes: 100, now: fixed });
    const line = "y".repeat(40); // 65 bytes with timestamp + newline
    log.line(line);
    log.line(line);
    const rotated = await readFile(`${file}.1`, "utf8");
    expect(rotated).toBe(`2026-11-03T12:34:56.789Z ${line}\n`);
    expect(await readFile(file, "utf8")).toBe(
      `2026-11-03T12:34:56.789Z ${line}\n`,
    );
    expect((await stat(file)).size).toBeLessThanOrEqual(100);
  });

  it("never throws, even once the file can't be written", () => {
    log = openDaemonLog({ path: file, now: fixed });
    log.close();
    expect(() => log?.line("after close")).not.toThrow();
  });

  it("returns a no-op log when the file can't be opened", () => {
    // A directory where the file should be: openSync fails with EISDIR.
    const bad = openDaemonLog({ path: dir, now: fixed });
    expect(() => bad.line("x")).not.toThrow();
    bad.close();
  });
});

describe("exit logging", () => {
  function fakeProcess(): EventEmitter & { exitCode?: number } {
    return new EventEmitter();
  }

  it("logs the exit code on exit", () => {
    const lines: string[] = [];
    const proc = fakeProcess();
    installExitLogging(proc, { line: (t) => lines.push(t) });
    proc.emit("exit", 3);
    expect(lines).toEqual(["homefleetd: exiting with code 3"]);
  });

  it("logs uncaught exceptions and unhandled rejections with their stack", () => {
    const lines: string[] = [];
    const proc = fakeProcess();
    installExitLogging(proc, { line: (t) => lines.push(t) });
    const error = new Error("boom");
    proc.emit("uncaughtExceptionMonitor", error, "uncaughtException");
    proc.emit(
      "uncaughtExceptionMonitor",
      "just a string",
      "unhandledRejection",
    );
    expect(lines[0]).toMatch(/^homefleetd: uncaughtException: Error: boom\n/);
    expect(lines[1]).toBe("homefleetd: unhandledRejection: just a string");
  });

  it("only observes: it never registers uncaughtException/unhandledRejection handlers", () => {
    // Registering either would swallow the crash Node would otherwise do.
    const proc = fakeProcess();
    installExitLogging(proc, { line: () => {} });
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});
