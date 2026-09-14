-- Denormalize the document ACL onto chunks so filtered vector search can use
-- the HNSW index.
--
-- Measured cause: with the ACL filter on the joined documents table
-- (`d.acl ?| principals`), the planner cannot stream ordered rows out of the
-- HNSW index, because the filter that decides which rows survive lives on a
-- different relation. It falls back to scanning and sorting the whole corpus.
-- Isolating the predicates showed the join itself, the org_id filter, and the
-- status filter all keep the index; only the cross-table ACL check breaks it.
--
-- Putting the ACL on the same row as the vector lets the index do the ordering
-- and the filter together. The cost is a denormalized copy that must be kept in
-- sync: ingestion writes it with the chunk, and changing a document's ACL now
-- updates its chunks too (see update_document_acl).
--
-- This runs BEFORE the HNSW index (0010) on purpose. Backfilling a column on a
-- table that already carries a vector index is pathologically slow, because
-- every row update reinserts that row's vector into the index graph even though
-- the vector did not change. Measured on 100k chunks: still running after 13
-- minutes with the index in place, versus seconds without it. Build the graph
-- once, after the data has settled.

alter table chunks
    add column acl jsonb not null default '["public-to-org"]'::jsonb;

update chunks c set acl = d.acl from documents d where d.id = c.document_id;

create index chunks_acl_gin on chunks using gin (acl);
