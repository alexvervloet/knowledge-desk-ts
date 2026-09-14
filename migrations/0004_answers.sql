-- Phase 4: the assistant. Each answered question records a row so feedback can
-- attach to it and Phase 5's cost ledger and Phase 9's traces have something to
-- key on. Feedback is one rating per user per answer.

create table answers (
    id         uuid primary key default gen_random_uuid(),
    org_id     uuid not null references orgs(id) on delete cascade,
    user_id    uuid not null references users(id) on delete cascade,
    question   text not null,
    provider   text not null,
    refused    boolean not null default false,
    created_at timestamptz not null default now()
);

create index answers_org_idx on answers(org_id);

create table feedback (
    id         uuid primary key default gen_random_uuid(),
    org_id     uuid not null references orgs(id) on delete cascade,
    user_id    uuid not null references users(id) on delete cascade,
    answer_id  uuid not null references answers(id) on delete cascade,
    rating     text not null check (rating in ('up', 'down')),
    note       text,
    created_at timestamptz not null default now(),
    unique (answer_id, user_id)
);

create index feedback_org_idx on feedback(org_id);
