/**
 * Pricing and per-model request shape.
 *
 * The rates are not display values: `finalizeAnswer` stores what `cost` returns,
 * and the per-org rolling budget and the platform daily cap are both summed from
 * that column.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../src/config.ts'
import {
  AnswerRefused,
  ClaudeAnswerProvider,
  PRICING,
  SUPPORTS_EFFORT,
  UNPRICED,
  cost,
  supportsEffort,
} from '../src/providers.ts'

const MILLION = 1_000_000

afterEach(() => {
  vi.restoreAllMocks()
})

/** Capture what the module warns about, since these paths log rather than throw. */
function captureWarnings(): () => string {
  const lines: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  return () => lines.join('\n')
}

describe('pricing', () => {
  /**
   * Sonnet was priced 50% high here, which quietly shrank every Sonnet org's
   * effective budget by a third.
   */
  it('bills each priced model at its own rate', () => {
    expect(cost('claude-opus-5', MILLION, 0)).toBe(5.0)
    expect(cost('claude-sonnet-5', MILLION, 0)).toBe(2.0)
    expect(cost('claude-haiku-4-5', MILLION, 0)).toBe(1.0)
    expect(cost('claude-haiku-4-5', 0, MILLION)).toBe(5.0)
  })

  /**
   * It used to fall back to Opus silently, so an unlisted model produced numbers
   * that looked right and were not, in whichever direction the real price
   * happened to lie.
   */
  it('bills an unpriced model at the dearest rate and says so', () => {
    const warnings = captureWarnings()
    expect(cost('claude-not-a-model', MILLION, 0)).toBe(UNPRICED[0])
    expect(warnings()).toContain('no price for model')
    expect(warnings()).toContain('claude-not-a-model')
  })

  /**
   * Over-counting stops a customer early, which they can ask about.
   * Under-counting spends money they never agreed to.
   */
  it('never makes the unpriced rate cheaper than a priced one', () => {
    for (const [input, output] of Object.values(PRICING)) {
      expect(input).toBeLessThanOrEqual(UNPRICED[0])
      expect(output).toBeLessThanOrEqual(UNPRICED[1])
    }
  })
})

// --- request shape ---------------------------------------------------------

describe('request shape', () => {
  /**
   * Haiku 4.5 returns 400 "This model does not support the effort parameter", so
   * sending it unconditionally meant answerModel could not actually be set to
   * Haiku: every answer failed.
   */
  it('sends effort only to models that accept it', () => {
    expect(supportsEffort('claude-opus-5')).toBe(true)
    expect(supportsEffort('claude-sonnet-5')).toBe(true)
    expect(supportsEffort('claude-haiku-4-5')).toBe(false)
  })

  /**
   * Omitting it costs some tuning. Sending it where it is rejected costs every
   * answer, so the unknown case takes the survivable failure.
   */
  it('omits effort for an unrecorded model and says so', () => {
    const warnings = captureWarnings()
    expect(supportsEffort('claude-not-a-model')).toBe(false)
    expect(warnings()).toContain('no effort capability recorded')
    expect(warnings()).toContain('claude-not-a-model')
  })

  /**
   * The two tables are edited together or they drift, and the drift is only
   * visible when somebody switches models.
   */
  it('gives every priced model an effort capability', () => {
    expect(new Set(Object.keys(PRICING))).toEqual(new Set(Object.keys(SUPPORTS_EFFORT)))
  })
})

// --- refusals --------------------------------------------------------------

/**
 * `claude-opus-5` returns stop_reason "refusal" with category
 * "reasoning_extraction" on this app's system prompt, so every answer comes back
 * empty. Sonnet 5, Haiku 4.5 and Opus 4.8 answer the identical prompt.
 *
 * This is a reminder rather than a proof: it cannot detect the day another model
 * starts refusing. tests/real-provider.test.ts is the one that can, and it only
 * runs when a key is present.
 */
it('defaults to an answer model that does not refuse this prompt', () => {
  expect(
    settings.answerModel,
    'claude-opus-5 refuses this system prompt outright; see LESSONS.md',
  ).not.toBe('claude-opus-5')
})

/**
 * A declined request is HTTP 200 with no content. Left alone it reaches the
 * caller as an assistant with nothing to say, which is indistinguishable from an
 * honest refusal to cite and invisible to every mock-provider test.
 */
it('raises on a refusal instead of streaming nothing', async () => {
  const refused = {
    stop_reason: 'refusal',
    stop_details: { category: 'reasoning_extraction' },
    usage: { input_tokens: 1905, output_tokens: 0 },
  }
  const fakeStream = {
    // The SDK's stream is async-iterable over events and exposes finalMessage().
    [Symbol.asyncIterator]: async function* () {
      // A refused request yields no content blocks at all.
    },
    finalMessage: () => Promise.resolve(refused),
  }

  // Reach past the constructor the way the Python test does, so no network
  // client is built and no key is needed.
  const provider = Object.create(ClaudeAnswerProvider.prototype) as ClaudeAnswerProvider
  Object.assign(provider, {
    model: 'claude-sonnet-5',
    client: { messages: { stream: () => fakeStream } },
  })

  const drain = async () => {
    for await (const _ of provider.stream('anything', [])) {
      // consume
    }
  }
  await expect(drain()).rejects.toThrow(/reasoning_extraction/)
  await expect(drain()).rejects.toBeInstanceOf(AnswerRefused)
})
