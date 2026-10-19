# Markdown backfill planner (Phase 11A)

Read-only planner for migrating the existing `dev_staging` Markdown columns
(`body_en` / `body_it`) into immutable content-addressed objects in the private
`website-content-dev` bucket. It produces an auditable manifest and reports
blockers **before** any mutation is authorized.

It does not upload, download, delete, update or invalidate anything. Phase 11B
(the authorized apply/rollback) is designed at the end of this document and is
**not** implemented.

## Usage

```bash
bun run storage:content:dev:backfill:plan
```

No arguments are accepted. `--apply`, `--rollback`, `--cleanup` and any other
argument fail with exit code `2` rather than being ignored.

| Exit code | Meaning |
|---:|---|
| `0` | Plan built, no blockers |
| `1` | Plan built, at least one blocker |
| `2` | Invalid usage (any argument) |
| `3` | Environment / project gate failure (before the first read) |
| `4` | Read or planning failure |

One deterministic JSON report is printed on stdout (`command`, `appEnv`,
`schema`, `projectRef`, `bucket`, `ok`, `summary`, `manifest`). It contains no
Markdown bodies, credentials or cookies, and no timestamp, so two runs against
an unchanged database produce byte-identical output.

## Environment gate (fail-closed)

Validated before the first read, with no fallback to `public`:

- `APP_ENV` is not `production`;
- `NEXT_PUBLIC_SUPABASE_DB_SCHEMA` is exactly `dev_staging`;
- `NEXT_PUBLIC_SUPABASE_URL` is a usable `https://<ref>.supabase.co` URL;
- the URL's project reference equals the pinned dev project
  (`EXPECTED_DEV_PROJECT_REF`);
- the destination bucket is exactly `website-content-dev`;
- `SUPABASE_SECRET_KEY` is present (server-side credentials only).

## Manifest

One entry per post and locale, ordered by entity (blog, portfolio), then numeric
post id ascending, then locale (EN, IT).

| Field | Meaning |
|---|---|
| `kind` | `blog` \| `portfolio` |
| `postId` | Post id |
| `locale` | `en` \| `it` |
| `sourceSha256` | SHA-256 of the exact legacy UTF-8 bytes (`null` when empty) |
| `sizeBytes` | Exact UTF-8 byte length of the legacy body |
| `expectedPath` | Canonical destination key `<kind>/<postId>/<locale>/<sha256>.md` |
| `currentPath` | Pointer currently committed on the row (never modified here) |
| `action` | `UPLOAD_AND_POINT` \| `ALREADY_CURRENT` \| `SKIP_EMPTY` \| `BLOCKED` |
| `blockers` | Human-readable reasons; empty for non-blocked entries |

Hashing, byte size, the 1 MiB limit and the canonical key builder all come from
`src/libs/cms/storage/bodyContent.ts` (`prepareBodyContent`, `bodyContentPath`) —
the planner re-implements none of them, and never normalizes Markdown: the exact
UTF-8 bytes are the identity, so Unicode, CRLF and trailing whitespace are
preserved verbatim. Image URLs are never rewritten; this is not an image
migration.

### Decision rules

| Situation | Action |
|---|---|
| Legacy body non-empty, pointer NULL | `UPLOAD_AND_POINT` |
| Legacy body non-empty, pointer already equals the body hash | `ALREADY_CURRENT` |
| Legacy body empty (`null`/`''`) and pointer NULL | `SKIP_EMPTY` — no empty object is invented |
| Legacy body empty **and** a pointer is set | `BLOCKED` — a pointer to content that is gone |
| Pointer owned by this entity/id/locale but a different hash | `BLOCKED` — pointer/body disagreement; never silently overwritten |
| Pointer naming another post, another locale, another entity or a non-canonical file | `BLOCKED` — ownership check |
| Body over 1 MiB | `BLOCKED` — limit from the shared contract |
| Duplicate `(kind, postId, locale)` rows | `BLOCKED` — ambiguous migration |
| `postId` not a positive integer | `BLOCKED` |

## Read-only guarantees

- The database dependency is a structurally narrowed type exposing only
  `from(table).select(columns).order(column)` — a mutation is not expressible
  through it. The CLI never constructs a Storage client at all.
- Unit tests drive the whole dry run through a deliberately wider fake client
  whose `insert`/`update`/`delete`/`upsert`/`remove`/`upload`/`download` methods
  throw and count, and assert those counters stay at `0` (tests: *read-only
  guarantees*).
- The planner performs no clock, environment or Storage read; `planEntry` is
  pure.

## Baseline (verified read-only on 2026-10-18)

| Entity | Rows | Locale entries | EN bytes | IT bytes | Total bytes |
|---|---:|---:|---:|---:|---:|
| blog | 6 | 12 | 77 239 | 81 897 | 159 136 |
| portfolio | 11 | 22 | 56 533 | 59 958 | 116 491 |
| **total** | **17** | **34** | | | **275 627** |

All 34 bodies are non-empty; all pointer columns are NULL; `website-content-dev`
holds 0 objects; the production `website-content` bucket does not exist. A run
therefore plans **34 objects / 275 627 bytes** with 0 blockers.

## Phase 11B design (not implemented here)

### Upload ordering

Per entry: prepare from the **committed** legacy column → upload the immutable
object (`upsert: false`, content-addressed) → read the object back and verify
the bytes hash to the SHA-256 embedded in the key → only then switch the
pointer. The legacy `body_en` / `body_it` columns are never modified by the
backfill, so a failed cutover always has the original source.

### Concurrency safety

A CMS edit can land between inventory and pointer update, and a read followed by
an unconditional `UPDATE` is not sufficient. The pointer switch must be a single
atomic compare-and-swap: *"set `body_<locale>_path` to the new key **only if**
the row still holds the exact body this object was built from"*.

Two viable shapes:

1. **PostgREST single statement** — `PATCH` with filters
   `id = :id AND body_<locale>_path IS NULL AND body_<locale> = :expectedBody`
   becomes one `UPDATE ... WHERE ...` in Postgres, which is atomic, and a
   returned-row count of `0` means the CAS lost. Limitation: `:expectedBody` in
   the query string is the full Markdown (up to ~23 KB observed), which is
   fragile across URL-length limits and proxies.
2. **Scoped dev-only SQL function** (recommended) —
   `dev_backfill_body_pointer_cas(p_kind, p_id, p_locale, p_expected_sha256, p_new_path)`,
   `SECURITY DEFINER`, executing one `UPDATE` guarded by
   `encode(sha256(convert_to(body_<locale>, 'UTF8')), 'hex') = p_expected_sha256`
   (plus the current pointer being NULL or already this key) and returning the
   affected row count. This keeps the CAS atomic, moves the comparison into the
   database, and avoids shipping bodies over the wire.

   The function would be proposed as a scoped `dev_staging`-only migration for
   review; it is deliberately **not** created in this phase. If neither shape is
   approved, the backfill must not run: a stale-body pointer overwrite is worse
   than an un-migrated row.

### Resume and idempotency

Re-running the planner reclassifies entries: completed ones become
`ALREADY_CURRENT` (skipped, or byte-verified if an apply wants proof), still
pending ones stay `UPLOAD_AND_POINT`. Because keys are content-addressed,
re-uploading identical bytes hits the existing-object path in
`uploadBodyContent` (byte-compared, never overwritten), and a body edited by a
CMS user yields a **new** key instead of a duplicate logical migration.

### Partial failure

An upload failure must leave the pointer untouched (the queue advances only
after a verified object exists). A lost CAS is reported distinctly from a
successful upload — `uploaded_object_pointer_stale` rather than `migrated` — and
any object left behind by that path is recorded as an orphan in the run report.
Orphans are tracked, never deleted blindly: a separate, explicitly authorized
cleanup decides.

### Rollback

Per entry, remember `previousPath` (usually NULL). Rollback restores it with the
same CAS discipline — *"set `body_<locale>_path` back to `previousPath` only if
the current value is still the key this run installed"* — so content a CMS user
changed after the migration is never rewound, and the legacy column (the source
of truth on rollback) is never touched. Objects are deleted only when no row and
no pointer references them (verified by query) and when they were created by
this run.

### Cache invalidation

A direct backfill emits no CMS mutation event, so after any pointer change the
executor must send the signed invalidation for the affected post detail:
`post:<kind>:<id>` (e.g. `post:blog:23`). List tags (`blog`, `posts`) are only
needed if a change becomes visible on a list surface — body Markdown does not
appear there — so detail tags alone are sufficient. After invalidation the
executor must confirm the public site actually reads Storage (request evidence:
a `GET .../storage/v1/object/website-content-dev/<kind>/<id>/<locale>/<sha>.md`
returning `text/markdown`), not merely that the page renders.

## Production planner (Phase 13, gate C2)

> **Retired 2026-10-19.** `src/libs/cms/storage/prodBackfillPlan.ts`, the
> production CLI modules and the `storage:content:prod:backfill:*` scripts were
> removed once the cutover completed. The production-planner description below is
> historical; the DEV planner remains in use.

`src/libs/cms/storage/prodBackfillPlan.ts` is the production twin of this
planner — the same classification, ordering, duplicate detection, summary
arithmetic and manifest digest (shared through `backfillPlan.ts` and
`backfillApply.manifestDigest`), with the values from the shared environment
descriptor (`src/libs/cms/storage/backfillEnvironment.ts`: `public`,
`website-content`, project `mtvwynyikouqzmhqespl`).

```bash
# declared state: inventory before the pointer columns exist, manifest after
bun run storage:content:prod:backfill:plan

# force one of the two operating states explicitly
bun run storage:content:prod:backfill:plan --inventory
bun run storage:content:prod:backfill:plan --manifest
```

Exit codes and the JSON shape match the DEV planner (`0` clean, `1` blockers,
`2` invalid usage, `3` environment/project gate, `4` read failure), plus three
production-only fields:

- `mode` — `inventory` or `manifest`, and `modeSource` (`argument`/`flag`);
- `digestKind` — `inventory-bodies-only` or `executable-manifest`. **Only the
  executable manifest digest may be passed to `--apply --confirm-digest`**;
- `baseline` — `blogRows`, `portfolioRows`, `posts`, `nonemptyBodies`,
  `totalSourceBytes` (exact UTF-8 bytes) and the projection actually read.

### Two operating states, one projection rule

1. **`inventory`** runs BEFORE the additive schema is installed. It projects
   exactly `id,body_en,body_it`, so it never names a column that does not exist
   yet, and reports the production baseline. A missing pointer column is not a
   failure here — the inventory cannot refer to one.
2. **`manifest`** runs after the columns exist. It adds the pointers to the
   projection and classifies every entry: `ALREADY_CURRENT`, `UPLOAD_AND_POINT`
   (pending) or `BLOCKED` (conflicted: a non-canonical pointer, a pointer/body
   disagreement, a duplicate row, or content over the 1 MiB limit).

The state is selected by `CMS_BODY_POINTER_COLUMNS` (the same capability flag the
CMS dual-write gate uses, enabled only when the value is exactly `true`), or
explicitly on the command line. The flag is a deployment *assertion*: with it set
and the columns absent, the manifest read fails loudly instead of planning
against columns that are not there.

Production always reads its OWN rows — the DEV manifest is never reused, and a
digest computed from a pointer-free (inventory) view can never authorize an
apply.
