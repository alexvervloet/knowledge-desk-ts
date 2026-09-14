/**
 * Retrieval: embed a query and fetch the nearest chunks the caller is allowed
 * to see. The access control lives in TenantScope.search; this module only turns
 * text into a query vector and hands it over. The assistant answers on top of
 * these results.
 */

import { getEmbedder } from './embeddings.ts'
import type { Context } from './providers.ts'
import type { TenantScope } from './tenancy.ts'

/**
 * Nearest chunks the caller may see, as passages rather than raw rows.
 *
 * The coercion lives here because this is where database rows become passages.
 * Every module downstream then reads `c.text` rather than `str(c.get("text"))`,
 * and a passage that arrives without one is a bug at this boundary rather than
 * eight silent empty strings further in.
 */
export async function search(scope: TenantScope, query: string, k = 5): Promise<Context[]> {
  const embedding = await getEmbedder().embedQuery(query)
  const rows = await scope.search(embedding, k)
  return rows.map((row) => ({
    ...row,
    path: asText(row.path),
    text: asText(row.text),
  }))
}

/**
 * A database value as text.
 *
 * `String(x)` on an unknown gives "[object Object]" for anything that is not a
 * scalar, which would put that literal string into a prompt and into a citation
 * check. These two columns are `text` in the schema and a driver that ever
 * returned something else is a bug worth seeing as an empty passage rather than
 * as a passage about Object.
 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
