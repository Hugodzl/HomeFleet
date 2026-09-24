/**
 * Static enforcement of the dashboard's XSS/CSRF discipline (spec:
 * "XSS discipline"). The page shares an origin with the control API's
 * mutating pair/* routes, so the client must never render data as HTML and
 * must never issue a non-GET request. The CSP is the second layer; this is
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
  /set(?:Timeout|Interval)\(\s*["'`]/,
  /XMLHttpRequest/,
  /sendBeacon/,
  /\bmethod\s*:\s*["'`](?!GET["'`])/,
];

test("client JS contains no HTML/eval sinks and no non-GET request", async () => {
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

test("every fetch in app.js is an explicit GET", async () => {
  const source = await readFile(path.join(assetsDir, "app.js"), "utf8");
  const fetches = source.match(/\bfetch\(/g) ?? [];
  expect(fetches).toHaveLength(1);
  expect(source).toMatch(/method:\s*"GET"/);
});

test("index.html has no inline script, inline handlers, or inline styles", async () => {
  const html = await readFile(path.join(assetsDir, "index.html"), "utf8");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
});
