-- Phase 1: the multi-tenant spine. Every domain table carries org_id and is
-- reached only through the tenant-scoped data layer. Users are global
-- identities; a membership binds a user to an org with a role.

create table orgs (
    id         uuid primary key default gen_random_uuid(),
    slug       text not null unique,
    name       text not null,
    created_at timestamptz not null default now()
);

create table users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,   -- stored lowercased by the app
    password_hash text not null,
    created_at    timestamptz not null default now()
);

create table memberships (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references users(id) on delete cascade,
    org_id     uuid not null references orgs(id) on delete cascade,
    role       text not null check (role in ('owner', 'admin', 'member')),
    created_at timestamptz not null default now(),
    unique (user_id, org_id)
);

create index memberships_org_idx on memberships(org_id);
create index memberships_user_idx on memberships(user_id);

create table groups (
    id         uuid primary key default gen_random_uuid(),
    org_id     uuid not null references orgs(id) on delete cascade,
    name       text not null,
    created_at timestamptz not null default now(),
    unique (org_id, name)
);

create index groups_org_idx on groups(org_id);

create table group_members (
    group_id uuid not null references groups(id) on delete cascade,
    user_id  uuid not null references users(id) on delete cascade,
    primary key (group_id, user_id)
);

create table sessions (
    id         uuid primary key default gen_random_uuid(),
    token_hash text not null unique,   -- sha256 of the opaque bearer token
    user_id    uuid not null references users(id) on delete cascade,
    org_id     uuid not null references orgs(id) on delete cascade,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index sessions_user_idx on sessions(user_id);
