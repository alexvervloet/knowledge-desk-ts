-- Phase 6: row-level security as defense in depth behind the data layer.
--
-- Two roles: migrations run as the owner (compose superuser); the app connects
-- as a dedicated least-privilege role `kd_app`. This split is what makes RLS
-- real: a superuser (or a table owner) bypasses RLS even with FORCE, so the app
-- must NOT be either. As kd_app, the policies below return no rows unless the
-- app has set the `app.current_org` GUC (db.connect(org_id) does), so a query
-- that forgets its org filter yields nothing rather than leaking across tenants.

do $$
begin
    if not exists (select from pg_roles where rolname = 'kd_app') then
        create role kd_app login password 'kd_app';
    end if;
end $$;

grant usage on schema public to kd_app;
grant select, insert, update, delete on all tables in schema public to kd_app;
grant usage, select on all sequences in schema public to kd_app;
-- Future tables (later migrations) get the same grants automatically.
alter default privileges in schema public
    grant select, insert, update, delete on tables to kd_app;

-- Enable and FORCE RLS on org-scoped tables that carry an org_id. group_members
-- has no org_id and is reached only through groups (protected here).
do $$
declare t text;
begin
    foreach t in array array['documents', 'chunks', 'groups', 'answers', 'feedback', 'audit_log']
    loop
        execute format('alter table %I enable row level security', t);
        execute format('alter table %I force row level security', t);
        execute format(
            'create policy org_isolation on %I using ('
            '  org_id = current_setting(''app.current_org'', true)::uuid'
            ') with check ('
            '  org_id = current_setting(''app.current_org'', true)::uuid'
            ')', t);
    end loop;
end $$;
