import { expect, test } from "vitest";
import { decodeUtf8Capped, truncateChars } from "./truncation.js";

test("decodeUtf8Capped leaves a buffer under the cap intact", () => {
  const result = decodeUtf8Capped(Buffer.from("hello", "utf8"), 100);
  expect(result).toEqual({ text: "hello", truncated: false });
});

test("decodeUtf8Capped treats a buffer exactly at the cap as not truncated", () => {
  const result = decodeUtf8Capped(Buffer.from("abcde", "utf8"), 5);
  expect(result).toEqual({ text: "abcde", truncated: false });
});

test("decodeUtf8Capped keeps the first cap-worth of an ASCII overflow", () => {
  const result = decodeUtf8Capped(Buffer.from("abcdefgh", "utf8"), 5);
  expect(result).toEqual({ text: "abcde", truncated: true });
});

test("decodeUtf8Capped backs off a 3-byte character split at the cap", () => {
  // "a" + "€€" is 1 + 3 + 3 bytes; a cap of 5 lands two bytes into the
  // second €, which must be dropped whole — never decoded as mojibake.
  const buffer = Buffer.from("a€€", "utf8");
  const result = decodeUtf8Capped(buffer, 5);
  expect(result.truncated).toBe(true);
  expect(result.text).toBe("a€");
  expect(result.text.includes("�")).toBe(false);
});

test("decodeUtf8Capped backs off a 4-byte character split at the cap", () => {
  // "𐍈" is 4 bytes; a cap of 6 lands two bytes into the second one.
  const buffer = Buffer.from("𐍈𐍈", "utf8");
  const result = decodeUtf8Capped(buffer, 6);
  expect(result.truncated).toBe(true);
  expect(result.text).toBe("𐍈");
  expect(result.text.includes("�")).toBe(false);
});

test("decodeUtf8Capped keeps a character ending exactly at the cap", () => {
  // "€" ends exactly at byte 4 of "a€ x"; the excluded byte starts a new
  // character, so nothing needs to be backed off.
  const buffer = Buffer.from("a€ x", "utf8");
  const result = decodeUtf8Capped(buffer, 4);
  expect(result).toEqual({ text: "a€", truncated: true });
});

test("truncateChars leaves short text unchanged", () => {
  expect(truncateChars("short", 10)).toBe("short");
});

test("truncateChars cuts long text and appends an ellipsis", () => {
  expect(truncateChars("abcdefgh", 5)).toBe("abcde…");
});

test("truncateChars never leaves a lone high surrogate at the cut", () => {
  // "𐍈" is a surrogate pair; a cut between its halves must drop the lead.
  const text = `abc${"𐍈"}`;
  const cut = truncateChars(text, 4);
  expect(cut).toBe("abc…");
});
