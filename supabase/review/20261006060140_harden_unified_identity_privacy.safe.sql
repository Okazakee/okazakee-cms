-- REVIEW-ONLY SAFE SPLIT — DO NOT AUTO-APPLY.
-- Source: supabase/migrations/20261006060140_harden_unified_identity_privacy.sql
--   (untracked review draft, left unedited).
-- This file keeps original sections 1, 3, 4, 5, 6, 7, 8 VERBATIM except this
-- header; original section 2 (auth-identity backfill UPDATEs 2a/2b/2c) is
-- REMOVED and parked in the deferred draft named below. Nothing here issues
-- top-level UPDATE/INSERT/DELETE against public rows: only ADD COLUMN,
-- constraints, partial unique indexes, COMMENTs, CREATE OR REPLACE FUNCTION,
-- GRANT/REVOKE, DROP/CREATE POLICY, and ENABLE RLS.
-- Deferred counterpart (DO NOT APPLY under the public-data freeze):
--   supabase/deferred/20261006060140_github_user_id_backfill.deferred.sql
-- Apply boundary (parent decides; CMS staging project only, never main):
--   APPLY this safe file first (nullable columns, no backfill), then deploy
--   CMS callers selecting github_user_id. Code-first order hard-fails on old
--   DB; migration-first keeps pre-migration callers working (NULL = legacy).
-- Rollback: drop added columns if needed:
--   alter table public.cms_allowed_users drop column if exists github_user_id;
--   alter table public.user_profiles drop column if exists github_user_id;
-- plus restore prior function/policy/grant definitions from git history.

-- ── DEFERRED §2 REMOVED (see deferred draft; original 2a/2b/2c UPDATEs) ──
-- Original section 2 joined auth.identities/auth.users to backfill
-- public.user_profiles.github_user_id (2a), public.cms_allowed_users by
-- verified email (2b), and legacy handle rows (2c). Parked unapplied.

-- 20261006060140_harden_unified_identity_privacy.sql
-- Unified identity + privacy hardening (ONE atomic migration, REVIEWED ONLY —
-- the parent verifies in isolation and publishes/applies; this file must not
-- be split into smaller histories).
--
-- Closes the gaps where the CMS source (ID-first/verified-email, identity_data
-- only) runs ahead of the live database:
--   1. CMS-AUTH-04: github_user_id columns/indexes/backfill absent, so the
--      immutable GitHub subject cannot authorize and the legacy display handle
--      remains the only GitHub path.
--   2. CMS-AUTH-03: cms_lookup_current_user() and is_admin_user() resolve the
--      caller from attacker-editable raw_user_meta_data->'user_name' and from
--      unverified auth.users.email, with no immutable-ID branch.
--   3. CMS-AUTH-06: is_admin_user() falls through from a non-admin email match
--      to the spoofable handle check, and both functions (plus the signup
--      trigger) are EXECUTE-granted to PUBLIC/anon.
--   4. CMS-AUTH-05: handle_new_user() persists the editable metadata handle
--      with no provider-subject column.
--   5. CMS-RLS-01: anon/authenticated SELECT policies on blog_posts and
--      portfolio_posts use USING (true), so drafts (hidden = true) are
--      publicly readable via the Data API.
--   6. CMS-PRIV-02: user_profiles email/PII is readable by any authenticated
--      user (USING true) and by anon for any author row; the own-UPDATE policy
--      has USING without WITH CHECK.
--
-- Intended side effects are limited to: auth RPC definitions + EXECUTE grants,
-- profile/post grants + SELECT/UPDATE policies, and draft visibility. No
-- Storage/Auth/booking objects are touched, no public rows are mutated (only
-- DDL + backfill of the new nullable column), no auth.users rows are changed.
--
-- Rollback sketch (parent only, after assessment): drop the three rewritten
-- functions' bodies via the previous migration files, drop policies
-- cms_published_read/*/user_profiles_*, restore grants from the *grants.sql
-- predecessors. The new columns are nullable with no dependents, so
--   alter table public.cms_allowed_users drop column if exists github_user_id;
--   alter table public.user_profiles drop column if exists github_user_id;
-- suffices to revert section 1.
-- APPROVED DEPLOY ORDER (CMS staging, never main): apply this migration
-- FIRST, then deploy CMS callers selecting github_user_id. No-lockout
-- rationale: columns/indexes/backfill are nullable/idempotent and signup
-- never blocks on NULL, so pre-migration callers keep working; post-migration
-- callers require the column, so code-first order would hard-fail on oldDB.
-- No caller source tolerance rewrites: migration-first is the gate.


-- ── 1. Immutable GitHub subject columns ─────────────────────────────────────
-- Nullable text holding the numeric provider subject (identities sub). NULL
-- means "email/dummy/legacy row": never constrains signup (handle_new_user
-- keeps working with NULL) and never maps dummy-*.local rows.

alter table public.cms_allowed_users
  add column if not exists github_user_id text;

alter table public.user_profiles
  add column if not exists github_user_id text;

-- Numeric-only subjects; display handles stay in github_username (render-only).
-- Idempotent: drop-then-add so re-runs converge instead of erroring on
-- duplicate constraint names.
alter table public.cms_allowed_users
  drop constraint if exists cms_allowed_users_github_user_id_numeric;
alter table public.cms_allowed_users
  add constraint cms_allowed_users_github_user_id_numeric
  check (github_user_id is null or github_user_id ~ '^[0-9]+$');

alter table public.user_profiles
  drop constraint if exists user_profiles_github_user_id_numeric;
alter table public.user_profiles
  add constraint user_profiles_github_user_id_numeric
  check (github_user_id is null or github_user_id ~ '^[0-9]+$');

-- One subject authorizes at most one allowlist row / one profile. Partial
-- indexes keep NULLs (email/dummy/legacy rows) unconstrained.
create unique index if not exists cms_allowed_users_github_user_id_uidx
  on public.cms_allowed_users (github_user_id)
  where github_user_id is not null;

create unique index if not exists user_profiles_github_user_id_uidx
  on public.user_profiles (github_user_id)
  where github_user_id is not null;

-- No separate plain lookup indexes: the partial unique indexes above already
-- serve equality lookups on github_user_id (NULLs excluded, which never
-- authorize), so plain indexes would duplicate storage and write cost.

comment on column public.cms_allowed_users.github_user_id is
  'Immutable numeric GitHub subject (auth.identities sub). Authorizes; github_username is display-only.';
comment on column public.user_profiles.github_user_id is
  'Immutable numeric GitHub subject (auth.identities sub). Mirrors the allowlist; github_username is display-only.';

-- ── 3. Signup trigger: identities-first, metadata display fallback ──────────
-- Persists the immutable subject when the provider linked it at signup;
-- editable user_metadata remains a DISPLAY fallback only, and dummy rows
-- never receive a subject. The trigger itself is untouched, so signup cannot
-- block: every new column stays nullable.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_github_id text;
  v_github_username text;
begin
  select
    gi.identity_data->>'sub',
    coalesce(
      gi.identity_data->>'user_name',
      gi.identity_data->>'preferred_username',
      gi.identity_data->>'login'
    )
    into v_github_id, v_github_username
    from auth.identities gi
    where gi.user_id = new.id
      and gi.provider = 'github'
    limit 1;

  if v_github_id is null or v_github_id !~ '^[0-9]+$' then
    v_github_id := null;
  end if;

  -- Dummy/local rows never map to a provider subject.
  if lower(coalesce(new.email, '')) like '%@dummy.local' then
    v_github_id := null;
  end if;

  insert into public.user_profiles
    (id, email, display_name, avatar_url, auth_provider, github_username, github_user_id)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'user_name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data->>'avatar_url',
    coalesce(new.raw_app_meta_data->>'provider', 'email'),
    coalesce(v_github_username, new.raw_user_meta_data->>'user_name'),
    v_github_id
  );
  return new;
end;
$function$;

-- Trigger functions fire as the system; no role needs EXECUTE. Revoking the
-- over-broad PUBLIC/anon/authenticated grants changes nothing at signup.
revoke all on function public.handle_new_user()
  from public, anon, authenticated;

-- ── 4. cms_lookup_current_user(): ID → verified-email → legacy ──────────────
-- Parameterless (identity comes from the caller's JWT via auth.uid()), so an
-- authenticated session can only ever learn its OWN allowlist status.
-- Order mirrors the CMS source findAllowedCmsUser: immutable subject first,
-- verified email second, provider-verified legacy handle last (dual-allowed
-- transition). raw_user_meta_data is never consulted.
create or replace function public.cms_lookup_current_user()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_email_verified boolean := false;
  v_github_id text;
  v_github_username text;
  v_role text;
  v_source text;
begin
  if v_uid is null then
    return null;
  end if;

  select
    u.email,
    (u.email_confirmed_at is not null)
    into v_email, v_email_verified
    from auth.users u
    where u.id = v_uid;

  select
    gi.identity_data->>'sub',
    coalesce(
      gi.identity_data->>'user_name',
      gi.identity_data->>'preferred_username',
      gi.identity_data->>'login'
    )
    into v_github_id, v_github_username
    from auth.identities gi
    where gi.user_id = v_uid
      and gi.provider = 'github'
    limit 1;

  if v_github_id is null or v_github_id !~ '^[0-9]+$' then
    v_github_id := null;
  end if;

  -- 1. Immutable provider subject.
  if v_github_id is not null then
    select role, 'github'
      into v_role, v_source
      from public.cms_allowed_users
      where github_user_id = v_github_id
        and role in ('admin', 'editor')
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  -- 2. Verified email only: an unverified address never matches.
  if v_email_verified and v_email is not null then
    select role, 'email'
      into v_role, v_source
      from public.cms_allowed_users
      where lower(email) = lower(v_email)
        and role in ('admin', 'editor')
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  -- 3. Transitional legacy handle, provider-verified (identities record),
  -- never user_metadata.
  if v_github_username is not null then
    select role, 'github'
      into v_role, v_source
      from public.cms_allowed_users
      where lower(github_username) = lower(v_github_username)
        and role in ('admin', 'editor')
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.cms_lookup_current_user() from public;
revoke execute on function public.cms_lookup_current_user()
  from anon, authenticated;
grant execute on function public.cms_lookup_current_user()
  to authenticated, service_role;

-- ── 5. is_admin_user(): ID decides, verified-email decides, legacy last ─────
-- A verified-email match returns immediately (a non-admin email NEVER falls
-- through to the handle check, closing the email+spoofed-handle escalation).
-- The legacy handle branch runs only when the session has no verified email,
-- and reads the provider-verified identities record, never user_metadata.
create or replace function public.is_admin_user()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_email_verified boolean := false;
  v_github_id text;
  v_github_username text;
  v_role text;
begin
  if v_uid is null then
    return false;
  end if;

  select
    u.email,
    (u.email_confirmed_at is not null)
    into v_email, v_email_verified
    from auth.users u
    where u.id = v_uid;

  select
    gi.identity_data->>'sub',
    coalesce(
      gi.identity_data->>'user_name',
      gi.identity_data->>'preferred_username',
      gi.identity_data->>'login'
    )
    into v_github_id, v_github_username
    from auth.identities gi
    where gi.user_id = v_uid
      and gi.provider = 'github'
    limit 1;

  if v_github_id is null or v_github_id !~ '^[0-9]+$' then
    v_github_id := null;
  end if;

  -- 1. Immutable provider subject decides immediately.
  if v_github_id is not null then
    select role
      into v_role
      from public.cms_allowed_users
      where github_user_id = v_github_id
        and role in ('admin', 'editor')
      limit 1;
    if v_role is not null then
      return v_role = 'admin';
    end if;
  end if;

  -- 2. Verified email decides immediately: no fallthrough to the handle.
  if v_email_verified and v_email is not null then
    select role
      into v_role
      from public.cms_allowed_users
      where lower(email) = lower(v_email)
        and role in ('admin', 'editor')
      limit 1;
    return coalesce(v_role = 'admin', false);
  end if;

  -- 3. Transitional legacy handle (no verified email on the session).
  if v_github_username is not null then
    select role
      into v_role
      from public.cms_allowed_users
      where lower(github_username) = lower(v_github_username)
        and role in ('admin', 'editor')
      limit 1;
    return coalesce(v_role = 'admin', false);
  end if;

  return false;
end;
$function$;

-- Live audit (pg_policies): "Admins can select i18n_translations" TO public
-- USING (is_admin_user() = true) is redundant with "Allow public read
-- access" / "Public can select i18n_translations" USING (true) on the same
-- table. RLS is permissive (OR), so dropping the admin SELECT preserves
-- anon rendering and removes the last SELECT-policy dependency on
-- is_admin_user(), making the anon EXECUTE revoke below safe. Dropped
-- BEFORE the revoke so no anon query ever evaluates is_admin_user().
-- Retained: authenticated-only (+ service_role) EXECUTE on is_admin_user().
-- Admin INSERT/UPDATE i18n policies (no client write grants) and hero/blog
-- JWT-role policies are intentionally untouched.
drop policy if exists "Admins can select i18n_translations"
  on public.i18n_translations;
revoke all on function public.is_admin_user() from public;
revoke execute on function public.is_admin_user() from anon, authenticated;
grant execute on function public.is_admin_user() to authenticated, service_role;


-- ── 6. Anon view counters stay callable ──────────────────────────────────────
-- The public site increments views with the publishable key; these RPCs must
-- remain EXECUTE-granted to anon/authenticated after the grant tightening.
grant execute on function public.increment_blog_post_views_bigint(bigint)
  to anon, authenticated, service_role;
grant execute on function public.increment_portfolio_post_views_bigint(bigint)
  to anon, authenticated, service_role;

-- ── 7. Posts: published-only public reads ───────────────────────────────────
-- Replaces the USING (true) public policies (drafts were Data-API readable).
-- CMS draft/author lists move to service-role-after-check in the caller
-- cutover; service_role bypasses RLS and is unaffected. Write grants were
-- already revoked (20260818120000); SELECT grants for anon/authenticated are
-- preserved so published reads and view counters keep working.

-- Supabase defaults SELECT-to-PUBLIC on new tables; revoke the pseudo-grant
-- so only the explicit anon/authenticated grants below remain (behavior
-- preserving: no other role legitimately reads these tables).
revoke select on table public.blog_posts from public;
revoke select on table public.portfolio_posts from public;
grant select on table public.blog_posts to anon, authenticated;
grant select on table public.portfolio_posts to anon, authenticated;

drop policy if exists "Allow public read access to blog_posts"
  on public.blog_posts;
drop policy if exists isolated_public_read on public.blog_posts;
drop policy if exists cms_published_read on public.blog_posts;
create policy cms_published_read on public.blog_posts
  for select to anon, authenticated
  using (hidden = false);

drop policy if exists "Public can read posts" on public.portfolio_posts;
drop policy if exists isolated_public_read on public.portfolio_posts;
drop policy if exists cms_published_read on public.portfolio_posts;
create policy cms_published_read on public.portfolio_posts
  for select to anon, authenticated
  using (hidden = false);

-- ── 8. Profiles: narrow grants + self/author/update policies ────────────────
-- CMS profile reads move to service-role-after-check in the caller cutover;
-- the Data API keeps only: self rows for authenticated users, published-post
-- author cards (id/display_name/avatar_url — email is NOT granted to any
-- client role), and a self-UPDATE guard with USING + WITH CHECK (no UPDATE
-- grant exists, so this only constrains a future grant; it can never widen).
revoke all on table public.user_profiles from public, anon, authenticated;
grant select (id, display_name, avatar_url)
  on public.user_profiles to anon, authenticated;

-- Defense in depth alongside section 7: client roles hold no write path.
revoke insert, update, delete, truncate, references, trigger
  on table public.user_profiles from anon, authenticated;

drop policy if exists "Authenticated can read profiles"
  on public.user_profiles;
drop policy if exists "Authenticated can read post authors"
  on public.user_profiles;
drop policy if exists "Public can read post authors" on public.user_profiles;
drop policy if exists "Users can update own profile" on public.user_profiles;
drop policy if exists isolated_public_read on public.user_profiles;

-- Both self + published-author SELECT policies kept intentionally: RLS is
-- permissive (OR), so overlap on own published rows is harmless, and each
-- covers rows the other cannot (self covers own drafts; author covers anon
-- author cards).
drop policy if exists user_profiles_self_read on public.user_profiles;
create policy user_profiles_self_read on public.user_profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists user_profiles_published_author_read
  on public.user_profiles;
create policy user_profiles_published_author_read on public.user_profiles
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.blog_posts bp
      where bp.author_id = user_profiles.id
        and bp.hidden = false
    )
    or exists (
      select 1 from public.portfolio_posts pp
      where pp.author_id = user_profiles.id
        and pp.hidden = false
    )
  );

drop policy if exists user_profiles_self_update on public.user_profiles;
create policy user_profiles_self_update on public.user_profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- cms_allowed_users stays fully internal (service_role + the two RPCs above):
-- re-assert no client or pseudo-role grant survives the new columns.
revoke all on table public.cms_allowed_users from public, anon, authenticated;

-- Idempotent guard: the policies above are meaningless if RLS were ever
-- disabled on these tables. No-op on a healthy project.
alter table public.blog_posts enable row level security;
alter table public.portfolio_posts enable row level security;
alter table public.user_profiles enable row level security;
alter table public.cms_allowed_users enable row level security;
