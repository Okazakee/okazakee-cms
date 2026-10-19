-- REVIEW-ONLY — DO NOT AUTO-APPLY. Legacy body retirement (schema contraction).
--
-- PURPOSE: make Supabase Storage the sole authoritative store for Markdown
-- bodies. PostgreSQL keeps metadata and the canonical `body_en_path` /
-- `body_it_path` pointers only; the four legacy text columns are removed.
--
-- PREFLIGHT (verified read-only, 2026-10-19):
--   * 34 populated canonical pointers; 34/34 referenced objects re-verified by
--     SHA-256 AND exact byte length against the committed legacy bodies.
--   * 0 missing referenced objects; 36 objects in `website-content`
--     (34 referenced + 2 known orphans from deleted portfolio 27).
--   * Database-side dependency on the legacy columns: exactly the two
--     `prod_backfill_*` CAS functions, 0 views, 0 triggers.
--   * Application-side dependency must be zero before this file is applied:
--     the deployed CMS and WS must already run Storage-only reads and writes,
--     the shim must already be OFF (`CMS_LEGACY_BODY_EN_SHIM=false`, step 5) and
--     `body_en` must already be nullable (step 4). Re-check the shim-off state
--     immediately before applying this file: a revision that still writes
--     `body_en` would start failing the moment the column disappears.
--
-- REQUIRED ORDERING (code and schema move together; see the release plan in
-- docs/PRODUCTION_LEGACY_RETIREMENT.md). Applying this file in any other order
-- breaks a live deployment:
--   1. Deploy the CMS and WS revisions that never select `body_en` / `body_it`,
--      with the legacy write shim ON (its default). `body_en` is still NOT NULL
--      and the shim still fills it, so every write satisfies the live schema.
--   2. Verify those revisions serve every page and the CMS editor without the
--      legacy columns (Storage-only path).
--   3. Capture a FRESH full-body backup, because after this file runs the CP-2
--      CAS rollback plan can no longer restore body contents.
--   4. Apply `supabase/review/prod_legacy_body_en_drop_not_null.sql`, the
--      preliminary, NON-DESTRUCTIVE step: it only relaxes `body_en` to nullable
--      on both tables (no drop, no data change, individually reversible). BEFORE
--      this file, and only then, the shim can be turned off without hitting the
--      NOT NULL constraint.
--   5. Deploy the SAME revisions with `CMS_LEGACY_BODY_EN_SHIM=false`. The app
--      then names `body_en` in no statement at all, so it is already
--      column-agnostic and needs neither the nullability nor the column.
--   6. Verify: create and save a post in the CMS, confirm the new rows leave
--      `body_en` NULL, every page still renders from Storage and no write error
--      names the legacy column.
--   7. Apply THIS file in ONE transaction (the contraction).
--   8. Verify with the queries below and run production smoke tests.
--   9. Delete the shim (`legacyBodyEnShim.ts` + `CMS_LEGACY_BODY_EN_SHIM`) in a
--      follow-up revision — pure code cleanup once nothing writes the column.
--
-- WHY THIS ORDER: at every point the running code satisfies the live schema and
-- never names a column that is gone. Applying this file while a revision that
-- still writes `body_en` is live breaks every post write; turning the shim off
-- while `body_en` is still NOT NULL breaks every post creation and EN body save.
-- Step 4 is what makes step 5 safe, and step 4 is reversible by redeploying the
-- shim-on revisions while the column is still present.
--
-- WHY THE CAS FUNCTIONS GO FIRST: they are the only database objects that read
-- the legacy columns (they hash `body_en` / `body_it` for the pointer CAS). Once
-- the columns are gone they cannot compile, so dropping them is not optional.
-- They are also inert after CP-2/CP-3: no operational path invokes them.
--
-- WHAT IS PRESERVED: the four canonical pointer CHECK constraints, the nullable
-- pointer columns, the private `website-content` bucket, and the
-- `website_content_body_read` Storage RLS policy. No unrelated migration is
-- touched, and `supabase db push` / bulk sync must never be used here (the
-- production pointer schema was installed outside migration history).
--
-- NULLABILITY: the pointer columns stay NULLABLE on purpose. New-post creation
-- needs the row (and its id) before the canonical path can exist, so a NOT NULL
-- constraint would break creation. Do not add one.
--
-- RECOVERY: this is destructive and is NOT covered by the CAS rollback plan.
-- Restoring the legacy columns requires restoring their values from the fresh
-- backup taken in step 3; there is no in-database recovery path. Reverting only
-- the preliminary nullability step (step 4, a different file) needs no backup at
-- all — `alter table ... alter column body_en set not null` — and must be done
-- before a shim-off revision has created a row with `body_en` NULL.

begin;

-- 1. Retire the obsolete production CAS functions (no remaining callers).
drop function if exists public.prod_backfill_body_pointer_cas(text, bigint, text, text, text, text);
drop function if exists public.prod_backfill_body_pointer_rollback(text, bigint, text, text, text, text);

-- 2. Drop the four legacy body columns. Pointers and CHECKs are untouched.
alter table public.blog_posts
  drop column if exists body_en,
  drop column if exists body_it;

alter table public.portfolio_posts
  drop column if exists body_en,
  drop column if exists body_it;

commit;

-- ── POST-APPLY VERIFICATION ───────────────────────────────────────────────
-- a) legacy columns gone:
--      select table_name, column_name from information_schema.columns
--       where table_schema = 'public' and column_name in ('body_en','body_it');
--    expect 0 rows.
-- b) pointers + constraints intact:
--      select (select count(*) from public.blog_posts where body_en_path is not null)
--           + (select count(*) from public.blog_posts where body_it_path is not null)
--           + (select count(*) from public.portfolio_posts where body_en_path is not null)
--           + (select count(*) from public.portfolio_posts where body_it_path is not null)
--        as pointers;                                   -- expect 34
--      select conname from pg_constraint
--       where conname like '%body_%_path_check';        -- expect the same 4
-- c) CAS functions gone:
--      select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname like 'prod_backfill%';  -- expect 0
-- d) Storage RLS unchanged:
--      select policyname from pg_policies
--       where schemaname = 'storage' and policyname = 'website_content_body_read';
--    expect 1 row.
