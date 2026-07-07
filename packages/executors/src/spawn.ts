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
 * `cmd.exe /d /s /c <target> <args...>` with the args passed through as-is.
 * cmd.exe argument parsing is quirky and NO re-quoting is attempted — the
 * allowlist gate is the security boundary, not arg escaping; only allowlist
 * a .cmd/.bat target whose argument handling is understood.
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
 * Decides the actual spawn target. Exported for cross-platform unit tests;
 * `safeSpawn` calls it with the live `process.platform`.
 */
export function resolveSpawnInvocation(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
): { executable: string; args: string[] } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    // /d skips AutoRun scripts, /s uses standard quote handling, /c runs
    // the command and exits. See the file-level doc for the caveat.
    return {
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", executable, ...args],
    };
  }
  return { executable, args };
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

  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: own process group, so the kill path can take the whole tree
      // with kill(-pid). win32 uses taskkill /t instead (see killTree).
      detached: process.platform !== "win32",
    });

    const stdout = new CappedStreamCollector();
    const stderr = new CappedStreamCollector();
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let killedBy: "timeout" | "canceled" | null = null;
    let settled = false;

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
      killTree(child);
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
