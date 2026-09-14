-- A generation counter for a document's derived state, so re-ingesting after a
-- deletion is not mistaken for work that has already been done.
--
-- Ingest jobs are idempotent by `ingest:{document_id}:{content_hash}`, which is
-- what makes a resync of unchanged files nearly free: the same bytes produce the
-- same key, the insert hits `on conflict do nothing`, and no duplicate work is
-- queued. That reasoning holds only while the previous job's output still
-- exists.
--
-- Dropping a document from a sync deletes its chunks. Re-uploading the identical
-- file then produces the identical key, collides with the *succeeded* job from
-- before the deletion, and enqueues nothing — leaving the document at 'pending'
-- with no chunks, permanently invisible to retrieval and looking fine in the
-- listing apart from a status nobody reads.
--
-- The counter increments whenever chunks are destroyed, so the key becomes
-- `ingest:{document_id}:{content_hash}:{revision}`. Identical bytes still
-- deduplicate; identical bytes after a deletion do not, which is the distinction
-- the content hash alone cannot express.

alter table documents
    add column revision int not null default 0;
