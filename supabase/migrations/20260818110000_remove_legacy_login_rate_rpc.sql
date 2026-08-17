-- Remove the legacy login rate-limiter RPC and its temporary grant.
--
-- BACKGROUND
-- 20260818090000_harden_login_rate_limit.sql retained the old
-- single-identifier cms_check_login_rate(text) together with its
-- anon/authenticated EXECUTE grant, and 20260818100000_login_rate_limit_
-- split_buckets.sql kept the function around, so the currently-deployed CMS
-- (which invoked it with the publishable key) kept working until the
-- split-bucket code was live.
--
-- That window is now closed:
--   * the split-bucket CMS is deployed (cms_check_login_rate(text,text) and
--     cms_clear_login_rate(text,text), service-role only);
--   * production login is smoke-tested;
--   * the CMS -> public signed revalidation smoke test passed.
--
-- This migration removes the compatibility surface. The new limiter is
-- unaffected.
--
-- REVERSIBLE
--   Recreate the function from 20260817100000_cms_login_rate_limit.sql and
--   re-grant:
--     grant execute on function public.cms_check_login_rate(text) to anon, authenticated;

revoke execute on function public.cms_check_login_rate(text)
from anon, authenticated;

drop function if exists public.cms_check_login_rate(text);
