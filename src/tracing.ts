/**
 * Langfuse tracing, enabled only when LANGFUSE_* keys are configured.
 *
 * One trace per question, tagged by org and user: a root span, a retriever child
 * that records how many chunks the org has versus how many this user is allowed to
 * see (so the ACL filter is visible in the trace), and the answer typed as a
 * generation carrying token and cost estimates.
 *
 * Keyless (dev, CI, mock mode) every call here is a no-op. Observability must never
 * take the product down, so every method is exception-proof: a Langfuse failure
 * degrades to a log line, never an error in the request.
 *
 * Everything that leaves for Langfuse is redacted first. The question and answer
 * are stored unredacted in Postgres on purpose (see TenantScope.recordAnswer),
 * and that argument rests on two things: a question is content rather than
 * metadata, and anyone who can read it is already an admin of the asker's own org.
 * Neither survives the trip to a third-party service, so the redaction happens
 * here, at the edge that crosses it.
 *
 * Three things differ from tracing.py, and all three are the JavaScript SDK being
 * a different SDK rather than choices:
 *
 * 1. Tracing runs on OpenTelemetry. `startObservation` writes to an OTel tracer,
 *    and with no registered span processor the spans go nowhere, so `init` has to
 *    stand up a NodeSDK. Python's client needs no such thing.
 * 2. The environment variable is `LANGFUSE_BASE_URL`. `LANGFUSE_HOST`, which the
 *    Python SDK reads, is silently ignored here — set it and you ship traces to
 *    cloud.langfuse.com without being told.
 * 3. There is no `auth_check()`. Fetching the project is the same request Python's
 *    check makes, so that is what `init` does. The health endpoint is not a
 *    substitute: it answers OK for bogus credentials.
 */

import type { LangfuseGeneration, LangfuseSpan } from '@langfuse/tracing'
import * as pii from './pii.ts'

let enabled = false
let flush: (() => Promise<void>) | null = null

/**
 * How a root observation gets made. Written by `init` on success, and by tests.
 *
 * The seam is explicit because there is no other way to get one. Python's tests
 * monkeypatch the module's `_client`; a `let` binding in an ES module cannot be
 * reached from outside, so the module has to offer the door rather than have one
 * picked. Narrow on purpose: a test can stand in for the SDK's entry point and
 * nothing else, and every span the tracer opens still goes through the same code
 * the real SDK does.
 */
type StartObservation = (name: string, attributes?: Record<string, unknown>) => LangfuseSpan

let startObservation: StartObservation | null = null

/**
 * Install a stand-in for the SDK's root-span factory. Exported for tests; `init`
 * is what calls it in a running process. Passing null turns tracing back off.
 */
export function setStartObservation(fn: StartObservation | null): void {
  startObservation = fn
  enabled = fn !== null
}

/**
 * Stand up the tracer if keys are configured. Safe to call more than once.
 *
 * Registration is gated on the keys being present rather than left to fail later.
 * A span processor built without credentials still POSTs to the default cloud URL
 * on flush and rejects with a 401, and an unhandled rejection from a background
 * flush is how observability takes down the thing it was watching.
 */
export function init(): void {
  if (enabled) return
  if (!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)) {
    console.info('langfuse: no keys configured, tracing disabled')
    return
  }
  // Deferred so a keyless process never loads the SDK at all.
  void (async () => {
    try {
      const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }] =
        await Promise.all([
          import('@opentelemetry/sdk-node'),
          import('@langfuse/otel'),
          import('@langfuse/tracing'),
          import('@langfuse/client'),
        ])

      // The JS SDK has no auth_check(). Fetching the project is the request the
      // Python one makes, and it is the one that actually rejects bad keys.
      try {
        await new LangfuseClient().api.projects.get()
      } catch {
        console.error('langfuse: credentials rejected, tracing disabled')
        return
      }

      const processor = new LangfuseSpanProcessor()
      const sdk = new NodeSDK({ spanProcessors: [processor] })
      sdk.start()
      flush = async () => {
        await processor.forceFlush()
      }
      setStartObservation(tracing.startObservation as unknown as StartObservation)
      console.info('langfuse: tracing enabled')
    } catch (err) {
      console.error('langfuse: init failed, tracing disabled', err)
    }
  })()
}

/** Flush pending spans. Called on shutdown; a no-op when tracing is off. */
export async function shutdown(): Promise<void> {
  if (flush === null) return
  try {
    await flush()
  } catch (err) {
    console.error('langfuse: flush failed', err)
  }
}

/**
 * Redact PII from a string on its way out to the tracer.
 *
 * Fails closed: if redaction itself raises, the text is dropped rather than sent.
 * That is the one place this module does not simply degrade to a log line,
 * because the failure mode it is guarding is disclosure.
 */
function scrub(text: string): string {
  try {
    return pii.redact(text)
  } catch (err) {
    console.error('langfuse: redaction failed', err)
    return '[REDACTION FAILED]'
  }
}

/**
 * One retrieved source as the trace records it. Structurally the assistant's
 * `Source`, named here so this module does not import from the one that calls it.
 */
export interface TracedSource {
  document_id: string
  ordinal: number
  path: string
}

/** Document paths are uploaded text and routinely name people. */
function scrubSources(sources: TracedSource[]): TracedSource[] {
  return sources.map((s) => ({ ...s, path: scrub(s.path) }))
}

/**
 * Collects one question's trace. Every method is exception-proof, and all are
 * no-ops when Langfuse is not configured.
 */
export class AskTracer {
  private root: LangfuseSpan | null = null
  private retrieval: LangfuseSpan | null = null
  private gen: LangfuseGeneration | null = null
  private readonly answer: string[] = []
  private readonly question: string
  private readonly model: string

  constructor(question: string, orgId: string, userId: string, providerName: string, model: string) {
    this.question = scrub(question)
    this.model = model
    if (!enabled || startObservation === null) return
    try {
      // The user is tagged by id, not by address: userId is what ties a trace
      // back to a person here, and an email is the one field in this payload
      // that identifies one on its own.
      this.root = startObservation('ask', {
        input: this.question,
        metadata: { org_id: orgId, user_id: userId, provider: providerName },
      })
      this.retrieval = this.root.startObservation(
        'retrieval',
        { input: this.question },
        { asType: 'retriever' },
      )
    } catch (err) {
      console.error('langfuse: trace start failed', err)
      this.root = null
    }
  }

  get active(): boolean {
    return this.root !== null
  }

  /**
   * End the retriever span with the chosen sources and the ACL-filter counts,
   * then open the generation span.
   */
  sources(
    sources: TracedSource[],
    stats: { orgChunks: number; allowedChunks: number } | null,
  ): void {
    if (this.root === null) return
    try {
      if (this.retrieval !== null) {
        this.retrieval.update({
          output: { sources: scrubSources(sources), acl: stats ?? {} },
        })
        this.retrieval.end()
        this.retrieval = null
      }
      this.gen = this.root.startObservation(
        'answer',
        { model: this.model, input: this.question },
        { asType: 'generation' },
      )
    } catch (err) {
      console.error('langfuse: sources recording failed', err)
    }
  }

  token(text: string): void {
    this.answer.push(text)
  }

  done(inputTokens: number, outputTokens: number, costUsd: number): void {
    if (this.root === null || this.gen === null) return
    try {
      // Redacted at the join, not per token: a pattern that straddles two
      // streamed tokens is invisible to either one on its own.
      this.gen.update({
        output: scrub(this.answer.join('')),
        usageDetails: { input: inputTokens, output: outputTokens },
        costDetails: { total: costUsd },
      })
    } catch (err) {
      console.error('langfuse: done recording failed', err)
    }
  }

  finish(error: string | null = null): void {
    if (this.root === null) return
    try {
      if (this.retrieval !== null) this.retrieval.end()
      if (this.gen !== null) this.gen.end()
      const output = error ?? scrub(this.answer.join(''))
      this.root.setTraceIO({ input: this.question, output })
      if (error !== null) {
        this.root.update({ level: 'ERROR', statusMessage: error, output: error })
      } else {
        this.root.update({ output })
      }
      this.root.end()
    } catch (err) {
      console.error('langfuse: trace finish failed', err)
    }
  }
}
