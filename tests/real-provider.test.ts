/**
 * The one test that calls a real model.
 *
 * Every other eval and test here is deliberately model-independent, which the
 * README describes as what makes them trustworthy and also what they cannot tell
 * you. This is the gap that argument leaves: a system prompt the API declines
 * outright passes all of them, because none of them ever asks a model anything.
 *
 * That happened. `claude-opus-5` returned `stop_reason: refusal` with category
 * `reasoning_extraction` on this app's system prompt, every answer came back
 * empty, and the whole suite stayed green. See LESSONS.md.
 *
 * Skipped without a key, so the default suite is unchanged. Run it on its own,
 * before changing the system prompt or the answer model:
 *
 *     npm run test:real
 *
 * On its own deliberately. Several tests elsewhere assert mock-provider behaviour
 * and fail when a key is present (`healthz reports the mock provider` by name),
 * so `npm test` with a key in the environment is not a thing this suite supports.
 * That is also part of why a refusing model went unnoticed: there was no way to
 * run the suite against a real one.
 *
 * One call, a few hundred tokens, well under a cent.
 */

import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { settings } from '../src/config.ts'
import {
  SYSTEM_PROMPT,
  buildUserTurn,
  newFenceNonce,
  supportsEffort,
  type Context,
} from '../src/providers.ts'

const PASSAGE = 'Acme refunds are processed within five business days of the request.'

describe.skipIf(!settings.anthropicApiKey)('the real provider', () => {
  it('does not refuse this system prompt', async () => {
    const contexts: Context[] = [
      {
        document_id: 'd1',
        ordinal: 0,
        path: 'handbook.md',
        text: PASSAGE,
        distance: 0.4,
      },
    ]
    const turn = buildUserTurn('how long do refunds take', contexts, newFenceNonce())

    const client = new Anthropic({ apiKey: settings.anthropicApiKey })
    const stream = client.messages.stream({
      model: settings.answerModel,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: turn }],
      ...(supportsEffort(settings.answerModel)
        ? { output_config: { effort: 'low' as const } }
        : {}),
    })

    let text = ''
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    const final = await stream.finalMessage()

    const category = final.stop_details?.category ?? null
    expect(
      final.stop_reason,
      `${settings.answerModel} refused this system prompt (category: ${category}). ` +
        'Every answer this app produces will be empty. See LESSONS.md.',
    ).not.toBe('refusal')
    // Not just "was not refused": a model that answers but ignores the citation
    // format has also broken the output checks, and that is worth one assertion
    // while a real call is already being paid for.
    expect(text.toLowerCase()).toContain('five business days')
    expect(text).toContain('[1]')
  }, 120_000)
})
