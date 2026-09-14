/**
 * Lightweight PII detection and redaction.
 *
 * Regex-based and deliberately conservative: it catches the obvious, unambiguous
 * formats (email, US phone, SSN, card-shaped numbers) rather than trying to be a
 * full PII classifier. Two uses: flag documents that contain PII at ingest (so an
 * admin can see it), and redact PII out of audit-log detail before it is stored.
 */

// Order matters: SSN before phone so a NNN-NN-NNNN string is not mislabeled.
const PATTERNS: Array<[string, RegExp]> = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/g],
  ['credit_card', /\b(?:\d[ -]?){13,16}\b/g],
  ['phone', /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g],
]

/** Sorted, de-duplicated list of PII types present in `text`. */
export function detectTypes(text: string): string[] {
  const found = new Set<string>()
  for (const [name, pattern] of PATTERNS) {
    // A /g regex carries lastIndex between calls, so a shared one would skip
    // matches on the second string it saw. Reset before every search.
    pattern.lastIndex = 0
    if (pattern.test(text)) found.add(name)
  }
  return [...found].sort()
}

/** Replace each PII match with a [REDACTED-TYPE] marker. */
export function redact(text: string): string {
  let out = text
  for (const [name, pattern] of PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, `[REDACTED-${name.toUpperCase()}]`)
  }
  return out
}

/** Redact PII from the string values of an audit-log detail object (one level). */
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(detail).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]),
  )
}
