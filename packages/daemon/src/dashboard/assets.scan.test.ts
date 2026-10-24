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
  /\bmethod\s*:\s*["'`](?!(?:GET|POST)["'`])/,
  /\bmethod\s*=\s*["'](?!GET|POST)/,
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

test("every fetch names its method; POSTs only reach the two upgrade routes and carry the token", async () => {
  const source = await readFile(path.join(assetsDir, "app.js"), "utf8");
  // Split into call sites: each starts at `fetch(` and runs to the next one.
  const parts = source.split(/\bfetch\(/).slice(1);
  expect(parts.length).toBeGreaterThan(0);
  const posts: string[] = [];
  for (const part of parts) {
    // Look only at this call's options object (up to its closing `});`).
    const call = part.slice(0, part.indexOf("});") + 3);
    expect(call).toMatch(/method\s*:/);
    if (/method\s*:\s*"POST"/.test(call)) {
      posts.push(call);
      expect(call).toContain("x-homefleet-control-token");
    }
  }
  expect(posts).toHaveLength(1);
  // The single POST helper receives its path from callers: they may name only
  // these two routes.
  const postPaths = [...source.matchAll(/postJson\(\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  expect(postPaths.length).toBeGreaterThan(0);
  for (const p of postPaths) {
    expect(["/control/upgrade/prepare", "/control/upgrade"]).toContain(p);
  }
  expect(source.match(/"POST"/g) ?? []).toHaveLength(1);
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
