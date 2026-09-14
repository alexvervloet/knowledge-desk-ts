/**
 * Request and response bodies for the HTTP API.
 *
 * Separated from the routes because this is where the trust boundary is drawn.
 * Every one of these schemas is the first thing an untrusted request meets, and
 * the bounds on them — how long a question may be, how many documents one upload
 * may carry, which roles are even nameable — are a policy worth reading in one
 * place rather than finding scattered between handlers.
 *
 * The bounds here are validation, not the whole story: they cap a single request,
 * while the per-tenant quotas in TenantScope cap the account, and the body limit
 * in bodylimit.ts refuses an oversized request before it is ever parsed into one
 * of these.
 */

import { z } from 'zod'
import * as normalize from './normalize.ts'

// Shared constraints, named once so the same rule cannot drift between two
// endpoints that mean the same thing by it.
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/)
const Password = z.string().min(8).max(200)
const Role = z.enum(['owner', 'admin', 'member'])
const Email = z.string().min(3).max(200)

/**
 * Reject control and invisible characters in a document path.
 *
 * A path is uploaded text and it is rendered into the answer prompt. The
 * renderer defuses grammar-shaped runs wherever they appear, but a newline needs
 * no marker to do damage, and an invisible character exists for no purpose here
 * except to make one string compare unequal to another that reads identically. A
 * real file path needs neither, so the cheapest place to settle it is here,
 * before the text is ever stored.
 */
const DocumentPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => ![...value].some((ch) => ch < ' ' || ch === '\x7f' || normalize.isInvisible(ch)),
    { message: 'must not contain control or invisible characters' },
  )

// --- auth -----------------------------------------------------------------

export const SignupRequest = z.object({
  org_slug: Slug,
  org_name: z.string().min(1).max(100),
  email: Email,
  password: Password,
})
export type SignupRequest = z.infer<typeof SignupRequest>

export const LoginRequest = z.object({
  email: Email,
  password: Password,
  org_slug: Slug.nullish(),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export interface TokenResponse {
  token: string
  org_id: string
  role: string
}

export const ChangePasswordRequest = z.object({
  current_password: Password,
  new_password: Password,
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>

// --- members and groups ---------------------------------------------------

export const AddMemberRequest = z.object({
  email: Email,
  password: Password,
  role: Role,
})
export type AddMemberRequest = z.infer<typeof AddMemberRequest>

export const SetRoleRequest = z.object({ role: Role })
export type SetRoleRequest = z.infer<typeof SetRoleRequest>

export const CreateGroupRequest = z.object({ name: z.string().min(1).max(100) })
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>

export const AddGroupMemberRequest = z.object({ email: Email })
export type AddGroupMemberRequest = z.infer<typeof AddGroupMemberRequest>

// --- sources and documents ------------------------------------------------

export const UploadedDocument = z.object({
  path: DocumentPath,
  content: z.string().max(1_000_000),
  acl: z.array(z.string()).nullish(),
})
export type UploadedDocument = z.infer<typeof UploadedDocument>

export const FolderUploadRequest = z.object({
  // 1000 documents of 1MB is far more than any single request should carry;
  // what actually stops one that large is the body limit, which refuses it
  // before it reaches this schema. These bounds are the backstop.
  documents: z.array(UploadedDocument).max(1000),
})
export type FolderUploadRequest = z.infer<typeof FolderUploadRequest>

export const UpdateAclRequest = z.object({ acl: z.array(z.string()).max(200) })
export type UpdateAclRequest = z.infer<typeof UpdateAclRequest>

// --- retrieval and the assistant ------------------------------------------

export const SearchRequest = z.object({
  query: z.string().min(1).max(500),
  k: z.number().int().min(1).max(50).default(5),
})
export type SearchRequest = z.infer<typeof SearchRequest>

export const AskRequest = z.object({
  question: z.string().min(1).max(500),
  k: z.number().int().min(1).max(50).nullish(),
})
export type AskRequest = z.infer<typeof AskRequest>

export const FeedbackRequest = z.object({
  answer_id: z.string(),
  rating: z.enum(['up', 'down']),
  note: z.string().max(2000).nullish(),
})
export type FeedbackRequest = z.infer<typeof FeedbackRequest>

// --- query strings --------------------------------------------------------

/**
 * The pagination query shared by every listing route.
 *
 * FastAPI coerces a query string to the declared type and 422s when it will not
 * fit; `z.coerce` is the same idea, and the app's schema error handler is what
 * makes the status match.
 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PageQuery = z.infer<typeof PageQuery>
