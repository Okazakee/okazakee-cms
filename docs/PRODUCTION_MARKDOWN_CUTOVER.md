# Production Markdown body cutover — operator runbook (Phase 14)

> **Retired 2026-10-19.** The production backfill CLIs and the
> `storage:content:prod:backfill:*` scripts referenced below were deleted once the
> cutover completed, and `CMS_BODY_POINTER_COLUMNS` was removed from the code.
> The command transcripts and flag references in this runbook are historical.

Executable runbook for moving long-form Markdown bodies out of the legacy
`public.blog_posts` / `public.portfolio_posts` `body_en` / `body_it` columns and
into the private `website-content` bucket on project `mtvwynyikouqzmhqespl`,
using atomic content-addressed pointer columns.

This document is the GATE D deliverable of Phase 13. It describes the **exact
Phase 14 sequence**. Only its read-only inspections have been executed (CP-0,
2026-10-18, recorded under *Exit codes, and expected-missing infrastructure
during CP-0*); every mutation it describes is still unexecuted and remains gated
by a named checkpoint.

## Scope and authorization boundary

Production and DEV are two schemas of the **same** Supabase project:

| | Schema | Bucket | Role |
|---|---|---|---|
| Production | `public` | `website-content` | target of this runbook |
| DEV clone | `dev_staging` | `website-content-dev` | already migrated, proven |

Every production mutation below is a **Phase 14** action gated by a named
authorization checkpoint. Until **CP-1** is held, no production schema change,
bucket creation, object upload, pointer switch, RLS change, flag activation,
deployment or rollback may be performed: CP-0 authorizes read-only production
inspection only.

Never run `supabase db push`, `supabase migration up`, `supabase db reset` or
any bulk migration command in this process: those can apply **unrelated pending
migrations**. Apply only the two reviewed artifacts named here, each inside its
own transaction, exactly as shown.

### Named approval checkpoints

All mutations are gated. Nothing proceeds to the next checkpoint without an
explicit, recorded operator decision.

| Checkpoint | Authorizes | Scope |
|---|---|---|
| **CP-0 — Phase 14 entry** | Any production action at all | Transition from Phase 13 freeze to Phase 14 execution |
| **CP-1 — Infrastructure authorization** | D1 steps 4–9 | Additive pointer schema + CAS; `website-content` provisioning; Storage RLS apply |
| **CP-2 — Backfill authorization** | D3 step 8 | The production Markdown backfill run (separate from CP-1) |
| **CP-3 — Read activation authorization** | D4 | Enabling CMS Storage-first reads, WS Storage-first reads, CMS dual-write |
| **CP-4 — Rollback authorization** | D5 pointer rollback | Reverting pointers installed by a recorded run |

CP-1, CP-2, CP-3 and CP-4 are **independent**. Holding an earlier one never
implies a later one, and a DEV acknowledgement value is never a production
authorization.

### Reviewed artifacts and pinned checksums

Confirm these byte-for-byte (**D1 step 2**) before any apply:

```bash
cd <okazakee-cms>
sha256sum \
  supabase/review/prod_markdown_backfill_cas.sql \
  supabase/review/prod_website_content_storage_rls.sql \
  supabase/migrations/20261017161925_optimize_indexes_public.sql
```

Expected:

```text
957e3007a26ff2ca7120b8d3e41d777d9631d2ceb9f310177de25af01bfa49f1  supabase/review/prod_markdown_backfill_cas.sql
18e462fc714cf6eb814da7fcc94a52e15e66a54117c8ce73afa955d9e9be5d56  supabase/review/prod_website_content_storage_rls.sql
48b77789de1d65b3c0d4d95b0779203382e3e68d660d129f9bfba9eaf4185581  supabase/migrations/20261017161925_optimize_indexes_public.sql
```

`20261017161925_optimize_indexes_public.sql` is an **unrelated parked
migration**: do not apply, move or delete it. Any checksum drift is a stop
condition, not something to reconcile in passing.

Re-verified **2026-10-18** with a read-only `sha256sum`: all three lines match
the pinned digests above, so both reviewed artifacts are unchanged and the
parked migration is untouched. Nothing in this runbook may apply a file whose
checksum has not just been confirmed here, and no reviewed SQL is retyped
anywhere in this document — the files are always applied by path.

### Production CLI commands

| Command | Mode |
|---|---|
| `bun run storage:content:prod:setup` | read-only bucket inspection |
| `bun run storage:content:prod:setup --apply` | creates `website-content` if missing |
| `bun run storage:content:prod:backfill:plan --inventory` | read-only pointer-free inventory (**pre-schema**, the one that works today) |
| `bun run storage:content:prod:backfill:plan --manifest` | read-only pointer-aware manifest (**post-schema** only) |
| `bun run storage:content:prod:backfill:exec --preflight` | read-only readiness (pointer-aware, therefore **post-schema**) |
| `bun run storage:content:prod:backfill:exec --apply --new-run` | mutation-gated backfill |
| `bun run storage:content:prod:backfill:exec --apply --resume` | explicit recovery of an existing run |
| `bun run storage:content:prod:backfill:rollback` | read-only journal plan (needs `PROD_BACKFILL_JOURNAL_PATH`; empty plan before the first run) |
| `bun run storage:content:prod:backfill:rollback --apply --run-id=<id> --expect-project-ref=<ref>` | mutation-gated rollback |

Common production environment for every command above:

```bash
APP_ENV=production
NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public
NEXT_PUBLIC_SUPABASE_URL=https://mtvwynyikouqzmhqespl.supabase.co
SUPABASE_SECRET_KEY=<server-side key>
```

Exact production contract, verified against the CLIs' usage output:

| Item | Name |
|---|---|
| Apply acknowledgement | `CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill` |
| Rollback acknowledgement | `CMS_PROD_BACKFILL_ROLLBACK_ACK=yes-rollback-to-production-backfill` |
| Journal path | `PROD_BACKFILL_JOURNAL_PATH` (absolute, outside both repositories, `0600`) |
| Forbidden journal roots | `CMS_PROD_BACKFILL_FORBIDDEN_ROOTS` |
| Revalidation origins | `CMS_PROD_REVALIDATION_ORIGINS` (comma-separated bare origins) |
| Digest / ref confirmation | `--confirm-digest=<sha256>`, `--expect-project-ref=<ref>` |
| Run selection | `--new-run`, `--resume`, `--run-id=<id>` |

`--new-run` and `--resume` are mutually exclusive; a resumed run must pass the
manifest digest recorded in the journal, never a freshly computed one.

### Exit codes, and expected-missing infrastructure during CP-0

Every command above shares one exit convention. `plan`, `exec --preflight` and
`rollback` (without `--apply`) are read-only, so every code below is an
**observed** result from this repository state against the live project, not a
prediction:

| Code | Meaning |
|---|---|
| 0 | settled — the read-only report was produced, or `--apply` finished with no failures |
| 1 | attention required — blockers, a failed readiness probe, or the inspected bucket missing |
| 2 | invalid usage |
| 3 | environment/project gate refused (wrong `APP_ENV`, schema, project, bucket or missing secret) |
| 4 | read or execution failure — including a projection that names a column the schema does not have |
| 5 | refused by a gate — acknowledgement, `--expect-project-ref`, journal destination, or the apply/rollback arming gate |

Observed **2026-10-18** on `https://mtvwynyikouqzmhqespl.supabase.co`
(`APP_ENV=production`, schema `public`; all read-only, zero mutations):

| Command | Exit | Observed |
|---|---|---|
| `…:plan --inventory` | **0** | `"mode": "inventory"`, digest `0ed666f4…`, 17 posts / 34 bodies / 275 670 bytes, `"pointerColumnsSelected": false` |
| `…:plan` (no argument) | **0** | the same inventory report, `"modeSource": "flag"` (`CMS_BODY_POINTER_COLUMNS` absent) |
| `…:plan --manifest` | **4** | `column blog_posts.body_en_path does not exist` — **expected pre-schema** |
| `…:exec --preflight` | **4** | the same missing-column error: preflight reads the **pointer-aware** manifest, so it is a post-schema step — **expected pre-schema** |
| `…:setup` | **1** | `"status": "missing"`, `"mutated": false`, `"mutationsPerformed": 0` — **expected pre-CP-1** |
| `…:rollback` (no `PROD_BACKFILL_JOURNAL_PATH`) | **5** | `PROD_BACKFILL_JOURNAL_PATH must name the journal produced by the backfill run` — **expected before the first run** |
| `…:rollback` with `PROD_BACKFILL_JOURNAL_PATH` set to a not-yet-created file | **0** | `"plan": []`, `"planned": 0`, `"mutationsPerformed": 0` — an absent journal is not an error |

**Expected missing infrastructure is not a failure.** During CP-0 the bucket,
the pointer columns, the CAS functions, the Storage RLS policy, every pointer
and every object are *supposed* to be absent. A command that reports them
missing — or that exits 4 because a projection named a column that does not
exist yet — is confirming the baseline, and must not be "fixed" by changing
production, by adding a nullable column, or by copying a parked migration. A
real failure is: something *present* that should be absent, a checksum drift, a
non-zero exit where this table records 0, or a success where it records 4/5.

The read-only command that must always work pre-schema is the pointer-free
inventory (`plan --inventory`), which projects exactly `id,body_en,body_it`.
Nothing in this runbook may make a pre-schema query succeed by altering
production.

### Secret hygiene (logs, transcripts, HAR files, screenshots)

`SUPABASE_SECRET_KEY`, `WEBSITE_REVALIDATION_SECRET` and any `PROD_DATABASE_URL`
are server secrets and must never reach a log, a terminal transcript, a HAR file
or a screenshot:

- Read them from the environment or a `0600` file; never paste a value into a
  command line, a document, an issue or a chat. The CLIs read them from the
  environment and print no secret material — their reports carry counts,
  digests, bucket status, journal run summaries and booleans only.
- Keep shell tracing **off** (`set +x`); a traced shell echoes the expanded
  `$SUPABASE_SECRET_KEY`.
- `curl -H "Authorization: Bearer $SUPABASE_SECRET_KEY"` places the secret in
  the process arguments, where `ps` can read it. Prefer a `0600` curl config
  (`curl --config <file>`) or a wrapper that injects the header from the
  environment, and never use `--verbose`/`-v` on an authenticated request.
- In a browser session, do not capture an authenticated admin request with a
  secret in a header: redact `apikey`, `Authorization` and `Cookie` before
  saving a HAR or a screenshot, and prefer anonymous / publishable-key evidence.
- Redirect command output only into a `0700` directory outside both
  repositories (the same location as the snapshot and the journal).

---

## D1. Production infrastructure

Prerequisite: **CP-0** declared. Steps 4–9 additionally require **CP-1**.

### 1. Snapshot production data and record source fingerprints

Read-only. Before anything changes, capture a logical snapshot of the two
content tables and the exact bytes that identify every body.

```bash
# logical snapshot (read-only) — store OUTSIDE both repositories
pg_dump "$PROD_DATABASE_URL" \
  --schema=public --table=public.blog_posts --table=public.portfolio_posts \
  --data-only --column-inserts > /var/lib/cms-cutover/prod-<date>.sql
```

Record the source fingerprints in **two independently executable stages**. The
stage-1 query runs now, before the pointer columns exist, and must never name
them: production is never changed to make a snapshot work.

**Stage 1 — pre-schema snapshot (run before D1 step 4).** It projects only
columns that exist today — `id, body_en, body_it, hidden` on both tables,
confirmed present by a read-only probe of the live project (2026-10-18) — and
names no pointer column. It is byte-exact: `convert_to(...,'UTF8')` is the
encoded body, never a normalized or estimated length, and `coalesce` only keeps
the expression total for a NULL locale. It is deterministic: two runs on an
unchanged database are identical.

```sql
-- blog; repeat verbatim for public.portfolio_posts (same legacy columns)
select 'blog' as kind, id, hidden,
       length(convert_to(coalesce(body_en,''),'UTF8')) as en_bytes,
       length(convert_to(coalesce(body_it,''),'UTF8')) as it_bytes,
       encode(sha256(convert_to(coalesce(body_en,''),'UTF8')),'hex') as en_sha256,
       encode(sha256(convert_to(coalesce(body_it,''),'UTF8')),'hex') as it_sha256
  from public.blog_posts
 order by id;
```

Expected baseline on the approved snapshot: **6 blog rows + 11 portfolio rows =
17 rows**, **34 non-empty bodies**, **275 670 source bytes** summed from the
`*_bytes` columns (this figure is the snapshot's own byte total; the DEV
planner's 275 627 is DEV's own baseline and must not be substituted). Every
`*_sha256` is the SHA-256 of the exact UTF-8 body bytes and is the same value
the backfill keys objects by — the plan report's `sourceSha256` / `sizeBytes`
for the same post/locale must equal it. Write the fingerprint file and its
SHA-256 to `/var/lib/cms-cutover/prod-snapshot.sha256`.

**Stage 2 — post-schema verification (run after D1 step 4, with D1 step 5).**
Only this stage may inspect the pointer columns. Re-run the stage-1 query
unchanged — the bodies must hash byte-identically, because installing the schema
writes no row — then add the pointers:

```sql
select 'blog' as kind, id, hidden,
       body_en_path, body_it_path,
       length(convert_to(coalesce(body_en,''),'UTF8')) as en_bytes,
       length(convert_to(coalesce(body_it,''),'UTF8')) as it_bytes,
       encode(sha256(convert_to(coalesce(body_en,''),'UTF8')),'hex') as en_sha256,
       encode(sha256(convert_to(coalesce(body_it,''),'UTF8')),'hex') as it_sha256
  from public.blog_posts
 order by id;
-- repeat for public.portfolio_posts
```

Stage 2 must reproduce the stage-1 hashes and byte totals exactly, and must
still show `body_en_path` / `body_it_path` as `NULL` for every row (pre-backfill
that is the expected state, not a defect).

Pre-schema inventory is also read-only and works **before the pointer columns
exist**; it is the pointer-free projection, so it never names a column the
schema lacks:

```bash
bun run storage:content:prod:backfill:plan --inventory
```

Exit code **0**, `"mode": "inventory"`, `"pointerColumnsSelected": false`. With
no argument the same command also selects `inventory` while
`CMS_BODY_POINTER_COLUMNS` is not exactly `true`; the explicit `--inventory`
removes the flag-accident risk. `--manifest` is the **post-schema** counterpart
and exits **4** with `column blog_posts.body_en_path does not exist` until D1
step 4 lands — expected, not a failure.

### 2. Confirm reviewed SQL checksums

Run the checksum block from *Reviewed artifacts and pinned checksums* above.
All three lines must match exactly. Stop on any drift.

### 3. Obtain explicit infrastructure authorization — **CP-1**

Record the decision (who, when, what is being authorized: additive schema +
bucket provisioning + Storage RLS). No mutation before this is written down.

### 4. Install the additive production pointer schema and CAS functions

Apply **only** the reviewed file, atomically, with error-stop. Do **not** copy
it into `supabase/migrations/`: that would leave a *pending migration* behind,
and the parked `20261017161925_optimize_indexes_public.sql` is already pending,
so any later bulk command would silently apply both. Never run
`supabase db push`, `supabase migration up`, `supabase db reset` or any bulk
apply in this process.

```bash
# byte-exact apply of the reviewed artifact: one transaction, abort on first error
psql "$PROD_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  -f supabase/review/prod_markdown_backfill_cas.sql
```

- `--single-transaction` wraps the whole file in one transaction. The file
  deliberately carries no top-level `BEGIN`/`COMMIT` (its `begin` tokens are
  PL/pgSQL block openers), so this is what makes the four columns, the four
  CHECK constraints, both functions and the grants land together or not at all —
  the CMS can never observe a half-installed capability.
- `ON_ERROR_STOP=1` is the error-stop half: the first error aborts the file and
  the transaction rolls back. A bare `BEGIN; \i <file>; COMMIT;` is **not**
  equivalent — without `ON_ERROR_STOP`, psql keeps executing after an error and
  still reaches `COMMIT`, committing partial work.
- The file is applied **by path**, never retyped or excerpted, so the bytes that
  land are exactly the bytes whose checksum D1 step 2 verified. If the reviewed
  SQL is instead applied through the Supabase management API / MCP
  `apply_migration`, that mechanism also takes the file's whole statement list
  as one migration — but the SQL must be the exact file content, with no manual
  edit and no partial paste.

Re-run the checksum block (D1 step 2) immediately before this command, and run
D1 step 5 immediately after. This is the step that creates the pointer columns
and the two `prod_backfill_*` functions in `public`.

### 5. Independently verify columns, constraints, function definitions and effective ACLs

Verify by query, not by assumption.

Columns (expect four rows: `body_en_path` / `body_it_path` on both tables,
`text`, nullable):

```sql
select table_name, column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('blog_posts','portfolio_posts')
   and column_name in ('body_en_path','body_it_path')
 order by table_name, column_name;
```

Constraints (expect exactly four CHECK constraints, canonical shape):

```sql
select conname, conrelid::regclass as tbl, pg_get_constraintdef(oid) as def
  from pg_constraint
 where conrelid in ('public.blog_posts'::regclass,
                    'public.portfolio_posts'::regclass)
   and conname like '%\_body\_%\_path\_check' escape '\'
 order by conname;
```

Functions, definitions and ACLs (expect `prosecdef = true`,
`proconfig = {search_path=pg_catalog, pg_temp}`, `proacl` granting EXECUTE to
`service_role` only):

```sql
select p.proname, p.prosecdef, p.proconfig, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname like 'prod_backfill%'
 order by p.proname;
```

Effective ACLs (the PostgREST gate is EXECUTE):

```sql
select has_function_privilege('anon',
         'public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text)',
         'EXECUTE') as anon_may_cas,
       has_function_privilege('authenticated',
         'public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text)',
         'EXECUTE') as authenticated_may_cas,
       has_function_privilege('service_role',
         'public.prod_backfill_body_pointer_cas(text,bigint,text,text,text,text)',
         'EXECUTE') as service_role_may_cas;
-- expect: false, false, true  (repeat for ..._rollback)
```

Confirm the unprivileged path is closed end-to-end: an **anon-key** RPC call to
`/rest/v1/rpc/prod_backfill_body_pointer_cas` returns **42501**, and all 34
pointers are still `NULL` (installing the schema writes no data):

```sql
select count(*) filter (where body_en_path is not null
                           or body_it_path is not null) as pointed
  from public.blog_posts
 union all
select count(*) filter (where body_en_path is not null
                           or body_it_path is not null)
  from public.portfolio_posts;
-- expect 0 and 0
```

Also confirm `pg_catalog.sha256(bytea)` exists
(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='pg_catalog' and p.proname='sha256'`) before relying on the CAS.

### 6. Provision `website-content` through the Storage API

The bucket is API-managed, never inserted by SQL. Inspect first (read-only),
then create:

```bash
# read-only: reports missing / already-correct / drifted + observed buckets
bun run storage:content:prod:setup

# mutate: create the bucket only if missing, with the required configuration
CMS_PROD_STORAGE_APPLY_ACK=yes-apply-to-production \
  bun run storage:content:prod:setup --apply
```

The command never updates, deletes or recreates an existing bucket, never
touches `website-content-dev`, and refuses unless `APP_ENV=production`,
schema `public`, project `mtvwynyikouqzmhqespl` and a server secret are set. An
existing bucket whose configuration diverges is **reported as `drifted` and
never silently repaired**.

### 7. Verify the private bucket configuration

Re-run the read-only command and require `"status": "already-correct"`,
`"ok": true`, `"mutated": false` and:

```json
"config": { "public": false, "fileSizeLimit": 1048576, "allowedMimeTypes": ["text/markdown"] }
```

Any `drift` entry, any `unexpectedBuckets` entry, or any status other than
`already-correct`/`created` is a stop condition for D1.

### 8. Apply the reviewed Storage RLS policy in a single database transaction

The reviewed artifact is
`supabase/review/prod_website_content_storage_rls.sql` and it is
**authoritative**: this runbook deliberately does not retype the policy SQL,
because an inlined copy can drift from the checksum-pinned file. The file
contains exactly one `DROP POLICY IF EXISTS` + one `CREATE POLICY`, and they
must be **one transaction** — a partially replaced policy is unacceptable.

```bash
# byte-exact apply of the reviewed artifact: one transaction, abort on first error
psql "$PROD_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  -f supabase/review/prod_website_content_storage_rls.sql
```

As in D1 step 4 the file is applied by path with `ON_ERROR_STOP` +
`--single-transaction` (atomic, error-stop); re-confirm its checksum (step 2)
immediately before. The policy CANNOT be created before D1 step 4 (its predicate
references `body_en_path` / `body_it_path`). It touches `storage.objects` only —
no bucket row, no `INSERT`/`UPDATE`/`DELETE` policy, no other `storage` policy.
Its full text, read model, activation order and rollback are documented at the
top of the file.

### 9. Independently verify Storage policy predicates and effective access

```sql
select policyname, cmd, roles, qual
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
 order by policyname;
```

Require exactly one new row — `website_content_body_read / SELECT /
{anon,authenticated}` — whose `qual` mentions `website-content`,
`storage.allow_any_operation` and both `public` post tables, and does **not**
mention `website-content-dev`. Require **no** new INSERT/UPDATE/DELETE/ALL row
and no change to pre-existing `storage.objects` / `storage.buckets` policies.

Effective access (post-migration; pre-backfill every predicate is `NULL`, so
downloads only succeed once pointers exist — this step verifies the **deny**
side first): as an anonymous caller, an object that no visible pointer
references returns 400/404, a hidden post's referenced body returns 400/404, a
bare prefix listing is not authorized (`allow_any_operation` gate), and
`service_role` still uploads/lists/deletes unaffected (BYPASSRLS).

---

## D2. Application compatibility, deployment order and flags

Flags (deployment **assertions**, never proof):

| Flag | App | Meaning |
|---|---|---|
| `CMS_BODY_POINTER_COLUMNS` | CMS | the pointer columns exist in this schema (backfill-tooling assertion; the CMS write path no longer reads it) |

> **Retired compatibility flag.** The legacy-column write shim no longer exists:
> while `body_en` was still `NOT NULL`, a write kept the non-Markdown placeholder
> in it so every save satisfied the constraint. Its flag was set `false` only
> AFTER the column had been made nullable and BEFORE the contraction dropped it
> (never while it was still `NOT NULL`, and never by dropping the column first),
> and the shim module plus its flag were deleted together with the columns.
> Setting the former variable now has no effect. See
> `docs/PRODUCTION_LEGACY_RETIREMENT.md` for the ordering.

> **Retired write flag.** `CMS_BODY_DUAL_WRITE_ENABLED` no longer exists: a body
> is written ONLY to the content bucket, and the row's pointer is committed
> afterwards by ONE `UPDATE` guarded on the pointer this save observed
> (`body_<locale>_path`, NULL included). The retired
> `prod_backfill_body_pointer_cas` function is not used. Order of operations is
> objects first (immutable upload, bytes re-hashed against the key) and then the
> pointer, so a failed upload can never leave a pointer set and a failed commit
> can never publish bytes that were not proven stored. PostgreSQL and Storage
> share **no transaction**: an object uploaded by a save whose commit failed (or
> was lost to a concurrent edit) stays unreferenced and is reclaimed by the
> Storage GC. Setting the variable has no effect.

> **Retired read flags.** `CMS_BODY_STORAGE_READ_ENABLED` and
> `WS_BODY_STORAGE_READ_ENABLED` no longer exist: the reader retirement made both
> applications read Markdown from Storage **unconditionally** — the detail
> projections name `body_en_path` / `body_it_path` and never `body_en` /
> `body_it`, with no fallback and no Storage/legacy comparison. There is nothing
> to enable, disable or roll back on the read path, and setting either variable
> has no effect. Any later step below that names one of them describes the
> executed CP-1B/CP-3 sequence; the rollback for a read failure is now a
> deployment rollback (see D-rollback row 7).

Only two pairings resolve a bucket: `APP_ENV=production` + schema `public`
→ `website-content`, and non-production + `dev_staging` → `website-content-dev`.
Anything else fails closed before any DB or Storage call.

### Exact deployment order

1. **D1 step 4** installed the additive schema. The running CMS does **not**
   reference the new columns yet (`CMS_BODY_POINTER_COLUMNS` unset/false), so no
   application change is required to install infrastructure.
2. **Deploy CMS** at the version that supports pointer columns, dual-write and
   Storage-first reads, with **all three body flags OFF**.
   **Deploy WS** with `WS_BODY_STORAGE_READ_ENABLED` unset.
3. **Verify CMS/WS compatibility with Storage reads disabled** — both run the
   legacy path exactly as before D1. This is a required gate: read/write
   activation is never enabled on an unverified deployment.
4. Only after D1 step 5 independently verified the schema, set
   **`CMS_BODY_POINTER_COLUMNS=true`** on production CMS and redeploy.
5. Keep **`CMS_BODY_STORAGE_READ_ENABLED`** and **`WS_BODY_STORAGE_READ_ENABLED`**
   OFF until the content migration is complete **and verified** (D3 → D4).
6. Keep **`CMS_BODY_DUAL_WRITE_ENABLED`** OFF during the backfill (see below).
   *Historical:* the flag is retired (see "Retired write flag"), so the write
   activation is now simply the deployment of the write-path revision — there is
   no longer a write flag to hold off.
7. Read activation happens in D4 under **CP-3**.

### Ordering constraints (hard)

- `CMS_BODY_POINTER_COLUMNS=true` **follows** independently verified schema
  (D1 step 5). Its value asserts the columns exist; enabling it creates nothing
  and must never run before the migration lands (it defaults off so nothing
  referenced the columns before step 4).
- **Storage reads stay disabled until the content migration is complete and
  verified.** Enabling a read flag creates nothing — pointers and objects must
  already exist or reads fall back/fail.
- Dual-write is **not** enabled during the cutover; it needs the columns and,
  to avoid a stale pointer, a populated pointer for every edited post.

### Chosen cutover write strategy: controlled legacy-write mode with pointer clearing

**Decision: controlled legacy-write mode with pointer clearing.** Rationale:

- During the migration window the CMS keeps writing the legacy `body_en` /
  `body_it` columns (the immutable source of truth for the backfill) and does
  **not** write Storage. This removes every dual-write failure mode from the
  critical path.
- Because `CMS_BODY_POINTER_COLUMNS=true` declares the columns, a **legacy-only
  body edit clears exactly the edited locale's pointer**: for every modified
  locale the CMS sets `body_<locale>_path = NULL`. So a post edited after being
  backfilled cannot keep a pointer to content that no longer matches its
  committed legacy body — a later Storage-first read could never disagree with
  the committed body.
- **Metadata-only updates** (title, tags, visibility, buttons, publish state)
  touch no body, so they clear nothing.
- **Locales that were not edited** keep their pointers untouched; only the
  edited locale is cleared.
- A cleared pointer simply classifies the row as pending again, and a
  `--apply --resume` run (or a later plan/exec) re-migrates that locale from the
  new committed body.

Consequence: **never assume nobody edits content during migration.** Edits are
expected and handled by pointer clearing; the fallback is always the legacy
column, which stays authoritative until Storage reads are verified.

Dual-write mode (pointer populated everywhere + `CMS_BODY_DUAL_WRITE_ENABLED=true`)
was a **post-cutover** activation and is now the ONLY write mode: the flag is
retired, the legacy columns are never written with Markdown (only the `body_en`
placeholder while that column is still `NOT NULL`), and the shim is switched off
after the column has been made nullable and before the contraction drops it — the
file is deleted together with the columns. See
`docs/PRODUCTION_LEGACY_RETIREMENT.md` for the ordering.

---

## D3. Production backfill

Prerequisites: D1 complete and verified; CP-1 held; D2 step 2–4 deployed;
journal, endpoint and rollback readiness confirmed below.

### 1. Refresh the source inventory

```bash
bun run storage:content:prod:backfill:plan --manifest
```

Read-only, pointer-aware (post-schema; `--manifest` is explicit so the mode never
depends on the value of `CMS_BODY_POINTER_COLUMNS`). It reads the current
committed bodies,
captures exact SHA-256 and sizes, generates canonical production object paths,
inspects committed pointers and classifies entries
(`UPLOAD_AND_POINT` / `ALREADY_CURRENT` / `SKIP_EMPTY` / `BLOCKED`), and reports
blockers explicitly. It never reuses the DEV manifest.

### 2. Generate a fresh production manifest

The manifest is the run's identity. Record its **digest** from the plan output.

### 3. Compare against the approved snapshot

Recompute source hashes **immediately before the authorized run**; do **not**
embed the D1 hashes as permanent assumptions in the executor. Compare the fresh
manifest against the `prod-snapshot.sha256` fingerprint:

- rows still 17, non-empty bodies still 34, bytes matching the snapshot;
- every body-backed entry `UPLOAD_AND_POINT` (or `ALREADY_CURRENT` on a resume),
  no `BLOCKED`;
- no oversized (> 1 MiB) body, no missing/corrupt source body.

Any divergence is a stop: re-plan, and if content legitimately changed, re-issue
the snapshot record before proceeding.

### 4. Verify the journal destination

A **persistent production-specific journal outside both repositories**,
absolute path, owner-only (e.g.
`/var/lib/cms-backfill/prod/backfill-run.jsonl`). The variable that carries it is
`PROD_BACKFILL_JOURNAL_PATH`, refused when it points inside either repository or
under a `CMS_PROD_BACKFILL_FORBIDDEN_ROOTS` entry, and refused when the file is
group- or world-readable — it is **never** the DEV journal path, and a DEV
journal path or DEV acknowledgement value is never production authorization.

```bash
bun run storage:content:prod:backfill:exec --preflight
```

The preflight must report the journal destination as present, absolute and
outside the repository. Before the first run the journal file does not exist
yet, so the report shows `"pathConfigured": true`, `"trustworthy": true` and
`"runs": []` (or `"pathConfigured": false` when the variable is unset). That is
**expected** — the destination is validated against the roots and permissions,
and the run list stays empty until the first `--apply` writes it. A
`"destinationProblem"` or a non-trustworthy journal is a stop.

### 5. Verify the revalidation endpoint

Production requires an **explicitly configured, validated HTTPS endpoint**
(exact-origin allowlist; the DEV-only `localhost`/`127.0.0.1` rule does **not**
apply and must not be reused). Confirm `WEBSITE_REVALIDATION_URL` is a
configured HTTPS production origin with path
`/api/internal/content-revalidate`, and that `WEBSITE_REVALIDATION_SECRET` is
present. The preflight reports whether the destination is configured **and
approved**. Do not invent a hostname; use the approved production origin.

### 6. Verify rollback readiness — capability before the run, candidates after it

Rollback has two distinct operations and they are verified at two different
times. The **planner needs a recorded run and its journal**, and before the
first run neither exists — so the planner invocation is *not* the pre-run
readiness check, and an empty plan before the first run is expected, not a
broken rollback.

**(a) Rollback capability / readiness — no journal required.** The
`--preflight` of step 4 *is* the rollback-readiness report: its `cas-rollback`
probe proves the atomic rollback function exists with its exact signature and
reaches its argument validation (a missing artifact reports `missing`), and its
`cas-forward`, `cas-privileges`, `pointer-columns`, `bucket-config` and
`storage-rls` probes cover the rest of the rollback surface. Preflight must be
fully `"ok": true` before CP-2, and it reads no journal run state. The planner
itself is reachable without a run too — an absent journal is *expected* here:

```bash
PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/backfill-run.jsonl \
bun run storage:content:prod:backfill:rollback
```

Exit **0** with `"plan": []`, `"summary": { "planned": 0, … }` and
`"mutationsPerformed": 0` (observed on the un-run production project). The
variable must be set: omitting it is refused with exit **5**
(`PROD_BACKFILL_JOURNAL_PATH must name the journal produced by the backfill
run`) — the CLI declining to guess a journal, not a broken rollback. A
group/world-readable journal path, or one inside a repository root, is refused
with exit **5** as well.

**(b) Rollback candidate planning — after the backfill, still read-only.** Once
D3 step 8 has written the run (and only then), the same command — still without
`--apply` — reconstructs the candidates from the recorded run identity plus its
immutable manifest digest and classifies each against the live row:

```bash
PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/backfill-run.jsonl \
bun run storage:content:prod:backfill:rollback --run-id=<recorded run id>
```

Exit **0** when the plan is empty **or at least one** candidate is `READY`; exit
**1** when candidates exist but none is `READY` (e.g. all `ALREADY_ROLLED_BACK`,
or all conflicted). It must show no `BODY_CHANGED` / `POINTER_DRIFTED`
candidate before any apply — read those states from the report's `summary`,
never from the exit code alone. `--apply` is a separate, **CP-4**-gated mutation
(D5 row 9) and is never part of readiness.

### 7. Obtain separate production backfill authorization — **CP-2**

Separate from CP-1. Record the exact manifest digest being authorized.

### 8. Execute the production backfill

```bash
# fresh run
CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill \
PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/backfill-run.jsonl \
bun run storage:content:prod:backfill:exec --apply --new-run \
  --confirm-digest=<fresh manifest sha256> \
  --expect-project-ref=mtvwynyikouqzmhqespl

# explicit recovery of an existing run
CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill \
PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/backfill-run.jsonl \
bun run storage:content:prod:backfill:exec --apply --resume \
  --confirm-digest=<RECORDED manifest sha256 from the journal> \
  --expect-project-ref=mtvwynyikouqzmhqespl
```

The production contract above is fixed by the CLI; both values are owner-only and
outside the repositories:

- `CMS_PROD_BACKFILL_APPLY_ACK=yes-apply-to-production-backfill` — the
  production-only acknowledgement that arms `--apply`. A production-specific
  variable **and** value: DEV's pair
  (`CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging`) is never accepted as
  production authorization.
- `PROD_BACKFILL_JOURNAL_PATH` — the production journal pointer (DEV used
  `BACKFILL_JOURNAL_PATH`). It must name an absolute path outside both
  repositories and outside every `CMS_PROD_BACKFILL_FORBIDDEN_ROOTS` entry,
  created `0600`, and refused when group- or world-readable; it must be distinct
  from any DEV journal.
- `CMS_PROD_REVALIDATION_ORIGINS` — comma-separated bare origins. The applied
  `WEBSITE_REVALIDATION_URL` must be `https`, on an origin listed verbatim
  there, on path `/api/internal/content-revalidate`, with the signing secret
  present. DEV's local-HTTP allowance is never consulted for production.

Apply requires, all at once: `APP_ENV=production`; schema exactly `public`;
project exactly `mtvwynyikouqzmhqespl`; bucket exactly `website-content`;
verified pointer columns/constraints; verified CAS signatures and privileges;
verified bucket configuration and RLS readiness; a fresh manifest digest; an
explicit production-only acknowledgement; a journal outside the repositories; an
approved HTTPS revalidation endpoint with valid signing credentials; and an
explicit `--new-run`/`--resume`. `--resume` requires the **recorded** digest and
never silently reinterprets a different run.

Per entry the executor executes, in order: (1) verify the original source
Markdown; (2) verify the intended immutable path; (3) upload **without upsert**;
(4) download and hash-verify the object; (5) execute the CAS; (6) verify the
committed pointer; (7) send the signed cache invalidation; (8) durably record the
outcome.

### 9. Stop on the first unexpected error

Strict sequential fail-fast. On the first unexpected failure the executor: stops
starting new operations; preserves completed pointers and objects; preserves the
journal; reports the failed entry and the pending entries; exits nonzero; never
resumes automatically, never rolls back automatically, never deletes objects. A
retry preserves the original manifest and all historical attempts.

### 10. Independently verify every pointer and object

Independently of the executor's own report, confirm for every manifest entry:

```sql
-- pointer equals the manifest's expected canonical path
select id, body_en_path, body_it_path
  from public.blog_posts order by id;
select id, body_en_path, body_it_path
  from public.portfolio_posts order by id;
```

For each pointer, download the object and verify **HTTP success and the exact
downloaded bytes** — never hash an error response. The object's name ends in the
SHA-256 of its own content, so the download must hash back to its own key:

```bash
# per entry, read-only; the secret comes from the environment (see Secret hygiene)
sha='<the 64 hex characters from the pointer key>'
url="$SUPABASE_URL/storage/v1/object/website-content/blog/<id>/<locale>/$sha.md"
out="/var/lib/cms-cutover/downloads/$sha.md"

code=$(curl -sS --fail-with-body -o "$out" -w '%{http_code}' \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  "$url") || { echo "download failed (HTTP $code) — refusing to hash an error body"; exit 1; }
[ "$code" = "200" ] || { echo "unexpected HTTP $code"; exit 1; }

echo "$sha  $out" | sha256sum -c -    # exact bytes must equal the key's address
```

`--fail-with-body` makes curl exit non-zero on 4xx/5xx, the explicit `$code`
check pins the success status, and only then are the bytes hashed; a 404 body or
an XML/JSON error page can never be compared against the key. Redirect output
and downloads only into a `0700` directory outside both repositories (see
*Secret hygiene*).

Require: pointer count = 34, object count = 34, every object hash matches its
key and the manifest `sourceSha256`, and no orphan object exists without a
committed pointer.

---

## D4. Read activation and verification

Prerequisite: D3 step 10 fully verified. All activations are gated by **CP-3**.
Verify with the **production runtime**, not with the CLI, and capture evidence.

> **Executed (CP-3).** Steps 1–2 below are the historical activation record. The
> read flags are retired: both applications now resolve bodies from Storage
> unconditionally, so there is nothing to set to activate a read path (see
> "Retired read flags" in D2). Steps 3+ (write activation and the write-path
> checks) are unaffected.

### Controlled activation order

1. **CMS Storage-first reads** — set `CMS_BODY_STORAGE_READ_ENABLED=true` on
   production CMS (`APP_ENV=production`, schema `public` → `website-content`) and
   redeploy.
   Verify actual reads of referenced Storage objects through the CMS runtime for
   **visible and hidden** posts in **both languages** (request evidence: a CMS
   read triggering
   `GET .../storage/v1/object/website-content/<kind>/<id>/<locale>/<sha>.md` →
   `200 text/markdown`, and the rendered body matching the committed bytes).
2. **WS Storage-first reads** — set `WS_BODY_STORAGE_READ_ENABLED=true` on the
   public site and redeploy.
   Verify the public detail page downloads the referenced object (network
   evidence: the same `object/website-content/...` GET returning
   `text/markdown`), not merely that the page renders. Test visible and hidden
   posts, EN and IT.
3. **CMS Storage-only writes** — the write path is unconditional now
   (`CMS_BODY_DUAL_WRITE_ENABLED` is retired; see "Retired write flag"), so this
   activation is the deployment of the write-path revision itself.
   Verify a create/edit uploads the immutable object, re-hashes the stored bytes
   against the key, and only then commits the pointer; that a metadata-only edit
   makes **no** Storage call and touches neither pointer; that an unchanged body
   uploads nothing; and that a concurrent edit is reported as a conflict instead
   of being overwritten.

Each step is verified before the next is enabled; enabling the next step does not
imply the previous one passed.

### No-regression checklist

- **No metadata regression** — titles, tags, buttons, visibility and publish
  state unchanged; lists/pagination identical.
- **No public access to hidden bodies** — a `hidden = true` post's body object
  is denied (400/404) to the anon/publishable path.
- **No unexpected listing permissions** — a bare prefix listing is not
  authorized (the `allow_any_operation` gate); only exact-name downloads are.
- **No service-role key exposure** — no server secret reaches the client; the
  RPC path stays service-role-only (42501 for anon/authenticated).
- **No stale cache entries** — all required signed invalidations returned
  `sent`/acknowledged; `post:<kind>:<id>` detail tags revalidated for every
  migrated post (list tags only if a change reaches a list surface).
- **No missing or corrupt Markdown** — every referenced object exists and
  byte-verifies against its key hash.
- **No unintended production writes during verification** — verification itself
  performs no pointer switch, upload, delete or flag change.

All required signed invalidations must be acknowledged before D4 is closed.

---

## D5. Safe-stop and rollback

For each operational checkpoint: preconditions, expected state, exact command,
verification, safe stop, recovery, and whether a **new** authorization is
required. Failure classes are distinguished per row.

Guiding rules for every class: **preserve the ability to roll the applications
back to a known-good revision and keep serving valid Markdown from Storage** —
both readers are Storage-only, so the legacy `body_en` / `body_it` columns are no
longer a fallback and no read flag can be switched off. During emergency recovery
**do not** remove pointer columns, objects or the production bucket. Actual
pointer rollback requires **CP-4** and verified conflict-free candidates.

| # | Checkpoint / failure class | Preconditions | Expected state | Exact command | Verification | Safe stop | Recovery | New auth? |
|---|---|---|---|---|---|---|---|---|
| 1 | **Infrastructure deployment failure** (schema install, D1 step 4) | CP-1 held; checksums match | One transaction committed | `psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/review/prod_markdown_backfill_cas.sql` | D1 step 5 queries | `ON_ERROR_STOP` aborts at the first error and the single transaction rolls back, leaving the schema unchanged | Re-run the same single-file apply; the file is idempotent (`IF NOT EXISTS` / scoped `DO` blocks) | No (within CP-1) |
| 2 | **Bucket provisioning failure** (D1 step 6) | CP-1 held | Bucket `website-content` present, private | `CMS_PROD_STORAGE_APPLY_ACK=yes-apply-to-production bun run storage:content:prod:setup --apply` | D1 step 7 read-only status | Do not create by SQL; stop | Re-run `--apply`; if `drifted`, reconcile deliberately (never auto-repair) | No (within CP-1) |
| 3 | **Security / RLS failure** (D1 step 8) | Bucket exists; pointer columns exist | Exactly one SELECT policy | `psql "$PROD_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/review/prod_website_content_storage_rls.sql` | D1 step 9 `pg_policies` + anon download tests | `ON_ERROR_STOP` aborts at the first error and the single transaction rolls back (the previous policy survives) | Re-run the same file; drop the policy alone to revert (`drop policy if exists website_content_body_read on storage.objects;`) | No (within CP-1) |
| 4 | **Partial Markdown backfill** (D3 step 8) | CP-2 held; manifest digest recorded | Some `UPLOADED_AND_POINTED`, run stopped | Stop at first error (executor halts itself) | D3 step 10 per-entry pointer/object verify | Read flags stay off throughout; legacy serves | Fix the cause, then `storage:content:prod:backfill:exec --apply --resume --confirm-digest=<recorded>` | No (within CP-2) |
| 5 | **Unexpected CMS edit** (during or after backfill) | — | Edited locale's pointer cleared by legacy-write pointer clearing | none (automatic) | Plan shows that locale pending/`BLOCKED` | Do not force a stale pointer | Re-migrate the edited locale via `--resume` or a fresh authorized run | New CP-2 if a new run/digest is required |
| 6 | **Cache invalidation failure** (D3 step 8 / D4) | Pointer switched | Entry `REVALIDATION_FAILED`, post in pending list | `storage:content:prod:backfill:exec --apply --resume …` (retries pending invalidations) | Object/pointer unchanged; event returns `sent` | Reads still safe (pointers correct) | Retry invalidations without touching pointers/objects | No (retry of recorded work) |
| 7 | **Storage-read failure** (D4) | Prior revision known-good | Reads failing in one app | Roll the app revision back to its previous deployment — the read path is unconditional, so there is no read flag to disable and no legacy fallback to fall into | Previous revision serves its bodies from Storage | Recovery is a redeploy of the previous revision | Investigate (bucket/RLS/object), re-verify, then redeploy the fixed revision | New deployment authorization |
| 8 | **Failed application deployment** (D2/D4) | Prior revision known-good | New revision unhealthy | Roll back the app revision | Previous revision healthy | Recovery is a redeploy of the previous revision | Fix and redeploy; re-verify the read path before any further activation | New deployment authorization |
| 9 | **Pointer rollback** (explicit) | CP-4 held; rollback plan shows zero conflicts | `ROLLED_BACK` pointers | `CMS_PROD_BACKFILL_ROLLBACK_ACK=yes-rollback-to-production-backfill PROD_BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/prod/backfill-run.jsonl bun run storage:content:prod:backfill:rollback --apply --run-id=<id> --expect-project-ref=mtvwynyikouqzmhqespl` | Per-entry restored pointer; no `BODY_CHANGED`/`POINTER_DRIFTED` | Stop on first conflict; restored entries stay | Re-invoke to resume; per-post invalidation after all locales restored | **Yes — CP-4** |

Rollback never modifies legacy Markdown, never performs Storage cleanup, and
never removes the bucket or pointer columns. Any rollback candidate that drifted
(`BODY_CHANGED`, `POINTER_DRIFTED`) is refused, not forced — the owning CMS edit
wins. Actual rollback execution is impossible without a separate explicit
operator invocation.

---

## D6. Monitoring

Assess the cutover from production evidence, not from the migration report. For
each signal, capture the evidence and apply the declared condition.

| Metric | Evidence source | Healthy | Stop-and-revert to legacy reads |
|---|---|---|---|
| Storage download errors | Storage API 4xx/5xx rate for `website-content` objects; WS/CMS runtime logs | 0 sustained errors after activation | Any sustained error rate on referenced objects |
| SHA-256 integrity failures | object-download hash vs key hash; `VERIFY_FAILED` outcomes | 0 mismatch | Any mismatch |
| Legacy/Storage disagreements | CMS/WS agreement check (committed column vs downloaded bytes) | 0 disagreements | Any disagreement |
| CMS write failures | CMS mutation error logs; `write` failures | no new class of write error after `CMS_BODY_POINTER_COLUMNS=true` | Writes failing because of the pointer columns |
| Missing pointer / object count | D3 step 10 counts (pointers = objects = 34, no orphans) | equal, no orphan | any referenced object missing |
| Cache invalidation failures | `REVALIDATION_FAILED` / pending posts; site cache hit on stale body | 0 pending; all events `sent` | stale body served because invalidations cannot be delivered |
| Hidden-content access tests | anon download of hidden post body (expect 400/404); bare listing denied | all deny as expected | any hidden body or unexpected listing accessible |
| Rollback candidate drift | `storage:content:prod:backfill:rollback` plan classification | all `READY`/`ALREADY_ROLLED_BACK` | any `POINTER_DRIFTED`/`BODY_CHANGED` that blocks recovery |

### Declaring production healthy

All of the following hold for the observation window: 0 Storage download
errors, 0 SHA-256 integrity failures, 0 missing
pointers or objects, 0 cache invalidation failures, hidden-body and listing
access tests deny as expected, no service-role key exposure, and no new CMS
write-failure class. Only then is D4 closed.

### Stopping and reverting

On any stop-and-revert condition: roll both applications back to the previous
deployment — the read path is unconditional, so there is no read flag to switch
off and no legacy `body_en` / `body_it` path to fall into.
Do **not** delete objects, pointers or the bucket. Investigate, then re-verify
before redeploying the fixed revision. Pointer rollback, if needed, requires
**CP-4** and conflict-free candidates.

---

## Phase 14 approval checkpoints (summary)

1. **CP-0** — Phase 14 entry.
2. **CP-1** — infrastructure: additive schema + CAS (D1 step 4), `website-content`
   provisioning (step 6), Storage RLS apply (step 8).
3. **CP-2** — production backfill execution (D3 step 8), separate from CP-1.
4. **CP-3** — read activation: CMS Storage-first reads, WS Storage-first reads,
   CMS dual-write (D4).
5. **CP-4** — pointer rollback execution (D5 row 9).

Every mutation above is Phase 14. Nothing in this document authorizes a Phase 13
production change.
