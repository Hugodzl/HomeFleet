/** `pnpm check:docs` — fail when the README or daemon README lag the code. */
import { fileURLToPath } from "node:url";
import { checkDocs, readDocsInputs } from "./lib/docs-freshness.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = checkDocs(readDocsInputs(root));
if (problems.length > 0) {
  for (const p of problems) console.error(`docs out of date: ${p}`);
  process.exit(1);
}
console.log("docs are up to date");
