-- 20260818150001_drop_enumerable_rpc_and_dead_function.sql
-- Phase 2 (apply AFTER the code calling cms_lookup_current_user is live).
--
-- 1. Drop cms_lookup_allowed_user(text, text): the enumerable allowlist RPC
--    (arbitrary p_email/p_github_username) is replaced by the parameterless
--    cms_lookup_current_user(). No dependencies in app code after deploy.
-- 2. Drop is_admin_user(uuid): dead SECURITY DEFINER overload — it
--    references public.user_roles which does not exist in this schema
--    (verified: 0 rows in pg_class for user_roles, no policies/triggers/
--    functions depend on this overload). The 0-arg is_admin_user() used by
--    RLS policies on i18n_translations/hero_section/blog_posts is KEPT.

drop function if exists public.cms_lookup_allowed_user(text, text);
drop function if exists public.is_admin_user(uuid);