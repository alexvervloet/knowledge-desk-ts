-- Harden the RLS policies for pooled connections.
--
-- With a connection per request, `app.current_org` was simply never set on a
-- fresh connection, so `current_setting(..., true)` returned NULL and the policy
-- compared `org_id = NULL`, matching nothing. That is the deny-by-default we
-- want. With pooling the GUC is transaction-scoped, and reverting it at commit
-- leaves an EMPTY STRING rather than NULL, so `''::uuid` raised
-- InvalidTextRepresentation instead of denying.
--
-- Erroring is not a data leak (the query fails), but it is a 500 where a clean
-- "no rows" belongs. nullif() turns the empty setting back into NULL so the
-- policy denies quietly, the same way it always did.

do $$
declare t text;
begin
    foreach t in array array['documents', 'chunks', 'groups', 'answers', 'feedback', 'audit_log']
    loop
        execute format('drop policy if exists org_isolation on %I', t);
        execute format(
            'create policy org_isolation on %I using ('
            '  org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid'
            ') with check ('
            '  org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid'
            ')', t);
    end loop;
end $$;
