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
): Promise<string> {
  const resolved = path.resolve(workspaceDir, requested);
  const realRoot = await realpath(workspaceDir);
  const missing: string[] = [];
  let existing = resolved;
  for (;;) {
    let realExisting: string | undefined;
    try {
      realExisting = await realpath(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
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
 * able to CREATE files (and their parent dirs). Approach taken: on ENOENT,
 * fall back to {@link resolveMissingTail}, which realpaths the deepest
 * existing ancestor and re-joins the missing components — the
 * generalization of "resolve the parent, re-join the basename" that also
 * covers write_file's parents-not-yet-created case.
 */
export async function resolveWritablePath(
  workspaceDir: string,
  requested: string,
): Promise<string> {
  let resolved: string;
  try {
    resolved = await resolveInWorkspace(workspaceDir, requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    resolved = await resolveMissingTail(workspaceDir, requested);
  }
  if (isGitAdminPath(await realpath(workspaceDir), resolved)) {
    throw new Error(
      `path is inside the git admin area (.git), which is never writable: ${requested}`,
    );
  }
  return resolved;
}

export const writeFileTool: AgentTool = makeTool({
  name: "write_file",
  description:
    "Create a new text file or completely replace an existing one. Missing parent " +
    `directories are created. Content is UTF-8, at most ${MAX_WRITE_FILE_BYTES} bytes. ` +
    "Paths are relative to the workspace root; anything under .git is refused.",
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
  argsSchema: z.object({ path: z.string(), content: z.string() }),
  run: async (args, context) => {
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > MAX_WRITE_FILE_BYTES) {
      return {
        isError: true,
        content: `content is ${bytes} bytes, over the ${MAX_WRITE_FILE_BYTES}-byte write cap; file not written`,
      };
    }
    const resolved = await resolveWritablePath(context.workspaceDir, args.path);
    // Parent dirs are created only HERE — after containment and the
    // git-admin refusal both passed — so a refused path leaves no trace.
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, args.content, "utf8");
    return { isError: false, content: `wrote ${bytes} bytes to ${args.path}` };
  },
});

export const editFileTool: AgentTool = makeTool({
  name: "edit_file",
  description:
    "Edit a workspace text file by exact-match replace: fails unless oldText occurs " +
    "exactly once; that single occurrence is replaced with newText. Paths are relative " +
    "to the workspace root; anything under .git is refused.",
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
    path: z.string(),
    oldText: z.string().min(1).max(MAX_EDIT_TEXT_CHARS),
    newText: z.string().max(MAX_EDIT_TEXT_CHARS),
  }),
  run: async (args, context) => {
    const resolved = await resolveWritablePath(context.workspaceDir, args.path);
    const info = await stat(resolved);
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
    const text = await readFile(resolved, "utf8");
    const count = text.split(args.oldText).length - 1;
    if (count !== 1) {
      return {
        isError: true,
        content: `oldText occurs ${count} times in ${args.path}; it must occur exactly once`,
      };
    }
    // Splice by index — String.replace would give `$&` and friends in
    // newText replacement-pattern meaning.
    const at = text.indexOf(args.oldText);
    const updated =
      text.slice(0, at) + args.newText + text.slice(at + args.oldText.length);
    await writeFile(resolved, updated, "utf8");
    return { isError: false, content: `edited ${args.path}` };
  },
});
