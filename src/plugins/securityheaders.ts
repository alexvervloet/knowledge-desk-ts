/**
 * Security response headers.
 *
 * The API serves the built SPA same-origin in production, so these headers land on
 * the document that holds the session token. The token lives in localStorage, which
 * is a reasonable choice for a bearer-token SPA and an unforgiving one: any script
 * that runs on the page can read it. Nothing in the UI renders user HTML today, so
 * there is no injection point to pair that with. This is the layer that keeps it
 * that way if one is ever added.
 *
 * The policy the app actually depends on is `script-src 'self'`: every script is a
 * built asset from our own origin, and the Vite build emits no inline script, so
 * nothing legitimate needs a nonce or a hash. `style-src` allows inline because the
 * components set `style={{...}}` attributes throughout; the CSP3 way to keep those
 * without opening `<style>` blocks is `style-src-attr`, which Firefox does not
 * support, and a policy that renders the app unstyled in one browser is a policy
 * someone will delete. Inline CSS is a far weaker vector than inline script, and it
 * is the whole of what is conceded here.
 */

import type { FastifyInstance } from 'fastify'

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // No plugins, no <base> rewriting, no framing, no cross-origin form posts.
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

export const HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  // frame-ancestors above already covers this for anything current; kept for
  // browsers that read only the older header.
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // Browsers ignore HSTS over plain http, so this is inert in local dev and
  // active behind a TLS-terminating proxy.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

/**
 * The Python side exempts FastAPI's /docs and /redoc from the CSP, because
 * Swagger UI loads from a CDN that `script-src 'self'` blocks. Fastify ships no
 * such page, so there is nothing to exempt and the policy applies everywhere.
 */
export function securityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(HEADERS)) {
      // Only if unset: a route that has deliberately set its own is making a
      // decision this hook should not overrule.
      if (reply.getHeader(name) === undefined) reply.header(name, value)
    }
    done(null, payload)
  })
}
