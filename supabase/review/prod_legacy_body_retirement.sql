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
--     the deployed CMS and WS must already run Storage-only reads and writes.
--
-- ORDERING (code first, schema last):
--   1. Deploy CMS and WS revisions that never select `body_en` / `body_it`.
--   2. Verify the deployed revisions serve every page and the CMS editor
--      without those columns (Storage-only path).
--   3. Capture a FRESH full-body backup, because after this file runs the
--      CP-2 CAS rollback plan can no longer restore body contents.
--   4. Apply this file in ONE transaction.
--   5. Verify with the queries below and run production smoke tests.
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
-- backup taken in step 3; there is no in-database recovery path.

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
