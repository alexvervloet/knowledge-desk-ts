/**
 * The Fastify application: the whole HTTP surface.
 *
 * Accounts and sessions, org membership and groups, document sync and listing,
 * access-scoped search, the streaming assistant, and the admin views (audit and
 * usage).
 *
 * Two rules hold across every route here, and both are enforced elsewhere on
 * purpose. Every org-scoped route acts through a TenantScope, which is the one
 * place tenant isolation lives, so a query that forgets its org is a bug with a
 * single address. And role checks belong to that scope rather than to these
 * handlers, so a route added later cannot skip one by forgetting to ask; the
 * exception is `DELETE /org`, which is an account operation rather than a scoped
 * one, and says so where it sits.
 *
 * Request and response bodies live in schemas.ts, so what this file shows is the
 * shape of the API: one function per endpoint, and what each of them is allowed
 * to do.
 */

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import * as accounts from './accounts.ts'
import * as assistant from './assistant.ts'
import * as audit from './audit.ts'
import { hashToken } from './auth.ts'
import { settings } from './config.ts'
import {
  authRateLimit,
  currentScope,
  parse,
  registerErrorHandlers,
  requireToken,
} from './deps.ts'
import { bodyLimit } from './plugins/bodylimit.ts'
import { HEADERS as SECURITY_HEADERS, securityHeaders } from './plugins/securityheaders.ts'
import { limiter } from './ratelimit.ts'
import * as retrieval from './retrieval.ts'
import {
  AddGroupMemberRequest,
  AddMemberRequest,
  AskRequest,
  ChangePasswordRequest,
  CreateGroupRequest,
  FeedbackRequest,
  FolderUploadRequest,
  LoginRequest,
  PageQuery,
  SearchRequest,
  SetRoleRequest,
  SignupRequest,
  UpdateAclRequest,
  type TokenResponse,
} from './schemas.ts'
import * as tracing from './tracing.ts'

export const VERSION = '0.0.1'

export const LOCAL_FOLDER_SOURCE = 'local-folder'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // The org caps in the upload route are the policy; this only keeps enforcing
    // them from costing what it would cost to parse the request first.
    bodyLimit: settings.maxRequestBytes,
    logger: false,
    // The SPA is served same-origin in production, so an unknown route should
    // fall through to index.html rather than being rewritten.
    ignoreTrailingSlash: false,
  })

  registerErrorHandlers(app)
  bodyLimit(app)
  tracing.init() // enables Langfuse only if LANGFUSE_* keys are set; no-op otherwise

  // Applies to the SPA as well as the API: in production the built UI is served
  // same-origin from here, so this is what constrains the page holding the
  // session token. Registered before CORS so it also covers a preflight reply.
  securityHeaders(app)

  await app.register(cors, {
    origin: settings.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*'],
    // The SPA reads the paging total from a response header, which a browser
    // hides on cross-origin replies unless it is exposed. Same-origin in prod,
    // cross-origin against the dev server.
    exposedHeaders: ['X-Total-Count'],
  })

  // --- health ---------------------------------------------------------------

  app.get('/healthz', () => ({
    status: 'ok',
    version: VERSION,
    provider: settings.provider,
  }))

  // --- auth -----------------------------------------------------------------

  app.post('/auth/signup', { preHandler: authRateLimit }, async (request, reply) => {
    const req = await parse(SignupRequest, request.body, reply)
    if (req === undefined) return reply
    const ctx = await accounts.createOrgWithOwner(
      req.org_slug,
      req.org_name,
      req.email,
      req.password,
    )
    const token = await accounts.createSession(ctx)
    await audit.log(ctx.orgId, ctx.userId, 'org.created', { slug: req.org_slug })
    const body: TokenResponse = { token, org_id: ctx.orgId, role: ctx.role }
    return reply.code(201).send(body)
  })

  app.post('/auth/login', { preHandler: authRateLimit }, async (request, reply) => {
    const req = await parse(LoginRequest, request.body, reply)
    if (req === undefined) return reply
    const ctx = await accounts.authenticate(req.email, req.password, req.org_slug)
    const token = await accounts.createSession(ctx)
    await audit.log(ctx.orgId, ctx.userId, 'user.login', {})
    const body: TokenResponse = { token, org_id: ctx.orgId, role: ctx.role }
    return reply.send(body)
  })

  app.post('/auth/logout', { preHandler: requireToken }, async (request, reply) => {
    await accounts.deleteSession(request.token)
    return reply.code(204).send()
  })

  app.get('/me', { preHandler: currentScope }, (request) => ({
    user_id: request.ctx.userId,
    email: request.ctx.email,
    org_id: request.ctx.orgId,
    role: request.ctx.role,
  }))

  /**
   * Change your own password. Throttled like the other credential routes,
   * because it verifies one. Revokes the caller's other sessions and keeps the
   * one making the request.
   */
  app.post(
    '/me/password',
    { preHandler: [currentScope, authRateLimit] },
    async (request, reply) => {
      const req = await parse(ChangePasswordRequest, request.body, reply)
      if (req === undefined) return reply
      if (req.new_password === req.current_password) {
        return reply.code(400).send({ detail: 'new password must differ' })
      }
      const revoked = await accounts.changePassword(
        request.ctx.userId,
        req.current_password,
        req.new_password,
        hashToken(request.token),
      )
      await audit.log(request.ctx.orgId, request.ctx.userId, 'user.password_changed', {
        sessions_revoked: revoked,
      })
      return reply.code(204).send()
    },
  )

  // --- members --------------------------------------------------------------

  app.post('/members', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(AddMemberRequest, request.body, reply)
    if (req === undefined) return reply
    const { scope } = request
    scope.requireCanGrant(req.role)
    const userId = await accounts.addMember(scope.orgId, req.email, req.password, req.role)
    await audit.log(scope.orgId, scope.ctx.userId, 'member.added', {
      user_id: userId,
      role: req.role,
    })
    return reply.code(201).send({ user_id: userId })
  })

  app.get('/members', { preHandler: currentScope }, async (request, reply) => {
    const page = await parse(PageQuery, request.query, reply)
    if (page === undefined) return reply
    const { scope } = request
    reply.header('X-Total-Count', String(await scope.countMembers()))
    return reply.send(await scope.listMembers(page.limit, page.offset))
  })

  app.patch<{ Params: { user_id: string } }>(
    '/members/:user_id',
    { preHandler: currentScope },
    async (request, reply) => {
      const req = await parse(SetRoleRequest, request.body, reply)
      if (req === undefined) return reply
      const { scope } = request
      const userId = request.params.user_id
      await scope.setMemberRole(userId, req.role)
      await audit.log(scope.orgId, scope.ctx.userId, 'member.role_changed', {
        user_id: userId,
        role: req.role,
      })
      return reply.send({ user_id: userId, role: req.role })
    },
  )

  app.delete<{ Params: { user_id: string } }>(
    '/members/:user_id',
    { preHandler: currentScope },
    async (request, reply) => {
      const { scope } = request
      const userId = request.params.user_id
      await scope.removeMember(userId)
      await audit.log(scope.orgId, scope.ctx.userId, 'member.removed', { user_id: userId })
      return reply.code(204).send()
    },
  )

  // --- groups ---------------------------------------------------------------

  app.post('/groups', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(CreateGroupRequest, request.body, reply)
    if (req === undefined) return reply
    return reply.code(201).send(await request.scope.createGroup(req.name))
  })

  app.get('/groups', { preHandler: currentScope }, (request) => request.scope.listGroups())

  app.get<{ Params: { group_id: string } }>(
    '/groups/:group_id',
    { preHandler: currentScope },
    (request) => request.scope.getGroup(request.params.group_id),
  )

  app.delete<{ Params: { group_id: string } }>(
    '/groups/:group_id',
    { preHandler: currentScope },
    async (request, reply) => {
      await request.scope.deleteGroup(request.params.group_id)
      return reply.code(204).send()
    },
  )

  app.get<{ Params: { group_id: string } }>(
    '/groups/:group_id/members',
    { preHandler: currentScope },
    (request) => request.scope.listGroupMembers(request.params.group_id),
  )

  app.post<{ Params: { group_id: string } }>(
    '/groups/:group_id/members',
    { preHandler: currentScope },
    async (request, reply) => {
      const req = await parse(AddGroupMemberRequest, request.body, reply)
      if (req === undefined) return reply
      const groupId = request.params.group_id
      const userId = await request.scope.addGroupMemberByEmail(groupId, req.email)
      return reply.code(201).send({ group_id: groupId, user_id: userId })
    },
  )

  app.delete<{ Params: { group_id: string; user_id: string } }>(
    '/groups/:group_id/members/:user_id',
    { preHandler: currentScope },
    async (request, reply) => {
      await request.scope.removeGroupMember(request.params.group_id, request.params.user_id)
      return reply.code(204).send()
    },
  )

  // --- sources and documents ------------------------------------------------

  /**
   * Reconcile an org's local-folder documents and enqueue ingest jobs for the
   * ones that changed. Returns immediately (202); the worker does the embedding.
   */
  app.post('/sources/folder', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(FolderUploadRequest, request.body, reply)
    if (req === undefined) return reply
    const { scope } = request
    const result = await scope.syncSource(LOCAL_FOLDER_SOURCE, req.documents)
    await audit.log(scope.orgId, scope.ctx.userId, 'source.synced', { ...result })
    return reply.code(202).send(result)
  })

  app.get('/documents', { preHandler: currentScope }, async (request, reply) => {
    const page = await parse(PageQuery, request.query, reply)
    if (page === undefined) return reply
    const { scope } = request
    reply.header('X-Total-Count', String(await scope.countDocuments()))
    return reply.send(await scope.listDocuments(page.limit, page.offset))
  })

  /**
   * One document's text, if the caller is permitted to read it.
   *
   * The ACL filter is part of the fetch, so this cannot return content the caller
   * may not see. A document that exists but is out of scope is a 404, the same as
   * one that does not exist, so an id cannot be used to test for existence.
   */
  app.get<{ Params: { document_id: string } }>(
    '/documents/:document_id',
    { preHandler: currentScope },
    (request) => request.scope.getDocument(request.params.document_id),
  )

  app.delete<{ Params: { document_id: string } }>(
    '/documents/:document_id',
    { preHandler: currentScope },
    async (request, reply) => {
      const { scope } = request
      const documentId = request.params.document_id
      await scope.deleteDocument(documentId)
      await audit.log(scope.orgId, scope.ctx.userId, 'document.deleted', {
        document_id: documentId,
      })
      return reply.code(204).send()
    },
  )

  app.patch<{ Params: { document_id: string } }>(
    '/documents/:document_id/acl',
    { preHandler: currentScope },
    async (request, reply) => {
      const req = await parse(UpdateAclRequest, request.body, reply)
      if (req === undefined) return reply
      const { scope } = request
      const documentId = request.params.document_id
      await scope.updateDocumentAcl(documentId, req.acl)
      await audit.log(scope.orgId, scope.ctx.userId, 'document.acl_changed', {
        document_id: documentId,
      })
      return reply.send({ document_id: documentId, acl: req.acl })
    },
  )

  // --- tenant retention -----------------------------------------------------

  app.get('/org/export', { preHandler: currentScope }, (request) => request.scope.export())

  /**
   * Delete the whole tenant. Owner only, and irreversible: cascades to every
   * org-scoped table.
   */
  app.delete('/org', { preHandler: currentScope }, async (request, reply) => {
    request.scope.requireRole('owner') // only gate not in the scope: deleting an org
    await accounts.deleteOrg(request.scope.orgId) // is an account operation, not a scoped one
    return reply.code(204).send()
  })

  // --- retrieval ------------------------------------------------------------

  /**
   * Nearest chunks the caller is permitted to see. Access filtering happens in
   * the candidate fetch, so results can only ever contain allowed content.
   */
  app.post('/search', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(SearchRequest, request.body, reply)
    if (req === undefined) return reply
    return reply.send(await retrieval.search(request.scope, req.query, req.k))
  })

  // --- assistant ------------------------------------------------------------

  /**
   * Stream a grounded, access-scoped answer as SSE. Each event is one
   * `data: {json}` frame: meta, sources, token(s), then done (or error).
   *
   * A per-user rate limit is enforced up front as a 429; the per-org budget and
   * question caps are enforced inside the stream as a loud limit frame (see the
   * assistant), so the client always gets a clear signal rather than silence.
   */
  app.post('/ask', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(AskRequest, request.body, reply)
    if (req === undefined) return reply
    const { scope } = request

    const [allowed, retryAfter] = limiter.check(scope.ctx.userId)
    if (!allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(Math.floor(retryAfter) + 1))
        .send({ detail: 'rate limit exceeded' })
    }

    const k = req.k ?? settings.retrievalK
    const frames = assistant.answerStream(scope, req.question, k)

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Fastify's onSend hook does not run for a raw write, so the security
      // headers are set here too, from the same object the hook uses. A streamed
      // answer is a response like any other.
      ...SECURITY_HEADERS,
    })

    // A client that walks away mid-answer has to reach the generator's finally
    // block, which is what books the tokens already spent. Without this the
    // generator is suspended at a yield nobody will ever pull from again, and the
    // answer is never billed.
    let closed = false
    reply.raw.on('close', () => {
      closed = true
      void frames.return(undefined)
    })

    try {
      for await (const event of frames) {
        if (closed) break
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      }
    } finally {
      if (!closed) reply.raw.end()
    }
    return reply
  })

  // --- audit ----------------------------------------------------------------

  /** Recent audit events for the caller's org. Admin only. */
  app.get('/audit', { preHandler: currentScope }, async (request, reply) => {
    const page = await parse(PageQuery, request.query, reply)
    if (page === undefined) return reply
    const { scope } = request
    reply.header('X-Total-Count', String(await scope.countAudit()))
    return reply.send(await scope.listAudit(page.limit, page.offset))
  })

  /** Org usage against its caps, for the admin dashboard. Admin only. */
  app.get('/usage', { preHandler: currentScope }, (request) => request.scope.usageSummary())

  app.post('/feedback', { preHandler: currentScope }, async (request, reply) => {
    const req = await parse(FeedbackRequest, request.body, reply)
    if (req === undefined) return reply
    await request.scope.addFeedback(req.answer_id, req.rating, req.note ?? null)
    return reply.code(201).send({ answer_id: req.answer_id, rating: req.rating })
  })

  // --- static SPA (production) ----------------------------------------------
  //
  // Registered last so it never shadows an API route: unmatched paths fall
  // through to the built frontend. Off unless SERVE_STATIC=1 and the build
  // exists, so dev and tests do not depend on a compiled UI.
  if (settings.serveStatic) {
    const { existsSync } = await import('node:fs')
    if (existsSync(settings.staticDir)) {
      const fastifyStatic = (await import('@fastify/static')).default
      const { resolve } = await import('node:path')
      await app.register(fastifyStatic, { root: resolve(settings.staticDir) })
      app.setNotFoundHandler(async (request, reply) => {
        // An unmatched API path is still a 404; anything else is a client route
        // the SPA owns.
        if (request.method !== 'GET') return reply.code(404).send({ detail: 'not found' })
        return reply.sendFile('index.html')
      })
    }
  }

  return app
}
