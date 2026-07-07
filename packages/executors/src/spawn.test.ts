import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type CommandAllowlist,
  MAX_CAPTURED_STREAM_BYTES,
  resolveSpawnInvocation,
  type SafeSpawnRequest,
  STREAM_TRUNCATION_MARKER,
  safeSpawn,
} from "./spawn.js";
import { makeTempDir, removeTempDir } from "./test-fixtures.js";

/** node is definitionally present: every spawn test runs `node -e "..."`. */
const nodeAllowlist: CommandAllowlist = {
  node: { executable: process.execPath },
};

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function workspace(): Promise<string> {
  const dir = await makeTempDir();
  tempDirs.push(dir);
  return dir;
}

async function runNode(
  script: string,
  overrides: Partial<SafeSpawnRequest> = {},
): Promise<ReturnType<typeof safeSpawn> extends Promise<infer T> ? T : never> {
  return safeSpawn({
    command: "node",
    args: ["-e", script],
    cwd: overrides.cwd ?? (await workspace()),
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    allowlist: nodeAllowlist,
    ...overrides,
  });
}

/**
 * A script that would leave a file behind if it ever ran — the sentinel for
 * asserting that a refused command truly never spawned.
 */
function sentinelScript(sentinelPath: string): string {
  return `require("fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran")`;
}

test("refuses a command not on the allowlist without spawning", async () => {
  const cwd = await workspace();
  const sentinel = path.join(cwd, "sentinel.txt");
  const outcome = await safeSpawn({
    command: "node",
    args: ["-e", sentinelScript(sentinel)],
    cwd,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    allowlist: {},
  });
  expect(outcome).toEqual({
    kind: "refused",
    error: {
      code: "COMMAND_NOT_ALLOWED",
      message: expect.stringContaining("node"),
      details: { command: "node" },
    },
  });
  expect(existsSync(sentinel)).toBe(false);
});

test("allowlist matching is exact; object prototype keys never match", async () => {
  for (const command of ["NODE", "__proto__", "hasOwnProperty"]) {
    const outcome = await runNode("", { command, allowlist: {} });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.code).toBe("COMMAND_NOT_ALLOWED");
    }
  }
});

test("refuses a missing workspace directory without spawning", async () => {
  const cwd = await workspace();
  const sentinel = path.join(cwd, "sentinel.txt");
  const outcome = await runNode(sentinelScript(sentinel), {
    cwd: path.join(cwd, "does-not-exist"),
  });
  expect(outcome.kind).toBe("refused");
  if (outcome.kind === "refused") {
    expect(outcome.error.code).toBe("WORKSPACE_UNAVAILABLE");
  }
  expect(existsSync(sentinel)).toBe(false);
});

test("runs in the workspace directory and captures both streams", async () => {
  const cwd = await workspace();
  await writeFile(path.join(cwd, "marker.txt"), "from-the-workspace", "utf8");
  const outcome = await runNode(
    'process.stdout.write(require("fs").readFileSync("marker.txt", "utf8"));' +
      'process.stderr.write("on stderr");',
    { cwd },
  );
  expect(outcome).toEqual({
    kind: "completed",
    output: {
      stdout: "from-the-workspace",
      stderr: "on stderr",
      exitCode: 0,
    },
  });
});

test("passes a nonzero exit code through as a completed outcome", async () => {
  const outcome = await runNode("process.exit(7)");
  expect(outcome.kind).toBe("completed");
  if (outcome.kind === "completed") {
    expect(outcome.output.exitCode).toBe(7);
  }
});

test("an entry without an explicit executable spawns the logical name", async () => {
  // The logical name IS the node path here; the entry declares nothing.
  const outcome = await safeSpawn({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("via logical name")'],
    cwd: await workspace(),
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    allowlist: { [process.execPath]: {} },
  });
  expect(outcome.kind).toBe("completed");
  if (outcome.kind === "completed") {
    expect(outcome.output.stdout).toBe("via logical name");
  }
});

test("kills the process on timeout and reports exitCode null", async () => {
  const outcome = await runNode(
    'process.stdout.write("started");setInterval(() => {}, 1000);',
    { timeoutMs: 400 },
  );
  expect(outcome.kind).toBe("timeout");
  if (outcome.kind === "timeout") {
    expect(outcome.output.exitCode).toBeNull();
    expect(outcome.output.stdout).toBe("started");
  }
});

test("timeout kills the whole process tree, grandchild included", async () => {
  const cwd = await workspace();
  const heartbeat = path.join(cwd, "heartbeat.txt");
  const grandchildScript =
    "setInterval(() => " +
    `require("fs").appendFileSync(${JSON.stringify(heartbeat)}, "x"), 50);`;
  const parentScript =
    'const cp = require("child_process");' +
    `cp.spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(
      grandchildScript,
    )}], { stdio: "ignore" });` +
    "setInterval(() => {}, 1000);";

  const outcome = await runNode(parentScript, { cwd, timeoutMs: 600 });
  expect(outcome.kind).toBe("timeout");

  // The grandchild heartbeats every 50ms; once the tree kill lands the file
  // stops growing. Poll until two consecutive reads agree.
  let previous = -1;
  await expect
    .poll(
      async () => {
        const size = existsSync(heartbeat)
          ? (await readFile(heartbeat)).length
          : 0;
        const stable = size === previous;
        previous = size;
        return stable;
      },
      { interval: 300, timeout: 5000 },
    )
    .toBe(true);
}, 10_000);

test("a SIGTERM-ignoring process is still killed at the timeout", async () => {
  // The kill path is forced (SIGKILL / taskkill /f), so trapping SIGTERM
  // must not let a process outlive its timeout on any platform.
  const outcome = await runNode(
    'process.on("SIGTERM", () => {});setInterval(() => {}, 1000);',
    { timeoutMs: 400 },
  );
  expect(outcome.kind).toBe("timeout");
});

test("cancellation kills the process and reports canceled", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const outcome = await runNode("setInterval(() => {}, 1000);", {
    signal: controller.signal,
  });
  expect(outcome.kind).toBe("canceled");
  if (outcome.kind === "canceled") {
    expect(outcome.output.exitCode).toBeNull();
  }
});

test("an already-aborted signal cancels without spawning", async () => {
  const cwd = await workspace();
  const sentinel = path.join(cwd, "sentinel.txt");
  const controller = new AbortController();
  controller.abort();
  const outcome = await runNode(sentinelScript(sentinel), {
    cwd,
    signal: controller.signal,
  });
  expect(outcome).toEqual({
    kind: "canceled",
    output: { stdout: "", stderr: "", exitCode: null },
  });
  expect(existsSync(sentinel)).toBe(false);
});

test("caps each stream at the byte cap, keeping the FIRST bytes plus a marker", async () => {
  const overshoot = MAX_CAPTURED_STREAM_BYTES + 50_000;
  const outcome = await runNode(
    `process.stdout.write("a".repeat(${overshoot}));` +
      'process.stderr.write("tiny");',
  );
  expect(outcome.kind).toBe("completed");
  if (outcome.kind === "completed") {
    expect(outcome.output.stdout).toBe(
      "a".repeat(MAX_CAPTURED_STREAM_BYTES) + STREAM_TRUNCATION_MARKER,
    );
    // The caps are per-stream: stderr stays intact.
    expect(outcome.output.stderr).toBe("tiny");
  }
}, 10_000);

test("does not split a multi-byte character at the capture cap", async () => {
  // "aa" then € (3 bytes) repeated: the cap lands 2 bytes into a €, which
  // must be dropped whole — no U+FFFD mojibake at the cut.
  const euros = Math.ceil(MAX_CAPTURED_STREAM_BYTES / 3);
  const outcome = await runNode(
    `process.stdout.write("aa" + "\\u20ac".repeat(${euros}));`,
  );
  expect(outcome.kind).toBe("completed");
  if (outcome.kind === "completed") {
    const captured = outcome.output.stdout;
    expect(captured.endsWith(STREAM_TRUNCATION_MARKER)).toBe(true);
    const text = captured.slice(0, -STREAM_TRUNCATION_MARKER.length);
    expect(text.includes("�")).toBe(false);
    expect(text.endsWith("€")).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      MAX_CAPTURED_STREAM_BYTES,
    );
  }
}, 10_000);

test("resolveSpawnInvocation wraps .cmd/.bat targets in cmd.exe on win32", () => {
  // The whole post-/c command is one pre-quoted verbatim token: the quoted
  // batch path followed by the quoted args. The escaping is quote-based, not
  // caret-based, because caret-escaping does NOT actually neutralize the
  // injection once a batch re-expands %1 (empirically confirmed); see
  // resolveSpawnInvocation and the "real .cmd cannot be arg-injected" test.
  // Clean args (no metacharacter, no whitespace) stay bare so a batch's %1
  // sees the intended literal; only the outer /c token is quoted.
  expect(resolveSpawnInvocation("pnpm.cmd", ["test"], "win32")).toEqual({
    ok: true,
    executable: "cmd.exe",
    args: ["/d", "/s", "/c", '"pnpm.cmd test"'],
    windowsVerbatimArguments: true,
  });
  // Extension matching is case-insensitive and path-aware.
  expect(
    resolveSpawnInvocation("C:\\tools\\BUILD.BAT", ["--fast"], "win32"),
  ).toEqual({
    ok: true,
    executable: "cmd.exe",
    args: ["/d", "/s", "/c", '"C:\\tools\\BUILD.BAT --fast"'],
    windowsVerbatimArguments: true,
  });
});

test("resolveSpawnInvocation leaves non-batch targets alone on win32", () => {
  // The non-.cmd/.exe path is unaffected: args pass through verbatim, even
  // ones full of cmd metacharacters (they never reach a shell).
  expect(
    resolveSpawnInvocation("node.exe", ["-e", "a & b", "%PATH%"], "win32"),
  ).toEqual({
    ok: true,
    executable: "node.exe",
    args: ["-e", "a & b", "%PATH%"],
  });
  // A name merely containing "cmd" is not a batch file.
  expect(resolveSpawnInvocation("cmdlet-tool", [], "win32")).toEqual({
    ok: true,
    executable: "cmdlet-tool",
    args: [],
  });
});

test("resolveSpawnInvocation never wraps on POSIX (metachars are literal)", () => {
  expect(
    resolveSpawnInvocation("weird.cmd", ["a & b", "%X%"], "linux"),
  ).toEqual({
    ok: true,
    executable: "weird.cmd",
    args: ["a & b", "%X%"],
  });
});

test("resolveSpawnInvocation neutralizes cmd metacharacters in .cmd args", () => {
  // Each metacharacter-bearing arg is double-quoted so cmd.exe treats it
  // literally (a quoted & | < > ( ) ^ cannot start a sibling command); the
  // whole command is one pre-quoted verbatim /c token.
  const resolved = resolveSpawnInvocation("greet.cmd", ["a&b", "x|y"], "win32");
  expect(resolved.ok).toBe(true);
  if (resolved.ok) {
    expect(resolved.executable).toBe("cmd.exe");
    // & and | are inside double quotes, so cmd never splits on them; the
    // clean batch path stays bare.
    expect(resolved.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"greet.cmd "a&b" "x|y""',
    ]);
    expect(resolved.windowsVerbatimArguments).toBe(true);
  }
});

test("resolveSpawnInvocation rejects un-escapable .cmd args fail-closed", () => {
  // % (env expansion), CR, LF, and ! (delayed expansion) cannot be
  // neutralized reliably through cmd.exe — reject, never spawn.
  for (const arg of ["%PATH%", "a\nb", "a\rb", "!X!"]) {
    const resolved = resolveSpawnInvocation("greet.cmd", [arg], "win32");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe("INVALID_REQUEST");
    }
  }
});

// Windows-only: prove the cmd.exe wrapping actually executes a real batch
// file (Node refuses to spawn .cmd/.bat without a shell — CVE-2024-27980).
test.runIf(process.platform === "win32")(
  "runs a real .cmd target through the cmd.exe wrapper",
  async () => {
    const cwd = await workspace();
    const cmdPath = path.join(cwd, "greet.cmd");
    await writeFile(cmdPath, "@echo off\r\necho hello %1\r\n", "utf8");
    const outcome = await safeSpawn({
      command: "greet",
      args: ["world"],
      cwd,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      allowlist: { greet: { executable: cmdPath } },
    });
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.output.exitCode).toBe(0);
      expect(outcome.output.stdout.trim()).toBe("hello world");
    }
  },
);

// Windows-only: prove the arg-injection hole is closed for real. The
// second review empirically ran `greet.cmd &whoami` and captured a
// username — the no-space arg is the live hole (Node only quotes args
// with spaces/tabs/quotes), so this asserts exactly that shape.
test.runIf(process.platform === "win32")(
  "a real .cmd cannot be arg-injected into running a second command",
  async () => {
    const cwd = await workspace();
    const cmdPath = path.join(cwd, "greet.cmd");
    // Writes its first arg to a file so we can prove what the batch saw.
    await writeFile(
      cmdPath,
      "@echo off\r\necho got:%1\r\n(echo %1)> received.txt\r\n",
      "utf8",
    );
    const sentinel = path.join(cwd, "PWNED.txt");
    // `&whoami` with no spaces: Node's own argv quoting leaves it bare, so
    // only resolveSpawnInvocation's double-quoting stops cmd.exe from
    // splitting on the & and running whoami as a sibling command.
    const injections = [
      "&whoami",
      `&echo pwned>${JSON.stringify(sentinel).slice(1, -1)}`,
      "a|b",
      "foo^bar",
    ];
    for (const injection of injections) {
      const outcome = await safeSpawn({
        command: "greet",
        args: [injection],
        cwd,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        allowlist: { greet: { executable: cmdPath } },
      });
      // Either neutralized (ran, no second command) — never a refusal for
      // these (all escapable) — the second command must not have executed.
      expect(outcome.kind).toBe("completed");
      if (outcome.kind === "completed") {
        // whoami output would contain a backslash domain\user or a name;
        // the batch's own echo prefixes "got:", so no unexpected command
        // output leaks in.
        expect(outcome.output.stdout).not.toMatch(/^\s*[a-z0-9.-]+\\/im);
      }
    }
    // The injected `echo pwned> PWNED.txt` never ran.
    expect(existsSync(sentinel)).toBe(false);
  },
);

test("a timeout still settles when the killer never reaps the child", async () => {
  // Watchdog seam: replace killTree with a no-op that only records the
  // child, so `close` never arrives — modelling taskkill exiting nonzero on
  // a protected child. The job must still settle within the grace window
  // instead of hanging forever. The captured child is reaped after, so the
  // orphan does not outlive the test.
  const captured: import("node:child_process").ChildProcess[] = [];
  const outcome = await runNode("setInterval(() => {}, 1000);", {
    timeoutMs: 300,
    killer: (child) => captured.push(child),
    killGraceMs: 500,
  });
  for (const child of captured) {
    child.kill("SIGKILL");
  }
  expect(outcome.kind).toBe("timeout");
  if (outcome.kind === "timeout") {
    expect(outcome.output.exitCode).toBeNull();
  }
}, 10_000);

test("a cancellation still settles when the killer never reaps the child", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const captured: import("node:child_process").ChildProcess[] = [];
  const outcome = await runNode("setInterval(() => {}, 1000);", {
    signal: controller.signal,
    killer: (child) => captured.push(child),
    killGraceMs: 500,
  });
  for (const child of captured) {
    child.kill("SIGKILL");
  }
  expect(outcome.kind).toBe("canceled");
  if (outcome.kind === "canceled") {
    expect(outcome.output.exitCode).toBeNull();
  }
}, 10_000);
