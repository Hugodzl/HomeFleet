/**
 * Workspace-sandboxed tools for the agent executor (ADR-0003): read_file,
 * list_dir, grep, glob, and allowlisted run_command.
 *
 * Path sandboxing is a security boundary. Model-supplied input is untrusted
 * in exactly the way discovery datagrams are: every path is resolved
 * against the workspace root and rejected when it escapes — traversal
 * (`..`), absolute paths outside the root, and on win32 drive-letter/UNC
 * escapes — with realpath-based containment so symlinks cannot escape
 * either (reads go through the verified real path). Rejections and all
 * other tool failures are returned to the model as ERROR TOOL-RESULTS, not
 * executor crashes: the loop continues.
 *
 * grep and glob are implemented in TS over a workspace walk — never by
 * spawning system tools; the walk skips symlinks entirely (a link's target
 * can live outside the workspace) plus `.git`/`node_modules` noise.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { type CommandAllowlist, safeSpawn } from "../spawn.js";
import { decodeUtf8Capped } from "../truncation.js";
import type { ToolDefinition } from "./openai-client.js";

/** Per-result byte cap for read_file. */
export const MAX_READ_FILE_BYTES = 65_536;

/** Appended to read_file content cut at {@link MAX_READ_FILE_BYTES}. */
export const READ_FILE_TRUNCATION_MARKER = `\n[content truncated: file exceeds ${MAX_READ_FILE_BYTES} bytes]`;

/** Match cap for grep. */
export const MAX_GREP_MATCHES = 100;

/**
 * Per-file byte cap for grep: a file larger than this is skipped, not read
 * into memory. read_file caps at 64 KiB; grep scans whole files, so this is
 * looser (1 MiB) but still bounds any single file — one huge file would
 * otherwise be an OOM risk (defense-in-depth alongside the ReDoS timeout).
 */
export const MAX_GREP_FILE_BYTES = 1_048_576;

/**
 * Total-scanned-bytes cap across all files in one grep, so a workspace full
 * of just-under-the-per-file-cap files cannot add up to an OOM.
 */
export const MAX_GREP_TOTAL_BYTES = 16 * 1_048_576;

/**
 * Hard wall-clock bound on the grep match work. The pattern is
 * model-supplied and runs synchronously per line; a catastrophic-
 * backtracking pattern (e.g. `(a+)+$` on a long non-matching line) freezes
 * the single-threaded event loop, so maxWallMs — checked only between agent
 * loop iterations — cannot save it. grep runs the match in a worker thread
 * the main thread can `terminate()` on expiry; this is that deadline.
 */
export const GREP_MATCH_TIMEOUT_MS = 2000;

/** Result cap for glob. */
export const MAX_GLOB_RESULTS = 1_000;

/** Directory names the grep/glob walk never descends into. */
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules"]);

/** Per-invocation context the loop hands to a tool. */
export interface ToolExecutionContext {
  /** Absolute path to the materialized workspace. */
  workspaceDir: string;
  /** The job's cancellation signal (run_command aborts on it). */
  signal: AbortSignal;
  /** Timeout for run_command spawns — the job's remaining wall budget. */
  commandTimeoutMs: number;
}

/** What a tool returns to the loop (and, summarized, to the event stream). */
export interface ToolResultPayload {
  content: string;
  isError: boolean;
}

export interface AgentTool {
  name: string;
  /** OpenAI function-calling definition advertised to the model. */
  definition: ToolDefinition;
  /**
   * Event-redaction allowlist for the loop's `tool_call` events. When set,
   * the emitted `argsSummary` is rebuilt from ONLY these argument keys —
   * everything else (file content, edit text) never reaches the event
   * stream. Content-carrying tools (write_file, edit_file) set this to
   * `["path"]` so progress events are `{tool, path}` with NO content (the
   * design spec's §2 promise); absent = the raw-args summary (read tools).
   */
  eventArgsKeys?: readonly string[];
  execute(
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResultPayload>;
}

export class SandboxViolationError extends Error {
  constructor(requested: string) {
    super(`path escapes the workspace: ${requested}`);
    this.name = "SandboxViolationError";
  }
}

/** Purely lexical containment: `target` is `root` or lives under it. */
export function isContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

/**
 * Resolves a model-supplied path to a real path inside the workspace, or
 * throws. Lexical containment is checked BEFORE any filesystem access, so
 * an outside path never even learns whether its target exists; the
 * realpath re-check then keeps symlinks from smuggling reads outside.
 *
 * The lexical check resolves and compares in the workspace's OWN namespace
 * (the path as handed in), never against its realpath. On win32 the two
 * forms can differ — e.g. an 8.3 short name like `RUNNER~1` (what
 * `os.tmpdir()` returns for a long user name) versus the long name
 * `realpath()` expands it to. Comparing a realpath'd root against a raw
 * absolute path then makes `path.relative` read an in-workspace path as an
 * escape. Resolving both sides in one namespace keeps the check consistent;
 * the realpath re-check below is what actually enforces the boundary against
 * symlink escapes, and it compares realpath-to-realpath.
 *
 * NOTE: `realpath(resolved)` throws ENOENT for a not-yet-existing entry, so
 * this guard only resolves EXISTING paths — the write tools' guard
 * (resolveWritablePath in write-tools.ts) layers missing-leaf handling on
 * top of it.
 */
export async function resolveInWorkspace(
  workspaceDir: string,
  requested: string,
): Promise<string> {
  if (requested.includes("\0")) {
    throw new SandboxViolationError(requested);
  }
  const resolved = path.resolve(workspaceDir, requested);
  if (!isContained(workspaceDir, resolved)) {
    throw new SandboxViolationError(requested);
  }
  const realRoot = await realpath(workspaceDir);
  // Throws ENOENT for a missing entry — reported as a normal tool error.
  const real = await realpath(resolved);
  if (!isContained(realRoot, real)) {
    throw new SandboxViolationError(requested);
  }
  return real;
}

/**
 * Compiles the minimal glob dialect to an anchored RegExp over
 * forward-slash relative paths: `*` within a segment, `**` across
 * segments, `?` one non-separator character; everything else literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // "**/" spans zero or more whole segments.
          source += "(?:[^/]*/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${source}$`);
}

function byName(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * All regular files under the (already realpath'd) root as sorted
 * forward-slash relative paths. Symlinks are neither followed nor listed.
 */
async function walkFiles(realRoot: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        await walk(path.join(dirAbs, entry.name), `${relPrefix}${entry.name}/`);
      } else if (entry.isFile()) {
        results.push(`${relPrefix}${entry.name}`);
      }
    }
  };
  await walk(realRoot, "");
  return results;
}

export interface ToolSpec<T> {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  argsSchema: z.ZodType<T>;
  /** See {@link AgentTool.eventArgsKeys}; absent = raw-args event summaries. */
  eventArgsKeys?: readonly string[];
  run: (args: T, context: ToolExecutionContext) => Promise<ToolResultPayload>;
}

/**
 * Wraps a tool body with the shared failure handling: invalid arguments
 * and ANY thrown error (sandbox violations, missing files, ...) become
 * error tool-results for the model — never an executor crash.
 */
export function makeTool<T>(spec: ToolSpec<T>): AgentTool {
  return {
    name: spec.name,
    definition: {
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    },
    ...(spec.eventArgsKeys !== undefined
      ? { eventArgsKeys: spec.eventArgsKeys }
      : {}),
    async execute(args, context) {
      const parsed = spec.argsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: `invalid arguments for ${spec.name}: ${parsed.error.message}`,
        };
      }
      try {
        return await spec.run(parsed.data, context);
      } catch (error) {
        return {
          isError: true,
          content: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export const readFileTool = makeTool({
  name: "read_file",
  description:
    "Read a text file from the workspace. Paths are relative to the workspace root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
    },
    required: ["path"],
  },
  argsSchema: z.object({ path: z.string() }),
  run: async (args, context) => {
    const real = await resolveInWorkspace(context.workspaceDir, args.path);
    const info = await stat(real);
    if (!info.isFile()) {
      throw new Error(`not a file: ${args.path}`);
    }
    const { text, truncated } = decodeUtf8Capped(
      await readFile(real),
      MAX_READ_FILE_BYTES,
    );
    return {
      content: truncated ? text + READ_FILE_TRUNCATION_MARKER : text,
      isError: false,
    };
  },
});

/** The kinds list_dir reports for a directory entry. */
type DirEntryKind = "file" | "dir" | "symlink";

export const listDirTool = makeTool({
  name: "list_dir",
  description:
    'List a workspace directory. Returns a JSON array of { name, kind } entries where kind is "file", "dir", or "symlink".',
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: 'Workspace-relative directory path ("." for the root)',
      },
    },
    required: ["path"],
  },
  argsSchema: z.object({ path: z.string() }),
  run: async (args, context) => {
    const real = await resolveInWorkspace(context.workspaceDir, args.path);
    // withFileTypes gives lstat semantics: a symlink reports as a symlink,
    // NOT as whatever it targets. Checked FIRST so a link to a directory is
    // never mislabeled "dir" (the walk skips symlinks, so the model would
    // otherwise be told a traversable dir exists that grep/glob ignore).
    const entries = await readdir(real, { withFileTypes: true });
    const listed = entries
      .map((entry): { name: string; kind: DirEntryKind } => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "dir"
            : "file",
      }))
      .sort((a, b) => byName(a.name, b.name));
    return { content: JSON.stringify(listed), isError: false };
  },
});

/** What the grep worker posts back to the main thread. */
interface GrepWorkerResult {
  /** `false` only for an uncompilable pattern (a normal tool error). */
  ok: boolean;
  /** Present when `ok` is false: the RegExp construction error message. */
  error?: string;
  matches: string[];
  /** The MAX_GREP_MATCHES cap was hit. */
  capped: boolean;
  /** Files skipped for exceeding the per-file byte cap. */
  skipped: string[];
  /** The total-scanned-bytes cap was hit and scanning stopped early. */
  bytesCapped: boolean;
}

/**
 * Runs the whole grep — workspace walk, bounded reads, per-line matching —
 * inside a worker thread. Kept as a plain-JS string so it needs no TS/ESM
 * transform: `new Worker(src, { eval: true })` runs identically under vitest
 * and a compiled/tsx runtime, and adds no dependency (item: ReDoS). It must
 * NOT import project code — everything it needs is inlined or in workerData.
 *
 * The point of the worker is that the MAIN thread can `terminate()` it when
 * a catastrophic-backtracking pattern blocks: a blocked regex on the main
 * thread would freeze the event loop and no timer could fire.
 */
const GREP_WORKER_SOURCE = /* js */ `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");

const {
  realRoot, pattern, skippedDirNames, maxMatches, maxFileBytes, maxTotalBytes,
} = workerData;
const skip = new Set(skippedDirNames);

let regex;
try {
  regex = new RegExp(pattern);
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error && error.message ? error.message : String(error),
    matches: [], capped: false, skipped: [], bytesCapped: false,
  });
}

if (regex) {
  const matches = [];
  const skipped = [];
  let capped = false;
  let bytesCapped = false;
  let totalBytes = 0;

  // Same walk as walkFiles(): sorted, symlink-skipping, .git/node_modules
  // pruned, regular files only. Kept in sync with the TS version by hand.
  const files = [];
  const walk = (dirAbs, relPrefix) => {
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(path.join(dirAbs, entry.name), relPrefix + entry.name + "/");
      } else if (entry.isFile()) {
        files.push(relPrefix + entry.name);
      }
    }
  };
  walk(realRoot, "");

  outer: for (const rel of files) {
    const abs = path.join(realRoot, rel);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size > maxFileBytes) {
      skipped.push(rel);
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      bytesCapped = true;
      break;
    }
    totalBytes += size;
    const lines = fs.readFileSync(abs, "utf8").split(/\\r?\\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue;
      if (matches.length >= maxMatches) {
        capped = true;
        break outer;
      }
      matches.push(rel + ":" + (i + 1) + ":" + lines[i]);
    }
  }

  parentPort.postMessage({ ok: true, matches, capped, skipped, bytesCapped });
}
`;

/**
 * Runs {@link GREP_WORKER_SOURCE} with a hard {@link GREP_MATCH_TIMEOUT_MS}
 * deadline. Resolves with the worker result, or rejects with a distinctive
 * "too expensive" error when the deadline fires (the worker is terminated).
 */
async function runGrepWorker(
  realRoot: string,
  pattern: string,
): Promise<GrepWorkerResult> {
  return new Promise<GrepWorkerResult>((resolve, reject) => {
    const worker = new Worker(GREP_WORKER_SOURCE, {
      eval: true,
      workerData: {
        realRoot,
        pattern,
        skippedDirNames: [...SKIPPED_DIR_NAMES],
        maxMatches: MAX_GREP_MATCHES,
        maxFileBytes: MAX_GREP_FILE_BYTES,
        maxTotalBytes: MAX_GREP_TOTAL_BYTES,
      },
    });
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    // The deadline the main thread owns: a blocked regex cannot fire its own
    // timer, but this one runs on the (unblocked) main thread.
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error("grep pattern too expensive or timed out")),
      );
    }, GREP_MATCH_TIMEOUT_MS);
    worker.once("message", (result: GrepWorkerResult) => {
      finish(() => resolve(result));
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
  });
}

export const grepTool = makeTool({
  name: "grep",
  description:
    "Search all workspace files line by line with a JavaScript regular expression. " +
    `Returns path:line:text matches (at most ${MAX_GREP_MATCHES}); skips .git, node_modules, ` +
    `and any file over ${MAX_GREP_FILE_BYTES} bytes.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "JavaScript regular expression, matched per line",
      },
    },
    required: ["pattern"],
  },
  argsSchema: z.object({ pattern: z.string() }),
  run: async (args, context) => {
    const realRoot = await realpath(context.workspaceDir);
    let result: GrepWorkerResult;
    try {
      result = await runGrepWorker(realRoot, args.pattern);
    } catch (error) {
      // The hard-timeout / terminate path: a pattern that would otherwise
      // freeze the loop. Surfaced to the model as an error tool-result.
      return {
        isError: true,
        content: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.ok) {
      return { isError: true, content: `invalid pattern: ${result.error}` };
    }
    const lines = [...result.matches];
    if (result.capped) {
      lines.push(
        `[match cap reached: first ${MAX_GREP_MATCHES} matches shown]`,
      );
    }
    if (result.bytesCapped) {
      lines.push(
        `[scan cap reached: stopped after ${MAX_GREP_TOTAL_BYTES} bytes]`,
      );
    }
    for (const rel of result.skipped) {
      lines.push(
        `[skipped ${rel}: file exceeds the ${MAX_GREP_FILE_BYTES}-byte per-file cap]`,
      );
    }
    return {
      content: lines.length === 0 ? "no matches" : lines.join("\n"),
      isError: false,
    };
  },
});

export const globTool = makeTool({
  name: "glob",
  description:
    "Find workspace files by glob pattern (*, **, ?) over forward-slash relative paths. " +
    `Returns at most ${MAX_GLOB_RESULTS} matching paths; skips .git and node_modules.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern, e.g. "src/**/*.ts"',
      },
    },
    required: ["pattern"],
  },
  argsSchema: z.object({ pattern: z.string() }),
  run: async (args, context) => {
    const regex = globToRegExp(args.pattern);
    const realRoot = await realpath(context.workspaceDir);
    const matched = (await walkFiles(realRoot)).filter((rel) =>
      regex.test(rel),
    );
    if (matched.length === 0) {
      return { content: "no matches", isError: false };
    }
    const capped = matched.length > MAX_GLOB_RESULTS;
    const lines = capped ? matched.slice(0, MAX_GLOB_RESULTS) : matched;
    if (capped) {
      lines.push(`[result cap reached: first ${MAX_GLOB_RESULTS} paths shown]`);
    }
    return { content: lines.join("\n"), isError: false };
  },
});

export function runCommandTool(allowlist: CommandAllowlist): AgentTool {
  const allowed = Object.keys(allowlist).sort(byName);
  return makeTool({
    name: "run_command",
    description:
      "Run an allowlisted command in the workspace and return its exit code and output. " +
      `Allowed commands: ${allowed.join(", ")}. ` +
      "Note: if an allowed command is a Windows batch file (.cmd/.bat), its " +
      "arguments may not contain %, newlines, or ! (such a call is rejected).",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Logical command name (must be on the allowlist)",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments, passed verbatim (no shell)",
        },
      },
      required: ["command"],
    },
    argsSchema: z.object({
      command: z.string(),
      args: z.array(z.string()).default([]),
    }),
    run: async (args, context) => {
      const outcome = await safeSpawn({
        command: args.command,
        args: args.args,
        cwd: context.workspaceDir,
        timeoutMs: context.commandTimeoutMs,
        signal: context.signal,
        allowlist,
      });
      switch (outcome.kind) {
        case "completed":
          // A nonzero exit is a normal command outcome the model should
          // read (failing tests are information), not a tool error.
          return {
            isError: false,
            content: JSON.stringify({
              exitCode: outcome.output.exitCode,
              stdout: outcome.output.stdout,
              stderr: outcome.output.stderr,
            }),
          };
        case "timeout":
          return {
            isError: true,
            content: JSON.stringify({
              error: `command timed out after ${context.commandTimeoutMs}ms`,
              stdout: outcome.output.stdout,
              stderr: outcome.output.stderr,
            }),
          };
        case "canceled":
          return { isError: true, content: "command canceled" };
        case "refused":
          return {
            isError: true,
            content: `${outcome.error.code}: ${outcome.error.message}`,
          };
      }
    },
  });
}
