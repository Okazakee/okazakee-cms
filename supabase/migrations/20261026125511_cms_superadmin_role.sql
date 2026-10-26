-- 20261026125511_cms_superadmin_role.sql
-- CMS role hierarchy: widen the allowlist CHECK and teach the public identity
-- functions about `superadmin`, without promoting anything.
--
-- Scope (explicit, both schemas):
--   public:       role CHECK widened; cms_lookup_current_user(p_schema) and
--                 is_admin_user() updated; last-superadmin guard trigger.
--   dev_staging: role CHECK widened; last-superadmin guard trigger.
--                 (dev_staging has no identity/admin function copies, and
--                 this migration must NOT create any public-reading dev RPC.)
--
-- Invariants:
--   * No automatic promotion: no row changes role here.
--   * ONE identity function, schema-selecting: public.cms_lookup_current_user
--     takes `p_schema text DEFAULT 'public'`. Identity always comes from
--     auth.uid()/auth.users/auth.identities; the parameter only chooses which
--     OWN-identity allowlist (public or dev_staging) is read. The legacy
--     zero-argument overload is dropped in the same migration, so exactly one
--     callable exists while an already-deployed no-arg call keeps working
--     (default = 'public') during the code rollout.
--   * The identity match order stays canonical: immutable GitHub subject ->
--     verified email (which DECIDES) -> provider-verified legacy handle only
--     when the session has no verified email. Never user_metadata.
--   * The last superadmin can never be demoted/removed, even by two
--     concurrent transactions: the trigger serialises the guarded path with
--     an advisory transaction lock before counting.
--   * `superadmin` remains bootstrap-only in the application; this migration
--     only makes the vocabulary and the DB backstop consistent.
--
-- Deployment order (parent): apply this file first (backward compatible: no
-- superadmin rows exist yet), then deploy the matching CMS code, then
-- bootstrap exactly one named identity in SQL.
--
-- Rollback sketch (parent only, new migration): drop both guard triggers and
-- functions, restore the previous role CHECK, and restore the previous
-- function bodies. Dropping the triggers is required before intentionally
-- reaching zero superadmins.

-- ── 1. public.cms_allowed_users: widen the role CHECK ───────────────────────
-- The live constraint name is not part of the source history, so discover and
-- drop every role CHECK on this table first instead of guessing a name.
do $public_check$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.cms_allowed_users'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format(
      'alter table public.cms_allowed_users drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$public_check$;

alter table public.cms_allowed_users
  add constraint cms_allowed_users_role_check
  check (role in ('editor', 'admin', 'superadmin'));

-- Allowlist stays fully internal: service_role plus the SECURITY DEFINER RPCs
-- only. Re-asserted so no future grant drift silently opens a client path.
revoke all on table public.cms_allowed_users from public, anon, authenticated;

-- ── 2. public.cms_lookup_current_user(p_schema): ONE schema-aware RPC ───────
-- Identity is ALWAYS the caller's JWT (auth.uid() -> auth.users/auth.identities):
-- the parameter only selects which allowlist is read, so a session can never
-- learn another user's row and no caller-supplied identity is accepted.
--
-- * `p_schema` must be EXACTLY `public` or `dev_staging` (whitelist). Anything
--   else returns NULL; so does a whitelisted schema whose allowlist table is
--   absent — there is never a silent fallback to public.
-- * The table is interpolated with %I only after that whitelist check, and all
--   values are passed through USING; `search_path` stays empty.
-- * `default 'public'` keeps an already-deployed no-argument RPC call valid
--   during the rollout, while the legacy zero-argument overload is dropped
--   first so exactly one candidate remains (no PostgREST overload ambiguity).
-- * A verified email DECIDES: an unmatched verified address returns NULL
--   instead of falling through to the legacy display handle (parity with
--   is_admin_user(), which keeps its public-only semantics).

-- Drop the legacy zero-argument overload. Never cascade: a dependent
-- policy/view would mean the identity contract changed in a way this migration
-- must not silently paper over.
do $drop_legacy_lookup$
declare
  v_legacy regprocedure := to_regprocedure('public.cms_lookup_current_user()');
  v_dependents text;
begin
  if v_legacy is null then
    return;
  end if;

  select string_agg(
           distinct pg_describe_object(d.classid, d.objid, d.objsubid),
           ', '
         )
    into v_dependents
    from pg_depend d
    where d.refclassid = 'pg_proc'::regclass
      and d.refobjid = v_legacy::oid
      and d.deptype = 'n';

  if v_dependents is not null then
    raise exception
      'refusing to drop public.cms_lookup_current_user(): dependents %',
      v_dependents
      using errcode = 'dependent_objects_still_exist';
  end if;

  drop function public.cms_lookup_current_user();
end;
$drop_legacy_lookup$;

create or replace function public.cms_lookup_current_user(
  p_schema text default 'public'
)
returns jsonb
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
    return null;
  end if;

  -- Exact whitelist: this parameter names a table, so it is never interpolated
  -- unless it is one of these two literals.
  if p_schema is null or p_schema not in ('public', 'dev_staging') then
    return null;
  end if;

  -- Whitelisted schema without the allowlist table: fail closed.
  if to_regclass(format('%I.cms_allowed_users', p_schema)) is null then
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
    execute format($lookup$
      select role
      from %I.cms_allowed_users
      where github_user_id = $1::text
        and role in ('editor', 'admin', 'superadmin')
      limit 1
    $lookup$, p_schema)
      into v_role
      using v_github_id;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', 'github');
    end if;
  end if;

  -- 2. Verified email decides: an unverified address never matches, and an
  -- unmatched verified address never falls through to the legacy handle.
  if v_email_verified and v_email is not null then
    execute format($lookup$
      select role
      from %I.cms_allowed_users
      where lower(email) = lower($1::text)
        and role in ('editor', 'admin', 'superadmin')
      limit 1
    $lookup$, p_schema)
      into v_role
      using v_email;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', 'email');
    end if;
    return null;
  end if;

  -- 3. Transitional legacy handle, provider-verified (identities record),
  -- never user_metadata. Only reachable with no verified email.
  if v_github_username is not null then
    execute format($lookup$
      select role
      from %I.cms_allowed_users
      where lower(github_username) = lower($1::text)
        and role in ('editor', 'admin', 'superadmin')
      limit 1
    $lookup$, p_schema)
      into v_role
      using v_github_username;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', 'github');
    end if;
  end if;

  return null;
end;
$function$;

-- Restricted grants for the exact text signature: anon never reaches the
-- allowlist; only an authenticated session (or the service key) can call it.
revoke all on function public.cms_lookup_current_user(text) from public;
revoke execute on function public.cms_lookup_current_user(text)
  from anon, authenticated;
grant execute on function public.cms_lookup_current_user(text)
  to authenticated, service_role;

-- Post-condition: exactly one cms_lookup_current_user overload may exist, or
-- the Data API would face an ambiguous function choice.
do $lookup_overloads$
declare
  v_overloads integer;
begin
  select count(*)
    into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'cms_lookup_current_user';

  if v_overloads <> 1 then
    raise exception
      'expected exactly one public.cms_lookup_current_user overload, found %',
      v_overloads;
  end if;
end;
$lookup_overloads$;

-- ── 3. public.is_admin_user(): superadmin is admin-level ────────────────────
-- ID decides, verified email decides (no fallthrough), legacy handle last.
-- `superadmin` satisfies the admin predicate so admin RLS policies keep
-- working for the owner account.
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
        and role in ('editor', 'admin', 'superadmin')
      limit 1;
    if v_role is not null then
      return v_role in ('admin', 'superadmin');
    end if;
  end if;

  -- 2. Verified email decides immediately: no fallthrough to the handle.
  if v_email_verified and v_email is not null then
    select role
      into v_role
      from public.cms_allowed_users
      where lower(email) = lower(v_email)
        and role in ('editor', 'admin', 'superadmin')
      limit 1;
    return coalesce(v_role in ('admin', 'superadmin'), false);
  end if;

  -- 3. Transitional legacy handle (no verified email on the session).
  if v_github_username is not null then
    select role
      into v_role
      from public.cms_allowed_users
      where lower(github_username) = lower(v_github_username)
        and role in ('editor', 'admin', 'superadmin')
      limit 1;
    return coalesce(v_role in ('admin', 'superadmin'), false);
  end if;

  return false;
end;
$function$;

revoke all on function public.is_admin_user() from public;
revoke execute on function public.is_admin_user() from anon, authenticated;
grant execute on function public.is_admin_user() to authenticated, service_role;

-- ── 4. Last-superadmin guard (atomic) ───────────────────────────────────────
-- Demoting or deleting the last superadmin would leave the CMS with no
-- bootstrap-level operator. The advisory transaction lock serialises the
-- guarded path so two concurrent demotions cannot both observe >1 row; the
-- lock is scoped to this invariant and cannot block ordinary allowlist writes.
create or replace function public.cms_allowed_users_guard_superadmin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $guard$
begin
  if tg_op = 'DELETE' then
    if old.role = 'superadmin' then
      perform pg_advisory_xact_lock(
        hashtext('cms_allowed_users_guard_superadmin')
      );
      if not exists (
        select 1
        from public.cms_allowed_users
        where role = 'superadmin'
          and id <> old.id
      ) then
        raise exception 'Cannot remove the last superadmin'
          using errcode = '55000';
      end if;
    end if;
    return old;
  end if;

  if old.role = 'superadmin' and new.role is distinct from 'superadmin' then
    perform pg_advisory_xact_lock(
      hashtext('cms_allowed_users_guard_superadmin')
    );
    if not exists (
      select 1
      from public.cms_allowed_users
      where role = 'superadmin'
        and id <> old.id
    ) then
      raise exception 'Cannot demote the last superadmin'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$guard$;

revoke all on function public.cms_allowed_users_guard_superadmin()
  from public, anon, authenticated;

drop trigger if exists cms_allowed_users_guard_superadmin
  on public.cms_allowed_users;
create trigger cms_allowed_users_guard_superadmin
  before update or delete on public.cms_allowed_users
  for each row execute function public.cms_allowed_users_guard_superadmin();

-- ── 5. dev_staging mirror ───────────────────────────────────────────────────
-- Schema-explicit and conditional: the isolated/test stacks may not provision
-- dev_staging, and dev_staging must never grow public-reading RPC copies.
-- Only the CHECK and the guard trigger are mirrored.
do $dev_staging$
declare
  v_constraint record;
begin
  if to_regclass('dev_staging.cms_allowed_users') is null then
    raise notice 'dev_staging.cms_allowed_users absent: skipping dev_staging RBAC mirror';
    return;
  end if;

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'dev_staging.cms_allowed_users'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format(
      'alter table dev_staging.cms_allowed_users drop constraint %I',
      v_constraint.conname
    );
  end loop;

  execute $dev_check$
    alter table dev_staging.cms_allowed_users
      add constraint cms_allowed_users_role_check
      check (role in ('editor', 'admin', 'superadmin'))
  $dev_check$;

  execute $dev_guard$
    create or replace function dev_staging.cms_allowed_users_guard_superadmin()
    returns trigger
    language plpgsql
    security definer
    set search_path = ''
    as $guard$
    begin
      if tg_op = 'DELETE' then
        if old.role = 'superadmin' then
          perform pg_advisory_xact_lock(
            hashtext('dev_staging_cms_allowed_users_guard_superadmin')
          );
          if not exists (
            select 1
            from dev_staging.cms_allowed_users
            where role = 'superadmin'
              and id <> old.id
          ) then
            raise exception 'Cannot remove the last superadmin'
              using errcode = '55000';
          end if;
        end if;
        return old;
      end if;

      if old.role = 'superadmin' and new.role is distinct from 'superadmin' then
        perform pg_advisory_xact_lock(
          hashtext('dev_staging_cms_allowed_users_guard_superadmin')
        );
        if not exists (
          select 1
          from dev_staging.cms_allowed_users
          where role = 'superadmin'
            and id <> old.id
        ) then
          raise exception 'Cannot demote the last superadmin'
            using errcode = '55000';
        end if;
      end if;

      return new;
    end;
    $guard$
  $dev_guard$;

  execute 'revoke all on function dev_staging.cms_allowed_users_guard_superadmin() from public, anon, authenticated';

  execute 'drop trigger if exists cms_allowed_users_guard_superadmin on dev_staging.cms_allowed_users';
  execute 'create trigger cms_allowed_users_guard_superadmin
    before update or delete on dev_staging.cms_allowed_users
    for each row execute function dev_staging.cms_allowed_users_guard_superadmin()';
end;
$dev_staging$;
