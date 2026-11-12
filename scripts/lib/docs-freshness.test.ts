import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  checkDocs,
  type DocsInputs,
  extractUsage,
  readDocsInputs,
} from "./docs-freshness.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the repo's own docs are up to date (run `pnpm check:docs` for details)", () => {
  expect(checkDocs(readDocsInputs(root))).toEqual([]);
});

describe("checkDocs on small inputs", () => {
  const cliSource = [
    "const USAGE = `homefleet - CLI",
    "",
    "Usage:",
    "  homefleet setup",
    "      Scaffold.",
    "",
    "  homefleet daemon start",
    "      Start it.",
    "`;",
  ].join("\n");
  const usage = extractUsage(cliSource);
  const good: DocsInputs = {
    version: "1.2.3",
    readme: [
      "> **Status: v1.2.3 — pre-alpha.**",
      "## What it does today",
      "| v1.2 | ran | x |",
      "## Install",
      "Install it (currently v1.2.3) globally. Run `homefleet setup`, then `homefleet daemon start`.",
      "## Roadmap",
      "- **v1.2** something",
      "## License",
    ].join("\n"),
    daemonReadme: `## The \`homefleet\` CLI\n\n\`\`\`\n${usage}\n\`\`\`\n\n## Control API\n`,
    cliSource,
    releaseNotesExist: true,
  };

  test("consistent inputs pass", () => {
    expect(checkDocs(good)).toEqual([]);
  });

  test("a version bump without README changes fails on every version spot", () => {
    const problems = checkDocs({
      ...good,
      version: "1.3.0",
      releaseNotesExist: false,
    });
    expect(problems.join("\n")).toMatch(/Status banner/);
    expect(problems.join("\n")).toMatch(/currently v1\.3\.0/);
    expect(problems.join("\n")).toMatch(/Roadmap: nothing mentions v1\.3/);
    expect(problems.join("\n")).toMatch(/Proven on real hardware/);
    expect(problems.join("\n")).toMatch(/docs\/releases\/v1\.3\.0\.md/);
  });

  test("a patch bump keeps the minor's roadmap entry and rig row", () => {
    const readme = good.readme.replace(/v1\.2\.3/g, "v1.2.4");
    expect(checkDocs({ ...good, version: "1.2.4", readme })).toEqual([]);
  });

  test("a new CLI command must reach both READMEs", () => {
    const cli = cliSource.replace(
      "`;",
      "\n  homefleet models\n      List models.\n`;",
    );
    const problems = checkDocs({ ...good, cliSource: cli });
    expect(problems.join("\n")).toMatch(/CLI block differs/);
    expect(problems.join("\n")).toMatch(
      /`homefleet models` command is never mentioned/,
    );
  });
});
