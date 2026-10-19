# Production legacy-body backup and restore

Operator procedure for the artifacts that make
`supabase/review/prod_legacy_body_retirement.sql` (the `body_en` / `body_it`
column drop on `public.blog_posts` / `public.portfolio_posts`) survivable.

The command is `src/utils/cms/prodLegacyBodyBackup.ts`
(`bun src/utils/cms/prodLegacyBodyBackup.ts …`), reachable through the
`package.json` script `storage:content:prod:backup`
(`bun run storage:content:prod:backup …`; the module also names an intended
`backup:content:prod:legacy-bodies` alias, which is a parent-owned change to
`package.json`). Every example below works either way.

## Two artifact kinds

The deletion of the legacy columns has **two different backup problems**, and
the command writes a different artifact kind for each. Every artifact records its
own `kind` in `manifest.json`, so the two are never confused:

| | `legacy-baseline` | `storage-authoritative` |
|---|---|---|
| when | **before** the shim-enabled CMS revision deploys | after it (and before the contraction) |
| what it is the only copy of | the pre-shim English `body_en` text | — |
| the authoritative content | the legacy column values **and** the pointer/object pairs | the pointer/object pairs (Storage) |
| a legacy value equal to the placeholder | **error**, `complete: false`, exit `1` — this run is too late to be a baseline | expected: informational finding + `counts.placeholders`, does not affect `complete` |
| a missing / unreadable / hash-mismatched object | error | **error**, `complete: false` |
| completeness | no error findings | no error findings |
| flag | (the default: no flag) | `--storage-authoritative` |

`legacy-baseline` is immutable once taken: it must be captured before the shim
revision reaches production, which is why the ordering below is a hard
constraint. The `storage-authoritative` snapshot is the **recovery artifact for
the drop**: after the shim deploys, the legacy text of any post saved by the
shim-enabled CMS *is* the placeholder by design, and what has to survive the
contraction is the pointer + object pair, not the placeholder string.

Commands:

```
# 1. the original, pre-shim baseline (take BEFORE the shim-enabled CMS deploys)
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply

# 2. the pre-contraction, post-shim recovery snapshot (the one to retake)
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply \
    --storage-authoritative --baseline-dir=<the baseline run dir from 1>
```

`--baseline-dir` is optional and read-only: it compares the new snapshot with the
reference baseline and records every difference as an informational
`baseline-drift` finding plus a `baseline` block in the manifest. Drift is
**reported, never enforced** — a snapshot is judged on its own pointers/objects
and its own records, so the snapshot must not be required to reproduce a
historical legacy-byte total (the baseline's `275670` bytes are context, not a
threshold), and a post added, edited or deleted since the baseline never makes the
artifact invalid.

Completeness therefore means, in both kinds: **every referenced pointer's object
was captured and the bytes hash to the SHA-256 in that canonical key, and every
captured record was written and is verifiable**. Anything that breaks that is an
error; the placeholder (in `storage-authoritative` mode) and drift from the
baseline are not.

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
  **outside both repositories**, with a `manifest.json` recording the artifact's
  `kind`, every hash and the placeholder count, and a `SHA256SUMS` file the
  operator retains out of band;
- `--verify` re-hashes the whole artifact offline (no network), reports the
  `kind` it read, and can assert the kind it must be;
- `--restore` replays it into a scratch table or a scratch project, refuses
  every live production content table, and refuses a `legacy-baseline` artifact
  unless the operator names that kind deliberately.

## Timing: take the baseline BEFORE the shim-enabled CMS deploys

A now-removed compatibility shim kept `body_en` `NOT NULL` until the contraction
by writing the placeholder `[content moved to object storage]` into it on every
create and update. **Any post saved by that revision has already lost its legacy
English body as a column value** — no backup taken afterwards can recover the
pre-shim *text* from Postgres, only the Storage object the shim points at (which is
why the post-shim snapshot is `storage-authoritative`: the object bytes are what
the CMS renders, and they survive the contraction).

Therefore:

| # | Step | Notes |
|---|---|---|
| 0 | **Take the `legacy-baseline` backup** | before the CMS revision that carries the shim reaches production |
| 1 | Deploy the Storage-only application revisions | CMS `retire-legacy-bodies`, WS `storage-only-runtime` |
| 2 | Verify Storage-only rendering in production | editor loads/saves, hidden posts unreachable |
| 3 | Take the `storage-authoritative` snapshot | `--storage-authoritative`, and never overwrite the step-0 artifact |
| 4 | Apply the contraction | one transaction, `<cli> db query --linked --file <wrapped>` |
| 5 | Verify, then run the GC | |

At step 3 a captured `body_en` equal to the placeholder is *expected*, is
recorded as an informational `legacy-body-placeholder` finding with the
placeholder count, and does not affect completeness. Post-shim edits are safe to
make before step 3: an edit writes the placeholder again, so the snapshot is
still complete as long as each post's object is present and hashes to its key.
The same placeholder in a `legacy-baseline` run is an error (`complete: false`,
exit `1`) — a too-late run can never be mistaken for the baseline.

## Modes and flags

```
bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir>
    read-only dry run: reads production, writes nothing anywhere
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply
    write a legacy-baseline artifact
CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies \
  bun src/utils/cms/prodLegacyBodyBackup.ts --out-dir=<dir> --apply \
    --storage-authoritative [--baseline-dir=<legacy baseline run dir>]
    write a storage-authoritative artifact (the recovery snapshot)
bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<dir> \
    [--require-kind=<legacy-baseline|storage-authoritative>]
    offline: re-hash every on-disk file against the manifest
CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target \
  bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<dir> \
    [--restore-schema=public] [--restore-table=legacy_body_backup_restore] \
    [--restore-bucket=<bucket>] [--require-kind=<kind>] --apply
    restore into a SCRATCH target
```

| Flag | Meaning |
|---|---|
| `--out-dir=<dir>` | root for `--apply`-created run directories; must be outside both repositories |
| `--backup-dir=<dir>` | an existing run directory (`--verify`, `--restore`) |
| `--apply` | performs writes (required for an artifact write or a restore) |
| `--storage-authoritative` | write the `storage-authoritative` artifact instead of the default `legacy-baseline`; changes only how the placeholder is classified |
| `--baseline-dir=<dir>` | export only: read that reference artifact (must be a `legacy-baseline`) and record the differences as informational drift |
| `--verify` | verify an artifact; performs no writes and needs no credentials |
| `--require-kind=<kind>` | `--verify` / `--restore`: refuse an artifact that is not of this kind. `--restore` defaults to `storage-authoritative`, so a pre-shim baseline is never silently restored as current |
| `--restore` | restore an artifact into the scratch target |
| `--restore-schema` / `--restore-table` | target for rows (default `public.legacy_body_backup_restore`) |
| `--restore-bucket` | also re-upload the captured object bytes into this bucket; omit for a rows-only restore |
| `--json` | machine-readable report only, no prose |
| `--help`, `-h` | usage |

Silence is read-only everywhere: without `--apply` nothing is written on any
surface, ever (no artifact file, no upsert, no upload). Unknown, duplicated or
misplaced flags are refused rather than ignored, and every flag is only legal in
the mode that uses it (`--storage-authoritative` and `--baseline-dir` belong to
an export, `--require-kind` to `--verify`/`--restore`).

### Gates

| Gate | Refusal |
|---|---|
| environment (export) | `APP_ENV` must be exactly `production` (read verbatim, no `NODE_ENV` fallback), `NEXT_PUBLIC_SUPABASE_DB_SCHEMA=public`, `NEXT_PUBLIC_SUPABASE_URL=https://<pinned ref>.supabase.co`, `SUPABASE_SECRET_KEY` present |
| acknowledgement (export) | `CMS_PROD_BACKUP_APPLY_ACK=yes-export-production-bodies` |
| output location | `--out-dir` outside both repositories, and not the filesystem root |
| acknowledgement (restore) | `CMS_BACKUP_RESTORE_ACK=yes-restore-to-scratch-target` |
| restore target | `CMS_BACKUP_RESTORE_URL` (a scratch project) + `CMS_BACKUP_RESTORE_KEY`; refuses `public.blog_posts` / `public.portfolio_posts` of the production project, and refuses the production content bucket |
| artifact integrity | a restore refuses to run when the artifact does not verify |
| artifact kind | a restore refuses an artifact whose recorded kind is not the required one (`storage-authoritative` by default) |
| reference baseline | `--baseline-dir` must name a readable `legacy-baseline` artifact |

Every client, reader and writer is created *after* its gate, so a refused run
builds nothing and reads nothing.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | settled (clean dry run, complete artifact written, artifact intact, restore applied) |
| 1 | attention required (incomplete capture, verification mismatch, a failed restore write, or an `--require-kind` mismatch) |
| 2 | invalid usage |
| 3 | refused by a gate (environment, project, out-dir, restore target, artifact completeness, artifact kind, a `--baseline-dir` that is not a legacy baseline) |
| 4 | read or execution failure (including a `--baseline-dir` that cannot be read) |
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
- `manifest.json` records the artifact's `kind` (`legacy-baseline` or
  `storage-authoritative`) — the single field that tells the two artifact kinds
  apart without reading the data; an artifact written before this field existed
  omits it and is by definition a `legacy-baseline`, which `--verify` and
  `--restore` read accordingly;
- `manifest.json` records, per post and locale: `bodyNull`, `bodySha256`,
  `bodyBytes`, `pointer`, `pointerHash`, `objectPath`, `objectSha256`,
  `objectBytes`, `objectFile`, `objectCaptured`, `objectMatchesBody`; plus the
  object inventory, `counts` (including `placeholders`), a `baseline` block when
  `--baseline-dir` was used (`runId`, `kind`, the reference's metrics, and the
  human-readable `drift` list), and a `files[]` list with the SHA-256 and byte
  length of `rows.jsonl` and of every object file;
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

The report's first line names the artifact: `runId=… kind=… intact=…`. Add
`--require-kind=<kind>` to make the kind itself a requirement: a mismatch is
reported as an `artifact-kind-mismatch` problem and the artifact is not intact,
so a `legacy-baseline` can never be *silently* accepted where a
`storage-authoritative` snapshot is required:

```
# the pre-shim baseline still verifies (integrity is intact)…
bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<baseline dir>

# …but it is not the authoritative snapshot, and saying so is refused
bun src/utils/cms/prodLegacyBodyBackup.ts --verify --backup-dir=<baseline dir> \
  --require-kind=storage-authoritative
```

Exit `0` and `intact=true` mean every recorded hash matches the bytes on disk.
Anything else is tampering, truncation or debris (or, for `--require-kind`, the
wrong artifact kind): keep the original artifact, do not restore from the failing
copy, and compare `sha256sums-sha256` with the value you recorded out of band.

`SHA256SUMS` is GNU-compatible, so an independent check is also available:

```
cd <run dir> && sha256sum -c SHA256SUMS
```

## Restore procedure

The restore target is always a **scratch** target: a scratch table, or a scratch
project. Nothing in this command can write into a live content table.

The restore also insists on the artifact **kind**: it requires
`storage-authoritative` unless `--require-kind` says otherwise. Restoring a
`legacy-baseline` artifact is what a pre-shim recovery would look like, and it is
allowed, but only when named:

```
# the recovery snapshot: no kind flag needed
bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<storage-authoritative dir> --apply

# the pre-shim baseline: refused (exit 3) unless the kind is named deliberately
bun src/utils/cms/prodLegacyBodyBackup.ts --restore --backup-dir=<baseline dir> \
  --require-kind=legacy-baseline --apply
```

Why the asymmetry: a `legacy-baseline` artifact holds the pre-shim legacy text of
every post as it was when the shim had not run, so it cannot rebuild the current
content of a post that has been edited since; the `storage-authoritative`
snapshot holds the pointer + object pair the CMS actually renders. Neither is
"better" — but the wrong one must never be restored *by accident*, which is why
the default is the current, authoritative kind and the baseline needs an explicit
acknowledgement (its `blocked` message says exactly that).

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

The capture reports anomalies instead of skipping them. `severity: error` marks
the artifact `complete: false` and exits `1`; `warning` asks for review and does
not; `info` records an expected condition and does not.

| Code | Severity | Meaning |
|---|---|---|
| `object-missing` | error | a committed pointer names an object Storage does not have |
| `object-unreadable` | error | the object exists but could not be read |
| `object-hash-mismatch` | error | the stored bytes do not hash to the hash in their own key |
| `body-without-pointer` | error | a non-empty legacy body with no committed pointer: nothing references its content |
| `legacy-body-placeholder` | error in `legacy-baseline`, info in `storage-authoritative` | the captured legacy value is the shim placeholder. In a baseline that means the run is too late; in a storage-authoritative snapshot it is the expected post-shim state, and the pointer's object is the authoritative content |
| `unaddressable-pointer` | error | a pointer that is not the canonical key for its own kind/id/locale |
| `duplicate-pointer` | error | two owners reference one object key |
| `body-missing-with-pointer` | warning | a committed pointer whose legacy column is NULL/empty; the object bytes are the only copy |
| `body-object-mismatch` | warning | the legacy value is neither the placeholder nor the value the object holds (a post edited after the backfill, or a partially migrated row). In `storage-authoritative` mode the object is the content of record, so this is a review item, not a failure — the placeholder variant of this disagreement is not reported separately, because the placeholder finding already explains it |
| `visibility-unknown` | warning | `hidden` is NULL, so visibility is recorded as unknown |
| `baseline-drift` | info | `--baseline-dir` was given and the capture differs from that reference (one entry listing every metric that moved). Reported, never enforced |

An `object-missing` / `body-without-pointer` run still writes an artifact — the
values that *are* reachable are captured and hashed — and names the gap in the
manifest, so an incomplete artifact is never mistaken for a complete one.

## Artifacts taken on this branch

The original, pre-shim `legacy-baseline` — captured before any deployment, and
**not** to be overwritten or regenerated:

```
/home/okazakee/Desktop/Projects/okazakee-prod-backups/prod-legacy-bodies-2026-10-19T01-09-40-544Z-5487d7b75377
manifest.json sha256  948794ee6d6cc6e5628777fc0cdf7c5aaba5250ca01bbf3b569177e852d69001
```

Its report (also the historical expectation of the retirement plan):

```
rows: total=17 blog=6 portfolio=11 hidden=5 visible=12
bodies: captured=34 bytes=275670
objects: referenced=34 captured=34 bytes=275670 missing=0
findings: errors=0 warnings=0 complete=true
```

The `275670` legacy bytes and the 34-bodies/34-objects totals are recorded for
comparison only. A fresh `storage-authoritative` snapshot is judged on its own
pointers, objects and manifest records: pass `--baseline-dir` to have the
differences reported as `baseline-drift`, and never treat a different total as a
failure of the snapshot.

The `storage-authoritative` snapshot taken on this branch (2026-10-19), in the
same directory as the baseline:

```
/home/okazakee/Desktop/Projects/okazakee-prod-backups/prod-legacy-bodies-2026-10-19T01-48-56-046Z-afa5a6f97d2a
manifest.json sha256  0a4081bc70897ef22ae80d28382c8730a99f339d998cc36536b7387030aac8e3
SHA256SUMS sha256     664ee6848caa62da593237ee44837500469b68513fd967c851c1871dd59d7382
rows.jsonl sha256     72cfd590859949135330f6a3b65e5c5e17734ce2dad8448757f1d04c43f88027
```

with `--storage-authoritative --baseline-dir=<the baseline above>`, whose report
was:

```
command=… mode=apply kind=storage-authoritative appEnv=production schema=public project=mtvwynyikouqzmhqespl bucket=website-content
rows: total=17 blog=6 portfolio=11 hidden=5 visible=12
bodies: captured=34 bytes=275670 placeholders=0
objects: referenced=34 captured=34 bytes=275670 missing=0
findings: errors=0 warnings=0 infos=0 complete=true
baseline: runId=5487d7b75377 dir=… drift=none
```

`--verify --require-kind=storage-authoritative` on it reports `intact=true` with
`files: checked=36 ok=36`, and an independent
`cd <run dir> && sha256sum -c SHA256SUMS` agrees (36 OK). `placeholders=0`
records that no post had been saved through the shim-enabled CMS when it was
taken: the first post saved afterwards turns that count positive and adds one
informational finding per placeholder, with no effect on completeness. This
snapshot supersedes nothing — the baseline stays the artifact the pre-shim
English text lives in, and this is the artifact the drop is recovered from.
Record both `sha256sums-sha256` values in the deployment record.

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
payload, deleted file, extra file, rewritten manifest, missing artifact), the
restore dry run/apply/failure paths, and the artifact-kind rules — the
placeholder is an error in a `legacy-baseline` and an informational finding (with
the placeholder count) in a `storage-authoritative` snapshot, a missing or
corrupt object is still an error in both, a manifest without `kind` reads as a
`legacy-baseline`, `--require-kind` refuses a mismatched artifact, a restore
refuses a baseline unless the kind is named, and `--baseline-dir` drift is
recorded without changing completeness.

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
- take the pre-contraction `storage-authoritative` snapshot with
  `--storage-authoritative --baseline-dir=<the baseline run dir>` and record its
  `sha256sums-sha256` and location in the deployment record, next to the
  baseline's (never overwrite the baseline artifact);
- record the baseline artifact's `sha256sums-sha256` and location in the
  deployment record;
- retire this command together with the shim and the legacy columns, once the
  contraction has been verified.
