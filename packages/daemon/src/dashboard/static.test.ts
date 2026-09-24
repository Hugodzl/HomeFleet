import { expect, test } from "vitest";
import {
  DASHBOARD_CSP,
  lookupStaticAsset,
  STATIC_SECURITY_HEADERS,
} from "./static.js";

test("/ serves the embedded index.html as UTF-8 HTML", () => {
  const asset = lookupStaticAsset("/");
  expect(asset?.contentType).toBe("text/html; charset=utf-8");
  expect(asset?.body).toContain("data-homefleet-dashboard");
});

test("lookup is exact-match only (no traversal, no prefix matching)", () => {
  for (const path of [
    "",
    "/index.html",
    "/dashboard/",
    "/dashboard/../control/status",
    "/control/status",
    "//",
  ]) {
    expect(lookupStaticAsset(path)).toBeUndefined();
  }
});

test("security headers carry the strict CSP and anti-framing/sniffing headers", () => {
  expect(STATIC_SECURITY_HEADERS["content-security-policy"]).toBe(
    DASHBOARD_CSP,
  );
  expect(DASHBOARD_CSP).toContain("default-src 'none'");
  expect(DASHBOARD_CSP).toContain("frame-ancestors 'none'");
  expect(DASHBOARD_CSP).not.toContain("unsafe-inline");
  expect(DASHBOARD_CSP).not.toContain("unsafe-eval");
  expect(STATIC_SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
  expect(STATIC_SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
  expect(STATIC_SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
  expect(STATIC_SECURITY_HEADERS["cache-control"]).toBe("no-store");
});

test("the page's script, view model and stylesheet are served with exact types", () => {
  expect(lookupStaticAsset("/dashboard/app.js")?.contentType).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/view-model.js")?.contentType).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/app.css")?.contentType).toBe(
    "text/css; charset=utf-8",
  );
  expect(lookupStaticAsset("/dashboard/app.js")?.body).toContain(
    "/control/jobs",
  );
});
