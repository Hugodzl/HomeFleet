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
  execute(
    args: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResultPayload>;
}

class SandboxViolationError extends Error {
  constructor(requested: string) {
    super(`path escapes the workspace: ${requested}`);
    this.name = "SandboxViolationError";
  }
}

/** Purely lexical containment: `target` is `root` or lives under it. */
function isContained(root: string, target: string): boolean {
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
 */
async function resolveInWorkspace(
  workspaceDir: string,
  requested: string,
): Promise<string> {
  if (requested.includes("\0")) {
    throw new SandboxViolationError(requested);
  }
  const realRoot = await realpath(workspaceDir);
  const resolved = path.resolve(realRoot, requested);
  if (!isContained(realRoot, resolved)) {
    throw new SandboxViolationError(requested);
  }
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

interface ToolSpec<T> {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  argsSchema: z.ZodType<T>;
  run: (args: T, context: ToolExecutionContext) => Promise<ToolResultPayload>;
}

/**
 * Wraps a tool body with the shared failure handling: invalid arguments
 * and ANY thrown error (sandbox violations, missing files, ...) become
 * error tool-results for the model — never an executor crash.
 */
function makeTool<T>(spec: ToolSpec<T>): AgentTool {
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

const readFileTool = makeTool({
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

const listDirTool = makeTool({
  name: "list_dir",
  description:
    'List a workspace directory. Returns a JSON array of { name, kind } entries where kind is "file" or "dir".',
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
    const entries = await readdir(real, { withFileTypes: true });
    const listed = entries
      .map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
      }))
      .sort((a, b) => byName(a.name, b.name));
    return { content: JSON.stringify(listed), isError: false };
  },
});

const grepTool = makeTool({
  name: "grep",
  description:
    "Search all workspace files line by line with a JavaScript regular expression. " +
    `Returns path:line:text matches (at most ${MAX_GREP_MATCHES}); skips .git and node_modules.`,
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
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (error) {
      return {
        isError: true,
        content: `invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const realRoot = await realpath(context.workspaceDir);
    const matches: string[] = [];
    let capped = false;
    for (const rel of await walkFiles(realRoot)) {
      if (capped) {
        break;
      }
      const lines = (await readFile(path.join(realRoot, rel), "utf8")).split(
        /\r?\n/,
      );
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) {
          continue;
        }
        if (matches.length >= MAX_GREP_MATCHES) {
          capped = true;
          break;
        }
        matches.push(`${rel}:${index + 1}:${line}`);
      }
    }
    if (capped) {
      matches.push(
        `[match cap reached: first ${MAX_GREP_MATCHES} matches shown]`,
      );
    }
    return {
      content: matches.length === 0 ? "no matches" : matches.join("\n"),
      isError: false,
    };
  },
});

const globTool = makeTool({
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

function runCommandTool(allowlist: CommandAllowlist): AgentTool {
  const allowed = Object.keys(allowlist).sort(byName);
  return makeTool({
    name: "run_command",
    description:
      "Run an allowlisted command in the workspace and return its exit code and output. " +
      `Allowed commands: ${allowed.join(", ")}.`,
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

/**
 * The advertised toolset. run_command is present only when the allowlist
 * has entries — an empty allowlist disables the tool AND omits it from the
 * definitions sent to the model.
 */
export function buildToolset(commandAllowlist: CommandAllowlist): AgentTool[] {
  const tools = [readFileTool, listDirTool, grepTool, globTool];
  if (Object.keys(commandAllowlist).length > 0) {
    tools.push(runCommandTool(commandAllowlist));
  }
  return tools;
}
