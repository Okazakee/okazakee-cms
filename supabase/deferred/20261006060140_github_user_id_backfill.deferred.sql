-- DEFERRED — DO NOT APPLY under the public-schema/non-data freeze.
-- Source: supabase/migrations/20261006060140_harden_unified_identity_privacy.sql
--   original section 2 (lines 91-162), extracted VERBATIM below.
-- Contains the ONLY public-row DML of the hardening set: three UPDATEs that
-- copy auth.identities sub values into public.user_profiles / cms_allowed_users.
-- Owner grants permission for metadata/schema-only hardening; these row
-- movements stay parked here until an explicit later data authorization.
-- This file lives OUTSIDE supabase/migrations/ so the CLI never applies it,
-- and it MUST NOT be moved into migrations/ or executed until that approval.
-- Preconditions when it is eventually revisited: safe hardening applied,
-- explicit row-movement approval, staging-first, dummy-*.local exclusion kept.

-- ── 2. Backfill from provider-verified identity records ─────────────────────
-- Source of truth is auth.identities (provider-signed), never user_metadata.
-- Dummy/local rows (dummy-*.local) never receive a provider subject.

-- 2a. Profiles join by auth user id (exact, no takeover possible).
update public.user_profiles p
set github_user_id = gi.sub
from (
  select distinct on (gi.user_id)
    gi.user_id as user_id,
    gi.identity_data->>'sub' as sub
  from auth.identities gi
  where gi.provider = 'github'
    and gi.identity_data->>'sub' ~ '^[0-9]+$'
  order by gi.user_id, gi.updated_at desc
) gi
where p.id = gi.user_id
  and p.github_user_id is null
  and (p.email is null or lower(p.email) not like '%@dummy.local')
  and not exists (
    select 1 from public.user_profiles x
    where x.github_user_id = gi.sub
  );

-- 2b. Allowlist rows join by verified login email (exact lower() match).
update public.cms_allowed_users a
set github_user_id = m.sub
from (
  select distinct on (lower(u.email))
    lower(u.email) as email,
    gi.identity_data->>'sub' as sub
  from auth.users u
  join auth.identities gi
    on gi.user_id = u.id
   and gi.provider = 'github'
  where u.email is not null
    and u.email_confirmed_at is not null
    and gi.identity_data->>'sub' ~ '^[0-9]+$'
  order by lower(u.email), gi.updated_at desc
) m
where a.github_user_id is null
  and a.email is not null
  and lower(a.email) not like '%@dummy.local'
  and lower(a.email) = m.email
  and not exists (
    select 1 from public.cms_allowed_users x
    where x.github_user_id = m.sub
  );

-- 2c. Legacy handle rows (no email) join by provider-verified user_name.
-- Transitional only: dual-allowed rows keep working until the ID backfill
-- covers them. A subject already claimed by another row is never remapped.
update public.cms_allowed_users a
set github_user_id = m.sub
from (
  select distinct on (lower(gi.identity_data->>'user_name'))
    lower(gi.identity_data->>'user_name') as user_name,
    gi.identity_data->>'sub' as sub
  from auth.identities gi
  where gi.provider = 'github'
    and gi.identity_data->>'sub' ~ '^[0-9]+$'
    and gi.identity_data->>'user_name' is not null
  order by lower(gi.identity_data->>'user_name'), gi.updated_at desc
) m
where a.github_user_id is null
  and a.email is null
  and a.github_username is not null
  and lower(a.github_username) = m.user_name
  and not exists (
    select 1 from public.cms_allowed_users x
    where x.github_user_id = m.sub
  );

