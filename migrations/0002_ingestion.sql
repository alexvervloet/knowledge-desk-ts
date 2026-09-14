-- Phase 2: ingestion. Documents and their chunks live per tenant; a durable
-- job queue drives embedding work off the request path. Embedding dimension is
-- fixed at 1024 (Voyage voyage-3 and the mock embedder both produce 1024-d).

create table documents (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references orgs(id) on delete cascade,
    source       text not null,                 -- e.g. 'local-folder'
    path         text not null,                 -- path within the source
    content      text not null,                 -- captured at upload time
    content_hash text not null,                 -- sha256 of content; drives resync
    acl          jsonb not null default '["public-to-org"]'::jsonb,
    status       text not null default 'pending'
                 check (status in ('pending', 'ingested', 'failed', 'deleted')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (org_id, source, path)
);

create index documents_org_idx on documents(org_id);

create table chunks (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references orgs(id) on delete cascade,
    document_id uuid not null references documents(id) on delete cascade,
    ordinal     int not null,
    text        text not null,
    embedding   vector(1024) not null,
    created_at  timestamptz not null default now(),
    unique (document_id, ordinal)
);

create index chunks_org_idx on chunks(org_id);
create index chunks_document_idx on chunks(document_id);

create table jobs (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references orgs(id) on delete cascade,
    kind            text not null,
    payload         jsonb not null default '{}'::jsonb,
    idempotency_key text not null unique,
    status          text not null default 'queued'
                    check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
    attempts        int not null default 0,
    max_attempts    int not null default 3,
    last_error      text,
    run_after       timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- The worker claims from this: queued and due, oldest first.
create index jobs_claim_idx on jobs(status, run_after, created_at);
