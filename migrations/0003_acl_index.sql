-- Phase 3: retrieval filters candidate documents by whether their ACL array
-- intersects the caller's principal set (the jsonb `?|` operator). A GIN index
-- on the acl array makes that containment test indexable rather than a scan.

create index documents_acl_gin on documents using gin (acl);
