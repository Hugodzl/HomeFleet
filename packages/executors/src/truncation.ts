/**
 * Byte-capped UTF-8 decoding, shared by the safe-spawn stream capture and
 * the agent tools. Captured output travels inside HTTP bodies with a hard
 * transport cap, so producers cut at a byte budget — and a multi-byte
 * character split at that boundary must not decode as mojibake, so the cut
 * backs off to a character boundary.
 */

export interface CappedText {
  text: string;
  truncated: boolean;
}

/**
 * Decodes at most `maxBytes` of `buffer` as UTF-8. When the buffer exceeds
 * the cap, the cut lands on a character boundary: a multi-byte sequence
 * straddling the cap is dropped whole rather than decoded as U+FFFD.
 */
export function decodeUtf8Capped(buffer: Buffer, maxBytes: number): CappedText {
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  let cut = maxBytes;
  // buffer[cut] is the first EXCLUDED byte. While it is a UTF-8
  // continuation byte (0b10xxxxxx), the character it belongs to straddles
  // the cap — back off to that character's lead byte and exclude it too.
  while (cut > 0 && ((buffer[cut] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    cut -= 1;
  }
  return { text: buffer.subarray(0, cut).toString("utf8"), truncated: true };
}

/**
 * Truncates to at most `maxChars` UTF-16 code units, appending an ellipsis
 * when cut. A cut between the halves of a surrogate pair drops the lone
 * high surrogate — event summaries must stay well-formed strings.
 */
export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}
