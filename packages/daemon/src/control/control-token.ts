/**
 * Per-boot control token: a random secret generated at every daemon start,
 * written to a user-only file, embedded in the served dashboard page, and
 * required on the upgrade POST routes.
 *
 * WHY: the static `x-homefleet-control: 1` header only stops a browser (no
 * cross-origin page can set it). Letting the dashboard TRIGGER an upgrade
 * needs something a co-resident, different-origin page cannot learn. The
 * token is only ever handed to (a) whoever can read the 0600 file (the same
 * OS user, i.e. the CLI) and (b) whoever can load the dashboard page itself,
 * which a cross-origin page cannot read (same-origin policy; no CORS headers).
 * It is regenerated each boot, so a leaked value dies with the process.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** File under the data dir holding the current boot's token. */
export const CONTROL_TOKEN_FILE = "control-token";
/** Request header carrying the token on the protected routes. */
export const CONTROL_TOKEN_HEADER = "x-homefleet-control-token";

/** 32 random bytes, hex-encoded (64 chars). */
export function generateControlToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Writes the token with mode 0600. `mode` only applies when the file is
 * CREATED, so a stale file from an earlier boot is removed first.
 */
export async function writeControlToken(
  dataDir: string,
  token: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, CONTROL_TOKEN_FILE);
  await rm(file, { force: true });
  await writeFile(file, token, { encoding: "utf8", mode: 0o600 });
}

/** Reads the token (trimmed); `undefined` when absent or empty. */
export function readControlTokenSync(dataDir: string): string | undefined {
  try {
    const text = readFileSync(
      path.join(dataDir, CONTROL_TOKEN_FILE),
      "utf8",
    ).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Constant-time compare; a length mismatch refuses without comparing. */
export function tokensMatch(
  expected: string,
  provided: string | undefined,
): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
