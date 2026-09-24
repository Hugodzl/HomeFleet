/**
 * The dashboard's static assets, embedded into the daemon bundle as strings
 * (`?raw` imports — see ./raw.d.ts) and served by the control server by
 * EXACT path lookup. There is no filesystem access and no path derived from
 * the request beyond a Map lookup, so there is no traversal surface.
 *
 * WHY the headers are this strict: the page shares an origin with the
 * control API's mutating `pair/*` routes, so script injection into this
 * page would be a real escalation. The CSP forbids inline script/style and
 * eval, and only lets the page talk to its own origin; the client code's
 * own discipline (textContent-only rendering, GET-only fetches) is enforced
 * separately by assets.scan.test.ts.
 */
import appCss from "./assets/app.css?raw";
import appJs from "./assets/app.js?raw";
import indexHtml from "./assets/index.html?raw";
import viewModelJs from "./assets/view-model.js?raw";

export interface StaticAsset {
  body: string;
  contentType: string;
}

export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent on every static response (never on the JSON data routes). */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": DASHBOARD_CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const ASSETS: ReadonlyMap<string, StaticAsset> = new Map([
  ["/", { body: indexHtml, contentType: "text/html; charset=utf-8" }],
  [
    "/dashboard/app.js",
    { body: appJs, contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/dashboard/view-model.js",
    { body: viewModelJs, contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/dashboard/app.css",
    { body: appCss, contentType: "text/css; charset=utf-8" },
  ],
]);

/** The asset served at exactly `pathname`, or `undefined`. */
export function lookupStaticAsset(pathname: string): StaticAsset | undefined {
  return ASSETS.get(pathname);
}
