-- REVIEW-ONLY — DO NOT AUTO-APPLY. Phase 11B.1 staged artifact.
--
-- Atomic compare-and-swap helpers for the DEV Markdown body backfill
-- (`dev_staging` only). This file lives in supabase/review/, so no
-- `supabase db push` / `db reset` / CI path picks it up; it must be reviewed
-- and deliberately promoted before it can ever run. It has NOT been applied.
--
-- WHY THIS EXISTS
--   The backfill switches `body_en_path` / `body_it_path` from NULL to a
--   canonical content-addressed key after uploading the immutable object.
--   A CMS edit can land between planning and switching, so a SELECT followed
--   by an unconditional UPDATE would silently point a row at content that no
--   longer matches its committed legacy body. Both functions below therefore
--   perform the switch as ONE `UPDATE ... WHERE ...` statement: the row is
--   written only if the guard still holds at write time (PostgreSQL
--   re-evaluates the predicate on the locked row). There is no read-then-write
--   path, and a diagnostic read after a zero-row update is used only to label
--   the outcome — it never authorizes a write.
--
-- WHAT IT TOUCHES
--   * dev_staging.blog_posts      — body_en_path / body_it_path ONLY
--   * dev_staging.portfolio_posts — body_en_path / body_it_path ONLY
--   * never `public.*`, never `storage.*`, never a bucket, no RLS/policy
--     change, no grant on a table, no DDL on any table, no data migration.
--   * the legacy `body_en` / `body_it` columns are only READ (hashed); they
--     are never written by either function.
--
-- AUTHORIZATION MODEL (see the GRANT/REVOKE block at the end)
--   * SECURITY DEFINER with a fixed `search_path = pg_catalog, pg_temp`, so
--     no caller-controlled object can be resolved.
--   * Every table reference is schema-qualified; the entity cannot be chosen
--     by the caller beyond the validated 'blog' | 'portfolio' enum, and the
--     destination bucket is never referenced at all (Storage is not involved).
--   * EXECUTE is revoked from PUBLIC, anon and authenticated, and granted to
--     service_role only — the role the CMS server-side executor uses.
--
-- CONTRACT (returns one row; `outcome` is the machine-readable result)
--   Forward:  APPLIED | ALREADY_CURRENT | STALE | MISSING | INVALID_*
--   Rollback: ROLLED_BACK | ALREADY_CURRENT | STALE | MISSING | INVALID_*
--   `reason` is a short non-sensitive code ('body_changed', 'pointer_drift',
--   'already_previous', ...). No body text, hash preimage or path of another
--   post is ever returned.
--
-- ── APPROVAL AND APPLICATION PROCEDURE (separate from this phase) ──────────
--   1. Review this file against the live `dev_staging` shape (pointer columns
--      and their CHECK constraints come from
--      supabase/migrations/20261017170828_add_body_storage_paths_dev_staging.sql).
--   2. Confirm `pg_catalog.sha256(bytea)` is present in the target project
--      (it is, in the dev project: pg_proc/pronamespace = pg_catalog).
--   3. Promote it only by copying it into supabase/migrations/ with a new
--      timestamped name, then applying it through the normal reviewed
--      migration flow. Never apply it to production, never create it in
--      `public`.
--   4. Verify after applying:
--        select p.proname, p.prosecdef, p.proconfig, p.proacl
--          from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'dev_staging' and p.proname like 'dev_backfill%';
--      Expect prosecdef = true, proconfig = {search_path=pg_catalog, pg_temp},
--      and proacl granting EXECUTE to service_role only.
--   5. Roll back the functions themselves with:
--        drop function if exists dev_staging.dev_backfill_body_pointer_cas(text,bigint,text,text,text,text);
--        drop function if exists dev_staging.dev_backfill_body_pointer_rollback(text,bigint,text,text,text,text);
--
-- ── FORWARD CAS ───────────────────────────────────────────────────────────
-- Atomically verifies, in the write statement itself:
--   1. entity is blog or portfolio            (validated before the write)
--   2. locale is en or it                     (validated before the write)
--   3. post id is a positive integer          (validated before the write)
--   4. the row exists                         (UPDATE affects 1 row)
--   5. committed legacy body hashes to the expected SHA-256
--   6. current pointer still equals the expected previous pointer, NULL included
--   7. the destination path is canonical for kind/id/locale/hash
create or replace function dev_staging.dev_backfill_body_pointer_cas(
  p_kind text,
  p_post_id bigint,
  p_locale text,
  p_expected_sha256 text,
  p_expected_previous text,
  p_new_path text
)
returns table (outcome text, reason text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_updated integer := 0;
  v_found boolean := false;
  v_body text;
  v_current text;
begin
  -- ── 1. entity ───────────────────────────────────────────────────────────
  if p_kind is null or p_kind not in ('blog', 'portfolio') then
    return query select 'INVALID_ENTITY'::text, null::text;
    return;
  end if;

  -- ── 2. locale ───────────────────────────────────────────────────────────
  if p_locale is null or p_locale not in ('en', 'it') then
    return query select 'INVALID_LOCALE'::text, null::text;
    return;
  end if;

  -- ── 3. post id ──────────────────────────────────────────────────────────
  if p_post_id is null or p_post_id <= 0 then
    return query select 'INVALID_ID'::text, null::text;
    return;
  end if;

  -- ── 7. canonical destination path (mirrors the CHECK constraints) ───────
  if p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    return query select 'INVALID_HASH'::text, null::text;
    return;
  end if;
  if p_new_path is null
     or p_new_path is distinct from
        pg_catalog.format('%s/%s/%s/%s.md', p_kind, p_post_id::text, p_locale, p_expected_sha256) then
    return query select 'INVALID_PATH'::text, null::text;
    return;
  end if;
  if p_expected_previous is not null
     and p_expected_previous !~ ('^' || p_kind || '/' || p_post_id::text || '/' || p_locale || '/[0-9a-f]{64}\.md$') then
    return query select 'INVALID_PREVIOUS'::text, null::text;
    return;
  end if;

  -- ── 4, 5, 6: the write. Guards 5 and 6 live in this single statement. ───
  if p_kind = 'blog' then
    update dev_staging.blog_posts b
       set body_en_path = case when p_locale = 'en' then p_new_path else b.body_en_path end,
           body_it_path = case when p_locale = 'it' then p_new_path else b.body_it_path end
     where b.id = p_post_id
       and (case when p_locale = 'en' then b.body_en_path else b.body_it_path end)
           is not distinct from p_expected_previous
       and pg_catalog.sha256(
             pg_catalog.convert_to(
               case when p_locale = 'en' then b.body_en else b.body_it end,
               'UTF8'
             )
           ) = pg_catalog.decode(p_expected_sha256, 'hex');
    get diagnostics v_updated = row_count;
  else
    update dev_staging.portfolio_posts p
       set body_en_path = case when p_locale = 'en' then p_new_path else p.body_en_path end,
           body_it_path = case when p_locale = 'it' then p_new_path else p.body_it_path end
     where p.id = p_post_id
       and (case when p_locale = 'en' then p.body_en_path else p.body_it_path end)
           is not distinct from p_expected_previous
       and pg_catalog.sha256(
             pg_catalog.convert_to(
               case when p_locale = 'en' then p.body_en else p.body_it end,
               'UTF8'
             )
           ) = pg_catalog.decode(p_expected_sha256, 'hex');
    get diagnostics v_updated = row_count;
  end if;

  if v_updated > 0 then
    return query select 'APPLIED'::text, null::text;
    return;
  end if;

  -- ── classification of a zero-row write (diagnostic only) ───────────────
  select s.found, s.body, s.current_path
    into v_found, v_body, v_current
    from (
      select true as found,
             case when p_locale = 'en' then b.body_en else b.body_it end as body,
             case when p_locale = 'en' then b.body_en_path else b.body_it_path end as current_path
        from dev_staging.blog_posts b
       where p_kind = 'blog' and b.id = p_post_id
      union all
      select true,
             case when p_locale = 'en' then p.body_en else p.body_it end,
             case when p_locale = 'en' then p.body_en_path else p.body_it_path end
        from dev_staging.portfolio_posts p
       where p_kind = 'portfolio' and p.id = p_post_id
    ) s;

  -- `v_found` is NULL when the diagnostic read matched no row (SELECT INTO
  -- leaves it NULL), so the test is NULL-safe: anything other than a real
  -- `true` means the row does not exist.
  if v_found is distinct from true then
    return query select 'MISSING'::text, null::text;
    return;
  end if;
  if pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8'))
     is distinct from pg_catalog.decode(p_expected_sha256, 'hex') then
    return query select 'STALE'::text, 'body_changed'::text;
    return;
  end if;
  if v_current is not distinct from p_new_path then
    return query select 'ALREADY_CURRENT'::text, null::text;
    return;
  end if;
  return query select 'STALE'::text, 'pointer_drift'::text;
end
$fn$;

comment on function dev_staging.dev_backfill_body_pointer_cas(text, bigint, text, text, text, text) is
  'DEV-only atomic CAS for the Markdown body backfill: sets the body_<locale>_path pointer only when the committed legacy body still hashes to the expected SHA-256 and the current pointer still equals the expected previous value (NULL included). Returns APPLIED|ALREADY_CURRENT|STALE|MISSING|INVALID_*. Review-only artifact; not auto-applied.';

-- ── ROLLBACK CAS ──────────────────────────────────────────────────────────
-- Atomically verifies: the row exists, its current pointer is exactly the
-- pointer this run installed, and its committed legacy body still matches the
-- recorded source SHA-256. Only then is the previous pointer restored (usually
-- NULL). A CMS edit after the backfill, or any pointer drift, yields STALE and
-- is reported instead of forced.
create or replace function dev_staging.dev_backfill_body_pointer_rollback(
  p_kind text,
  p_post_id bigint,
  p_locale text,
  p_installed_path text,
  p_expected_sha256 text,
  p_previous_path text
)
returns table (outcome text, reason text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_updated integer := 0;
  v_found boolean := false;
  v_body text;
  v_current text;
begin
  if p_kind is null or p_kind not in ('blog', 'portfolio') then
    return query select 'INVALID_ENTITY'::text, null::text;
    return;
  end if;
  if p_locale is null or p_locale not in ('en', 'it') then
    return query select 'INVALID_LOCALE'::text, null::text;
    return;
  end if;
  if p_post_id is null or p_post_id <= 0 then
    return query select 'INVALID_ID'::text, null::text;
    return;
  end if;
  if p_expected_sha256 is null or p_expected_sha256 !~ '^[0-9a-f]{64}$' then
    return query select 'INVALID_HASH'::text, null::text;
    return;
  end if;
  if p_installed_path is null
     or p_installed_path !~ ('^' || p_kind || '/' || p_post_id::text || '/' || p_locale || '/[0-9a-f]{64}\.md$') then
    return query select 'INVALID_INSTALLED'::text, null::text;
    return;
  end if;
  if p_previous_path = p_installed_path then
    return query select 'INVALID_PREVIOUS'::text, 'same_as_installed'::text;
    return;
  end if;
  if p_previous_path is not null
     and p_previous_path !~ ('^' || p_kind || '/' || p_post_id::text || '/' || p_locale || '/[0-9a-f]{64}\.md$') then
    return query select 'INVALID_PREVIOUS'::text, null::text;
    return;
  end if;

  -- The write: guards (row, installed pointer, body hash) are all in the
  -- statement. Only the pointer column is ever set.
  if p_kind = 'blog' then
    update dev_staging.blog_posts b
       set body_en_path = case when p_locale = 'en' then p_previous_path else b.body_en_path end,
           body_it_path = case when p_locale = 'it' then p_previous_path else b.body_it_path end
     where b.id = p_post_id
       and (case when p_locale = 'en' then b.body_en_path else b.body_it_path end)
           is not distinct from p_installed_path
       and pg_catalog.sha256(
             pg_catalog.convert_to(
               case when p_locale = 'en' then b.body_en else b.body_it end,
               'UTF8'
             )
           ) = pg_catalog.decode(p_expected_sha256, 'hex');
    get diagnostics v_updated = row_count;
  else
    update dev_staging.portfolio_posts p
       set body_en_path = case when p_locale = 'en' then p_previous_path else p.body_en_path end,
           body_it_path = case when p_locale = 'it' then p_previous_path else p.body_it_path end
     where p.id = p_post_id
       and (case when p_locale = 'en' then p.body_en_path else p.body_it_path end)
           is not distinct from p_installed_path
       and pg_catalog.sha256(
             pg_catalog.convert_to(
               case when p_locale = 'en' then p.body_en else p.body_it end,
               'UTF8'
             )
           ) = pg_catalog.decode(p_expected_sha256, 'hex');
    get diagnostics v_updated = row_count;
  end if;

  if v_updated > 0 then
    return query select 'ROLLED_BACK'::text, null::text;
    return;
  end if;

  select s.found, s.body, s.current_path
    into v_found, v_body, v_current
    from (
      select true as found,
             case when p_locale = 'en' then b.body_en else b.body_it end as body,
             case when p_locale = 'en' then b.body_en_path else b.body_it_path end as current_path
        from dev_staging.blog_posts b
       where p_kind = 'blog' and b.id = p_post_id
      union all
      select true,
             case when p_locale = 'en' then p.body_en else p.body_it end,
             case when p_locale = 'en' then p.body_en_path else p.body_it_path end
        from dev_staging.portfolio_posts p
       where p_kind = 'portfolio' and p.id = p_post_id
    ) s;

  -- `v_found` is NULL when the diagnostic read matched no row (SELECT INTO
  -- leaves it NULL), so the test is NULL-safe: anything other than a real
  -- `true` means the row does not exist.
  if v_found is distinct from true then
    return query select 'MISSING'::text, null::text;
    return;
  end if;
  if pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8'))
     is distinct from pg_catalog.decode(p_expected_sha256, 'hex') then
    return query select 'STALE'::text, 'body_changed'::text;
    return;
  end if;
  if v_current is not distinct from p_previous_path then
    return query select 'ALREADY_CURRENT'::text, 'already_previous'::text;
    return;
  end if;
  return query select 'STALE'::text, 'pointer_drift'::text;
end
$fn$;

comment on function dev_staging.dev_backfill_body_pointer_rollback(text, bigint, text, text, text, text) is
  'DEV-only atomic CAS rollback for the Markdown body backfill: restores the previous pointer only while it is still exactly the pointer the run installed and the committed legacy body still matches the recorded SHA-256. Returns ROLLED_BACK|ALREADY_CURRENT|STALE|MISSING|INVALID_*. Never writes body_en/body_it. Review-only artifact; not auto-applied.';

-- ── PRIVILEGES ────────────────────────────────────────────────────────────
-- PUBLIC receives EXECUTE on new functions by default; remove it, then deny
-- the API roles explicitly and allow only the server-side executor role.
revoke all on function dev_staging.dev_backfill_body_pointer_cas(text, bigint, text, text, text, text) from public;
revoke all on function dev_staging.dev_backfill_body_pointer_cas(text, bigint, text, text, text, text) from anon;
revoke all on function dev_staging.dev_backfill_body_pointer_cas(text, bigint, text, text, text, text) from authenticated;
grant execute on function dev_staging.dev_backfill_body_pointer_cas(text, bigint, text, text, text, text) to service_role;

revoke all on function dev_staging.dev_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from public;
revoke all on function dev_staging.dev_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from anon;
revoke all on function dev_staging.dev_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from authenticated;
grant execute on function dev_staging.dev_backfill_body_pointer_rollback(text, bigint, text, text, text, text) to service_role;
