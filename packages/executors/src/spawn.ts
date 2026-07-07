/**
 * Safe process-execution core: the ONE spawn path shared by the command
 * executor and the agent executor's run_command tool (ADR-0003).
 *
 * Security model: the allowlist is the boundary. Job-controlled input picks
 * a LOGICAL command name; only an exact-match allowlist hit resolves to an
 * executable, and nothing job-controlled is ever interpreted by a shell
 * (`shell: false` always). One Windows exception to "no shell": Node
 * refuses to spawn `.cmd`/`.bat` files without one (EINVAL since
 * CVE-2024-27980), so a batch target is wrapped as
 * `cmd.exe /d /s /c <target> <args...>`.
 *
 * That wrap re-introduces a shell for the arguments: with `shell: false`
 * Node quotes each arg per CommandLineToArgvW rules, but cmd.exe runs its
 * OWN metacharacter pass first, and a bare (space-free) arg like `&whoami`
 * is not quoted by Node and reaches cmd.exe unquoted (a reviewer
 * empirically confirmed `cmd.exe /d /s /c greet.cmd &whoami` executed
 * whoami). Args are untrusted (the model's run_command, or a delegating
 * peer's command job) and the wrap path is the DEFAULT path (M8 runs pnpm =
 * pnpm.cmd), so `resolveSpawnInvocation` neutralizes the args by DOUBLE-
 * QUOTING each one (cmd treats a metacharacter inside quotes as literal) and
 * fail-closes (never spawns) on the characters quotes cannot contain: %, CR,
 * LF, ! (the Rust-std / "BatBadBut" CVE-2024-24576 approach). The whole
 * `<target> <args...>` string is passed as one `/c` token with
 * `windowsVerbatimArguments` so cmd.exe — not Node's argv quoter — is the
 * only thing that parses it; `/s` then strips the outer quotes and takes the
 * rest literally. Caret-escaping was tried and empirically REJECTED: a
 * caret-escaped `&whoami` still ran whoami once the batch re-expanded it, so
 * caret is a best-effort escaper of exactly the kind the advisory warns
 * against. The allowlist still gates the command NAME; the quoting gates the
 * ARGUMENTS the allowlisted target receives.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { CommandOutput, HfpError } from "@homefleet/protocol";
import { decodeUtf8Capped } from "./truncation.js";

/**
 * Per-stream capture cap. Results travel inside HTTP bodies capped at 1 MiB
 * by the transport (`MAX_BODY_BYTES`); with stdout and stderr each held to
 * 256 KiB the executor can never produce a result that cannot ship. On
 * overflow the FIRST cap-worth of bytes is kept and a marker is appended.
 */
export const MAX_CAPTURED_STREAM_BYTES = 262_144;

/** Appended to a captured stream that overflowed the cap. */
export const STREAM_TRUNCATION_MARKER = `\n[output truncated: stream exceeded ${MAX_CAPTURED_STREAM_BYTES} bytes]`;

export interface CommandAllowlistEntry {
  /**
   * Executable path or name to spawn for this logical command; defaults to
   * the logical name itself. On win32 a bare name is resolved by
   * CreateProcess, which appends `.exe` but never `.cmd` — a batch target
   * like pnpm must be declared explicitly (`pnpm.cmd` or a full path) to
   * get the cmd.exe wrapping.
   */
  executable?: string;
}

/**
 * Maps allowed logical command names to how they run. Enforcement is an
 * exact string match on the logical name, checked before any spawn.
 */
export type CommandAllowlist = Record<string, CommandAllowlistEntry>;

/**
 * How long safeSpawn waits for `close` after issuing the kill before it
 * force-settles anyway. taskkill can exit nonzero against a protected child
 * that never closes; without this watchdog safeSpawn would hang forever on
 * that child's pipes and wedge the job slot. 2s is generous for a normal
 * child to flush and close after SIGKILL/taskkill.
 */
export const KILL_GRACE_MS = 2000;

export interface SafeSpawnRequest {
  /** Logical command name; must exactly match an allowlist key. */
  command: string;
  args: string[];
  /** Working directory — the job's materialized workspace; must exist. */
  cwd: string;
  /** Kill the process (tree) when exceeded. */
  timeoutMs: number;
  /** Cancellation; aborting takes the same kill path as the timeout. */
  signal: AbortSignal;
  allowlist: CommandAllowlist;
  /**
   * Test seam: how the process (tree) is killed. Defaults to the real
   * {@link killTree}. A test substitutes a no-op to model a kill that never
   * reaps the child, proving the watchdog still settles the job.
   */
  killer?: (child: ChildProcess) => void;
  /**
   * Test seam: override for {@link KILL_GRACE_MS}, so a test need not wait
   * the full production grace. Defaults to {@link KILL_GRACE_MS}.
   */
  killGraceMs?: number;
}

/**
 * Every way a spawn can end. `refused` means the process never ran (not
 * allowlisted, workspace missing, or the spawn itself failed); the other
 * kinds carry captured output, with `exitCode: null` whenever our kill path
 * (timeout or cancellation) terminated the process.
 */
export type SafeSpawnOutcome =
  | { kind: "completed"; output: CommandOutput }
  | { kind: "timeout"; output: CommandOutput }
  | { kind: "canceled"; output: CommandOutput }
  | { kind: "refused"; error: HfpError };

/**
 * Result of deciding a spawn target. Discriminated so the .cmd/.bat wrap
 * path can fail closed: an argument that cannot be safely neutralized for
 * cmd.exe yields `{ ok: false }` and the caller must NOT spawn.
 *
 * `windowsVerbatimArguments` is set on the cmd.exe wrap path: `args` is then
 * already the exact command line cmd.exe should see (a single pre-quoted
 * `/c` token), so Node must pass it through WITHOUT its own argv quoting —
 * otherwise Node re-escapes the quotes and cmd re-splits on the metachar.
 */
export type SpawnInvocation =
  | {
      ok: true;
      executable: string;
      args: string[];
      windowsVerbatimArguments?: boolean;
    }
  | { ok: false; error: HfpError };

/**
 * Characters cmd.exe interprets in ways that surviving inside double quotes
 * cannot suppress, so an argument containing any of them is rejected rather
 * than shipped:
 *   - `%` triggers environment-variable expansion (`%PATH%`) even in quotes,
 *   - `!` triggers delayed expansion when it is enabled, even in quotes,
 *   - CR / LF terminate the command line, so anything after is a new command.
 * This is the fail-closed half of the BatBadBut approach (see file doc).
 */
const CMD_UNESCAPABLE = /[%\r\n!]/;

/**
 * Characters that force an argument to be quoted for cmd.exe: the shell
 * metacharacters that could start a sibling command, plus whitespace (which
 * cmd would otherwise treat as an argument separator — this path passes the
 * command line verbatim, so Node does no quoting of its own).
 */
const CMD_NEEDS_QUOTING = /[\s&|<>()^"]/;

/**
 * Wraps a token for cmd.exe only when it needs it: a token with no
 * metacharacter and no whitespace is safe bare (and is left bare so a batch
 * `%1` sees the intended literal, not an added `"`). When quoting is needed,
 * any embedded `"` is doubled (`""` is cmd's literal-quote escape) and the
 * token is surrounded by quotes; inside quotes cmd treats `& | < > ( ) ^` as
 * literal, so a quoted argument cannot break out. Callers must have already
 * rejected {@link CMD_UNESCAPABLE} characters.
 */
function quoteCmdToken(token: string): string {
  if (token !== "" && !CMD_NEEDS_QUOTING.test(token)) {
    return token;
  }
  return `"${token.replaceAll('"', '""')}"`;
}

/**
 * Decides the actual spawn target. Exported for cross-platform unit tests;
 * `safeSpawn` calls it with the live `process.platform`. On the win32
 * .cmd/.bat wrap path it neutralizes cmd.exe metacharacters by quoting (or
 * fails closed); every other path passes args through verbatim (they are
 * never handed to a shell, so metachars are literal there).
 */
export function resolveSpawnInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
): SpawnInvocation {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    for (const arg of args) {
      if (CMD_UNESCAPABLE.test(arg)) {
        // The command NAME was allowlisted; this ARGUMENT is the problem.
        // Fail closed: quotes cannot contain %/CR/LF/!, so shipping one
        // would reopen the injection hole (see the file-level doc).
        return {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message:
              "argument contains a character that cannot be safely passed " +
              "to a batch (.cmd/.bat) command on Windows (one of %, CR, LF, !)",
            details: { arg },
          },
        };
      }
    }
    // The whole post-/c command is ONE token: the quoted batch path followed
    // by the quoted args. /d skips AutoRun, /s makes cmd strip just the outer
    // quotes and take the remainder literally, /c runs and exits. The batch
    // path is always quoted so a space in it (e.g. C:\Program Files\...) is
    // handled the same way.
    const command = [
      quoteCmdToken(executable),
      ...args.map(quoteCmdToken),
    ].join(" ");
    return {
      ok: true,
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { ok: true, executable, args };
}

/** Collects a stream up to the byte cap; overflow is drained and dropped. */
class CappedStreamCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    // Keep a few bytes past the cap so decodeUtf8Capped can see whether the
    // byte after the cut is a continuation byte; drop the rest but keep
    // consuming so the child never blocks on a full pipe.
    const budget = MAX_CAPTURED_STREAM_BYTES + 4 - this.bytes;
    if (budget <= 0) {
      return;
    }
    const kept = chunk.length <= budget ? chunk : chunk.subarray(0, budget);
    this.chunks.push(kept);
    this.bytes += kept.length;
  }

  text(): string {
    const { text, truncated } = decodeUtf8Capped(
      Buffer.concat(this.chunks),
      MAX_CAPTURED_STREAM_BYTES,
    );
    return truncated ? text + STREAM_TRUNCATION_MARKER : text;
  }
}

/**
 * Kills the process AND its descendants. `child.kill()` alone is not
 * enough: on win32 it cannot reach grandchildren, so taskkill walks the
 * tree (/t) with force (/f); on POSIX the child was spawned as a process
 * group leader and the whole group gets SIGKILL — not ignorable, so a
 * SIGTERM trap cannot let a job outlive its timeout. Descendants that
 * detach into their own group/session escape both; accepted for v0.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    }).once("error", () => {
      // taskkill missing or failed: nothing further to do — the timeout
      // outcome is still reported; the leak is logged by the caller's kind.
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The group is already gone (or grouping failed); at least take the
      // direct child.
      child.kill("SIGKILL");
    }
  }
}

/**
 * Runs one allowlisted command to an outcome. Never rejects on job-shaped
 * input: refusals, timeouts, and cancellations are all encoded in the
 * returned {@link SafeSpawnOutcome}.
 */
export async function safeSpawn(
  request: SafeSpawnRequest,
): Promise<SafeSpawnOutcome> {
  const { command, args, cwd, timeoutMs, signal, allowlist } = request;
  const killer = request.killer ?? killTree;
  const killGraceMs = request.killGraceMs ?? KILL_GRACE_MS;

  // The command name is job-controlled and the allowlist is a plain
  // object: Object.hasOwn keeps prototype keys ("__proto__", ...) from
  // ever matching. Checked BEFORE anything else — a disallowed command
  // must not even learn whether the workspace exists.
  if (!Object.hasOwn(allowlist, command)) {
    return {
      kind: "refused",
      error: {
        code: "COMMAND_NOT_ALLOWED",
        message: `command "${command}" is not on this worker's allowlist`,
        details: { command },
      },
    };
  }
  const executable = allowlist[command]?.executable ?? command;

  let cwdIsDirectory = false;
  try {
    cwdIsDirectory = (await stat(cwd)).isDirectory();
  } catch {
    // Missing or unreadable — refused below.
  }
  if (!cwdIsDirectory) {
    return {
      kind: "refused",
      error: {
        code: "WORKSPACE_UNAVAILABLE",
        message: `workspace directory is not available on this worker: ${cwd}`,
        details: { cwd },
      },
    };
  }

  if (signal.aborted) {
    return {
      kind: "canceled",
      output: { stdout: "", stderr: "", exitCode: null },
    };
  }

  const invocation = resolveSpawnInvocation(executable, args, process.platform);
  if (!invocation.ok) {
    // An argument could not be safely neutralized for the .cmd/.bat wrap
    // path: never spawn. The command name was allowed; the argument is not.
    return { kind: "refused", error: invocation.error };
  }

  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: own process group, so the kill path can take the whole tree
      // with kill(-pid). win32 uses taskkill /t instead (see killTree).
      detached: process.platform !== "win32",
      // The cmd.exe wrap path pre-builds the exact command line; Node must
      // NOT re-quote it (that would reopen the injection hole).
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    });

    const stdout = new CappedStreamCollector();
    const stderr = new CappedStreamCollector();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let killedBy: "timeout" | "canceled" | null = null;
    let settled = false;
    // Watchdog: armed once a kill is issued. If 'close' never arrives (the
    // killer exited nonzero on a protected child, say), it force-settles so
    // safeSpawn cannot hang forever on the child's pipes.
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const forceSettle = (reason: "timeout" | "canceled"): void => {
      // The child never closed after the kill: ship what we captured with a
      // null exit code, under the same outcome kind the kill intended.
      settle({
        kind: reason,
        output: {
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode: null,
        },
      });
    };

    const kill = (reason: "timeout" | "canceled"): void => {
      if (settled || killedBy !== null) {
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        // Already exited; 'close' is on its way — don't relabel a normal
        // completion as killed.
        return;
      }
      killedBy = reason;
      killer(child);
      watchdog = setTimeout(() => forceSettle(reason), killGraceMs);
    };

    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = (): void => kill("canceled");
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (outcome: SafeSpawnOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Clear the watchdog so it never leaks or fires late on the normal
      // close path (where it may already be armed).
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    child.once("error", (error) => {
      // Spawn failure (e.g. allowlisted executable missing): the process
      // never ran, and 'close' may never fire.
      settle({
        kind: "refused",
        error: {
          code: "INTERNAL",
          message: `failed to spawn "${invocation.executable}": ${error.message}`,
        },
      });
    });

    // 'close' (not 'exit'): both stdio pipes are fully flushed by then.
    child.once("close", (code) => {
      const output: CommandOutput = {
        stdout: stdout.text(),
        stderr: stderr.text(),
        // Our kill path reports null regardless of how the platform
        // encodes the forced termination.
        exitCode: killedBy === null ? code : null,
      };
      settle(
        killedBy === null
          ? { kind: "completed", output }
          : { kind: killedBy, output },
      );
    });
  });
}
