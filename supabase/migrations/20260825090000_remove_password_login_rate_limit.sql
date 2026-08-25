-- Remove the email/password login rate limiter.
--
-- Password login was removed from the CMS (GitHub OAuth is the only sign-in
-- path), so its durable limiter has no remaining callers. Execution was
-- already revoked from anon/authenticated (service_role only); this
-- migration drops the functions and the backing table entirely, along with
-- any stored identifier hashes.
--
-- Objects removed (created by 20260817100000_cms_login_rate_limit.sql,
-- hardened by 20260818090000_harden_login_rate_limit.sql and rebuilt as
-- split buckets by 20260818100000_login_rate_limit_split_buckets.sql):
--   * cms_check_login_rate(text, text)
--   * cms_check_login_single(text)
--   * cms_clear_login_rate(text, text)
--   * table cms_login_attempts
--
-- The legacy single-identifier cms_check_login_rate(text) was already
-- dropped by 20260818110000_remove_legacy_login_rate_rpc.sql; the IF EXISTS
-- guards keep this migration idempotent regardless of applied state.
--
-- REVERSIBLE: recreate the objects from the three migrations listed above.

revoke execute on function cms_check_login_rate(text, text) from service_role;
revoke execute on function cms_clear_login_rate(text, text) from service_role;
revoke execute on function cms_check_login_single(text) from service_role;

drop function if exists cms_check_login_rate(text, text);
drop function if exists cms_clear_login_rate(text, text);
drop function if exists cms_check_login_single(text);
drop function if exists cms_check_login_rate(text);

drop table if exists cms_login_attempts;
