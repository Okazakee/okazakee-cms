-- Dev-only author-policy isolation for the `dev_staging` clone.
--
-- WHY: Phase 1B normalized dev_staging RLS while preserving existing effective
-- behavior. That audit exposed one genuine dev-clone artifact: the dev policy
-- `user_profiles_public_author_read` decided whether an anonymous caller may
-- read an author profile by querying `public.blog_posts` / `public.portfolio_posts`
-- (the relation OIDs were resolved against `public` when the policy was
-- created), instead of the dev clone's own post tables. A dev author profile was
-- therefore exposed based on whether that author had *production* content.
--
-- This file fixes only that environment-isolation leak: the predicate keeps the
-- same command (SELECT), role (anon), permissiveness, OR semantics and
-- `author_id = user_profiles.id` relationship, and only the two referenced
-- relations change to `dev_staging.*`. Coordinated data check: dev and public
-- author sets are identical (2 / 2, no mismatch either way), so no currently
-- visible author changes.
--
-- EXPLICITLY NOT CHANGED: `public.is_admin_user()` and the i18n admin-write
-- policies that call it. That function is intentionally shared CMS
-- authentication infrastructure backed by the shared `public.cms_allowed_users`
-- allowlist, not a post-author relationship.
--
-- Also NOT added: `hidden = false` / `created_at <= now()` — visibility
-- semantics are a separate, later policy decision. This phase is isolation only.
--
-- SCHEMA: every statement targets `dev_staging` explicitly so nothing resolves
-- through search_path and nothing can reach production content. Against a
-- database without a `dev_staging` schema this file fails loudly instead of
-- altering `public`.
--
-- IDEMPOTENT: PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so the policy is
-- dropped-if-exists then recreated; replay converges on the same definition.
--
-- REVERSIBLE
--   recreate the same policy with `public.blog_posts` / `public.portfolio_posts`
--   (restores the pre-isolation dev state; not recommended).

drop policy if exists user_profiles_public_author_read
  on dev_staging.user_profiles;

create policy user_profiles_public_author_read on dev_staging.user_profiles
  for select to anon
  using (
    (
      exists (
        select 1 from dev_staging.blog_posts bp
        where bp.author_id = user_profiles.id
      )
    )
    or (
      exists (
        select 1 from dev_staging.portfolio_posts pp
        where pp.author_id = user_profiles.id
      )
    )
  );
