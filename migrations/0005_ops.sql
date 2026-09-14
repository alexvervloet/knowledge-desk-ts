-- Phase 5: operational controls. Each answer carries its token usage and dollar
-- estimate so a per-org rolling budget can be summed from the answers table, and
-- `blocked` records questions stopped before the model ran (over budget or cap).
-- The audit log is an append-only record an org admin can query.

alter table answers
    add column input_tokens  int not null default 0,
    add column output_tokens int not null default 0,
    add column cost_usd      double precision not null default 0,
    add column blocked       boolean not null default false;

-- Rolling-window and monthly-count queries scan by org and time.
create index answers_org_created_idx on answers(org_id, created_at);

create table audit_log (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references orgs(id) on delete cascade,
    actor_user_id uuid references users(id) on delete set null,
    action        text not null,
    detail        jsonb not null default '{}'::jsonb,
    created_at    timestamptz not null default now()
);

create index audit_log_org_idx on audit_log(org_id, created_at desc);
