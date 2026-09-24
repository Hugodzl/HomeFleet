/**
 * Maps a small set of typographic punctuation marks to their plain-ASCII
 * equivalents, leaving every other character (including non-ASCII ones, e.g.
 * accented letters in a user's file path) untouched.
 *
 * WHY: homefleetd writes every operator-facing line to stderr as UTF-8.
 * Operators commonly redirect that stderr to a file (e.g. PowerShell's
 * `Start-Process -RedirectStandardError`), then read it back with
 * PowerShell 5.1's `Get-Content` — which decodes the file using the system's
 * ANSI codepage, not UTF-8. Typographic characters like an em dash or an
 * ellipsis then show up as mojibake (`—` -> `â€"`, `…` -> `â€¦`). Routing
 * every stderr write through this function keeps the log ASCII-clean for
 * that reader without touching stdout (consumed by a real console, which
 * handles Unicode fine) or any protocol stream.
 */
const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[—–]/g, "-"], // em dash, en dash
  [/…/g, "..."], // ellipsis
  [/[‘’]/g, "'"], // single quotes
  [/[″“”]/g, '"'], // double prime, double quotes
];

export function asciiPunctuation(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
