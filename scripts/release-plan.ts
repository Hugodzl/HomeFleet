/**
 * pnpm release:plan <releases.json>
 *
 * Reads `gh api --paginate --slurp repos/<repo>/releases` output from the
 * file, plans this run from GITHUB_REF / GITHUB_REF_NAME (see
 * lib/release-plan.ts), prints the plan, and appends `mode=`, `final=` and
 * `candidate=` to $GITHUB_OUTPUT when set.
 */
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { flattenReleasePages, planRelease } from "./lib/release-plan.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const file = positionals[0];
  if (file === undefined || positionals.length !== 1) {
    throw new Error("usage: pnpm release:plan <releases.json>");
  }
  const releases = flattenReleasePages(
    JSON.parse(await readFile(file, "utf8")),
  );
  const plan = planRelease({
    ref: process.env.GITHUB_REF ?? "",
    refName: process.env.GITHUB_REF_NAME ?? "",
    releases,
  });
  const lines = [
    `mode=${plan.mode}`,
    `final=${plan.final ?? ""}`,
    `candidate=${plan.candidate ?? ""}`,
  ];
  console.log(lines.join("\n"));
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output !== "") {
    await appendFile(output, `${lines.join("\n")}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
