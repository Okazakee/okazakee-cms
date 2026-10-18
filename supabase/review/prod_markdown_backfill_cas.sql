-- REVIEW-ONLY — DO NOT AUTO-APPLY. Phase 13B.1 staged artifact.
--
-- Production Markdown body pointer schema + atomic compare-and-swap helpers
-- (`public` on project mtvwynyikouqzmhqespl). This file lives in
-- supabase/review/, so no `supabase db push` / `db reset` / CI path picks it
-- up; it must be reviewed and deliberately promoted before it can ever run.
-- IT HAS NOT BEEN APPLIED, and this phase must not apply it.
--
-- SOURCE OF TRUTH: supabase/review/dev_markdown_backfill_cas.sql (deployed to
-- dev_staging and proven there) plus
-- supabase/migrations/20261017170828_add_body_storage_paths_dev_staging.sql
-- for the column and constraint shapes. The function bodies below are the DEV
-- implementation with only the schema and function names changed, so the
-- proven semantics are preserved byte-for-byte; everything added on top is the
-- production DDL and the production authorization/exposure notes.
--
-- WHY THIS EXISTS
--   The backfill switches `body_en_path` / `body_it_path` from NULL to a
--   canonical content-addressed key after uploading the immutable object.
--   A CMS edit can land between planning and switching, so a SELECT followed
--   by an unconditional UPDATE would silently point a row at content that no
--   longer matches its committed legacy body, and a later Storage-first read
--   would fail the legacy/Storage agreement check on content the CMS believes
--   it saved. Both functions below therefore perform the switch as ONE
--   `UPDATE ... WHERE ...` statement: the row is written only if the guard
--   still holds at write time (PostgreSQL re-evaluates the predicate on the
--   locked row). There is no read-then-write path, and the diagnostic read
--   after a zero-row update is used only to label the outcome — it never
--   authorizes a write.
--
-- WHAT IT TOUCHES
--   * public.blog_posts      — body_en_path / body_it_path (columns + CHECKs
--                              below, then pointer writes by the functions)
--   * public.portfolio_posts — the same
--   * never a bucket, never an object, never a Storage policy, no grant on a
--     table, no other DDL, no data migration, no backfill execution.
--   * the legacy `body_en` / `body_it` columns are only READ (hashed); they
--     are never written. body_en is NOT NULL and stays so; body_it stays
--     nullable.
--   * NULL stays valid: both columns remain nullable so the transition can be
--     incremental, and the CHECKs accept NULL.
--
-- TRANSACTION BOUNDARIES
--   * The whole file is written to be applied inside ONE transaction (the
--     reviewed migration flow wraps it; if run by hand, use BEGIN/COMMIT).
--     The four-column DDL, the constraints, both function definitions and the
--     grants either all land or none do, so the CMS can never observe a
--     half-installed capability.
--   * Each CAS call is a single statement and therefore atomic: the guard and
--     the write cannot be separated by a concurrent CMS edit, which blocks on
--     the row lock until the sweep commits.
--   * The CHECK constraints are added with an ACCESS EXCLUSIVE lock and are
--     validated against the 34 existing rows; those rows all have NULL
--     pointers, so validation is trivially satisfied and takes no meaningful
--     time at this scale.
--
-- IDEMPOTENCY / REPEAT APPLICATION
--   * Column adds use IF NOT EXISTS; each CHECK is added from a scoped DO
--     block only when pg_constraint does not already carry that name for the
--     table (PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS).
--   * `create or replace function` redefines in place; re-granting and
--     re-revoking are idempotent.
--   * Applying this file twice must therefore be a no-op on data. The isolated
--     suite asserts that (schema: repeat-application test).
--   * Re-calling the CAS on a row already at the destination returns
--     ALREADY_CURRENT and writes nothing.
--
-- POSTGREST EXPOSURE (required for the CMS administrative RPC path)
--   `public` IS the PostgREST-exposed schema, so these two functions become
--   visible as `/rest/v1/rpc/prod_backfill_body_pointer_cas` and
--   `/rest/v1/rpc/prod_backfill_body_pointer_rollback`. That is intended: the
--   CMS server-side executor calls them through the service-role key.
--   They are not callable through the publishable/anon path: the GRANT block
--   revokes EXECUTE from PUBLIC, anon and authenticated and grants it to
--   service_role only, and EXECUTE is the PostgREST gate for rpc. A call from
--   anon/authenticated therefore fails with 42501 before the function body
--   runs, independent of RLS. Both are SECURITY DEFINER with a fixed
--   `search_path = pg_catalog, pg_temp` (so RLS on the two content tables does
--   not apply inside them by design — they are the privileged administrative
--   path) and every reference is schema-qualified.
--   The functions are marked VOLATILE (default): they write, so PostgREST must
--   never treat them as read-only.
--
-- CMS ACTIVATION ORDER (must be honoured by the Phase 14 runbook)
--   1. Apply this file (columns + constraints + functions) and verify the four
--      columns, four constraints and both function ACLs exist.
--   2. Only then set CMS_BODY_POINTER_COLUMNS=true — its value is a deployment
--      ASSERTION that the schema above exists, not proof of it, and enabling
--      it does not create anything. It defaults off, so nothing referenced the
--      columns before step 1.
--   3. Keep CMS_BODY_DUAL_WRITE_ENABLED off until the backfill has populated
--      the pointers; enabling dual-write does not bypass schema readiness (it
--      still needs the columns), and with the pointers populated a legacy-only
--      edit clears the affected pointer instead of leaving it stale.
--
-- ── APPROVAL AND APPLICATION PROCEDURE (separate from this phase) ──────────
--   1. Review this file against the live `public` shape (4-column target on
--      both tables, both currently without pointer columns).
--   2. Confirm `pg_catalog.sha256(bytea)` is present in the project (verify in
--      pg_proc/pronamespace = pg_catalog; it is the same project family as the
--      DEV deployment, but re-verify).
--   3. Promote it only by copying it into supabase/migrations/ with a new
--      timestamped name, then applying it through the normal reviewed
--      migration flow, after the approved production snapshot.
--   4. Verify after applying:
--        select p.proname, p.prosecdef, p.proconfig, p.proacl
--          from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public' and p.proname like 'prod_backfill%';
--      Expect prosecdef = true, proconfig = {search_path=pg_catalog, pg_temp},
--      and proacl granting EXECUTE to service_role only. Also confirm an
--      anon-key RPC call returns 42501 and that both columns stay NULL on all
--      34 rows (this file never writes data).
--   5. Roll back the functions themselves with:
--        drop function if exists public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text);
--        drop function if exists public.prod_backfill_body_pointer_rollback(text,bigint,text,text,text,text);
--      (Column/constraint rollback is deliberately NOT staged here: dropping
--      them after pointers exist would destroy the pointer state the rollback
--      path depends on. They are additive and harmless while NULL.)
--
-- ==========================================================================
-- SECTION 1 — POINTER COLUMNS AND CONSTRAINTS (mirror of the DEV shapes)
-- ==========================================================================
-- POINTER CONTRACT (immutable, content-addressed, no leading slash):
--   blog/<id>/en/<sha256>.md
--   blog/<id>/it/<sha256>.md
--   portfolio/<id>/en/<sha256>.md
--   portfolio/<id>/it/<sha256>.md
-- where <id> is the row's own numeric id, <sha256> is exactly 64 lowercase hex
-- characters, and the extension is exactly `.md`. The four CHECK constraints
-- are the canonical enforcement of entity + row id + locale + SHA-256; the
-- functions re-validate the same shape before writing, so a caller cannot
-- install a non-canonical pointer even if it bypassed the constraint's naming.

alter table public.blog_posts
  add column if not exists body_en_path text,
  add column if not exists body_it_path text;

alter table public.portfolio_posts
  add column if not exists body_en_path text,
  add column if not exists body_it_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'blog_posts_body_en_path_check'
       and conrelid = 'public.blog_posts'::regclass
  ) then
    alter table public.blog_posts
      add constraint blog_posts_body_en_path_check check (
        body_en_path is null
        or body_en_path ~ ('^blog/' || id::text || '/en/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'blog_posts_body_it_path_check'
       and conrelid = 'public.blog_posts'::regclass
  ) then
    alter table public.blog_posts
      add constraint blog_posts_body_it_path_check check (
        body_it_path is null
        or body_it_path ~ ('^blog/' || id::text || '/it/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'portfolio_posts_body_en_path_check'
       and conrelid = 'public.portfolio_posts'::regclass
  ) then
    alter table public.portfolio_posts
      add constraint portfolio_posts_body_en_path_check check (
        body_en_path is null
        or body_en_path ~ ('^portfolio/' || id::text || '/en/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'portfolio_posts_body_it_path_check'
       and conrelid = 'public.portfolio_posts'::regclass
  ) then
    alter table public.portfolio_posts
      add constraint portfolio_posts_body_it_path_check check (
        body_it_path is null
        or body_it_path ~ ('^portfolio/' || id::text || '/it/[0-9a-f]{64}\.md$')
      );
  end if;
end $$;

-- ==========================================================================
-- SECTION 2 — ATOMIC CAS FUNCTIONS
-- ==========================================================================
-- ── FORWARD CAS ───────────────────────────────────────────────────────────
-- Atomically verifies, in the write statement itself:
--   1. entity is blog or portfolio            (validated before the write)
--   2. locale is en or it                     (validated before the write)
--   3. post id is a positive integer          (validated before the write)
--   4. the row exists                         (UPDATE affects 1 row)
--   5. committed legacy body hashes to the expected SHA-256
--   6. current pointer still equals the expected previous pointer, NULL included
--   7. the destination path is canonical for kind/id/locale/hash
create or replace function public.prod_backfill_body_pointer_cas(
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
    update public.blog_posts b
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
    update public.portfolio_posts p
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
        from public.blog_posts b
       where p_kind = 'blog' and b.id = p_post_id
      union all
      select true,
             case when p_locale = 'en' then p.body_en else p.body_it end,
             case when p_locale = 'en' then p.body_en_path else p.body_it_path end
        from public.portfolio_posts p
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

comment on function public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text) is
  'Production atomic CAS for the Markdown body backfill: sets the body_<locale>_path pointer only when the committed legacy body still hashes to the expected SHA-256 and the current pointer still equals the expected previous value (NULL included). Returns APPLIED|ALREADY_CURRENT|STALE|MISSING|INVALID_*. Review-only artifact; not auto-applied.';

-- ── ROLLBACK CAS ──────────────────────────────────────────────────────────
-- Atomically verifies: the row exists, its current pointer is exactly the
-- pointer this run installed, and its committed legacy body still matches the
-- recorded source SHA-256. Only then is the previous pointer restored (usually
-- NULL). A CMS edit after the backfill, or any pointer drift, yields STALE and
-- is reported instead of forced.
create or replace function public.prod_backfill_body_pointer_rollback(
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
    update public.blog_posts b
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
    update public.portfolio_posts p
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
        from public.blog_posts b
       where p_kind = 'blog' and b.id = p_post_id
      union all
      select true,
             case when p_locale = 'en' then p.body_en else p.body_it end,
             case when p_locale = 'en' then p.body_en_path else p.body_it_path end
        from public.portfolio_posts p
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

comment on function public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text) is
  'Production atomic CAS rollback for the Markdown body backfill: restores the previous pointer only while it is still exactly the pointer the run installed and the committed legacy body still matches the recorded SHA-256. Returns ROLLED_BACK|ALREADY_CURRENT|STALE|MISSING|INVALID_*. Never writes body_en/body_it. Review-only artifact; not auto-applied.';

-- ── PRIVILEGES ────────────────────────────────────────────────────────────
-- PUBLIC receives EXECUTE on new functions by default; remove it, then deny
-- the API roles explicitly and allow only the server-side executor role.
revoke all on function public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text) from public;
revoke all on function public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text) from anon;
revoke all on function public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text) from authenticated;
grant execute on function public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text) to service_role;

revoke all on function public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from public;
revoke all on function public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from anon;
revoke all on function public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text) from authenticated;
grant execute on function public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text) to service_role;
