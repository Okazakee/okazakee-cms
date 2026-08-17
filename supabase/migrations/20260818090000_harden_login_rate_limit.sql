-- Harden login rate-limiter permissions for the standalone CMS.
--
-- BACKGROUND
-- The base migration (20260817100000_cms_login_rate_limit.sql) created
-- cms_login_attempts and two RPCs, but relied on Supabase defaults that
-- expose the limiter:
--
--   * Supabase grants ALL on new public-schema tables to anon and
--     authenticated, and RLS is disabled by default  -> anyone could
--     SELECT/INSERT/UPDATE/DELETE limiter rows directly through the
--     Data API (read other users' attempt hashes, reset or forge buckets);
--   * functions default to EXECUTE for PUBLIC -> anonymous callers could
--     also run cms_purge_login_attempts();
--   * cms_check_login_rate is SECURITY DEFINER and accepts an identifier
--     hash: letting browser/public roles invoke it lets any caller burn
--     arbitrary buckets (denial of service) or probe lockout state.
--
-- FIX
-- The limiter is only invoked server-side from the CMS login Server Action,
-- which calls the RPC with the service-role client (src/libs/cms/supabase/
-- admin.ts). Therefore:
--
--   1. revoke direct table access from anon/authenticated;
--   2. enable RLS with NO policies (deny-all) as a second line of defense;
--   3. revoke the purge RPC from anon/authenticated/public;
--   4. grant RPC execution to service_role only (the split-bucket RPCs added
--      by the next migration);
--   5. schedule the purge via pg_cron (previously documented as manual
--      only), keeping identifiers hashed.
--
-- ROLLING DEPLOYMENT (read before applying)
-- The currently-deployed CMS still invokes the OLD single-identifier
-- cms_check_login_rate(text) with the publishable (anon) key. Until the
-- split-bucket code (20260818100000_login_rate_limit_split_buckets.sql) is
-- deployed, that anon/authenticated execute grant is therefore RETAINED
-- below. The follow-up cleanup migration removes it together with the old
-- function once the new CMS is live:
--
--   revoke execute on function cms_check_login_rate(text) from anon, authenticated;
--   drop function if exists cms_check_login_rate(text);
--
-- Deployment order: apply both migrations -> verify -> deploy the CMS ->
-- smoke-test login -> apply the cleanup migration.
--
-- APPLY
--   supabase db push
-- or run this file via the Supabase SQL editor (project must have pg_cron;
-- it is preinstalled on all Supabase plans).
--
-- VERIFY after applying
--   select * from information_schema.role_table_grants
--    where table_name = 'cms_login_attempts' and grantee in ('anon','authenticated');
--   -- expect 0 rows
--   select proname, proacl from pg_proc
--    where proname in ('cms_check_login_rate','cms_purge_login_attempts');
--   -- anon/authenticated must not appear in proacl, EXCEPT the temporary
--   -- anon/authenticated grant on cms_check_login_rate(text) (rolled back by
--   -- the cleanup migration once the new CMS is live)
--   select * from cron.job where jobname = 'cms-purge-login-attempts';
--
-- REVERSIBLE
--   restore original grants (from the base migration):
--     grant all on table cms_login_attempts to anon, authenticated;
--     alter table cms_login_attempts disable row level security;
--     grant execute on function cms_check_login_rate(text) to anon, authenticated;
--     grant execute on function cms_purge_login_attempts() to public;
--   stop the scheduled purge:
--     select cron.unschedule('cms-purge-login-attempts');

-- 1. Deny direct table access through the Data API.
alter table cms_login_attempts enable row level security;
-- No policies are added: RLS on with zero policies means anon/authenticated
-- can never see or touch rows even if they somehow regain grants.

revoke all on table cms_login_attempts from anon, authenticated;
revoke all on table cms_login_attempts from public;

-- 2. RPC execution is server-only (service_role) EXCEPT the old
-- single-identifier cms_check_login_rate(text), which keeps its
-- anon/authenticated execute grant TEMPORARILY: the currently-deployed CMS
-- invokes it with the publishable (anon) key until the split-bucket code is
-- live. The cleanup migration (see header) revokes the grant and drops the
-- function once the new CMS is deployed.
revoke execute on function cms_check_login_rate(text) from public;

revoke all on function cms_purge_login_attempts() from anon, authenticated;
revoke all on function cms_purge_login_attempts() from public;

-- Temporary rolling-deployment grant (see header). Re-granted explicitly so
-- the retention is visible and idempotent in this migration.
grant execute on function cms_check_login_rate(text) to anon, authenticated;
grant execute on function cms_check_login_rate(text) to service_role;
grant execute on function cms_purge_login_attempts() to service_role;

-- 3. Scheduled cleanup so the table never grows unbounded (stale rows are
-- deleted hourly; rows under an active lockout are preserved until it
-- expires). Idempotent: re-running this migration replaces the job.
create extension if not exists pg_cron;

do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
    from cron.job
    where jobname = 'cms-purge-login-attempts';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'cms-purge-login-attempts',
  '0 * * * *', -- hourly
  $$select cms_purge_login_attempts()$$
);
