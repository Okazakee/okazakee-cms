-- Dev-only post-visibility hardening for the `dev_staging` clone.
--
-- WHY: both dev post tables still expose EVERY row to the Data API because
-- their public SELECT policies use `USING (true)`:
--
--   dev_staging.blog_posts      "Allow public read access to blog_posts"  USING (true)
--   dev_staging.portfolio_posts "Public can read posts"                   USING (true)
--
-- Live dev data has hidden rows (blog_posts hidden=true: 1; portfolio_posts
-- hidden=true: 4), so an anon/authenticated Data API caller can currently read
-- drafts directly. This file replaces each permissive read policy with
-- `cms_published_read` USING (hidden = false) so drafts are protected at the
-- database boundary.
--
-- DELIBERATELY NOT ADDED: a `created_at <= now()` predicate. The public site
-- (okazakee-ws) already enforces publish dates through environment config
-- (production defaults to enforcing; staging/preview may set
-- CONTENT_ENFORCE_PUBLISH_DATE=false), and future unhidden posts must stay
-- previewable in dev/staging. The dev database contract therefore protects
-- drafts via `hidden` only and leaves scheduling to the application.
--
-- AUTHOR-PROFILE INTERACTION: Phase 1C rebound
-- `dev_staging.user_profiles.user_profiles_public_author_read` to read
-- `dev_staging.blog_posts` / `dev_staging.portfolio_posts`. Because RLS applies
-- inside that policy's EXISTS subqueries for the caller, anon author-profile
-- visibility now inherits this same `hidden = false` boundary: an author whose
-- only posts are hidden stops being visible. That policy is NOT edited here.
--
-- SCOPE: dev_staging only, exactly two SELECT-policy replacements. No `public`
-- object, no grant, no column grant, no function/RPC, no Storage, no data, no
-- index, and no other policy — `cms_allowed_users`, `user_profiles`,
-- `blog_posts."Admins and mods can insert"` and every Phase 1B/1C policy are
-- untouched. Tables are explicitly schema-qualified, so nothing resolves
-- through search_path.
--
-- IDEMPOTENT: PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so each policy is
-- dropped-if-exists (old name AND the target name) then recreated; replay
-- converges on the same definition.

-- ── blog_posts ───────────────────────────────────────────────────────────
drop policy if exists "Allow public read access to blog_posts"
  on dev_staging.blog_posts;
drop policy if exists cms_published_read on dev_staging.blog_posts;

create policy cms_published_read on dev_staging.blog_posts
  for select to anon, authenticated
  using (hidden = false);

-- ── portfolio_posts ──────────────────────────────────────────────────────
drop policy if exists "Public can read posts"
  on dev_staging.portfolio_posts;
drop policy if exists cms_published_read on dev_staging.portfolio_posts;

create policy cms_published_read on dev_staging.portfolio_posts
  for select to anon, authenticated
  using (hidden = false);
