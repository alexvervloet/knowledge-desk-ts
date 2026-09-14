/**
 * Retrieval: embed a query and fetch the nearest chunks the caller is allowed
 * to see. The access control lives in TenantScope.search; this module only turns
 * text into a query vector and hands it over. The assistant answers on top of
 * these results.
 */

import type { Row } from './db.ts'
import { getEmbedder } from './embeddings.ts'
import type { TenantScope } from './tenancy.ts'

export async function search(scope: TenantScope, query: string, k = 5): Promise<Row[]> {
  const embedding = await getEmbedder().embedQuery(query)
  return scope.search(embedding, k)
}
