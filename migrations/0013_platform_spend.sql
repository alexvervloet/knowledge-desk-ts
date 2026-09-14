-- A deployment-wide daily spend total, so the bill has a ceiling that does not
-- depend on how many orgs exist.
--
-- Every cost control so far is per-org: the rolling budget, the monthly question
-- cap, the storage and document caps. All of them are bounds on one tenant, and
-- signup is unauthenticated and creates a tenant with a fresh set of all four.
-- Resetting the budget therefore cost one HTTP request. Throttling signup raises
-- the price of that but does not put a number on the worst case; this does.
--
-- Deliberately not org-scoped, and deliberately not under row-level security:
-- the row is a single scalar summed across every tenant, so it carries no
-- tenant data to leak, and an RLS policy keyed on app.current_org would make it
-- unreadable from exactly the code that has to check it. That is the whole
-- reason it is a separate table rather than an aggregate over `answers`, which
-- RLS correctly restricts to one org at a time.
--
-- Calendar day rather than the rolling 24h window the per-org budget uses. The
-- per-org one is a fairness control, where a rolling window stops a tenant
-- gaming the reset; this one only has to bound a daily bill, and a day key makes
-- it a single upsert with no scan.

create table platform_spend (
    day      date primary key,
    cost_usd double precision not null default 0
);
