/**
 * Tests for the write-capable agent tools (v0.2 code-writing delegation):
 * write_file, edit_file, and the shared resolveWritablePath guard whose
 * git-admin-area refusal keeps a model from planting hooks or rewriting
 * git metadata. Real temp-dir I/O throughout, mirroring tools.test.ts.
 */
import {
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "../test-fixtures.js";
import type { ToolExecutionContext } from "./tools.js";
import { buildToolset } from "./toolset.js";
import {
  editFileTool,
  MAX_EDIT_TEXT_CHARS,
  MAX_WRITE_FILE_BYTES,
  resolveWritablePath,
  writeFileTool,
} from "./write-tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function tempDir(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

function context(workspaceDir: string): ToolExecutionContext {
  return {
    workspaceDir,
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

test("write_file creates a new file, auto-creating parent directories", async () => {
  const ws = await tempDir();
  const result = await writeFileTool.execute(
    { path: "src/deep/new.ts", content: "export const a = 1;\n" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  await expect(
    readFile(path.join(ws, "src", "deep", "new.ts"), "utf8"),
  ).resolves.toBe("export const a = 1;\n");
});

test("write_file replaces an existing file's content", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "note.txt"), "old content");
  const result = await writeFileTool.execute(
    { path: "note.txt", content: "new content" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  await expect(readFile(path.join(ws, "note.txt"), "utf8")).resolves.toBe(
    "new content",
  );
});

test("write_file accepts content exactly at the byte cap", async () => {
  const ws = await tempDir();
  const content = "x".repeat(MAX_WRITE_FILE_BYTES);
  const result = await writeFileTool.execute(
    { path: "max.txt", content },
    context(ws),
  );
  expect(result.isError).toBe(false);
  const info = await stat(path.join(ws, "max.txt"));
  expect(Number(info.size)).toBe(MAX_WRITE_FILE_BYTES);
});

test("write_file refuses an existing-directory target with a clear message", async () => {
  const ws = await tempDir();
  await mkdir(path.join(ws, "adir"));
  const result = await writeFileTool.execute(
    { path: "adir", content: "x" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  // A model-actionable refusal, not a leaked raw fs error.
  expect(result.content).toMatch(/existing directory/i);
  expect(result.content).not.toContain("EISDIR");
});

test("write_file names the parent component that is an existing file", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "blocker.txt"), "i am a file");
  const result = await writeFileTool.execute(
    { path: "blocker.txt/sub/new.txt", content: "x" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  // Names the blocking component and reads as a refusal — the raw mkdir
  // EEXIST ("file already exists") reads success-adjacent to a small model.
  expect(result.content).toContain("blocker.txt");
  expect(result.content).toMatch(/existing file, not a directory/i);
  expect(result.content).not.toContain("EEXIST");
  await expect(readFile(path.join(ws, "blocker.txt"), "utf8")).resolves.toBe(
    "i am a file",
  );
});

test("write_file rejects content over the byte cap and leaves the file untouched", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "keep.txt"), "original");
  const result = await writeFileTool.execute(
    { path: "keep.txt", content: "y".repeat(MAX_WRITE_FILE_BYTES + 1) },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain(String(MAX_WRITE_FILE_BYTES));
  await expect(readFile(path.join(ws, "keep.txt"), "utf8")).resolves.toBe(
    "original",
  );
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

test("edit_file replaces an exact unique match", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.ts"), "const x = 1;\nconst y = 2;\n");
  const result = await editFileTool.execute(
    { path: "a.ts", oldText: "const y = 2;", newText: "const y = 3;" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  await expect(readFile(path.join(ws, "a.ts"), "utf8")).resolves.toBe(
    "const x = 1;\nconst y = 3;\n",
  );
});

test("edit_file does not treat replacement text as a regex pattern", async () => {
  // String.prototype.replace gives `$&` and friends special meaning; the
  // tool must splice literally.
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.txt"), "value: PLACEHOLDER\n");
  const result = await editFileTool.execute(
    { path: "a.txt", oldText: "PLACEHOLDER", newText: "$&-$'-$1" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  await expect(readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe(
    "value: $&-$'-$1\n",
  );
});

test("edit_file reports zero matches as an error naming the count", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.ts"), "const x = 1;\n");
  const result = await editFileTool.execute(
    { path: "a.ts", oldText: "absent text", newText: "whatever" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("0");
  expect(result.content).toMatch(/exactly once/i);
  // Recovery protocol for the model: re-read, don't guess.
  expect(result.content).toMatch(/copy the text exactly/i);
  await expect(readFile(path.join(ws, "a.ts"), "utf8")).resolves.toBe(
    "const x = 1;\n",
  );
});

test("edit_file reports multiple matches as an error naming the count", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.ts"), "dup\ndup\n");
  const result = await editFileTool.execute(
    { path: "a.ts", oldText: "dup", newText: "uniq" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("2");
  expect(result.content).toMatch(/exactly once/i);
  // Recovery protocol for the model: disambiguate, don't retry blindly.
  expect(result.content).toMatch(/surrounding lines/i);
  await expect(readFile(path.join(ws, "a.ts"), "utf8")).resolves.toBe(
    "dup\ndup\n",
  );
});

test("edit_file rejects oversized oldText/newText via the args schema", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.txt"), "hello");
  const big = "z".repeat(MAX_EDIT_TEXT_CHARS + 1);
  for (const args of [
    { path: "a.txt", oldText: big, newText: "x" },
    { path: "a.txt", oldText: "hello", newText: big },
  ]) {
    const result = await editFileTool.execute(args, context(ws));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid arguments");
  }
  await expect(readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe("hello");
});

test("edit_file rejects an empty oldText via the args schema", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.txt"), "hello");
  const result = await editFileTool.execute(
    { path: "a.txt", oldText: "", newText: "x" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("invalid arguments");
});

test("both tools reject an empty path via the args schema", async () => {
  const ws = await tempDir();
  const written = await writeFileTool.execute(
    { path: "", content: "x" },
    context(ws),
  );
  expect(written.isError).toBe(true);
  expect(written.content).toContain("invalid arguments");
  const edited = await editFileTool.execute(
    { path: "", oldText: "a", newText: "b" },
    context(ws),
  );
  expect(edited.isError).toBe(true);
  expect(edited.content).toContain("invalid arguments");
});

test("edit_file with empty newText deletes the matched text", async () => {
  // The schema asymmetry (oldText min 1, newText may be empty) is
  // deliberate: empty newText IS the deletion operation.
  const ws = await tempDir();
  await writeFile(path.join(ws, "a.txt"), "keep DELETE keep");
  const result = await editFileTool.execute(
    { path: "a.txt", oldText: " DELETE", newText: "" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  await expect(readFile(path.join(ws, "a.txt"), "utf8")).resolves.toBe(
    "keep keep",
  );
});

test("edit_file reports a missing file with a model-actionable message", async () => {
  const ws = await tempDir();
  const result = await editFileTool.execute(
    { path: "nope.txt", oldText: "a", newText: "b" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  // The workspace-relative dialect the model speaks — never the raw ENOENT
  // with an absolute host path.
  expect(result.content).toContain("file not found: nope.txt");
  expect(result.content).toContain("write_file");
  expect(result.content).not.toContain("ENOENT");
  expect(result.content).not.toContain(ws);
});

test("edit_file refuses a non-UTF-8 file rather than corrupting it", async () => {
  // readFile(_, "utf8") lossy-decodes invalid bytes to U+FFFD; a whole-file
  // write-back would re-encode them and corrupt UNTOUCHED regions. The tool
  // must refuse instead.
  const ws = await tempDir();
  const raw = Buffer.concat([
    Buffer.from("prefix needle suffix ", "utf8"),
    Buffer.from([0xe9]), // Latin-1 'é' — invalid as UTF-8
    Buffer.from(" tail", "utf8"),
  ]);
  await writeFile(path.join(ws, "latin1.txt"), raw);
  const result = await editFileTool.execute(
    { path: "latin1.txt", oldText: "needle", newText: "thread" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/UTF-8/);
  const after = await readFile(path.join(ws, "latin1.txt"));
  expect(after.equals(raw)).toBe(true);
});

test("edit_file refuses an edit that would grow the file over the cap", async () => {
  // Without this, a file grown past the cap by one edit could never be
  // edited again (the pre-read cap would refuse it forever).
  const ws = await tempDir();
  const body = `needle${"x".repeat(MAX_WRITE_FILE_BYTES - 10)}`;
  await writeFile(path.join(ws, "near-cap.txt"), body);
  const result = await editFileTool.execute(
    { path: "near-cap.txt", oldText: "needle", newText: "n".repeat(200) },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/grow/i);
  expect(result.content).toContain(String(MAX_WRITE_FILE_BYTES));
  await expect(readFile(path.join(ws, "near-cap.txt"), "utf8")).resolves.toBe(
    body,
  );
});

test("edit_file refuses a file over the byte cap instead of truncating it", async () => {
  const ws = await tempDir();
  const big = `${"x".repeat(MAX_WRITE_FILE_BYTES + 10)}needle`;
  await writeFile(path.join(ws, "big.txt"), big);
  const result = await editFileTool.execute(
    { path: "big.txt", oldText: "needle", newText: "thread" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain(String(MAX_WRITE_FILE_BYTES));
  await expect(readFile(path.join(ws, "big.txt"), "utf8")).resolves.toBe(big);
});

// ---------------------------------------------------------------------------
// Containment (both tools share resolveWritablePath)
// ---------------------------------------------------------------------------

test("write_file rejects an absolute path outside the workspace", async () => {
  const ws = await tempDir();
  const outside = await tempDir();
  const target = path.join(outside, "pwn.txt");
  const result = await writeFileTool.execute(
    { path: target, content: "x" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("escapes the workspace");
  expect(await pathExists(target)).toBe(false);
});

test("write_file and edit_file reject ../ traversal", async () => {
  const ws = await tempDir();
  for (const attempt of ["../x", "..", "src/../../x", "src/./../.."]) {
    const written = await writeFileTool.execute(
      { path: attempt, content: "x" },
      context(ws),
    );
    expect(written.isError).toBe(true);
    expect(written.content).toContain("escapes the workspace");
    const edited = await editFileTool.execute(
      { path: attempt, oldText: "a", newText: "b" },
      context(ws),
    );
    expect(edited.isError).toBe(true);
    expect(edited.content).toContain("escapes the workspace");
  }
});

test("write_file refuses to write through a symlinked dir pointing outside", async (ctx) => {
  const ws = await tempDir();
  const outside = await tempDir();
  try {
    await symlink(outside, path.join(ws, "linked"), "dir");
  } catch {
    // Windows may refuse symlink creation without developer mode or
    // elevation; the lexical containment cases above still cover the
    // sandbox — skip only this realpath-specific case.
    ctx.skip();
  }
  const result = await writeFileTool.execute(
    { path: "linked/pwn.txt", content: "escaped" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("escapes the workspace");
  expect(await pathExists(path.join(outside, "pwn.txt"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Git admin area refusal
// ---------------------------------------------------------------------------

test("write_file refuses paths inside the git admin area", async () => {
  const ws = await tempDir();
  for (const attempt of [
    ".git/hooks/pre-commit",
    ".git",
    "sub/../.git/config",
  ]) {
    const result = await writeFileTool.execute(
      { path: attempt, content: "#!/bin/sh\necho pwned\n" },
      context(ws),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/git admin/i);
  }
  // Nothing was created — not even the parent directories.
  expect(await pathExists(path.join(ws, ".git"))).toBe(false);
  expect(await pathExists(path.join(ws, "sub"))).toBe(false);
});

test("write_file refuses the git admin area case-insensitively", async () => {
  // On win32 (and default macOS volumes) `.GIT` IS the `.git` directory;
  // the refusal compares case-insensitively on every platform.
  const ws = await tempDir();
  const result = await writeFileTool.execute(
    { path: ".GIT/hooks/x", content: "x" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/git admin/i);
  expect(await pathExists(path.join(ws, ".GIT"))).toBe(false);
});

test("edit_file refuses existing files inside the git admin area", async () => {
  const ws = await tempDir();
  await mkdir(path.join(ws, ".git"));
  await writeFile(path.join(ws, ".git", "config"), "[core]\n");
  const result = await editFileTool.execute(
    { path: ".git/config", oldText: "[core]", newText: "[evil]" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/git admin/i);
  await expect(readFile(path.join(ws, ".git", "config"), "utf8")).resolves.toBe(
    "[core]\n",
  );
});

test.runIf(process.platform === "win32")(
  "the 8.3 short-name alias of .git is refused on win32",
  async (ctx) => {
    // NTFS can expose `.git` under a short name like `GIT~1`; realpath of
    // the deepest existing ancestor expands the alias to `.git`, so the
    // guard sees the canonical first component.
    const ws = await tempDir();
    await mkdir(path.join(ws, ".git"));
    try {
      // 8.3 generation is per-volume (fsutil 8dot3name) — when the alias
      // does not exist there is nothing to bypass; skip.
      await realpath(path.join(ws, "GIT~1"));
    } catch {
      ctx.skip();
    }
    const result = await writeFileTool.execute(
      { path: "GIT~1/hooks/pre-commit", content: "pwned" },
      context(ws),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/git admin/i);
    expect(await pathExists(path.join(ws, ".git", "hooks"))).toBe(false);
  },
);

test("a symlink into .git is refused after realpath resolution", async (ctx) => {
  const ws = await tempDir();
  await mkdir(path.join(ws, ".git"));
  try {
    await symlink(path.join(ws, ".git"), path.join(ws, "innocent"), "dir");
  } catch {
    // Windows without developer mode/elevation — skip (see above).
    ctx.skip();
  }
  const result = await writeFileTool.execute(
    { path: "innocent/hooks/pre-commit", content: "pwned" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/git admin/i);
  expect(await pathExists(path.join(ws, ".git", "hooks"))).toBe(false);
});

// ---------------------------------------------------------------------------
// resolveWritablePath
// ---------------------------------------------------------------------------

test("resolveWritablePath resolves a not-yet-existing nested path under the workspace realpath", async () => {
  const ws = await tempDir();
  const resolved = await resolveWritablePath(ws, "a/b/c.txt");
  const realWs = await realpath(ws);
  expect(resolved).toBe(path.join(realWs, "a", "b", "c.txt"));
  // Resolution alone must not create anything.
  expect(await pathExists(path.join(ws, "a"))).toBe(false);
});

test("resolveWritablePath resolves an existing file like the read-tool guard", async () => {
  const ws = await tempDir();
  await writeFile(path.join(ws, "existing.txt"), "x");
  const resolved = await resolveWritablePath(ws, "existing.txt");
  expect(resolved).toBe(path.join(await realpath(ws), "existing.txt"));
});

// ---------------------------------------------------------------------------
// buildToolset composition
// ---------------------------------------------------------------------------

test("buildToolset excludes the write tools by default", () => {
  for (const toolset of [buildToolset({}), buildToolset({}, {})]) {
    const names = toolset.map((entry) => entry.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
  }
});

test("buildToolset includes both write tools with includeWriteTools", () => {
  const names = buildToolset({}, { includeWriteTools: true }).map(
    (entry) => entry.name,
  );
  expect(names).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "write_file",
    "edit_file",
  ]);
  const withCommand = buildToolset(
    { node: { executable: process.execPath } },
    { includeWriteTools: true },
  ).map((entry) => entry.name);
  expect(withCommand).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "write_file",
    "edit_file",
    "run_command",
  ]);
});

test("write tool definitions are well-formed function definitions", () => {
  for (const entry of [writeFileTool, editFileTool]) {
    expect(entry.definition.type).toBe("function");
    expect(entry.definition.function.name).toBe(entry.name);
    expect(entry.definition.function.description.length).toBeGreaterThan(0);
    expect(entry.definition.function.parameters).toMatchObject({
      type: "object",
    });
  }
  expect(editFileTool.definition.function.description).toMatch(/exactly once/i);
  // The recovery protocol lives in the descriptions too: edit_file says to
  // copy from read_file output; write_file steers partial changes away from
  // whole-file rewrites from memory.
  expect(editFileTool.definition.function.description).toMatch(
    /copy oldText exactly/i,
  );
  expect(writeFileTool.definition.function.description).toMatch(
    /prefer edit_file/i,
  );
});

// ---------------------------------------------------------------------------
// makeTool contract: failures are error tool-results, never thrown
// ---------------------------------------------------------------------------

test("failures are error tool-results, never thrown exceptions", async () => {
  const ws = await tempDir();
  const missing = await editFileTool.execute(
    { path: "nope.txt", oldText: "a", newText: "b" },
    context(ws),
  );
  expect(missing.isError).toBe(true);
  expect(typeof missing.content).toBe("string");
  const invalid = await writeFileTool.execute({ path: 42 }, context(ws));
  expect(invalid.isError).toBe(true);
  expect(invalid.content).toContain("invalid arguments");
});
