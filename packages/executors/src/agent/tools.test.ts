import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { CommandAllowlist } from "../spawn.js";
import { makeTempDir, removeTempDir } from "../test-fixtures.js";
import {
  type AgentTool,
  buildToolset,
  globToRegExp,
  MAX_GREP_MATCHES,
  MAX_READ_FILE_BYTES,
  READ_FILE_TRUNCATION_MARKER,
  type ToolExecutionContext,
} from "./tools.js";

const nodeAllowlist: CommandAllowlist = {
  node: { executable: process.execPath },
};

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

/** A small workspace with nested files for the read/list/grep/glob tools. */
async function makeWorkspace(): Promise<string> {
  const ws = await tempDir();
  await writeFile(path.join(ws, "README.md"), "# HomeFleet\nTODO: docs\n");
  await mkdir(path.join(ws, "src"));
  await writeFile(
    path.join(ws, "src", "index.ts"),
    'export const x = "TODO";\n',
  );
  await writeFile(path.join(ws, "src", "util.ts"), "export const y = 1;\n");
  await mkdir(path.join(ws, ".git"));
  await writeFile(
    path.join(ws, ".git", "config"),
    "TODO: should never surface",
  );
  return ws;
}

function context(
  workspaceDir: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    workspaceDir,
    signal: new AbortController().signal,
    commandTimeoutMs: 10_000,
    ...overrides,
  };
}

function tool(
  name: string,
  allowlist: CommandAllowlist = nodeAllowlist,
): AgentTool {
  const found = buildToolset(allowlist).find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`toolset has no tool named ${name}`);
  }
  return found;
}

test("buildToolset omits run_command when the allowlist is empty", () => {
  const names = buildToolset({}).map((entry) => entry.name);
  expect(names).toEqual(["read_file", "list_dir", "grep", "glob"]);
});

test("buildToolset includes run_command when the allowlist has entries", () => {
  const toolset = buildToolset(nodeAllowlist);
  expect(toolset.map((entry) => entry.name)).toEqual([
    "read_file",
    "list_dir",
    "grep",
    "glob",
    "run_command",
  ]);
  for (const entry of toolset) {
    expect(entry.definition.type).toBe("function");
    expect(entry.definition.function.name).toBe(entry.name);
    expect(entry.definition.function.description.length).toBeGreaterThan(0);
    expect(entry.definition.function.parameters).toMatchObject({
      type: "object",
    });
  }
});

test("read_file returns file content", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute(
    { path: "src/index.ts" },
    context(ws),
  );
  expect(result).toEqual({
    content: 'export const x = "TODO";\n',
    isError: false,
  });
});

test("read_file accepts an absolute path INSIDE the workspace", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute(
    { path: path.join(ws, "README.md") },
    context(ws),
  );
  expect(result.isError).toBe(false);
  expect(result.content).toContain("# HomeFleet");
});

test("read_file caps content at MAX_READ_FILE_BYTES with a marker", async () => {
  const ws = await makeWorkspace();
  await writeFile(
    path.join(ws, "big.txt"),
    "x".repeat(MAX_READ_FILE_BYTES + 5_000),
  );
  const result = await tool("read_file").execute(
    { path: "big.txt" },
    context(ws),
  );
  expect(result.isError).toBe(false);
  expect(result.content).toBe(
    "x".repeat(MAX_READ_FILE_BYTES) + READ_FILE_TRUNCATION_MARKER,
  );
});

test("read_file reports a missing file as a tool error, not a crash", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute(
    { path: "nope.txt" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("no such file");
});

test("read_file reports a directory as a tool error", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute({ path: "src" }, context(ws));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("not a file");
});

test("read_file rejects invalid arguments as a tool error", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute({ file: 42 }, context(ws));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("invalid arguments");
});

test("path traversal is rejected as a tool error", async () => {
  const ws = await makeWorkspace();
  for (const attempt of ["../x", "..", "src/../../x", "src/./../.."]) {
    const result = await tool("read_file").execute(
      { path: attempt },
      context(ws),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  }
});

test("an absolute path outside the workspace is rejected", async () => {
  const ws = await makeWorkspace();
  const outside = await tempDir();
  // The error may echo the requested path, so the file NAME must not be
  // the probe string — only its content is.
  await writeFile(path.join(outside, "private.txt"), "secret");
  const result = await tool("read_file").execute(
    { path: path.join(outside, "private.txt") },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("escapes the workspace");
  expect(result.content).not.toContain("secret");
});

test("a path containing a null byte is rejected", async () => {
  const ws = await makeWorkspace();
  const result = await tool("read_file").execute({ path: "a\0b" }, context(ws));
  expect(result.isError).toBe(true);
  expect(result.content).toContain("escapes the workspace");
});

test.runIf(process.platform === "win32")(
  "drive-letter and UNC escapes are rejected on win32",
  async () => {
    const ws = await makeWorkspace();
    // Other drive, drive-relative, and UNC forms all resolve outside.
    for (const attempt of [
      "Q:\\x",
      "Q:x",
      "\\\\server\\share\\x",
      "C:\\Windows\\win.ini",
    ]) {
      const result = await tool("read_file").execute(
        { path: attempt },
        context(ws),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("escapes the workspace");
    }
  },
);

test("a symlink pointing outside the workspace is rejected", async () => {
  const ws = await makeWorkspace();
  const outside = await tempDir();
  const target = path.join(outside, "secret.txt");
  await writeFile(target, "secret");
  try {
    await symlink(target, path.join(ws, "innocent.txt"), "file");
  } catch {
    // Windows may refuse file-symlink creation without developer mode or
    // elevation; the lexical containment cases above still cover the
    // sandbox — skip only this realpath-specific case.
    return;
  }
  const result = await tool("read_file").execute(
    { path: "innocent.txt" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("escapes the workspace");
  expect(result.content).not.toContain("secret");
});

test("list_dir lists entries with file/dir kinds, sorted", async () => {
  const ws = await makeWorkspace();
  const result = await tool("list_dir").execute({ path: "." }, context(ws));
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toEqual([
    { name: ".git", kind: "dir" },
    { name: "README.md", kind: "file" },
    { name: "src", kind: "dir" },
  ]);
});

test("list_dir reports a missing directory as a tool error", async () => {
  const ws = await makeWorkspace();
  const result = await tool("list_dir").execute(
    { path: "missing" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("no such file");
});

test("grep reports path:line:text matches and skips .git", async () => {
  const ws = await makeWorkspace();
  const result = await tool("grep").execute({ pattern: "TODO" }, context(ws));
  expect(result.isError).toBe(false);
  const lines = result.content.split("\n");
  expect(lines).toEqual([
    "README.md:2:TODO: docs",
    'src/index.ts:1:export const x = "TODO";',
  ]);
});

test("grep caps the number of matches", async () => {
  const ws = await makeWorkspace();
  const many = Array.from({ length: MAX_GREP_MATCHES + 50 }, () => "hit").join(
    "\n",
  );
  await writeFile(path.join(ws, "many.txt"), many);
  const result = await tool("grep").execute({ pattern: "hit" }, context(ws));
  expect(result.isError).toBe(false);
  const lines = result.content.split("\n");
  expect(lines).toHaveLength(MAX_GREP_MATCHES + 1);
  expect(lines[lines.length - 1]).toContain("match cap");
});

test("grep reports an invalid pattern as a tool error", async () => {
  const ws = await makeWorkspace();
  const result = await tool("grep").execute(
    { pattern: "(unclosed" },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("invalid pattern");
});

test("grep reports no matches without erroring", async () => {
  const ws = await makeWorkspace();
  const result = await tool("grep").execute(
    { pattern: "definitely-absent-token" },
    context(ws),
  );
  expect(result).toEqual({ content: "no matches", isError: false });
});

test("workspace walks do not follow symlinked directories", async () => {
  const ws = await makeWorkspace();
  const outside = await tempDir();
  await writeFile(path.join(outside, "leak.txt"), "TODO leak");
  try {
    await symlink(outside, path.join(ws, "linked"), "dir");
  } catch {
    // Windows may refuse symlink creation without developer mode or
    // elevation; skip only this case (see the read_file symlink test).
    return;
  }
  const result = await tool("grep").execute({ pattern: "TODO" }, context(ws));
  expect(result.content).not.toContain("leak");
});

test("glob matches *, **, and ? and returns forward-slash relative paths", async () => {
  const ws = await makeWorkspace();
  const all = await tool("glob").execute({ pattern: "**/*.ts" }, context(ws));
  expect(all.isError).toBe(false);
  expect(all.content.split("\n")).toEqual(["src/index.ts", "src/util.ts"]);

  const top = await tool("glob").execute({ pattern: "*.md" }, context(ws));
  expect(top.content).toBe("README.md");

  const single = await tool("glob").execute(
    { pattern: "src/inde?.ts" },
    context(ws),
  );
  expect(single.content).toBe("src/index.ts");
});

test("glob reports no matches without erroring", async () => {
  const ws = await makeWorkspace();
  const result = await tool("glob").execute(
    { pattern: "*.nothing" },
    context(ws),
  );
  expect(result).toEqual({ content: "no matches", isError: false });
});

test("globToRegExp implements the minimal matcher semantics", () => {
  // * does not cross a path separator; ** does; ? is one non-separator.
  expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
  expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
  expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
  expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
  expect(globToRegExp("src/**").test("src/deep/a.ts")).toBe(true);
  expect(globToRegExp("a?.md").test("ab.md")).toBe(true);
  expect(globToRegExp("a?.md").test("a/.md")).toBe(false);
  // Regex metacharacters in the pattern are literal.
  expect(globToRegExp("a.b").test("axb")).toBe(false);
  expect(globToRegExp("a+(b)").test("a+(b)")).toBe(true);
});

test("run_command routes through the allowlist and safe-spawn core", async () => {
  const ws = await makeWorkspace();
  const result = await tool("run_command").execute(
    {
      command: "node",
      args: ["-e", 'process.stdout.write("hi");process.exit(3)'],
    },
    context(ws),
  );
  // A nonzero exit is a normal command outcome, not a tool error.
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toEqual({
    exitCode: 3,
    stdout: "hi",
    stderr: "",
  });
});

test("run_command rejects a non-allowlisted command as a tool error", async () => {
  const ws = await makeWorkspace();
  const result = await tool("run_command").execute(
    { command: "rm", args: ["-rf", "/"] },
    context(ws),
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("COMMAND_NOT_ALLOWED");
});
