# Legacy Markdown retirement — release and recovery plan

Target architecture: PostgreSQL holds post metadata and the canonical
content-addressed pointers only; Supabase Storage (`website-content`) is the sole
authoritative store for Markdown bodies. No dual-write, no legacy fallback, no
silent agreement checks, no unmanaged orphan accumulation.

## What ships

| Artifact | Where | State |
|---|---|---|
| Storage-only reads (CMS) | CMS branch `retire-legacy-bodies`, `1f3d1cc` | committed, verified |
| Storage-only writes + dual-write removal + cleanup (CMS) | same branch, `66572f1` | committed, verified |
| Storage-only reads (WS) | WS branch `storage-only-runtime`, `8f9c086` | committed, verified |
| GC for `website-content` | CMS branch, `b578017` | committed, 43 tests + live dry run |
| Reviewed contraction SQL | `supabase/review/prod_legacy_body_retirement.sql`, `566281e` | **not applied** |

Gate results at commit time: CMS 95 files / 1210 tests, lint, tsc, build, prod-infra
65, `db:dev:check` 128/0/9; WS 51 files / 397 tests, lint, tsc, build. Both worktrees
clean.

## Deployment ordering (code first, schema last)

1. **Deploy the two application revisions** (CMS from `retire-legacy-bodies`, WS from
   `storage-only-runtime`). Both are Storage-only on the read path already; the
   writes no longer store Markdown in Postgres.
2. **Verify in production before contracting**: every page renders from Storage,
   the CMS editor loads and saves bodies, new-post creation works, hidden posts stay
   unreachable, and no request falls back to a legacy body.
3. **Take a fresh full-body backup** (see below). The existing CP-0 snapshot and the
   CP-2 CAS rollback plan **cannot** restore dropped column contents.
4. **Apply the contraction** (below) in one transaction.
5. **Verify** and run the production smoke tests.
6. **Remove the shim** in a follow-up revision (`legacyBodyEnShim.ts` +
   `CMS_LEGACY_BODY_EN_SHIM`), then apply the GC for the two known leftovers.

The applications must be able to run without the legacy columns *before* step 4.
They already are: no runtime projection names `body_en`/`body_it` as content.

## The compatibility shim (step 1 → step 4 only)

`body_en` is still `NOT NULL` on both production tables, so creation and updates
would fail if nothing wrote it. `src/libs/cms/legacyBodyEnShim.ts`, gated by
`CMS_LEGACY_BODY_EN_SHIM` (default **on**, off only when exactly `false`), writes the
placeholder `[content moved to object storage]` into `body_en` only — never
Markdown, never `body_it`. Delete the file and the flag together with the columns.

## Fresh backup (required before step 4)

```sql
copy (
  select 'blog' as kind, id, hidden, json_build_object(
           'body_en', body_en, 'body_it', body_it,
           'body_en_path', body_en_path, 'body_it_path', body_it_path) as payload
    from public.blog_posts
  union all
  select 'portfolio', id, hidden, json_build_object(
           'body_en', body_en, 'body_it', body_it,
           'body_en_path', body_en_path, 'body_it_path', body_it_path)
    from public.portfolio_posts
) to '/tmp/prod-bodies-before-contraction.jsonl';
```

Store it outside both repositories with `0600` permissions, record its SHA-256 and
the per-body hashes, and verify it restores into a scratch table before proceeding.
Expected: 17 rows, 34 non-empty bodies, 275 670 bytes.

## The contraction (step 4)

`supabase/review/prod_legacy_body_retirement.sql`, applied atomically
(`<cli> db query --linked --file <wrapped>` inside an explicit `begin; … commit;`,
never `supabase db push`):

```sql
drop function if exists public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text);
drop function if exists public.prod_backfill_body_pointer_rollback(text,bigint,text,text,text,text);
alter table public.blog_posts      drop column if exists body_en, drop column if exists body_it;
alter table public.portfolio_posts drop column if exists body_en, drop column if exists body_it;
```

The CAS functions go first because they are the only database objects that read the
legacy columns, and no operational path calls them any more. Preserved: the four
canonical pointer CHECK constraints, the nullable pointer columns, the private
bucket and the `website_content_body_read` RLS policy. The pointer columns stay
**nullable** — creation needs the row id before the canonical path can exist.

Impact: a brief ACCESS EXCLUSIVE lock on the two content tables while the columns
are dropped; no table rewrite for `DROP COLUMN`. The public read path is unaffected
because it never selects the dropped columns.

## Recovery

| Scenario | Action |
|---|---|
| Problem found **before** step 4 | Redeploy the previous revision. Nothing destructive has happened. |
| Problem found **after** step 4 | The dropped columns are gone permanently; restore their values from the fresh backup into re-added nullable columns (`alter table … add column body_en text`), then restore the shim behaviour or roll the revision back. Storage objects and pointers are the authoritative content and are untouched by the contraction. |
| Bad Storage object suspected | Do **not** delete objects. Reconstruct from the objects themselves; the pointers and objects are consistent by construction (the backfill verified every object byte-for-byte). |
| Orphan cleanup went wrong | The GC only ever deletes unreferenced canonical `.md` objects after a retention window and a re-check; restore from the pre-GC backup if needed. |

Rollback limitation to state plainly: **after step 4 a code rollback is safe, but a
data rollback is only possible from the backup.** The CP-2 CAS rollback plan
restores *pointers*, never dropped column contents.

## Garbage collection (after step 5)

`bun run storage:content:prod:gc` is dry-run by default; deletion needs `--apply`
**and** `CMS_PROD_STORAGE_GC_APPLY_ACK=yes-delete-production-content`, plus a
retention window (default 14 days, 1-day apply floor). The two `portfolio/27`
objects are the only current candidates and are deliberately **not deleted yet** —
do it only after the backup exists and a fresh dry run still shows exactly those
two, with zero unmanaged and zero missing references.

## GO/NO-GO checklist

- [ ] Both application revisions deployed and verified Storage-only in production.
- [ ] Fresh full-body backup taken, verified, stored outside the repos, hashes recorded.
- [ ] Dry run still reports 34 references, 0 missing objects, and only the two known orphans as candidates.
- [ ] Reviewed SQL re-checked against the live schema (4 columns, 2 functions).
- [ ] Recovery procedure rehearsed on a scratch database.
- [ ] Explicit approval recorded for the destructive step.
