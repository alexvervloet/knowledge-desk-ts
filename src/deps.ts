/**
 * Fastify wiring: pull the bearer token, resolve it to an acting context, and
 * hand routes a ready TenantScope. Domain errors are mapped to HTTP codes here so
 * route handlers can just throw them.
 *
 * FastAPI expresses this with Depends() in each signature. Fastify expresses it
 * with hooks a route opts into by listing them in `preHandler`, which is the same
 * bargain: the gate is declared at the route rather than remembered inside it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError, type ZodType } from 'zod'
import * as accounts from './accounts.ts'
import { settings } from './config.ts'
import {
  AuthError,
  Conflict,
  DomainError,
  Forbidden,
  NotFound,
  QuotaExceeded,
} from './errors.ts'
import { authLimiter } from './ratelimit.ts'
import { TenantScope, type AuthContext } from './tenancy.ts'

declare module 'fastify' {
  interface FastifyRequest {
    ctx: AuthContext
    scope: TenantScope
    token: string
  }
}

/**
 * Identify an unauthenticated caller for rate limiting.
 *
 * There is no user id yet on the auth routes, so the caller's address is the only
 * handle available. Behind a proxy the socket peer is the proxy, which would put
 * every user in one bucket, so a configured header wins when present.
 */
export function clientKey(request: FastifyRequest): string {
  const header = settings.clientIpHeader
  if (header) {
    const value = request.headers[header.toLowerCase()]
    const first = Array.isArray(value) ? value[0] : value
    if (first) return first.split(',')[0]!.trim()
  }
  return request.ip || 'unknown'
}

/**
 * Throttle the unauthenticated auth routes per caller address.
 *
 * Without this, `/auth/login` takes password guesses as fast as they arrive, and
 * each one costs a bcrypt verification, so the same requests are both a
 * brute-force channel and a way to spend someone else's CPU.
 */
export function authRateLimit(request: FastifyRequest, reply: FastifyReply): void {
  const [allowed, retryAfter] = authLimiter.check(
    clientKey(request),
    settings.authRateBurst,
    settings.authRatePerMin,
  )
  if (!allowed) {
    void reply
      .code(429)
      .header('Retry-After', String(Math.floor(retryAfter) + 1))
      .send({ detail: 'too many attempts' })
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null
  return header.slice(7).trim()
}

/** Require a bearer token, without resolving it. Used by logout. */
export async function requireToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(request)
  if (token === null) {
    await reply.code(401).send({ detail: 'missing bearer token' })
    return
  }
  request.token = token
}

/** Resolve the bearer token into an acting context, and a scope built from it. */
export async function currentScope(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(request)
  if (token === null) {
    await reply.code(401).send({ detail: 'missing bearer token' })
    return
  }
  const ctx = await accounts.resolveSession(token)
  if (ctx === null) {
    await reply.code(401).send({ detail: 'invalid or expired session' })
    return
  }
  request.token = token
  request.ctx = ctx
  request.scope = new TenantScope(ctx)
}

const STATUS: Array<[new (m: string) => DomainError, number]> = [
  [AuthError, 401],
  [Forbidden, 403],
  [NotFound, 404],
  [Conflict, 409],
  [QuotaExceeded, 413],
]

/**
 * Validate `body` against `schema` or answer 422.
 *
 * Fastify's own schema validation is JSON Schema and answers 400. The Python side
 * is pydantic and answers 422, and three test files assert that number, so
 * validation runs here instead: one helper, called at the top of each route that
 * takes a body.
 */
export async function parse<T>(
  schema: ZodType<T>,
  value: unknown,
  reply: FastifyReply,
): Promise<T | undefined> {
  const result = schema.safeParse(value)
  if (!result.success) {
    await reply.code(422).send({ detail: formatIssues(result.error) })
    return undefined
  }
  return result.data
}

/**
 * Read one field off a value of unknown shape.
 *
 * Fastify's error handler types its argument as unknown, and the two fields this
 * module wants off it are conventions rather than a contract. Reflect.get reads
 * them without asserting the whole object into a shape it was never checked to
 * have.
 */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Reflect.get(value, key)
}

function numberField(value: unknown, key: string): number | undefined {
  const found = field(value, key)
  return typeof found === 'number' ? found : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof DomainError) {
      const match = STATUS.find(([type]) => error instanceof type)
      await reply.code(match?.[1] ?? 400).send({ detail: error.message })
      return
    }
    // Fastify's own errors carry a statusCode; anything else is a real 500 and
    // its message stays in the log rather than going to the caller.
    const statusCode = numberField(error, 'statusCode')
    if (statusCode !== undefined && statusCode < 500) {
      await reply.code(statusCode).send({ detail: stringField(error, 'message') ?? 'request failed' })
      return
    }
    request.log.error(error)
    await reply.code(500).send({ detail: 'internal server error' })
  })

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ detail: 'not found' })
  })
}
