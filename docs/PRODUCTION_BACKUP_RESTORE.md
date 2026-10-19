# Production legacy-body backup and restore

Operator procedure for the baseline that makes
`supabase/review/prod_legacy_body_retirement.sql` (the `body_en` / `body_it`
column drop on `public.blog_posts` / `public.portfolio_posts`) survivable.

The command is `src/utils/cms/prodLegacyBodyBackup.ts`
(`bun src/utils/cms/prodLegacyBodyBackup.ts …`). Its intended `package.json`
script name is `backup:content:prod:legacy-bodies`; adding that script is a
parent-owned change to `package.json`, and every example below works without it.

## Why this command exists

Before the contraction those column values have exactly ONE copy, and the
contraction is irreversible. A server-side export such as

```sql
copy (select 'blog' as kind, id, hidden, json_build_object(…) from public.blog_posts) to '/tmp/prod-bodies-before-contraction.jsonl';
```

is **not** an acceptable recovery artifact: it runs inside the database host, it
writes into the project, the operator cannot re-hash it, it does not capture the
Storage bytes, and it cannot be restored independently (or rehearsed) without
re-reading production.

`prodLegacyBodyBackup.ts` is the replacement:

- it reads production **only** over PostgREST (post rows) and the Supabase
  **Storage API** (object bytes). There is no SQL in the module, no `COPY`, no
  `storage.objects` access, and nothing is ever written into the project — not a
  row, not an object, not a bucket;
- it captures every post's kind/id/visibility, the legacy `body_en`/`body_it`
  values, the committed canonical pointers, and the authoritative Storage bytes
  for every referenced pointer, each with its SHA-256 and byte length;
- it writes a timestamped, append-only run directory (`0700`, files `0600`)
  **outside both repositories**, with a `manifest.json` recording every hash and
  a `SHA256SUMS` file the operator retains out of band;
- `--verify` re-hashes the whole artifact offline (no network);
- `--restore` replays it into a scratch table or a scratch project, and refuses
  every live production content table.

## Timing: take the baseline BEFORE the shim-enabled CMS deploys

`src/libs/cms/legacyBodyEnShim.ts` keeps `body_en` `NOT NULL` until the
contraction by writing the placeholder `[content moved to object storage]` into
it on every create and update. **Any post saved by that revision has already
lost its legacy English body** — no backup taken afterwards can recover it.

Therefore:

| # | Step | Notes |
|---|---|---|
| 0 | **Take this baseline backup** | before the CMS revision that carries the shim reaches production |
| 1 | Deploy the Storage-only application revisions | CMS `retire-legacy-bodies`, WS `storage-only-runtime` |
| 2 | Verify Storage-only rendering in production | editor loads/saves, hidden posts unreachable |
| 3 | Re-run this command for a pre-contraction refresh (optional) | any post saved at step 1/2 has a placeholder `body_en`; the re-run reports it as an error finding |
| 4 | Apply the contraction | one transaction, `<cli> db query --linked --file <wrapped>` |
| 5 | Verify, then run the GC | |

A captured `body_en` equal to the placeholder is reported as the
`legacy-body-placeholder` finding, marks the artifact `complete: false`, and
exits `1` — a too-late run can never be mistaken for a baseline.

## Modes and flags

```
bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir>
    read-only dry run: reads production, writes nothing anywhere
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply
    write the baseline artifact
bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<dir>
    offline: re-hash every on-disk file against the manifest
CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target \
  bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<dir> \
    [--restore-schema=public] [--restore-table=legacy_body_backup_restore] \
    [--restore-bucket=<bucket>] --apply
    restore into a SCRATCH target
```

| Flag | Meaning |
|---|---|
| `--out-dir=<dir>` | root for `--apply`-created run directories; must be outside both repositories |
| `--backup-dir=<dir>` | an existing run directory (`--verify`, `--restore`) |
| `--apply` | performs writes (required for an artifact write or a restore) |
| `--verify` | verify an artifact; performs no writes and needs no credentials |
| `--restore` | restore an artifact into the scratch target |
| `--restore-schema` / `--restore-table` | target for rows (default `public.legacy_body_backup_restore`) |
| `--restore-bucket` | also re-upload the captured object bytes into this bucket; omit for a rows-only restore |
| `--json` | machine-readable report only, no prose |
| `--help`, `-h` | usage |

Silence is read-only everywhere: without `--apply` nothing is written on any
surface, ever (no artifact file, no upsert, no upload). Unknown, duplicated or
misplaced flags are refused rather than ignored.

### Gates

| Gate | Refusal |
|---|---|
| environment (export) | `APP_ENV` must be exactly `production` (read verbatim, no `NODE_ENV` fallback), `NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public`, `NEXT_PUBLIC_SUPABASE_URL=https://<pinned ref>.supabase.co`, `SUPABASE_SECRET_KEY` present |
| acknowledgement (export) | `CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies` |
| output location | `--out-dir` outside both repositories, and not the filesystem root |
| acknowledgement (restore) | `CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target` |
| restore target | `CMS_BACKUP_RESTORE_URL` (a scratch project) + `CMS_BACKUP_RESTORE_KEY`; refuses `public.blog_posts` / `public.portfolio_posts` of the production project, and refuses the production content bucket |
| artifact | a restore refuses to run when the artifact does not verify |

Every client, reader and writer is created *after* its gate, so a refused run
builds nothing and reads nothing.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | settled (clean dry run, complete artifact written, artifact intact, restore applied) |
| 1 | attention required (incomplete capture, verification mismatch, a failed restore write) |
| 2 | invalid usage |
| 3 | refused by a gate (environment, project, out-dir, restore target, artifact completeness) |
| 4 | read or execution failure |
| 5 | refused by the apply gate (acknowledgement missing) |

## Output layout

```
<out-dir>/prod-legacy-bodies-<YYYY-MM-DDTHH-MM-SS-mmmZ>-<runId>/
  manifest.json     every recorded hash: per body, per object, per file
  rows.jsonl        one JSON object per post: kind,id,hidden,body_en,body_it,body_en_path,body_it_path
  objects/
    <kind>/<postId>/<locale>/<sha256>.md   the exact Storage bytes of each referenced pointer
  SHA256SUMS        `<sha256>  <path>` for manifest.json, rows.jsonl and every object
```

- the run directory name is timestamped and the run id is random, so runs sort
  chronologically and never collide; a run directory is created with a
  non-recursive `mkdir` and files with the exclusive `wx` flag, so an existing
  run is never written into, merged with or overwritten;
- the directory is mode `0700` and every file mode `0600`;
- `manifest.json` records, per post and locale: `bodyNull`, `bodySha256`,
  `bodyBytes`, `pointer`, `pointerHash`, `objectPath`, `objectSha256`,
  `objectBytes`, `objectFile`, `objectCaptured`, `objectMatchesBody`; plus the
  object inventory and a `files[]` list with the SHA-256 and byte length of
  `rows.jsonl` and of every object file;
- `manifest.json` cannot contain its own hash, so `SHA256SUMS` pins it; record
  the SHA-256 of `SHA256SUMS` (`sha256sums-sha256` in the human report) **out of
  band**, e.g. in the deployment record. That value is the root of the artifact's
  hash chain.

The artifact is self-sufficient: `rows.jsonl` holds the legacy values,
`objects/` holds the authoritative Storage bytes, and the two hash chains let a
third party re-check both without touching production.

## Verification

Offline, no credentials, no network:

```
bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<run dir>
```

It checks three independent chains and reports one line per anomaly:

1. every file named by `SHA256SUMS` re-hashed against it (this pins
   `manifest.json` itself);
2. the file set against the manifest — a recorded file that is missing and a
   file recorded nowhere are both reported;
3. the semantic level — every captured body re-hashed from `rows.jsonl` against
   the manifest's per-body hash and byte length, and every object re-hashed
   against both the manifest and the hash embedded in its own canonical key.

Exit `0` and `intact=true` mean every recorded hash matches the bytes on disk.
Anything else is tampering, truncation or debris: keep the original artifact,
do not restore from the failing copy, and compare
`sha256sums-sha256` with the value you recorded out of band.

`SHA256SUMS` is GNU-compatible, so an independent check is also available:

```
cd <run dir> && sha256sum -c SHA256SUMS
```

## Restore procedure

The restore target is always a **scratch** target: a scratch table, or a scratch
project. Nothing in this command can write into a live content table.

### 1. Scratch table in the existing project (the rehearsal)

```sql
create table if not exists public.legacy_body_backup_restore (
  run_id         text   not null,
  kind           text   not null check (kind in ('blog','portfolio')),
  post_id        bigint not null,
  hidden         boolean,
  body_en        text,
  body_it        text,
  body_en_path   text,
  body_it_path   text,
  body_en_sha256 text,
  body_it_sha256 text,
  body_en_bytes  bigint not null default 0,
  body_it_bytes  bigint not null default 0,
  primary key (run_id, kind, post_id)
);
```

Then, with the target credentials:

```
export CMS_BACKUP_RESTORE_URL="https://<ref>.supabase.co"
export CMS_BACKUP_RESTORE_KEY="<server-side key — never printed, never logged>"

# dry run first: verifies the artifact and prints exactly what would be written
bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<run dir>

CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target \
  bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<run dir> --apply
```

Rows are upserted on `(run_id, kind, post_id)`, so re-running the same artifact
is idempotent and two artifacts can coexist in one table. `run_id` is the run
directory's suffix.

Check the rehearsal against the manifest:

```sql
select count(*) as rows, count(*) filter (where hidden) as hidden,
       count(*) filter (where body_en is not null) as bodies_en
  from public.legacy_body_backup_restore
 where run_id = '<runId>';                      -- expect rows, hidden and body counts of the manifest

-- must return zero rows: every restored value hashes to its recorded digest
select kind, post_id, 'en' as locale, body_en_sha256
  from public.legacy_body_backup_restore
 where run_id = '<runId>' and body_en is not null
   and encode(sha256(convert_to(body_en, 'UTF8')), 'hex') <> body_en_sha256
union all
select kind, post_id, 'it', body_it_sha256
  from public.legacy_body_backup_restore
 where run_id = '<runId>' and body_it is not null
   and encode(sha256(convert_to(body_it, 'UTF8')), 'hex') <> body_it_sha256;
```

### 2. Scratch project (fully independent)

Create a project, apply the same table DDL there, point
`CMS_BACKUP_RESTORE_URL` / `CMS_BACKUP_RESTORE_KEY` at it and run the same
command. The production project is never contacted by a restore. To rehearse the
Storage half as well, create a bucket in the scratch project and add
`--restore-bucket=<that bucket>`: every captured object is then re-uploaded
immutably (`upsert: false`), read back and proved byte-for-byte, and the restore
refuses if the artifact is missing any referenced object's bytes.

### 3. Production recovery (manual, reviewed — never run from this command)

The tool deliberately cannot write into a live content table. If the dropped
columns have to be repopulated, do it deliberately, in one transaction, from the
rehearsed scratch table:

```sql
begin;

alter table public.blog_posts
  add column if not exists body_en text, add column if not exists body_it text;
alter table public.portfolio_posts
  add column if not exists body_en text, add column if not exists body_it text;

update public.blog_posts b
   set body_en = r.body_en, body_it = r.body_it
  from public.legacy_body_backup_restore r
 where r.run_id = '<runId>' and r.kind = 'blog' and r.post_id = b.id;

update public.portfolio_posts p
   set body_en = r.body_en, body_it = r.body_it
  from public.legacy_body_backup_restore r
 where r.run_id = '<runId>' and r.kind = 'portfolio' and r.post_id = p.id;

-- verify before committing: the counts and per-body digests above must hold,
-- then
commit;
```

The re-added columns are nullable; re-adding `NOT NULL` is a separate,
deliberate decision. Storage objects and the canonical pointers are untouched by
the contraction, so no object restore is needed for this path.

## Findings

The capture reports anomalies instead of skipping them; `severity: error` marks
the artifact `complete: false` and exits `1`.

| Code | Severity | Meaning |
|---|---|---|
| `object-missing` | error | a committed pointer names an object Storage does not have |
| `object-unreadable` | error | the object exists but could not be read |
| `object-hash-mismatch` | error | the stored bytes do not hash to the hash in their own key |
| `body-without-pointer` | error | a non-empty legacy body with no committed pointer: Postgres holds the only copy |
| `legacy-body-placeholder` | error | the captured `body_en` is the shim placeholder — the run is NOT a baseline |
| `unaddressable-pointer` | error | a pointer that is not the canonical key for its own kind/id/locale |
| `duplicate-pointer` | error | two owners reference one object key |
| `body-missing-with-pointer` | warning | a committed pointer whose legacy column is NULL/empty; the object bytes are the only copy |
| `body-object-mismatch` | warning | the legacy column and the canonical object disagree (a post was edited after the backfill, or the shim already deployed) |
| `visibility-unknown` | warning | `hidden` is NULL, so visibility is recorded as unknown |

An `object-missing` / `body-without-pointer` run still writes an artifact — the
values that *are* reachable are captured and hashed — and names the gap in the
manifest, so an incomplete baseline is never mistaken for a complete one.

## Baseline expected on this branch

Observed by a read-only dry run and by the artifact taken on 2026-10-19:

```
rows: total=17 blog=6 portfolio=11 hidden=5 visible=12
bodies: captured=34 bytes=275670
objects: referenced=34 captured=34 bytes=275670 missing=0
findings: errors=0 warnings=0 complete=true
```

which matches the `17 rows, 34 non-empty bodies, 275 670 bytes` expectation of
the retirement plan, plus `34` Storage objects (one per pointer). Record the
artifact's `sha256sums-sha256` in the deployment record when the real baseline is
taken.

## What this command never does

- no SQL of any kind — rows come from PostgREST, object bytes from the Storage
  API; there is no `COPY` and no `storage.objects` access;
- never writes into the project: no insert, no update, no upload against
  production, no bucket creation;
- never mutates production while capturing; a dry run performs exactly the read
  calls of an apply run and writes nothing;
- never overwrites, merges into or updates an existing run directory;
- never restores into `public.blog_posts` / `public.portfolio_posts` of the
  production project, and never uploads into the production content bucket;
- never prints a credential.

## Tests

```
bunx vitest run src/utils/cms/prodLegacyBodyBackup.test.ts \
                src/utils/cms/prodLegacyBodyBackup.fs.test.ts
```

`…prodLegacyBodyBackup.test.ts` drives the whole command against injected fake
row/object clients and an in-memory filesystem: environment/acknowledgement/
out-dir/restore-target refusals (each proving no client was built), zero
mutations in every dry run, manifest and per-body hash correctness, every
finding kind, tamper detection in `--verify` (rewritten object, rewritten row
payload, deleted file, extra file, rewritten manifest, missing artifact), and the
restore dry run/apply/failure paths.

`…prodLegacyBodyBackup.fs.test.ts` exercises the real filesystem: `0700`
directory and `0600` file modes, nested object layout, refusal to reuse a run
directory or to overwrite a file or to escape the run directory, recursive
listing, real byte-level tamper detection, the real repository boundary derived
from the module location, and a full export → verify → restore round trip
through the CLI.

`…prodLegacyBodyBackup.pglite.test.ts` restores into a real PostgreSQL (PGlite,
WASM) whose scratch table is created from the SQL block in this document, using
the real `--restore --apply` path, and then cross-checks counts, per-body
SHA-256 (`encode(sha256(convert_to(…,'UTF8')),'hex')`), byte lengths, visibility
and the pointer columns entirely inside SQL. To rehearse a real artifact the
same way (the CSV below assumes the run directory produced above):

```
LEGACY_BODY_BACKUP_REHEARSAL_DIR=<run dir> \
  bunx vitest run src/utils/cms/prodLegacyBodyBackup.pglite.test.ts
```

The rehearsal target is a scratch database only: the restore never reads
production, never touches the production bucket, and the artifact is left
byte-for-byte unchanged (the suite asserts that before and after its digests).

## Follow-ups owned by the parent

- add the `backup:content:prod:legacy-bodies` script to `package.json` and link
  this document from `docs/PRODUCTION_LEGACY_RETIREMENT.md` (step 3 of its
  deployment ordering, which this document supersedes: the baseline must be taken
  before the shim-enabled revision deploys, not after step 2);
- record the baseline artifact's `sha256sums-sha256` and location in the
  deployment record;
- retire this command together with the shim and the legacy columns, once the
  contraction has been verified.
