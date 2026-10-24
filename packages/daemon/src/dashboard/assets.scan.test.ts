/**
 * Static enforcement of the dashboard's XSS/CSRF discipline (spec:
 * "XSS discipline"). The page shares an origin with the control API's
 * mutating pair/* routes, so the client must never render data as HTML and
 * must never issue a non-GET request except the two token-bearing upgrade POSTs. The CSP is the second layer; this is
 * the first.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const assetsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets",
);

async function assetSources(ext: string): Promise<Array<[string, string]>> {
  const names = (await readdir(assetsDir)).filter((n) => n.endsWith(ext));
  return Promise.all(
    names.map(
      async (n) =>
        [n, await readFile(path.join(assetsDir, n), "utf8")] as [
          string,
          string,
        ],
    ),
  );
}

const FORBIDDEN_JS: RegExp[] = [
  /\binnerHTML\b/,
  /\bouterHTML\b/,
  /insertAdjacentHTML/,
  /document\.write/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /createContextualFragment|DOMParser|srcdoc|\.submit\(/,
  /set(?:Timeout|Interval)\(\s*["'`]/,
  /XMLHttpRequest/,
  /sendBeacon/,
  /\bmethod\s*:(?!\s*"(?:GET|POST)")/,
  /\bmethod\s*=(?!\s*"(?:GET|POST)")/,
];

test("client JS contains no HTML/eval sinks and no unexpected request method", async () => {
  const sources = await assetSources(".js");
  expect(sources.map(([n]) => n).sort()).toEqual(["app.js", "view-model.js"]);
  for (const [name, source] of sources) {
    for (const pattern of FORBIDDEN_JS) {
      expect({ name, hit: pattern.test(source) }).toEqual({
        name,
        hit: false,
      });
    }
  }
});

const ALLOWED_POST_PATHS = ["/control/upgrade/prepare", "/control/upgrade"];

/** Everything wrong with a client source's fetch/POST discipline (empty = ok). */
function fetchViolations(source: string): string[] {
  const problems: string[] = [];
  const calls = source.split(/\bfetch\(/).slice(1);
  let posts = 0;
  for (const part of calls) {
    // This call's options object, up to its closing `});`.
    const call = part.slice(0, part.indexOf("});") + 3);
    if (!/method:\s*"(?:GET|POST)"/.test(call)) {
      problems.push("fetch without a literal double-quoted GET/POST method");
    }
    if (/method:\s*"POST"/.test(call)) {
      posts++;
      if (!call.includes("x-homefleet-control-token")) {
        problems.push("POST fetch without the token header");
      }
    }
  }
  if (posts !== 1 || (source.match(/"POST"/g) ?? []).length !== 1) {
    problems.push("expected exactly one POST call site");
  }
  // Every `postJson(` is the definition (1) or a call whose first argument is
  // a double-quoted literal naming an allowed route.
  const mentions = (source.match(/\bpostJson\(/g) ?? []).length;
  const literal = [...source.matchAll(/\bpostJson\(\s*"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  if (mentions !== literal.length + 1) {
    problems.push("postJson called with a non-literal path");
  }
  for (const p of literal) {
    if (!ALLOWED_POST_PATHS.includes(p)) {
      problems.push(`postJson to disallowed path ${p}`);
    }
  }
  if (literal.length === 0) {
    problems.push("no postJson callers found");
  }
  return problems;
}

test("every fetch names its method; the only POSTs are the two upgrade routes, with the token", async () => {
  const source = await readFile(path.join(assetsDir, "app.js"), "utf8");
  expect(fetchViolations(source)).toEqual([]);
});

test("the fetch scan flags bypass attempts", () => {
  const good = `
    async function postJson(path, body) {
      await fetch(path, { method: "POST", headers: { "x-homefleet-control-token": t }, body });
    }
    postJson("/control/upgrade", {});`;
  expect(fetchViolations(good)).toEqual([]);
  expect(
    fetchViolations(`${good}
postJson(path, {});`),
  ).toContain("postJson called with a non-literal path");
  expect(
    fetchViolations(`${good}
postJson(\`/x/\${id}\`, {});`),
  ).toContain("postJson called with a non-literal path");
  expect(
    fetchViolations(`${good}
postJson("/control/pair", {});`),
  ).toContain("postJson to disallowed path /control/pair");
  expect(
    fetchViolations(`${good}
fetch(p, { method: verb, cache: "no-store" });`),
  ).toContain("fetch without a literal double-quoted GET/POST method");
  expect(
    fetchViolations(`${good}
fetch(p, { method: 'POST', cache: "x" });`),
  ).toContain("fetch without a literal double-quoted GET/POST method");
  expect(
    FORBIDDEN_JS.some((re) => re.test(`fetch(p, { method: 'POST' });`)),
  ).toBe(true);
  expect(FORBIDDEN_JS.some((re) => re.test(`{ method: verb }`))).toBe(true);
  expect(FORBIDDEN_JS.some((re) => re.test(`{ method: "POST" }`))).toBe(false);
});

test("app.js never embeds a 64-hex literal (the token comes from the page meta)", async () => {
  const source = await readFile(path.join(assetsDir, "app.js"), "utf8");
  expect(source).not.toMatch(/[0-9a-f]{64}/i);
});

test("index.html has no inline script, inline handlers, or inline styles", async () => {
  const html = await readFile(path.join(assetsDir, "index.html"), "utf8");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html).toContain('<dialog id="upgrade-dialog"');
});
