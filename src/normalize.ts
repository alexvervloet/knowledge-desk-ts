/**
 * Fold text to a comparison form, keeping a map back to the original.
 *
 * A filter that matches on bytes loses to an attacker who picks the bytes. A
 * Cyrillic-spelled `Ignore` and one carrying a zero-width space are different byte
 * sequences and the same word to every reader, ours and the model's. Enumerating
 * lookalikes one at a time is a race you lose slowly (the Unicode confusables table
 * runs to thousands of entries), so this covers the two families that matter for
 * marker forgery: invisible characters, and the Latin lookalikes people actually
 * reach for.
 *
 * The offset map is the point. Matching on folded text and replacing on folded text
 * would hand the model a document we rewrote, which is both lossy and useless for
 * an incident review that wants to know what the document said. `fold` returns the
 * folded string alongside, for each folded character, the index it came from in the
 * original, so a span found in the folded text can be cut out of the original.
 *
 * Deliberately not NFKC. Full compatibility normalization rewrites ligatures, width
 * variants, and a long tail of other things, and it changes lengths in ways that
 * make an exact offset map fiddly. Everything here is either a deletion or a
 * one-for-one substitution, so the map is exact and the code stays short enough to
 * audit.
 *
 * Indices here are code-point indices, not UTF-16 code units, which is the one
 * thing this port had to add. Python indexes strings by code point; JavaScript
 * indexes by UTF-16 unit, so a single astral character counts as two. An offset map
 * built on UTF-16 units would put a replacement marker through the middle of an
 * emoji. `fold` takes an array of code points and every index it returns is into
 * that array.
 */

// Latin lookalikes from the alphabets a confusable attack actually uses. Cyrillic
// and Greek capitals first, because marker text is upper case, then the lower
// case forms and the handful of digit and punctuation confusables.
const LOOKALIKES = new Map<string, string>([
  // Cyrillic
  ['\u0410', 'A'],
  ['\u0412', 'B'],
  ['\u0415', 'E'],
  ['\u041a', 'K'],
  ['\u041c', 'M'],
  ['\u041d', 'H'],
  ['\u041e', 'O'],
  ['\u0420', 'P'],
  ['\u0421', 'C'],
  ['\u0422', 'T'],
  ['\u0423', 'Y'],
  ['\u0425', 'X'],
  ['\u0405', 'S'],
  ['\u0406', 'I'],
  ['\u0408', 'J'],
  ['\u0430', 'a'],
  ['\u0432', 'b'],
  ['\u0435', 'e'],
  ['\u043a', 'k'],
  ['\u043c', 'm'],
  ['\u043d', 'h'],
  ['\u043e', 'o'],
  ['\u0440', 'p'],
  ['\u0441', 'c'],
  ['\u0442', 't'],
  ['\u0443', 'y'],
  ['\u0445', 'x'],
  ['\u0455', 's'],
  ['\u0456', 'i'],
  ['\u0458', 'j'],
  ['\u0501', 'd'],
  ['\u0261', 'g'],
  ['\u217c', 'l'],
  ['\u0578', 'n'],
  ['\u057d', 'u'],
  // Greek
  ['\u0391', 'A'],
  ['\u0392', 'B'],
  ['\u0395', 'E'],
  ['\u0396', 'Z'],
  ['\u0397', 'H'],
  ['\u0399', 'I'],
  ['\u039a', 'K'],
  ['\u039c', 'M'],
  ['\u039d', 'N'],
  ['\u039f', 'O'],
  ['\u03a1', 'P'],
  ['\u03a4', 'T'],
  ['\u03a5', 'Y'],
  ['\u03a7', 'X'],
  ['\u03bf', 'o'],
  ['\u03bd', 'v'],
  ['\u03b1', 'a'],
  ['\u03c1', 'p'],
  ['\u03c4', 't'],
  ['\u03c5', 'u'],
  ['\u03c7', 'x'],
  // Fullwidth Latin, which is a compatibility form NFKC would have caught.
  ['\uff21', 'A'],
  ['\uff22', 'B'],
  ['\uff23', 'C'],
  ['\uff24', 'D'],
  ['\uff25', 'E'],
  ['\uff26', 'F'],
  ['\uff27', 'G'],
  ['\uff28', 'H'],
  ['\uff29', 'I'],
  ['\uff2a', 'J'],
  ['\uff2b', 'K'],
  ['\uff2c', 'L'],
  ['\uff2d', 'M'],
  ['\uff2e', 'N'],
  ['\uff2f', 'O'],
  ['\uff30', 'P'],
  ['\uff31', 'Q'],
  ['\uff32', 'R'],
  ['\uff33', 'S'],
  ['\uff34', 'T'],
  ['\uff35', 'U'],
  ['\uff36', 'V'],
  ['\uff37', 'W'],
  ['\uff38', 'X'],
  ['\uff39', 'Y'],
  ['\uff3a', 'Z'],
  ['\uff41', 'a'],
  ['\uff42', 'b'],
  ['\uff43', 'c'],
  ['\uff44', 'd'],
  ['\uff45', 'e'],
  ['\uff46', 'f'],
  ['\uff47', 'g'],
  ['\uff48', 'h'],
  ['\uff49', 'i'],
  ['\uff4a', 'j'],
  ['\uff4b', 'k'],
  ['\uff4c', 'l'],
  ['\uff4d', 'm'],
  ['\uff4e', 'n'],
  ['\uff4f', 'o'],
  ['\uff50', 'p'],
  ['\uff51', 'q'],
  ['\uff52', 'r'],
  ['\uff53', 's'],
  ['\uff54', 't'],
  ['\uff55', 'u'],
  ['\uff56', 'v'],
  ['\uff57', 'w'],
  ['\uff58', 'x'],
  ['\uff59', 'y'],
  ['\uff5a', 'z'],
  // Punctuation that shows up in marker forgery.
  ['\uff1c', '<'],
  ['\uff1e', '>'],
  ['\uff0f', '/'],
  ['\uff3f', '_'],
  ['\uff0d', '-'],
  ['\u2010', '-'],
  ['\u2011', '-'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\ufe58', '-'],
  // Curly quotes, so a quoted evidence span parses whichever pair the model
  // reaches for.
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u201e', '"'],
  ['\u2033', '"'],
  ['\u2018', '\''],
  ['\u2019', '\''],
  ['\u201a', '\''],
])

// Characters that render as nothing and exist to break a string comparison. The
// Cf category covers the zero-width joiners, the directional overrides, and the
// byte-order mark; the explicit few are the ones outside it.
const INVISIBLE = new Set(['\u00ad', '\u200b', '\u2060', '\ufeff'])

// JavaScript has no unicodedata.category, so the Cf category comes from the
// regexp engine's own Unicode tables via a property escape. Same set Python
// reads, same source data.
const FORMAT_CHARACTER = /\p{Cf}/u

export function isInvisible(ch: string): boolean {
  return INVISIBLE.has(ch) || FORMAT_CHARACTER.test(ch)
}

/** The code points of `text`, which is what every index below is an index into. */
export function codePoints(text: string): string[] {
  return [...text]
}

/**
 * Return [foldedText, origin] where origin[i] is the code-point index in `text`
 * that foldedText's i-th code point came from.
 *
 * Invisible characters are dropped, so the folded string is shorter and the map
 * skips their indices. Every other character maps one for one, which is what
 * keeps `origin` exact.
 */
export function fold(text: string): [string, number[]] {
  const out: string[] = []
  const origin: number[] = []
  const chars = codePoints(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (isInvisible(ch)) continue
    out.push(LOOKALIKES.get(ch) ?? ch)
    origin.push(i)
  }
  return [out.join(''), origin]
}

/**
 * Map a [start, end) span in folded text back to a span in the original.
 *
 * The end is the index after the last folded character, so it maps to one past
 * that character's origin. An empty span, and a span running to the end of the
 * string, both fall back to the original length.
 *
 * `start` and `end` are code-point indices into the folded string, so a caller
 * holding a RegExp match index has to convert first: see `foldedIndices`.
 */
export function originalSpan(
  origin: number[],
  start: number,
  end: number,
  length: number,
): [number, number] {
  if (start >= origin.length) return [length, length]
  const first = origin[start] as number
  const last = (0 < end && end <= origin.length ? origin[end - 1] : origin[origin.length - 1]) as number
  return [first, last + 1]
}

/**
 * Convert a RegExp match's UTF-16 offsets into code-point offsets.
 *
 * `RegExp.exec` reports `index` in UTF-16 units even under the `u` flag, and
 * every index in this module is a code-point index. Without this conversion a
 * document containing one emoji before a forged marker would have its
 * replacement land one position late, and the further into the document the
 * match sat the worse the drift got.
 */
export function foldedIndices(folded: string, utf16Start: number, utf16End: number): [number, number] {
  let cp = 0
  let start = -1
  let end = -1
  for (let i = 0; i <= folded.length; ) {
    if (i === utf16Start) start = cp
    if (i === utf16End) end = cp
    if (i === folded.length) break
    i += (folded.codePointAt(i) as number) > 0xffff ? 2 : 1
    cp += 1
  }
  return [start < 0 ? cp : start, end < 0 ? cp : end]
}

/**
 * Replace the given original-coordinate spans in `text` with `marker`.
 *
 * Applied right to left so earlier spans keep their indices. Callers pass spans
 * already mapped through `originalSpan`, so the coordinates are code-point
 * indices and the slicing is done on the code-point array.
 */
export function replaceFolded(text: string, spans: Array<[number, number]>, marker: string): string {
  const chars = codePoints(text)
  const ordered = [...spans].sort((a, b) => b[0] - a[0] || b[1] - a[1])
  let out = chars
  for (const [start, end] of ordered) {
    out = [...out.slice(0, start), marker, ...out.slice(end)]
  }
  return out.join('')
}
