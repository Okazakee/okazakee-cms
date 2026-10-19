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
| Reviewed preliminary SQL (`body_en` becomes nullable) | `supabase/review/prod_legacy_body_en_drop_not_null.sql` | **not applied** |
| Reviewed contraction SQL | `supabase/review/prod_legacy_body_retirement.sql`, `566281e` | **not applied** |

Gate results at commit time: CMS 95 files / 1210 tests, lint, tsc, build, prod-infra
65, `db:dev:check` 128/0/9; WS 51 files / 397 tests, lint, tsc, build. Both worktrees
clean.

## Deployment ordering (code and schema move together)

Reordering is not a matter of taste here. The rule is: **at every point the deployed
code satisfies the live schema, and no deployed statement names a column that does
not exist.** That needs three movements, not two — the constraint is relaxed *before*
the code stops writing, and the column is dropped only *after* nothing writes it.

1. **Deploy the two application revisions** (CMS from `retire-legacy-bodies`, WS from
   `storage-only-runtime`) with the compatibility shim **on** (its default). Both are
   Storage-only on the read path already; the writes no longer store Markdown in
   Postgres, and the shim keeps satisfying `body_en NOT NULL`.
2. **Verify in production**: every page renders from Storage, the CMS editor loads and
   saves bodies, new-post creation works, hidden posts stay unreachable, and no request
   falls back to a legacy body.
3. **Take a fresh full-body backup** (see below) and verify it. The existing CP-0
   snapshot and the CP-2 CAS rollback plan **cannot** restore dropped column contents.
4. **Apply the preliminary, non-destructive step**
   (`supabase/review/prod_legacy_body_en_drop_not_null.sql`): `body_en` becomes
   nullable on `blog_posts` and `portfolio_posts`. It drops nothing, changes no data
   and is individually reversible. This is what makes step 5 possible: it is the only
   change that lets the code stop writing `body_en` while the column still exists.
5. **Deploy the same revisions again with the compatibility shim off.** With the
   shim off, the application names `body_en` in no projection, filter, insert or
   update any more — it is already column-agnostic — so a nullable column is simply
   never written and the write path is unchanged (see the shim-off guarantee below).
6. **Verify**: create and save a post in the CMS; the new rows leave `body_en` NULL,
   every page still renders from Storage, and no write error names the legacy column.
7. **Apply the contraction** (`prod_legacy_body_retirement.sql`, below) in one
   transaction.
8. **Verify** and run the production smoke tests.
9. **Delete the shim** in a follow-up revision — pure code cleanup now that nothing
   writes the column and the column is gone (done) — then apply the GC for the two
   known leftovers.

Why not the obvious shorter order (drop the column, remove the shim afterwards)? It
leaves a window in which a live revision still writes `body_en` against a table that
no longer has it, so **every** post write fails until the shim-removal deployment
lands; if that deployment lags or is missed, the window is unbounded. And turning the
shim off *before* relaxing the constraint is the mirror image: every post creation and
every EN body save violates `body_en NOT NULL`. Steps 4 and 5 are each safe exactly
because the other one has already happened.

Step 4 is also what makes step 5 recoverable: if the shim-off revision misbehaves,
the shim-on revision can be redeployed against a schema that still has the column, and
`alter table … set not null` restores the original constraint while every row still
holds a value (that stops being possible once a shim-off INSERT has left `body_en`
NULL).

**Public read availability is preserved throughout.** No read step touches these
columns at any point: the WS public read path selects metadata plus the canonical
`body_en_path`/`body_it_path` pointers, the CMS list projections never name the legacy
columns, and the `website_content_body_read` Storage RLS predicate matches on the
pointers only. Step 4 changes no read (it is catalog-only); step 7 removes only
columns no read names and needs, as before, one brief ACCESS EXCLUSIVE lock per table
with no table rewrite.

## The compatibility shim (step 1 → step 5 only — now deleted)

While `body_en` was still `NOT NULL` on both production tables, creation and updates
would have failed if nothing wrote it. A temporary compatibility shim, gated by a
dedicated environment flag (default **on**, off only when exactly `false`), wrote the
placeholder `[content moved to object storage]` into `body_en` only — never Markdown,
never `body_it`. The flag was flipped off at step 5, *after* step 4 made the column
nullable and *before* step 7 dropped it; the shim module and its flag were deleted at
step 9, together with the columns.

**Shim-off guarantee.** With the shim off, the helper returned `{}`, so no INSERT and
no UPDATE carried a `body_en` field at all — the app is agnostic to the column being
nullable, and equally agnostic to it being gone. That is what made step 7 a pure
schema contraction with no coordinated deployment, and it is still pinned by tests:
the create and EN-edit cases in `src/app/actions/cms/sections/storageOnlyWrite.test.ts`
and `src/app/actions/cms/sections/portfolioStorageOnlyWrite.test.ts`, which drive the
real create and EN-edit paths and assert that the committed statements name neither
`body_en` nor `body_it`.

The shim was the only place in the application that named `body_en` on a write;
`body_en` also appears as the CMS editor's request-payload key for the English body,
which is a form field name (consumed before the row payload is built, and stripped from
it by `stripRetiredBodyColumns`), not a database column reference. Do not "fix" those
field names to remove the column dependency — the dependency is already zero.

## Fresh backup (step 3, required before the contraction)

Use the client-side backup tool. A server-side `COPY ... TO '/tmp/...'` is **not** an
operator recovery artifact and must not be used (full procedure, scratch-restore
rehearsal and retention rules: `docs/PRODUCTION_BACKUP_RESTORE.md`):

```bash
# read-only dry run: reads production via PostgREST + Storage, writes nothing
bun run storage:content:prod:backup --out-dir=<dir outside both repos>

# the export (writes the artifact; needs APP_ENV=production and the ack)
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun run storage:content:prod:backup --out-dir=<dir> --apply

# offline integrity check: no credentials, no network
bun run storage:content:prod:backup --verify --backup-dir=<run dir>
```

It captures the legacy `body_en`/`body_it` values, the canonical pointers **and the
authoritative Storage bytes**, with a per-body SHA-256 and byte length, into a new
`0700` run directory written exclusively (`0600` files, never merged with an existing
run) alongside `manifest.json` and `SHA256SUMS`; record the `SHA256SUMS` hash out of band.

A fresh **pre-contraction** snapshot must capture Storage's authoritative bytes and the
pointers, not the legacy text alone: legitimate edits between step 3 and step 7 change the
objects and pointers, so a legacy-only backup would restore stale content. Do **not** treat
the historical `275 670`-byte legacy total as a requirement — compare against the artifact's
own manifest and the live pointers and report any drift rather than forcing the old number.

Take that snapshot with the explicit post-shim mode, which records
`kind: storage-authoritative` in its manifest and treats the shim placeholder in the legacy
columns as the expected state (an informational finding, plus a placeholder count) instead of
an error — the pointer + object pairs stay the authoritative content and every one of them
must still be captured and hash to its own key:

```bash
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun run storage:content:prod:backup --out-dir=<dir> --apply \
    --storage-authoritative --baseline-dir=<the pre-shim baseline run dir>
```

The pre-shim baseline (no flag) is the other artifact kind and stays pristine; a restore
requires `kind: storage-authoritative` unless `--require-kind=legacy-baseline` is passed
explicitly, so the two are never confused (`docs/PRODUCTION_BACKUP_RESTORE.md`).

Run the scratch-restore rehearsal in `docs/PRODUCTION_BACKUP_RESTORE.md` before the
contraction; it is the proof that the artifact is actually restorable.

## Preliminary step: `body_en` becomes nullable (step 4)

`supabase/review/prod_legacy_body_en_drop_not_null.sql`, applied atomically
(`<cli> db query --linked --file <wrapped>` inside an explicit `begin; … commit;`,
never `supabase db push`):

```sql
alter table public.blog_posts      alter column body_en drop not null;
alter table public.portfolio_posts alter column body_en drop not null;
```

This is **not** the contraction. It drops no column and no function, it changes no
data (catalog-only, no row read or rewritten), and it leaves the pointer columns,
the four CHECK constraints, the CAS functions, the bucket and the RLS policy exactly
as they are. `body_it` is already nullable and is deliberately not touched. Applying
it twice is a no-op.

It exists so that the shim can be switched off at step 5 while the column is still
there: without it, the only way to stop writing `body_en` would be to drop the column
first, and every revision that still wrote it would then fail. It is **individually
reversible** — `alter table … alter column body_en set not null` — but only while no
row holds NULL, which is true right up to the first insert or EN body save performed
by the shim-off revision. Rehearse that reversal on a scratch database as part of the
GO/NO-GO, before the shim-off deployment.

Impact: catalog-only, no table rewrite, a brief ACCESS EXCLUSIVE lock per table.
No read step names the column, so public read availability is unaffected.

## The contraction (step 7)

`supabase/review/prod_legacy_body_retirement.sql`, applied atomically
(`<cli> db query --linked --file <wrapped>` inside an explicit `begin; … commit;`,
never `supabase db push`):

```sql
drop function if exists public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text);
drop function if exists public.prod_backfill_body_pointer_rollback(text,bigint,text,text,text,text);
alter table public.blog_posts      drop column if exists body_en, drop column if exists body_it;
alter table public.portfolio_posts drop column if exists body_en, drop column if exists body_it;
```

Apply this only after step 6 has been verified: `body_en` is nullable (step 4) and the
live revision has the shim off (step 5), so no statement the deployed code issues
names `body_en`. A revision that still writes it would start failing every post write
the moment the column disappears; re-check the running revision before applying this
file.

The CAS functions go first because they are the only database objects that read the
legacy columns, and no operational path calls them any more. Preserved: the four
canonical pointer CHECK constraints, the nullable pointer columns, the private
bucket and the `website_content_body_read` RLS policy. The pointer columns stay
**nullable** — creation needs the row id before the canonical path can exist.

Impact: a brief ACCESS EXCLUSIVE lock on the two content tables while the columns
are dropped; no table rewrite for `DROP COLUMN`. The public read path is unaffected
because it never selects the dropped columns.

## Execution record — 2026-10-19 (completed)

The retirement above was executed in production in this order, each step gated on
the previous one:

1. **Code first** — CMS PR #3 (`d0034c80`) and WS PR #30 (`4e21064`) deployed; both
   apps verified Storage-only (`24/24` visible pages 200, `10/10` hidden 404).
   Hotfix `922fcc2` (`dpl_4M2epCxWBt9tYyRgHLoAUoAQznCJ`) fixed the CMS editor
   hydration regression (the DEV-only lazy-body gate made production open empty
   editors after the legacy columns stopped being written).
2. **Fresh snapshot** — `prod-legacy-bodies-2026-10-19T08-44-45-546Z-c91ac37ee228`,
   kind `storage-authoritative`: 18 rows, 36 pointers, 36 objects captured, 0
   missing, `complete=true`; sums `a30a1dfc…`; restoration rehearsed against this
   artifact in scratch Postgres.
3. **Preliminary nullability** — `prod_legacy_body_en_drop_not_null.sql`
   (`adddf76e…`), catalog-only, 0 NULL rows afterwards.
4. **Shim off** — `CMS_LEGACY_BODY_EN_SHIM=false`, CMS redeployed; the authenticated
   CMS validation (post 20: create, EN/IT reload, EN-only edit producing a new
   immutable object while the IT pointer stayed unchanged, metadata edits, both
   legacy columns NULL) confirmed the contract.
5. **Contraction** — `prod_legacy_body_retirement.sql` (`d0822c5b…`) applied
   atomically: the two obsolete CAS functions and the four legacy columns dropped.
6. **Post-contraction** — 0 legacy columns, 4 pointer columns, 4 CHECKs, 0 CAS
   functions, 18 posts, 36 pointers, 0 missing referenced objects, bucket private
   with its RLS policy, `24/24` visible pages clean, `12/12` hidden routes 404
   (including post 20), DEV untouched at 34/34.
7. **Shim removed** — `legacyBodyEnShim.ts`, its flag and the now-dead
   `CMS_BODY_DUAL_WRITE_ENABLED` / `CMS_BODY_STORAGE_READ_ENABLED` /
   `WS_BODY_STORAGE_READ_ENABLED` configuration are being retired in the follow-up
   revision; `CMS_BODY_POINTER_COLUMNS` and the obsolete production backfill CLIs
   were removed in the follow-up revision (retired 2026-10-19).

**Unreferenced objects at completion: 3** — the two `portfolio/27` orphans and the
EN object superseded by the post-20 edit. Their 14-day retention has not elapsed;
GC must not run before it. Post 20 itself remains, hidden, for the operator to
delete through the CMS once satisfied.

## Recovery

| Scenario | Action |
|---|---|
| Problem found **before** step 4 | Redeploy the previous (shim-on) revision. Nothing destructive has happened and the schema is unchanged. |
| Problem found **in steps 4–6** (column nullable; shim off from step 5) | Redeploy the shim-on revision — the column is still there and still writable — and, if the original constraint must return, `alter table … alter column body_en set not null` while no row holds NULL. No backup needed: these steps change no data. |
| Problem found **after** step 7 | The dropped columns are gone permanently. A legacy-code rollback is **NOT safe on its own**: the old revision reads and writes `body_en`/`body_it`, which no longer exist, so every post read and write fails. Recovery needs BOTH halves, in this order: re-add nullable columns (`alter table … add column body_en text, add column body_it text`), restore their values from the verified backup artifact, and only then deploy the legacy revision. Storage objects and pointers are the authoritative content and are untouched by the contraction. |
| Bad Storage object suspected | Do **not** delete objects. Reconstruct from the objects themselves; the pointers and objects are consistent by construction (the backfill verified every object byte-for-byte). |
| Orphan cleanup went wrong | The GC only ever deletes unreferenced canonical `.md` objects after a retention window and a re-check; restore from the pre-GC backup if needed. |

Rollback limitation to state plainly: **after step 7, reverting to a legacy application
revision requires reconstructing the dropped schema and restoring coherent body values from
the backup first.** A code rollback alone leaves a revision naming columns that no longer
exist; a data rollback alone leaves no code that needs them — neither half is sufficient.
The CP-2 CAS rollback plan restores *pointers* and can never restore dropped column contents.
Steps 4–6 carry no such limitation: they change no data, and the constraint can be restored
while no row holds NULL.

## Garbage collection (after step 8)

`bun run storage:content:prod:gc` is dry-run by default; deletion needs `--apply`
**and** `CMS_PROD_STORAGE_GC_APPLY_ACK=yes-delete-production-content`.

The collector's retention window is authoritative, and it is not to be overridden to
collect the two `portfolio/27` orphans early: pass **no** `--retention-days` argument
(or the intended full window) rather than a shortened one. An object is only ever a
deletion candidate once its own age at least equals the window in force (default 14
days); a shorter window only makes the tool delete something the window exists to
protect. A dry run may legitimately use `--retention-days=0` to inspect the full
collectable set, but an apply below the 1-day floor is refused outright by the CLI —
so that inspection value can never arm a delete.

The two `portfolio/27` objects are the only current candidates, and they are
deliberately **not deleted yet**. Delete them only when both hold: (a) their age
exceeds the retention window in force, and (b) the fresh full-body backup exists and a
new dry run still shows exactly those two, with zero unmanaged and zero missing
references.

## GO/NO-GO checklist

- [ ] Both application revisions deployed and verified Storage-only in production, with the legacy shim **on**.
- [ ] Fresh full-body backup taken, verified, stored outside the repos, hashes recorded.
- [ ] Nullability step (`prod_legacy_body_en_drop_not_null.sql`) reviewed against the live schema, and its reversal (`set not null`) rehearsed on a scratch database while no row holds NULL.
- [ ] Shim-off revision deployed only after the nullability step and verified: new rows leave `body_en` NULL, creation and saves work, and no write names the legacy column.
- [ ] Running revision re-checked as shim-off immediately before the contraction.
- [ ] Contraction SQL re-checked against the live schema (4 columns, 2 functions).
- [ ] Dry run still reports 34 references, 0 missing objects, and only the two known orphans as candidates — with no shortened retention window.
- [ ] Recovery procedure rehearsed on a scratch database.
- [ ] Explicit approval recorded for the destructive step.
