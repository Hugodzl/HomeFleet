/**
 * `asciiPunctuation` is what every stderr write in homefleetd.ts is routed
 * through — see log-line.ts for why (PowerShell 5.1's `Get-Content` reads
 * redirected files as ANSI, mangling UTF-8 typographic punctuation).
 */
import { expect, test } from "vitest";
import { asciiPunctuation } from "./log-line.js";

test("maps U+2014 em dash to a hyphen", () => {
  expect(asciiPunctuation("a\u2014b")).toBe("a-b");
});

test("maps U+2013 en dash to a hyphen", () => {
  expect(asciiPunctuation("a\u2013b")).toBe("a-b");
});

test("maps U+2026 ellipsis to three dots", () => {
  expect(asciiPunctuation("wait\u2026")).toBe("wait...");
});

test("maps U+2018 and U+2019 single quotes to an apostrophe", () => {
  expect(asciiPunctuation("\u2018hi\u2019")).toBe("'hi'");
});

test("maps U+2033, U+201C and U+201D to a straight double quote", () => {
  expect(asciiPunctuation("\u201Chi\u201D")).toBe('"hi"');
  expect(asciiPunctuation("5\u2033")).toBe('5"');
});

test("leaves every other character untouched, mixed in a real message", () => {
  expect(
    asciiPunctuation(
      "homefleetd started \u2014 \u2018test-node\u2019 waiting\u2026",
    ),
  ).toBe("homefleetd started - 'test-node' waiting...");
});

test("leaves non-ASCII characters that are not mapped punctuation intact", () => {
  expect(asciiPunctuation("C:\\Users\\H\u00e9l\u00e8ne\\\u2026")).toBe(
    "C:\\Users\\H\u00e9l\u00e8ne\\...",
  );
});
