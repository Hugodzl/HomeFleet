/**
 * Write-capable agent tools (v0.2 code-writing delegation, ADR in
 * docs/specs/2026-07-10-code-writing-delegation-design.md): write_file and
 * edit_file.
 *
 * Both tools resolve model-supplied paths through {@link resolveWritablePath},
 * which is the read tools' realpath/containment discipline PLUS a refusal of
 * the worktree's git admin area — a model must never be able to plant hooks
 * or rewrite git metadata. As everywhere in tools.ts, failures come back as
 * error tool-results (the makeTool contract), never executor crashes.
 */
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type AgentTool,
  isContained,
  makeTool,
  resolveInWorkspace,
  SandboxViolationError,
} from "./tools.js";

/** Byte cap for write_file content and for the file edit_file will touch. */
export const MAX_WRITE_FILE_BYTES = 1_048_576;

/** Character cap on edit_file's oldText/newText, enforced by the args schema. */
export const MAX_EDIT_TEXT_CHARS = 65_536;

/**
 * Containment for a path that may not exist yet: walk up from the lexically
 * resolved path to the deepest EXISTING ancestor, realpath that, and re-join
 * the missing components. The missing components cannot be symlinks (they
 * do not exist), so realpathing the existing prefix is what enforces the
 * boundary — the same guarantee resolveInWorkspace gives for existing paths.
 *
 * Lexical containment (null byte, `..`, absolute/drive/UNC escapes) has
 * already been checked by resolveInWorkspace before its ENOENT surfaced, and
 * path.resolve normalized the input, so every missing component here is a
 * plain name — re-joining them cannot re-introduce traversal.
 */
async function resolveMissingTail(
  workspaceDir: string,
  requested: string,
  realRoot: string,
): Promise<string> {
  const resolved = path.resolve(workspaceDir, requested);
  const missing: string[] = [];
  let existing = resolved;
  for (;;) {
    let realExisting: string | undefined;
    try {
      realExisting = await realpath(existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTDIR: a FILE sits mid-path (POSIX realpath surfaces it; win32
      // reports ENOENT for the same shape). Keep walking up — the write
      // itself then fails with a clear parent-is-a-file refusal.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    if (realExisting !== undefined) {
      const full = path.join(realExisting, ...missing);
      if (!isContained(realRoot, full)) {
        throw new SandboxViolationError(requested);
      }
      return full;
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      // Filesystem root reached without an existing ancestor — unreachable
      // when lexical containment passed (workspaceDir itself exists).
      throw new SandboxViolationError(requested);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
}

/**
 * The resolved path's first component relative to the workspace realroot is
 * `.git` (or IS `.git`). Compared case-insensitively on EVERY platform: on
 * win32 and default macOS volumes `.GIT` is literally the git dir, and on
 * case-sensitive filesystems refusing a directory that merely spells the
 * git dir differently costs nothing.
 */
function isGitAdminPath(realRoot: string, resolved: string): boolean {
  const rel = path.relative(realRoot, resolved);
  const first = rel.split(path.sep)[0] ?? "";
  return first.toLowerCase() === ".git";
}

/**
 * Write-path resolution: the read-tool containment (resolveInWorkspace) plus
 * a refusal of anything at or under the worktree's git admin area — a model
 * must never be able to plant hooks or rewrite git metadata. Checked on the
 * RESOLVED (realpath'd) relative path, so `./.git`, `a/../.git`, and even a
 * workspace-internal symlink into `.git` are all caught.
 *
 * Leaf handling: resolveInWorkspace realpath()s the requested path itself
 * and so throws ENOENT for a not-yet-existing file, but write_file must be
 * able to CREATE files (and their parent dirs). Approach taken: on ENOENT
 * (or POSIX ENOTDIR — a file mid-path), fall back to
 * {@link resolveMissingTail}, which realpaths the deepest
 * existing ancestor and re-joins the missing components — the
 * generalization of "resolve the parent, re-join the basename" that also
 * covers write_file's parents-not-yet-created case.
 */
export async function resolveWritablePath(
  workspaceDir: string,
  requested: string,
): Promise<string> {
  // realpath'd once here; the missing-tail fallback and the git check share
  // it (resolveInWorkspace still derives its own internally).
  const realRoot = await realpath(workspaceDir);
  let resolved: string;
  try {
    resolved = await resolveInWorkspace(workspaceDir, requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw error;
    }
    resolved = await resolveMissingTail(workspaceDir, requested, realRoot);
  }
  if (isGitAdminPath(realRoot, resolved)) {
    throw new Error(
      `path is inside the git admin area (.git), which is never writable: ${requested}`,
    );
  }
  return resolved;
}

/**
 * Deepest existing ancestor of `start` when that ancestor is NOT a
 * directory — the component blocking parent-dir creation. Undefined when
 * everything existing on the way up is a directory.
 */
async function findBlockingFile(start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    try {
      return (await stat(current)).isDirectory() ? undefined : current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

export const writeFileTool: AgentTool = makeTool({
  name: "write_file",
  description:
    "Create a new text file or completely replace an existing one. Missing parent " +
    `directories are created. Content is UTF-8, at most ${MAX_WRITE_FILE_BYTES} bytes. ` +
    "Paths are relative to the workspace root; anything under .git is refused. " +
    "For partial changes prefer edit_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: {
        type: "string",
        description: "The full new file content (UTF-8)",
      },
    },
    required: ["path", "content"],
  },
  argsSchema: z.object({ path: z.string().min(1), content: z.string() }),
  // Progress events carry {tool, path} only — file content must never reach
  // the event stream (design spec §2; see AgentTool.eventArgsKeys).
  eventArgsKeys: ["path"],
  run: async (args, context) => {
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > MAX_WRITE_FILE_BYTES) {
      return {
        isError: true,
        content: `content is ${bytes} bytes, over the ${MAX_WRITE_FILE_BYTES}-byte write cap; file not written`,
      };
    }
    const resolved = await resolveWritablePath(context.workspaceDir, args.path);
    try {
      if ((await stat(resolved)).isDirectory()) {
        return {
          isError: true,
          content: `cannot write ${args.path}: it is an existing directory, not a file`,
        };
      }
    } catch {
      // Does not exist yet — the create case; writeFile surfaces anything
      // stranger than that on its own.
    }
    try {
      // Parent dirs are created only HERE — after containment and the
      // git-admin refusal both passed — so a refused path leaves no trace.
      await mkdir(path.dirname(resolved), { recursive: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A FILE blocking the directory chain: win32 reports EEXIST ("file
      // already exists" — reads success-adjacent to a small model), POSIX
      // ENOTDIR. Name the blocker in the model's workspace-relative dialect.
      if (code !== "EEXIST" && code !== "ENOTDIR") {
        throw error;
      }
      const blocker = await findBlockingFile(path.dirname(resolved));
      const named =
        blocker === undefined
          ? args.path
          : path
              .relative(await realpath(context.workspaceDir), blocker)
              .split(path.sep)
              .join("/");
      return {
        isError: true,
        content: `cannot create parent directories for ${args.path}: ${named} is an existing file, not a directory`,
      };
    }
    await writeFile(resolved, args.content, "utf8");
    return { isError: false, content: `wrote ${bytes} bytes to ${args.path}` };
  },
});

export const editFileTool: AgentTool = makeTool({
  name: "edit_file",
  description:
    "Edit a workspace text file by exact-match replace: fails unless oldText occurs " +
    "exactly once; that single occurrence is replaced with newText. Copy oldText " +
    "exactly from read_file output. Paths are relative to the workspace root; " +
    "anything under .git is refused.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      oldText: {
        type: "string",
        description:
          "Exact text to replace — must occur exactly once in the file",
      },
      newText: { type: "string", description: "Replacement text" },
    },
    required: ["path", "oldText", "newText"],
  },
  argsSchema: z.object({
    path: z.string().min(1),
    oldText: z.string().min(1).max(MAX_EDIT_TEXT_CHARS),
    newText: z.string().max(MAX_EDIT_TEXT_CHARS),
  }),
  // oldText/newText are repo content: path-only events, like write_file.
  eventArgsKeys: ["path"],
  run: async (args, context) => {
    const resolved = await resolveWritablePath(context.workspaceDir, args.path);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The raw ENOENT names an absolute host path — the wrong dialect for
      // the model. Speak workspace-relative and point at the recovery moves.
      if (code === "ENOENT" || code === "ENOTDIR") {
        return {
          isError: true,
          content: `file not found: ${args.path} — check the path with list_dir or glob; to create a new file use write_file`,
        };
      }
      throw error;
    }
    if (!info.isFile()) {
      throw new Error(`not a file: ${args.path}`);
    }
    // A capped read would silently DROP the tail on write-back, so a file
    // over the cap is refused outright rather than read-truncated.
    if (info.size > MAX_WRITE_FILE_BYTES) {
      return {
        isError: true,
        content: `file is ${info.size} bytes, over the ${MAX_WRITE_FILE_BYTES}-byte edit cap: ${args.path}`,
      };
    }
    const raw = await readFile(resolved);
    const text = raw.toString("utf8");
    // UTF-8 fidelity guard: decoding lossy-maps invalid bytes to U+FFFD and
    // the whole-file write-back would re-encode them — corrupting UNTOUCHED
    // regions. Refuse unless the decode round-trips byte-for-byte.
    if (!Buffer.from(text, "utf8").equals(raw)) {
      return {
        isError: true,
        content: `${args.path} is not valid UTF-8 text; edit_file only edits UTF-8 text files`,
      };
    }
    const count = text.split(args.oldText).length - 1;
    if (count === 0) {
      return {
        isError: true,
        content: `oldText occurs 0 times in ${args.path}; it must occur exactly once — read the file and copy the text exactly, including whitespace`,
      };
    }
    if (count > 1) {
      return {
        isError: true,
        content: `oldText occurs ${count} times in ${args.path}; it must occur exactly once — include more surrounding lines to make oldText unique`,
      };
    }
    // Splice by index — String.replace would give `$&` and friends in
    // newText replacement-pattern meaning.
    const at = text.indexOf(args.oldText);
    const updated =
      text.slice(0, at) + args.newText + text.slice(at + args.oldText.length);
    const updatedBytes = Buffer.byteLength(updated, "utf8");
    // Post-splice growth cap: a file grown past the cap by one edit could
    // otherwise never be edited again (the pre-read cap would refuse it
    // forever).
    if (updatedBytes > MAX_WRITE_FILE_BYTES) {
      return {
        isError: true,
        content: `edit would grow ${args.path} to ${updatedBytes} bytes, over the ${MAX_WRITE_FILE_BYTES}-byte cap; file unchanged`,
      };
    }
    await writeFile(resolved, updated, "utf8");
    return { isError: false, content: `edited ${args.path}` };
  },
});
