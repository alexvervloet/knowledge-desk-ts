-- Vector index for access-scoped retrieval.
--
-- Without this, every search sorts the org's entire chunk set: measured at 100k
-- chunks, p50 569ms and p95 2272ms, with the plan scanning all 100,000 rows.
--
-- HNSW rather than IVFFlat: it needs no training pass, so it stays correct as a
-- tenant's corpus grows from zero, which matters when every org starts empty.
-- vector_cosine_ops matches the `<=>` operator the search uses; an index built
-- for a different operator is simply ignored by the planner.
--
-- The subtlety is that our search is not a pure nearest-neighbor query: it also
-- filters by org_id and by the caller's ACL. An approximate index is consulted
-- before those filters, so a strict scan can return its candidates, lose most of
-- them to the ACL, and hand back fewer than k rows. pgvector 0.8's iterative
-- scan fixes exactly this by re-probing until it has enough surviving rows; it
-- is enabled per connection in db.py, since an index alone would silently
-- under-return for users with narrow permissions.
--
-- Runs last, after 0009 has denormalized the ACL onto chunks: the filter has to
-- sit on the same relation as the vector for the planner to use this index at
-- all, and backfilling that column is far cheaper before the graph exists.

create index chunks_embedding_hnsw
    on chunks using hnsw (embedding vector_cosine_ops);
