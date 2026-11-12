/**
 * Docs-freshness checks: the user-facing docs must follow the code, so a
 * release or a new command can't ship while the GitHub home page still
 * describes the previous one. Runs in `pnpm test` (so CI blocks the PR) and
 * on its own as `pnpm check:docs`.
 *
 * Each check is a plain string comparison against the repo's own sources of
 * truth (the daemon package version and the CLI's USAGE text), so a failure
 * always says exactly which file and line of text to fix.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DocsInputs {
  /** Version from packages/daemon/package.json, e.g. "0.7.0". */
  version: string;
  /** Root README.md text. */
  readme: string;
  /** packages/daemon/README.md text. */
  daemonReadme: string;
  /** packages/daemon/src/cli/cli.ts text (holds the USAGE literal). */
  cliSource: string;
  /** Whether docs/releases/v<version>.md exists. */
  releaseNotesExist: boolean;
}

/** The body of the CLI's USAGE text after "Usage:", dedented by two spaces. */
export function extractUsage(cliSource: string): string {
  const m = /const USAGE = `[^\n]*\n\nUsage:\n([\s\S]*?)`;/.exec(cliSource);
  if (!m?.[1]) throw new Error("cli.ts: could not find the USAGE literal");
  return m[1]
    .trimEnd()
    .split("\n")
    .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
    .join("\n");
}

/** Top-level command words in USAGE ("setup", "pair", "daemon", …). */
export function usageCommands(usage: string): string[] {
  const words = new Set<string>();
  for (const line of usage.split("\n")) {
    const m = /^homefleet ([a-z][a-z-]*)/.exec(line);
    if (m?.[1]) words.add(m[1]);
  }
  return [...words];
}

/** Text of a "## <title>" section, up to the next "## " heading. */
export function section(markdown: string, title: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l === `## ${title}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

export function checkDocs(d: DocsInputs): string[] {
  const problems: string[] = [];
  const v = `v${d.version}`;
  const minor = `v${d.version.split(".").slice(0, 2).join(".")}`;

  if (!d.readme.includes(`> **Status: ${v} `)) {
    problems.push(
      `README.md: the Status banner must start "> **Status: ${v} — …". Update it for the release.`,
    );
  }
  if (!d.readme.includes(`(currently ${v})`)) {
    problems.push(
      `README.md Install: the "(currently ${v})" note is missing or names an old version.`,
    );
  }
  const roadmap = section(d.readme, "Roadmap");
  if (roadmap === undefined) {
    problems.push(`README.md: no "## Roadmap" section.`);
  } else if (
    !new RegExp(`\\b${minor.replace(/\./g, "\\.")}\\b`).test(roadmap)
  ) {
    problems.push(
      `README.md Roadmap: nothing mentions ${minor}. Mark what ${minor} shipped as done.`,
    );
  }
  const proven = section(d.readme, "What it does today");
  if (proven === undefined) {
    problems.push(`README.md: no "## What it does today" section.`);
  } else if (
    !new RegExp(`\\| ${minor.replace(/\./g, "\\.")}(\\.\\d+)? \\|`).test(proven)
  ) {
    problems.push(
      `README.md "Proven on real hardware": no row for ${minor}. Add the rig result (or "not run on the rig yet").`,
    );
  }
  if (!d.releaseNotesExist) {
    problems.push(`docs/releases/${v}.md is missing.`);
  }

  const usage = extractUsage(d.cliSource);
  const cli = section(d.daemonReadme, "The `homefleet` CLI");
  const block = cli && /```\n([\s\S]*?)\n```/.exec(cli)?.[1];
  if (block === undefined || block === null) {
    problems.push(
      'packages/daemon/README.md: no code block under "## The `homefleet` CLI".',
    );
  } else if (block.trimEnd() !== usage) {
    problems.push(
      "packages/daemon/README.md: the `homefleet` CLI block differs from the USAGE text in " +
        "packages/daemon/src/cli/cli.ts. Copy USAGE's command list into it (dedented by two spaces).",
    );
  }

  for (const cmd of usageCommands(usage)) {
    if (!d.readme.includes(`homefleet ${cmd}`)) {
      problems.push(
        `README.md: the \`homefleet ${cmd}\` command is never mentioned.`,
      );
    }
  }
  return problems;
}

export function readDocsInputs(root: string): DocsInputs {
  const read = (p: string) =>
    readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
  const { version } = JSON.parse(read("packages/daemon/package.json")) as {
    version: string;
  };
  return {
    version,
    readme: read("README.md"),
    daemonReadme: read("packages/daemon/README.md"),
    cliSource: read("packages/daemon/src/cli/cli.ts"),
    releaseNotesExist: existsSync(join(root, `docs/releases/v${version}.md`)),
  };
}
