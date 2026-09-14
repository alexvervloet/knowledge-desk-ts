/**
 * A request body size limit, applied before the body is parsed.
 *
 * The upload route enforces per-org storage and document caps, but only after the
 * framework has read and validated the whole request into objects. The upload
 * schema permits 1000 documents of 1,000,000 characters, so the request that gets
 * rejected can be about a gigabyte, and a measured 60 MB payload against a 50 MB
 * cap still took peak RSS from 66 MB to 373 MB before returning its 413. On a
 * 512 MB machine, the rejection is the expensive part.
 *
 * Fastify has a `bodyLimit` option that does the Content-Length half of this
 * natively and, unlike the Python side's ASGI middleware, also counts a chunked
 * body as it streams. What it does not do is answer in this app's error shape, so
 * this module sets the limit and translates the framework's reply into the
 * `{detail}` body every other error here uses.
 */

import type { FastifyInstance } from 'fastify'

/** Fastify's code for a body past `bodyLimit`, whether declared or streamed. */
const TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE'

export function bodyLimit(app: FastifyInstance): void {
  app.addHook('onError', (_request, _reply, error, done) => {
    // Fastify answers 413 already; this only replaces the message, so a client
    // parsing `detail` gets the same field here as on every other failure.
    if ((error as { code?: string }).code === TOO_LARGE) {
      error.message = 'request body too large'
    }
    done()
  })
}

export { TOO_LARGE }
