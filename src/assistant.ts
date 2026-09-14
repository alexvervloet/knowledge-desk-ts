/**
 * The assistant: retrieve within the caller's permissions, then stream a
 * grounded answer. If retrieval returns nothing the caller may see, it refuses
 * rather than answering from the model's own knowledge, so the access boundary
 * enforced in retrieval carries all the way through to the generated answer.
 *
 * `answerStream` yields events the API renders as SSE frames:
 *   {"type": "meta", "answer_id": ..., "provider": ...}
 *   {"type": "sources", "sources": [{document_id, ordinal, path}]}
 *   {"type": "token", "text": ...}          zero or more
 *   {"type": "done", "usage": {...}, "cost_usd": float, "warnings": [...]}
 *   {"type": "error", "message": ...}       on failure, instead of done
 */

import { randomBytes } from 'node:crypto'
import * as audit from './audit.ts'
import { settings } from './config.ts'
import * as outputchecks from './outputchecks.ts'
import { countDefused, getAnswerProvider, type Context } from './providers.ts'
import * as retrieval from './retrieval.ts'
import type { TenantScope } from './tenancy.ts'
import { AskTracer } from './tracing.ts'

export const REFUSAL =
  "I don't have anything I'm allowed to cite for that. Nothing in the" +
  ' documents you can access matches this question.'

export interface Source {
  document_id: string
  ordinal: number
  path: string
}

export type AskEvent =
  | { type: 'meta'; answer_id: string; provider: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | {
      type: 'done'
      usage: { input_tokens: number; output_tokens: number }
      cost_usd: number
      warnings: outputchecks.Finding[]
    }
  | { type: 'error'; message: string }

/**
 * Return a reason string if this org is over an operational limit, else null.
 * Checked before any model call so spend and volume are hard-capped.
 */
async function limitBlock(scope: TenantScope): Promise<string | null> {
  if ((await scope.spendLast24h()) >= settings.dailyBudgetUsd) return 'daily budget exhausted'
  if ((await scope.questionsThisMonth()) >= settings.monthlyQuestionCap) {
    return 'monthly question limit reached'
  }
  // The per-org caps above bound one tenant. They bound the bill only if tenants
  // are scarce, and signup is open, so this is the number that actually caps what
  // the deployment can spend in a day.
  if ((await scope.platformSpendToday()) >= settings.platformDailyBudgetUsd) {
    return 'service daily budget exhausted'
  }
  return null
}

export async function* answerStream(
  scope: TenantScope,
  question: string,
  k: number,
): AsyncGenerator<AskEvent, void, undefined> {
  // An async generator, and the early-close behaviour is part of the contract.
  // A caller that walks away mid-answer calls .return(), and the finally block
  // that runs is what books the tokens already spent.
  const provider = getAnswerProvider()
  const model = provider.name === 'claude' ? settings.answerModel : provider.name
  const tracer = new AskTracer(question, scope.orgId, scope.ctx.userId, provider.name, model)
  // The full failure detail, for the trace and the log. Not what the caller
  // sees: an unexpected exception carries whatever the failing layer put in it,
  // which for a database error is host names and role names.
  let traceError: string | null = null
  // Everything the finally block needs to bill a stream that does not finish.
  let answerId: string | null = null
  let contexts: Context[] = []
  const streamed: string[] = []
  let billed = false
  try {
    // Hard limits first: a blocked question is recorded but never reaches the model.
    const blockedReason = await limitBlock(scope)
    if (blockedReason !== null) {
      answerId = await scope.recordAnswer(question, provider.name, false)
      await scope.markBlocked(answerId)
      await audit.log(scope.orgId, scope.ctx.userId, 'question.blocked', {
        answer_id: answerId,
        reason: blockedReason,
      })
      yield { type: 'meta', answer_id: answerId, provider: provider.name }
      // Deliberately caller-facing: this one is a message we chose, telling the
      // asker exactly why they got nothing.
      traceError = `[LIMIT] request blocked: ${blockedReason}. No answer was generated.`
      yield { type: 'error', message: traceError }
      return
    }

    contexts = await retrieval.search(scope, question, k)
    const refused = contexts.length === 0
    answerId = await scope.recordAnswer(question, provider.name, refused)
    await audit.log(scope.orgId, scope.ctx.userId, 'question.asked', {
      answer_id: answerId,
      refused,
    })

    // Defusing a grammar forgery silently throws away the only interesting thing
    // about it. A corpus where this is nonzero and rising is a corpus somebody is
    // writing into, and nothing else in the system would say so.
    const forged = countDefused(contexts)
    if (forged) {
      await audit.log(scope.orgId, scope.ctx.userId, 'retrieval.grammar_defused', {
        answer_id: answerId,
        spans: forged,
      })
    }

    yield { type: 'meta', answer_id: answerId, provider: provider.name }

    if (refused) {
      for (const word of REFUSAL.split(' ')) {
        tracer.token(word + ' ')
        yield { type: 'token', text: word + ' ' }
      }
      yield {
        type: 'done',
        usage: { input_tokens: 0, output_tokens: 0 },
        cost_usd: 0.0,
        warnings: [],
      }
      return
    }

    const sources: Source[] = contexts.map((c) => ({
      document_id: String(c.document_id),
      ordinal: Number(c.ordinal),
      path: c.path,
    }))
    tracer.sources(sources, tracer.active ? await scope.retrievalStats() : null)
    yield { type: 'sources', sources }

    for await (const event of provider.stream(question, contexts)) {
      if (event.type === 'usage') {
        await scope.finalizeAnswer(
          answerId,
          event.inputTokens,
          event.outputTokens,
          event.costUsd,
        )
        billed = true
        tracer.done(event.inputTokens, event.outputTokens, event.costUsd)
        // The usage frame is last, so the answer is complete here. These are
        // detectors rather than a gate: the caller has already read the tokens.
        // They ride out in the done frame for the UI and land in the audit log,
        // where a pattern across answers is visible in a way one flagged answer
        // is not.
        const warnings = outputchecks.checkAnswer(streamed.join(''), contexts)
        if (warnings.length > 0) {
          await audit.log(scope.orgId, scope.ctx.userId, 'answer.flagged', {
            answer_id: answerId,
            codes: warnings.map((w) => w.code).join(','),
          })
        }
        yield {
          type: 'done',
          usage: { input_tokens: event.inputTokens, output_tokens: event.outputTokens },
          cost_usd: event.costUsd,
          warnings,
        }
      } else {
        streamed.push(event.text)
        tracer.token(event.text)
        yield event
      }
    }
  } catch (err) {
    // A provider failure must not 500 mid-stream.
    //
    // The exception message went straight into the frame the browser renders, so
    // a database failure handed the caller its host name and the role it was
    // connecting as. The detail goes to the log; the caller gets a reference that
    // ties their report back to it.
    const reference = randomBytes(4).toString('hex')
    console.error(
      `answer generation failed [ref=${reference}] org=${scope.orgId} user=${scope.ctx.userId}`,
      err,
    )
    traceError = `answer generation failed [ref=${reference}]: ${String(err)}`
    yield {
      type: 'error',
      message: `Answer generation failed. Quote reference ${reference} if you report this.`,
    }
  } finally {
    // A stream that never reaches its usage frame — the client disconnected, or
    // the provider failed part way — still cost real tokens, because the model
    // generated them before we stopped reading. Left unbilled, aborting each
    // request just before the end spends without ever touching the budget. Book
    // an estimate instead, flagged as such.
    //
    // Only when something was actually streamed: that is the evidence the model
    // ran at all, and it keeps a failure that happened before the first token
    // from inventing a charge.
    if (answerId !== null && !billed && streamed.length > 0) {
      const usage = provider.estimate(question, contexts, streamed.join(''))
      await scope.finalizeAnswer(
        answerId,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
        true,
      )
    }
    tracer.finish(traceError)
  }
}
