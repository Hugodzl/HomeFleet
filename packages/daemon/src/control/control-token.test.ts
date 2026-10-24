import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_TOKEN_FILE,
  generateControlToken,
  readControlTokenSync,
  tokensMatch,
  writeControlToken,
} from "./control-token.js";

describe("control token", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-token-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates 64 hex chars, different every call", () => {
    const a = generateControlToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateControlToken()).not.toBe(a);
  });

  it("round-trips through the file and a rewrite replaces the content", async () => {
    await writeControlToken(dir, "aa");
    expect(readControlTokenSync(dir)).toBe("aa");
    await writeControlToken(dir, "bb");
    expect(readControlTokenSync(dir)).toBe("bb");
    expect(CONTROL_TOKEN_FILE).toBe("control-token");
  });

  it("creates the data dir if missing", async () => {
    const nested = path.join(dir, "a", "b");
    await writeControlToken(nested, "cc");
    expect(readControlTokenSync(nested)).toBe("cc");
  });

  it("reads undefined for an absent file", () => {
    expect(readControlTokenSync(dir)).toBeUndefined();
  });

  it("tokensMatch compares safely", () => {
    expect(tokensMatch("ab", "ab")).toBe(true);
    expect(tokensMatch("ab", "ac")).toBe(false);
    expect(tokensMatch("ab", "abc")).toBe(false);
    expect(tokensMatch("ab", undefined)).toBe(false);
  });
});
