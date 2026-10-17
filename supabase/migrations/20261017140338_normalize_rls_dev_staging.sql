-- Dev-only RLS normalization for the `dev_staging` clone.
--
-- WHY: Supabase's advisors flag `auth_rls_initplan` (the `auth.*` helpers and
-- `is_admin_user()` re-evaluated per row) and `multiple_permissive_policies`
-- (several permissive policies overlapping on the same table + command) inside
-- dev_staging. This file collapses the redundant SELECT policies and makes every
-- retained helper call InitPlan-safe. It is a normalization/performance change:
-- the effective data access contract is intentionally unchanged.
--
-- SCOPE: dev_staging only. No `public` object is created, altered or dropped, no
-- table or column grant changes, no SECURITY DEFINER function body, no Storage
-- policy, no data. `portfolio_posts` visibility, the blog/portfolio SELECT
-- policies and `cms_allowed_users` are deliberately untouched.
--
-- PRESERVED-AS-IS (pre-existing dev behaviour, NOT "fixed" here): the dev
-- `user_profiles` author predicates read `public.blog_posts` /
-- `public.portfolio_posts`, exactly as the live dev policies already do (their
-- relations were resolved against `public` when they were created). Rewriting
-- them to `dev_staging.*` would change the effective dev access contract, so
-- this file reproduces the existing `public.` references verbatim. Flagged for
-- the coordinator as a likely dev-clone artifact worth its own decision.
--
-- IDEMPOTENT: PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so every policy
-- is `DROP POLICY IF EXISTS` followed by `CREATE POLICY`. Re-running converges
-- on the same final set.

-- ── hero_section ─────────────────────────────────────────────────────────
-- One public read policy (anon + authenticated) replaces three overlapping
-- ones; two of them were already strict supersets of the third.
drop policy if exists "Allow authenticated users to select from hero_section"
  on dev_staging.hero_section;
drop policy if exists "Public can read hero_section"
  on dev_staging.hero_section;
drop policy if exists hero_section_public_select
  on dev_staging.hero_section;

drop policy if exists hero_section_public_read on dev_staging.hero_section;
create policy hero_section_public_read on dev_staging.hero_section
  for select to anon, authenticated
  using (true);

-- Admin mutations keep the exact `user_role = 'admin'` semantics; only the
-- repeated `auth.jwt()` evaluation becomes a scalar subquery (InitPlan).
drop policy if exists hero_section_insert_admins on dev_staging.hero_section;
create policy hero_section_insert_admins on dev_staging.hero_section
  for insert to authenticated
  with check (((select auth.jwt()) ->> 'user_role') = 'admin');

drop policy if exists hero_section_update_admins on dev_staging.hero_section;
create policy hero_section_update_admins on dev_staging.hero_section
  for update to authenticated
  using (((select auth.jwt()) ->> 'user_role') = 'admin')
  with check (((select auth.jwt()) ->> 'user_role') = 'admin');

drop policy if exists hero_section_delete_admins on dev_staging.hero_section;
create policy hero_section_delete_admins on dev_staging.hero_section
  for delete to authenticated
  using (((select auth.jwt()) ->> 'user_role') = 'admin');

-- ── i18n_translations ────────────────────────────────────────────────────
-- One public read policy replaces three overlapping PUBLIC ones; the admin
-- SELECT was already implied by the two USING(true) policies.
drop policy if exists "Admins can select i18n_translations"
  on dev_staging.i18n_translations;
drop policy if exists "Allow public read access"
  on dev_staging.i18n_translations;
drop policy if exists "Public can select i18n_translations"
  on dev_staging.i18n_translations;

drop policy if exists i18n_translations_public_read
  on dev_staging.i18n_translations;
create policy i18n_translations_public_read on dev_staging.i18n_translations
  for select to anon, authenticated
  using (true);

-- Admin writes keep `is_admin_user()` authorization and their PUBLIC role so
-- the effective contract is unchanged; the call is schema-qualified and wrapped
-- in a scalar subquery so it is evaluated once (no search_path dependence).
drop policy if exists "Admins can insert i18n_translations"
  on dev_staging.i18n_translations;
create policy "Admins can insert i18n_translations"
  on dev_staging.i18n_translations
  for insert to public
  with check ((select public.is_admin_user()));

drop policy if exists "Admins can update i18n_translations"
  on dev_staging.i18n_translations;
create policy "Admins can update i18n_translations"
  on dev_staging.i18n_translations
  for update to public
  using ((select public.is_admin_user()))
  with check ((select public.is_admin_user()));

-- ── user_profiles ────────────────────────────────────────────────────────
-- `Authenticated can read profiles` was already USING(true), so every
-- authenticated SELECT was authorised unconditionally; the three narrower
-- authenticated policies were therefore redundant.
drop policy if exists "Admins can read all profiles"
  on dev_staging.user_profiles;
drop policy if exists "Authenticated can read post authors"
  on dev_staging.user_profiles;
drop policy if exists "Authenticated can read profiles"
  on dev_staging.user_profiles;
drop policy if exists "Users can read their own profile"
  on dev_staging.user_profiles;

drop policy if exists user_profiles_authenticated_read
  on dev_staging.user_profiles;
create policy user_profiles_authenticated_read on dev_staging.user_profiles
  for select to authenticated
  using (true);

-- Anon author cards: same predicate as the dropped `Public can read post
-- authors` (dev semantics: no `hidden` filter, and the same `public.` relations
-- the live dev policy resolves).
drop policy if exists "Public can read post authors"
  on dev_staging.user_profiles;
drop policy if exists user_profiles_public_author_read
  on dev_staging.user_profiles;
create policy user_profiles_public_author_read on dev_staging.user_profiles
  for select to anon
  using (
    (
      exists (
        select 1 from public.blog_posts bp
        where bp.author_id = user_profiles.id
      )
    )
    or (
      exists (
        select 1 from public.portfolio_posts pp
        where pp.author_id = user_profiles.id
      )
    )
  );

-- Self-update: the live policy omitted WITH CHECK (PostgreSQL defaults it to
-- USING); this states both explicitly with an InitPlan-safe `auth.uid()`.
drop policy if exists "Users can update own profile"
  on dev_staging.user_profiles;
drop policy if exists user_profiles_self_update on dev_staging.user_profiles;
create policy user_profiles_self_update on dev_staging.user_profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ── blog_posts legacy INSERT policy ──────────────────────────────────────
-- Name and authorization semantics preserved exactly; only the per-row
-- `auth.jwt()` pointer becomes InitPlan-safe. `author_id = (select auth.uid())`
-- was already in the scalar form.
drop policy if exists "Admins and mods can insert" on dev_staging.blog_posts;
create policy "Admins and mods can insert" on dev_staging.blog_posts
  for insert to authenticated
  with check (
    (((select auth.jwt()) ->> 'role') = any (array['admin', 'mod']))
    and author_id = (select auth.uid())
  );
