# Production cutover — deployment record (CP-1)

Durable, repository-side record of the Phase 14 CP-1 production infrastructure
installation. It exists because that installation was deliberately performed
**outside** the Supabase migration-history mechanism, so the database itself
carries no row proving what was applied. This file plus the checksums below are
the provenance.

## Scope

| | |
|---|---|
| Project | `mtvwynyikouqzmhqespl` |
| Target schema | `public` (production) |
| Companion schema | `dev_staging` (DEV — not touched by this installation) |
| Supabase CLI | project-local `node_modules/supabase` (2.120.0); global 2.105.0 is fallback |
| PostgreSQL | 17.6 |

## Applied artifacts

| Artifact | Bytes | SHA-256 | Applied |
|---|---|---|---|
| `supabase/review/prod_markdown_backfill_cas.sql` | 23 723 | `957e3007a26ff2ca7120b8d3e41d777d9631d2ceb9f310177de25af01bfa49f1` | 2026-10-18 |
| `supabase/review/prod_website_content_storage_rls.sql` | 8 943 | `18e462fc714cf6eb814da7fcc94a52e15e66a54117c8ce73afa955d9e9be5d56` | 2026-10-18 |

Both hashes were re-verified against these values immediately before and after
execution. Neither file was moved into `supabase/migrations/`.

Parked and deliberately **not** applied:
`supabase/migrations/20261017161925_optimize_indexes_public.sql` =
`48b77789de1d65b3c0d4d95b0779203382e3e68d660d129f9bfba9eaf4185581` (unchanged).

## Execution mechanism

`psql` and a production connection string (`PROD_DATABASE_URL`) are **not**
available in this environment, and the repo's own CLI runner is read-only by
design. Each artifact was therefore applied through the linked Management API:

```bash
# wrapper built at execution time: "begin;\n" + artifact bytes + "\ncommit;\n"
bun node_modules/supabase/dist/supabase.js db query --linked --file <wrapped.sql>
```

- The artifact bytes are embedded **unmodified**; the wrapper only adds the
  transaction control. Verified in-process: `wrapped[7:7+len(artifact)] == artifact`.
- `supabase/.temp/project-ref` pins the target to `mtvwynyikouqzmhqespl`, so the
  command cannot reach another project.
- `db query` executes SQL; it is **not** a migration command, so it cannot pick
  up, apply, or reconcile anything in `supabase/migrations/`.

## Transaction outcome

| Artifact | Exit | Outcome |
|---|---|---|
| CAS schema + functions | 0 | committed atomically (single explicit transaction) |
| Storage RLS policy | 0 | `DROP POLICY IF EXISTS` + `CREATE POLICY` in one transaction |

No retry, correction or compensation was needed; no partial state was ever
observed.

## Application timestamps

The catalog does not record DDL timestamps (no such column on `pg_proc` /
`pg_constraint`), so these are the reliable markers available:

| Step | Timestamp (UTC unless noted) | Source |
|---|---|---|
| CAS schema + functions applied | 2026-10-18 14:58:59Z (16:58:59 +0200) | execution wrapper mtime |
| Bucket `website-content` created | 2026-10-18 14:59:54.734653Z | `storage.buckets.created_at` (authoritative, server-side) |
| Storage RLS policy applied | 2026-10-18 15:00:12Z (17:00:12 +0200) | execution wrapper mtime |

The three ordering markers agree with the executed order (schema → bucket → RLS).

## Verified postconditions

- 4 nullable `text` pointer columns (`body_en_path`, `body_it_path` on both
  `public.blog_posts` and `public.portfolio_posts`); all 34 pointer values NULL.
- 4 validated canonical CHECK constraints in `public` pinning entity, row id,
  locale, 64-lowercase-hex SHA-256 and the `.md` extension.
- 2 CAS functions with exact signatures, `SECURITY DEFINER`, fixed
  `search_path = pg_catalog, pg_temp`, ACL granting EXECUTE to `service_role`
  only (`has_function_privilege`: anon false, authenticated false, service_role
  true). A live publishable-key RPC attempt returned **401 / `42501`
  permission denied**, i.e. denial happens before the function body runs.
- Private bucket `website-content`: `public=false`, `file_size_limit=1048576`,
  `allowed_mime_types={text/markdown}`; re-read independently as
  `already-correct`.
- Exactly one new `storage.objects` policy `website_content_body_read`
  (`SELECT`, roles `anon,authenticated`, `bucket_id = 'website-content'`,
  operation-aware `storage.allow_any_operation(...)`, `hidden = false` and exact
  pointer equality over both public content tables). No anon write policy.
  The pre-existing DEV policy is unchanged and cross-references nothing in
  production.
- Legacy data intact: 17 rows, byte total **275 670**, planner inventory digest
  `0ed666f425668578cb9249974865abdb54c52a89146049ec8f9247b0b63947ca` — identical to
  the approved CP-0 digest, i.e. all 34 bodies hash exactly as snapshotted.
- Production still holds **0 populated pointers** and **0** Markdown objects.

## Why there is no migration-history entry

The production schema is intentionally not represented in
`supabase_migrations.schema_migrations`:

1. The artifacts are review-only staged SQL, not part of the migration series;
   copying them into `supabase/migrations/` would have created a *pending*
   migration beside the parked one.
2. Applying them through the migration machinery would have required a migration
   version and would have invited a bulk sync that could also apply unrelated
   pending SQL.
3. Provenance is instead the checksummed artifact + this record + the CP-1
   verification evidence.

## Implications, and the standing warning

- **Never run `supabase db push`, `supabase migration up`, `supabase db reset`
  or any bulk sync against this project.** The parked migration would be
  eligible, and the production schema would not be recognised as already
  installed.
- Any future migration that touches these columns, constraints or functions must
  be written to tolerate their existing presence (`ADD COLUMN IF NOT EXISTS`,
  `pg_constraint`-guarded CHECKs, `CREATE OR REPLACE`), because the live
  definition is not derivable from history. The staged artifacts already use
  exactly those guards, so a later reviewed promotion can remain idempotent.
- Before the next production schema change, reconcile: compare the live
  definitions against this record and the two checksums, and decide explicitly
  whether the change belongs in the migration series or in another staged
  artifact.
- Do not create a synthetic migration-history row to "fix" this.

## Related records

- `docs/PRODUCTION_MARKDOWN_CUTOVER.md` — the operator runbook (D1–D6).
- `docs/PRODUCTION_EVIDENCE_RECONCILIATION.md` — CP-0/CP-1 evidence reconciliation.
- `docs/PRODUCTION_OPEN_WORK_REGISTER.md` — cumulative outstanding work.


## Phase 14 CP-2 / CP-3 — execution record

| Step | Result |
|---|---|
| CP-2 backfill | run `2ff5a39b-ffd8-4fec-a909-c67378d9afd1`, manifest `0ed666f425668578cb9249974865abdb54c52a89146049ec8f9247b0b63947ca`: 34/34 `UPLOADED_AND_POINTED`, 34 pointer switches, 34 immutable objects, 0 failures, 0 revalidation failures |
| Independent verification | 34/34 objects downloaded and SHA-256-matched to the committed legacy bodies; 34/34 path hashes; 0 missing, 0 orphans; legacy 275 670 bytes unchanged; DEV unchanged |
| Rollback readiness | read-only plan: 34 planned / 34 READY / 0 conflicts |
| Live Storage RLS | anon referenced-visible **allowed**; anon referenced-hidden **denied** (service_role allowed); anon listing **0 objects** (root, `blog/`, `portfolio/5/`); anon write **denied** |
| CP-3 CMS reads | `CMS_BODY_STORAGE_READ_ENABLED=true` → `dpl_Do83LQBExtDdfKTZSASVv8HWVWEc` (Ready, aliased) |
| CP-3 WS reads | `WS_BODY_STORAGE_READ_ENABLED=true` → `dpl_E35oWnb18cyPu95RhSVyZiat475R` (Ready, aliased) |
| CP-3 CMS dual-write | `CMS_BODY_DUAL_WRITE_ENABLED=true` → `dpl_BCbFAUDHZF9WRnhAjC3HLUrjJYfm` (Ready, aliased) |
| Post-activation E2E | 24/24 visible pages 200 and clean, 10/10 hidden 404, mobile clean, text lengths identical to the pre-activation baseline |

An accidental `service_role` write control during the RLS testing created one probe object
(`rls-probe-does-not-persist.md`); it was deleted immediately (DELETE 200) and the bucket was
re-verified at exactly 34 objects. No migration object was deleted, and no orphan remains.
