/**
 * homefleetd's own log file: every operator-facing line the daemon writes to
 * stderr is also appended to `<dataDir>/homefleetd.log`, prefixed with an ISO
 * timestamp — however the daemon was started. A daemon launched by the
 * Task Scheduler (no redirect) otherwise leaves no trace at all, and the
 * updater's raw stderr redirect (`homefleetd.err.log`) has no timestamps, so
 * an unexplained stop couldn't even be dated.
 *
 * Every write is synchronous (`writeSync` on an append fd) so the last lines
 * before a crash or `process.exit` reach the disk. A forced kill
 * (TerminateProcess / SIGKILL) still can't be logged; the last timestamped
 * line is what dates it.
 *
 * Logging must never take the daemon down: every filesystem error here is
 * swallowed.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const DAEMON_LOG_FILE = "homefleetd.log";

/** Past this size the file is rotated once to `<file>.1` (replacing it). */
export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface DaemonLog {
  /** Appends `<ISO timestamp> <text>\n`. Never throws. */
  line(text: string): void;
  close(): void;
}

export function openDaemonLog(options: {
  path: string;
  maxBytes?: number;
  now?: () => Date;
}): DaemonLog {
  const file = options.path;
  const maxBytes = options.maxBytes ?? DAEMON_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  let fd: number | undefined;
  let size = 0;

  const open = (): void => {
    fd = openSync(file, "a");
    size = statSync(file).size;
  };
  const rotate = (): void => {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
    renameSync(file, `${file}.1`);
    open();
  };

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    open();
    if (size >= maxBytes) rotate();
  } catch {
    if (fd !== undefined) closeSync(fd);
    fd = undefined;
  }

  return {
    line(text) {
      if (fd === undefined) return;
      try {
        const bytes = Buffer.from(`${now().toISOString()} ${text}\n`, "utf8");
        if (size > 0 && size + bytes.length > maxBytes) rotate();
        if (fd === undefined) return;
        writeSync(fd, bytes);
        size += bytes.length;
      } catch {
        // Never let logging crash the daemon.
      }
    },
    close() {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = undefined;
    },
  };
}

/**
 * Logs the exit paths nothing else records: the exit code, and uncaught
 * exceptions / unhandled rejections (with their stack). It listens to
 * `uncaughtExceptionMonitor` — which Node also emits for an unhandled
 * rejection under the default `--unhandled-rejections=throw` — rather than
 * `uncaughtException`/`unhandledRejection`, because registering either of
 * those would swallow the crash instead of just observing it.
 */
export function installExitLogging(
  proc: Pick<NodeJS.EventEmitter, "on">,
  log: Pick<DaemonLog, "line">,
): void {
  proc.on("exit", (code: number) => {
    log.line(`homefleetd: exiting with code ${code}`);
  });
  proc.on("uncaughtExceptionMonitor", (error: unknown, origin: string) => {
    const detail =
      error instanceof Error ? (error.stack ?? String(error)) : String(error);
    log.line(`homefleetd: ${origin}: ${detail}`);
  });
}
