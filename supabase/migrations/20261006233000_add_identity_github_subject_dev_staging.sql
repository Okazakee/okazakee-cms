-- Dev-only catch-up: immutable GitHub subject columns in the `dev_staging`
-- clone, mirroring section 1 of
-- `supabase/review/20261006060140_harden_unified_identity_privacy.safe.sql`
-- (applied to `public` as native history `20261006082930`).
--
-- WHY: the CMS source selects `github_user_id` when it syncs the signed-in
-- user's profile and when it looks the allowlist up by immutable subject
-- (`buildCmsUser` / `syncCmsUserProfile` / `findAllowedCmsUser`). Only
-- `public` carried the column, so the staging CMS (branch `staging`,
-- NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging) died at boot with
-- `column user_profiles.github_user_id does not exist`. This file brings the
-- clone to parity with the deployed callers.
--
-- SCHEMA: every statement is explicitly `dev_staging.`-qualified so it cannot
-- resolve through search_path and cannot reach production content. Against a
-- database without a `dev_staging` schema this file fails loudly instead of
-- altering `public`:
--   dev:  apply as-is (the staging CMS and local dev already resolve
--         dev_staging)
--   prod: promote deliberately, do not replay this file there
--
-- NO BACKFILL, by design: exactly like the public apply, the column stays
-- NULL for pre-existing rows ("never configured" authorises through verified
-- email or the legacy handle). The parked public-row backfill
-- (`supabase/deferred/20261006060140_github_user_id_backfill.deferred.sql`,
-- which still needs its own data authorisation) is deliberately NOT mirrored
-- here.

alter table dev_staging.cms_allowed_users
  add column if not exists github_user_id text;

alter table dev_staging.user_profiles
  add column if not exists github_user_id text;

-- Numeric-only subjects; display handles stay in github_username
-- (render-only). Idempotent: drop-then-add so re-runs converge instead of
-- erroring on duplicate constraint names.
alter table dev_staging.cms_allowed_users
  drop constraint if exists cms_allowed_users_github_user_id_numeric;
alter table dev_staging.cms_allowed_users
  add constraint cms_allowed_users_github_user_id_numeric
  check (github_user_id is null or github_user_id ~ '^[0-9]+$');

alter table dev_staging.user_profiles
  drop constraint if exists user_profiles_github_user_id_numeric;
alter table dev_staging.user_profiles
  add constraint user_profiles_github_user_id_numeric
  check (github_user_id is null or github_user_id ~ '^[0-9]+$');

-- One subject authorises at most one allowlist row / one profile. Partial
-- indexes keep NULLs (email/dummy/legacy rows) unconstrained, and they also
-- serve the equality lookups, so no plain index is added.
create unique index if not exists cms_allowed_users_github_user_id_uidx
  on dev_staging.cms_allowed_users (github_user_id)
  where github_user_id is not null;

create unique index if not exists user_profiles_github_user_id_uidx
  on dev_staging.user_profiles (github_user_id)
  where github_user_id is not null;

comment on column dev_staging.cms_allowed_users.github_user_id is
  'Immutable numeric GitHub subject (auth.identities sub). Authorizes; github_username is display-only.';
comment on column dev_staging.user_profiles.github_user_id is
  'Immutable numeric GitHub subject (auth.identities sub). Mirrors the allowlist; github_username is display-only.';

-- REVERSIBLE
--   drop index if exists dev_staging.cms_allowed_users_github_user_id_uidx;
--   drop index if exists dev_staging.user_profiles_github_user_id_uidx;
--   alter table dev_staging.cms_allowed_users drop column if exists github_user_id;
--   alter table dev_staging.user_profiles drop column if exists github_user_id;
-- Dropping both columns restores the pre-hardening clone: the columns were
-- never backfilled, so no stored value is lost, and every other object
-- (grants, RLS, existing indexes) is untouched by this file.
