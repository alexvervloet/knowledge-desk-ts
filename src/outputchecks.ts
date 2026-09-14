/**
 * Deterministic checks on a finished answer.
 *
 * The layers before this one guess. A fence guesses that the model will respect a
 * boundary it can locate; defusing guesses which shapes it might honour. These
 * functions do not guess: they look at concrete output and answer yes or no. That
 * is what makes an output check the most reliable layer in an injection defense,
 * and why it belongs behind the others rather than instead of them.
 *
 * **These are detectors, not a gate, and the reason is the streaming.** Tokens go
 * to the browser as they arrive, so by the time an answer is complete the caller
 * has already read it. Gating would mean buffering the whole answer and giving up
 * streaming, which is a real trade and not obviously the right one for a product
 * whose main interaction is watching an answer appear. So the findings ride along
 * in the `done` frame for the UI to show, and land in the audit log where a pattern
 * across many answers is visible. Calling them a gate would be the more flattering
 * description and the false one.
 *
 * What these checks are not: proof that an answer is true. Verifying that a quote
 * exists in the passage it cites catches detached, invented, and stale citations,
 * and it says nothing about whether the quote supports the sentence built around
 * it. Entailment needs task-specific factuality work. A UI showing a green check
 * here would be claiming something this module cannot deliver.
 *
 * What is deliberately not detected: a plain URL sitting in a sentence. Stripping
 * markdown images and foreign-domain links works because those have a structural
 * handle to grab. A human-readable phishing link written as ordinary prose has
 * none, and no filter here will catch it. Catching it needs domain reputation or a
 * policy of not surfacing model-authored links at all, each a project with its own
 * false positives. Left visibly unhandled rather than tuned away.
 */

import * as normalize from './normalize.ts'
import { SYSTEM_CANARY, markerShaped, type Context } from './providers.ts'

export interface Finding {
  code: string
  detail: string
}

// `[12]` in an answer is a claim that passage 12 exists. Matching the same shape
// the prompt uses to label them.
const CITATION = /\[\s*(\d{1,3})\s*\]/gu

// A citation followed by its evidence span. The system prompt asks for a short
// verbatim quote after each `[n]`, and this is the pair that gets verified. Run
// against folded text, where curly quotes have already become straight ones.
//
// Newlines are allowed inside the span. A streamed answer wraps, and a quote
// broken across two lines is the model reproducing the passage correctly; a
// pattern that stopped at the newline would read it as an unquoted citation and
// report the compliant answer. Both parts are non-greedy and length-bounded, so
// the match still stops at the nearest closing quote rather than running on.
const CITED_QUOTE = /\[\s*(\d{1,3})\s*\][^"]{0,40}?"([^"]{1,300}?)"/gu

/**
 * Whitespace-collapsed, case-folded form for comparing a quote to a passage.
 *
 * Lenient on purpose. A quote differing from its source only by line wrapping
 * or capitalisation is the model reproducing the passage correctly, and
 * flagging it would be a false positive. False positives are what turn a
 * warning list into something nobody reads, and they buy nothing here: no
 * attack turns on the case of a word.
 */
function comparable(text: string): string {
  return caseFold(normalize.fold(text)[0].split(/\s+/).filter(Boolean).join(' '))
}

/**
 * Python's `str.casefold`, which JavaScript has no equivalent of.
 *
 * `toLowerCase` is caseless matching for most of the alphabet and stops short of
 * the two folds that turn up in real European-language documents: the German
 * sharp s, which casefolds to "ss", and the Greek final sigma, which casefolds to
 * a medial one. A quote reproduced with "strasse" where the passage says
 * "straße" is the model copying correctly, and comparing with `toLowerCase`
 * alone would report it as unsupported. Spelled out rather than pulled from a
 * package, because it is two substitutions and a reader can check them.
 */
function caseFold(text: string): string {
  return text.replaceAll('\u00df', 'ss').replaceAll('\u1e9e', 'ss').toLowerCase().replaceAll('\u03c2', '\u03c3')
}

// A markdown image is the exfiltration channel worth naming: a client that
// renders it fetches the URL without the reader doing anything, so a secret
// encoded into the query string leaves silently. A link is the milder cousin,
// needing a click. Both have a structural handle; a bare URL in prose does not.
const MD_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)/gu
const MD_LINK = /(?<!!)\[[^\]]*\]\(\s*([^)\s]+)/gu

function findAll(pattern: RegExp, text: string): string[] {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].map((m) => m[1] as string)
}

/**
 * Findings for one finished answer. Empty means nothing was noticed.
 *
 * Every check runs against folded text, for the same reason the input side
 * does: a secret respelled with a Cyrillic character walks past a comparison
 * that reads bytes, and an output check is exactly where that would be most
 * embarrassing.
 */
export function checkAnswer(answer: string, contexts: Context[]): Finding[] {
  const [folded] = normalize.fold(answer)
  const findings: Finding[] = []

  // A citation the retrieval never issued. Cheap to detect, and worth detecting
  // because a fabricated citation number destroys trust in every real one the
  // moment a reader follows it and finds nothing.
  const allowed = new Set(Array.from({ length: contexts.length }, (_, i) => i + 1))
  const cited = new Set(findAll(CITATION, folded).map(Number))
  const bad = [...cited].filter((n) => !allowed.has(n)).sort((a, b) => a - b)
  if (bad.length > 0) {
    findings.push({
      code: 'citation_out_of_range',
      detail:
        `cited ${bad.map((n) => `[${n}]`).join(', ')} with` +
        ` ${contexts.length} passage(s) retrieved`,
    })
  }

  // Whether each quoted claim is actually in the passage it cites. This is what
  // citation *existence* does not give you: a model that reads a forged policy
  // can attribute it to the real key of the passage that carried it, at which
  // point the key check passes and the false claim reads as sourced.
  //
  // It detects detached, invented, and stale citations. It does not prove
  // entailment: a quote can be real, in the right passage, and still not support
  // the sentence built around it. That needs task-specific factuality work, and
  // nothing here should be read as standing in for it.
  const passages = contexts.map((c) => comparable(String(c.text ?? '')))
  const quoted = new Set<number>()
  const unsupported: string[] = []
  CITED_QUOTE.lastIndex = 0
  for (const match of folded.matchAll(CITED_QUOTE)) {
    const n = Number(match[1])
    quoted.add(n)
    if (!allowed.has(n)) continue // already reported as out of range
    if (!(passages[n - 1] as string).includes(comparable(match[2] as string))) {
      unsupported.push(`[${n}]`)
    }
  }
  if (unsupported.length > 0) {
    findings.push({
      code: 'citation_unsupported',
      detail: `quoted text not found in the cited passage: ${[...new Set(unsupported)].sort().join(', ')}`,
    })
  }

  // A citation carrying no quote is verified against nothing. Reported, because
  // otherwise a model that quietly stops quoting disables the check above and
  // every finding here keeps reading green.
  const unquoted = [...cited].filter((n) => allowed.has(n) && !quoted.has(n)).sort((a, b) => a - b)
  if (unquoted.length > 0) {
    findings.push({
      code: 'citation_unquoted',
      detail: `cited without an evidence span: ${unquoted.map((n) => `[${n}]`).join(', ')}`,
    })
  }

  // The answer reproducing the fence means the model is describing the prompt's
  // structure back to the caller, which is what a successful injection looks
  // like from out here.
  if (markerShaped(folded)) {
    findings.push({
      code: 'fence_echoed',
      detail: 'the answer reproduced an untrusted-content marker',
    })
  }

  if (folded.includes(SYSTEM_CANARY)) {
    findings.push({
      code: 'system_prompt_echoed',
      detail: 'the answer repeated part of the system prompt',
    })
  }

  const urls = findAll(MD_IMAGE, folded)
  if (urls.length > 0) {
    findings.push({
      code: 'markdown_image',
      detail: `answer embedded ${urls.length} image URL(s): ${urls[0]}`,
    })
  }
  const links = findAll(MD_LINK, folded)
  if (links.length > 0) {
    findings.push({
      code: 'markdown_link',
      detail: `answer embedded ${links.length} link URL(s): ${links[0]}`,
    })
  }

  return findings
}
