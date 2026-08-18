-- 20260818120000_revoke_public_write_grants.sql
-- Security hardening (Security Advisor / rls_disabled_in_public follow-up).
--
-- RLS is already enabled on all public tables. This migration removes the
-- remaining write/DDL privileges that anon and authenticated still hold via
-- table ACLs (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER), keeping
-- SELECT where the public website legitimately reads content.
--
-- Write path analysis (verified against repo source):
--   - okazakee-ws (public site): reads content with the anon key (SELECT
--     only) and calls the SECURITY DEFINER view-count RPCs. No direct writes.
--   - okazakee-cms (CMS): all inserts/updates/deletes go through
--     getCmsAdminClient() (service_role, bypasses RLS). No client-side
--     table writes via the authenticated role.
--   - service_role is intentionally left untouched (server-side CMS client).
--
-- cms_login_attempts is intentionally excluded: already hardened (RLS on,
-- no anon/authenticated grants, service_role only).

-- Public content tables: drop write/DDL privileges from unprivileged roles.
revoke insert, update, delete, truncate, references, trigger
  on table public.blog_posts from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.career_entries from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.cms_allowed_users from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.contacts from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.hero_section from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.i18n_translations from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.portfolio_posts from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.skills from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.skills_categories from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.user_profiles from anon, authenticated;