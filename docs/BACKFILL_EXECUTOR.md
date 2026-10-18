# Markdown backfill executor (Phase 11B.1)

Implementation and isolated tests for the DEV Markdown backfill executor: atomic
pointer switching, rollback, durable reporting and cache invalidation wiring.
**Nothing here has been run against the dev project, and the CAS SQL has not
been applied.**

Companion documents:

- `docs/BACKFILL_PLAN.md` — the read-only planner (Phase 11A) and the plan format.
- `supabase/review/dev_markdown_backfill_cas.sql` — the staged, unapplied CAS SQL.

## Files

| File | Role |
|---|---|
| `src/libs/cms/storage/backfillPlan.ts` | Phase 11A planner (unchanged) |
| `src/libs/cms/storage/backfillCas.ts` | CAS client: local argument validation, RPC mapping, readiness probe |
| `src/libs/cms/storage/backfillJournal.ts` | Append-only JSONL journal, torn-tail-aware parser, unresolved-intent recovery |
| `src/libs/cms/storage/backfillApply.ts` | Executor: per-entry ordering, outcomes, orphan inventory, revalidation, CLI arg contract |
| `src/utils/cms/backfillExec.ts` | Execution CLI (`--preflight`, gated `--apply`) |
| `supabase/review/dev_markdown_backfill_cas.sql` | Staged DEV-only CAS + rollback functions |
| `src/testing/sql/markdownBackfillCas.test.ts` | Real-Postgres (PGlite) tests for the CAS SQL |
| `src/libs/cms/storage/backfillApply.test.ts` | Executor tests with injected dependencies |

## CLI

```bash
# read-only preflight (the only mode to run before the CAS functions exist)
bun run storage:content:dev:backfill:exec --preflight

# future apply: recoverable across invocations
BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging \
bun run storage:content:dev:backfill:exec --apply --new-run \
  --confirm-digest=<manifest sha256> --expect-project-ref=<ref>

# resume the unfinished run recorded in that journal
BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging \
bun run storage:content:dev:backfill:exec --apply --resume \
  --confirm-digest=<manifest sha256> --expect-project-ref=<ref>

# rollback: read-only plan by default
BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
bun run storage:content:dev:backfill:rollback [--run-id=<id>]

# rollback execution (strictly gated)
BACKFILL_JOURNAL_PATH=/var/lib/cms-backfill/run.jsonl \
CMS_BACKFILL_ROLLBACK_ACK=yes-rollback-dev-staging \
bun run storage:content:dev:backfill:rollback --apply --run-id=<id> \
  --expect-project-ref=<ref>
```

`--preflight` validates the environment/project gates, builds the reviewed
plan, reports the manifest digest, probes whether the staged CAS functions exist
(a call the SQL refuses before it can write), and reports whether the
revalidation destination is configured **and approved**. It uploads nothing,
switches nothing, invalidates nothing.

Unknown flags, a missing mode and conflicting modes fail with exit `2`.

### The apply gates

1. explicit `--apply` **plus** an explicit run selection (`--new-run` or
   `--resume`);
2. `--confirm-digest` equal to the freshly computed plan digest **and**
   `--expect-project-ref` equal to the configured project reference;
3. `CMS_BACKFILL_APPLY_ACK=yes-apply-to-dev-staging`;
4. `APP_ENV=development` **exactly**, `dev_staging`, `website-content-dev`, a
   server secret, an approved local DEV revalidation endpoint
   (`http(s)://localhost|127.0.0.1|[::1]/api/internal/content-revalidate`) with
   `WEBSITE_REVALIDATION_SECRET` present, and a durable
   `BACKFILL_JOURNAL_PATH` outside the repository (absolute, owner-only).

Nothing runs automatically on import, startup, CI or package installation, and
the existence of the `--apply` flag is never treated as authorization.

| Exit | Meaning |
|---:|---|
| 0 | preflight ok / apply or rollback finished without failures |
| 1 | plan has blockers, or the run reported failures/conflicts |
| 2 | invalid usage |
| 3 | environment/project gate failure |
| 4 | read or execution failure |
| 5 | refused by an apply/rollback gate (ack, digest, project ref, CAS readiness, journal, endpoint) |


## CAS SQL security model

Both functions live in `dev_staging` and are `SECURITY DEFINER` with a fixed
`search_path = pg_catalog, pg_temp`; every table is schema-qualified, the entity
is restricted to the validated `blog | portfolio` enum (never a caller-supplied
identifier), and no bucket, `storage.*` object, `public` relation or dynamic SQL
is referenced. `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated`
and granted to `service_role` only.

The forward function verifies, **inside the single `UPDATE`**: entity, locale, a
positive id, the row's existence, that the committed legacy body still hashes to
the expected SHA-256 (`pg_catalog.sha256(convert_to(body_<locale>, 'UTF8'))`),
and that the current pointer still equals the expected previous pointer
(`IS NOT DISTINCT FROM`, so NULL is a first-class expectation). The destination
key must equal the canonical `<kind>/<id>/<locale>/<sha256>.md`. There is no
select-then-update path; a post-update diagnostic read only labels the outcome
(`APPLIED | ALREADY_CURRENT | STALE | MISSING | INVALID_*`, plus a short
`reason` such as `body_changed` or `pointer_drift`).

The rollback function restores the recorded previous pointer only while the row
still holds exactly the pointer this run installed **and** the committed body
still matches the recorded hash; otherwise it returns `STALE` and writes
nothing. Neither function ever writes `body_en` / `body_it`.

### Application procedure (separate approval, not done here)

1. Review `supabase/review/dev_markdown_backfill_cas.sql` against the live
   `dev_staging` shape (pointer columns and their CHECK constraints come from
   `supabase/migrations/20261017170828_add_body_storage_paths_dev_staging.sql`).
2. Confirm `pg_catalog.sha256(bytea)` exists in the target project (it does in
   the dev project: `pg_proc.pronamespace = pg_catalog`).
3. Promote the file into `supabase/migrations/` with a fresh timestamp and apply
   it through the normal reviewed migration flow. Never to production, never in
   `public`.
4. Verify: `prosecdef = true`, `proconfig = {search_path=pg_catalog, pg_temp}`,
   `proacl` granting `service_role` only. `--preflight` reports readiness through
   a probe call.
5. Roll back with `drop function dev_staging.dev_backfill_body_pointer_cas(...)`
   and `drop function dev_staging.dev_backfill_body_pointer_rollback(...)`.

## Execution order per entry

1. read the **committed** legacy body and re-check it against the manifest
   SHA-256 (a CMS edit after planning stops the entry before any upload);
2. prepare the canonical immutable object from that committed text;
3. upload with `upsert: false`, or byte-verify the identical existing key;
4. download the object and verify exact bytes **and** the SHA-256;
5. atomic CAS (guards above) — never from a stale read;
6. re-read the committed pointer to confirm the switch;
7. group by post and send **one** signed revalidation event per post.

Markdown is never rewritten: bytes come from the committed column, so Unicode,
CRLF and image URLs are preserved exactly. Upload success and pointer success are
distinct: a failed upload never advances a pointer, and a lost CAS never
re-points using stale content.

## Outcomes

```text
UPLOADED_AND_POINTED   object verified AND pointer switched and confirmed
ALREADY_CURRENT        pointer already correct; object re-verified
SKIPPED_EMPTY          nothing to migrate for that locale
UPLOAD_FAILED          upload did not succeed (pointer untouched)
VERIFY_FAILED          bytes/hash mismatch, corrupt existing object, bad path
CAS_STALE              body or pointer changed since planning (pointer untouched)
CAS_MISSING            row/body gone (pointer untouched)
CAS_REFUSED            the database rejected the CAS input
POINTER_VERIFY_FAILED  CAS reported success but the committed pointer differs
REVALIDATION_FAILED    pointer switched, signed invalidation did not succeed
```

`pointerSwitched` (this run moved the pointer) and `objectCreatedByRun` (this
run performed the upload) are tracked separately from `pointerVerified`, so a
resumed run neither re-uploads nor claims objects it did not create.

## Journal, identity and resume

Append-only JSONL, outside the repository. Each entry gets an `intent` record
**before** any upload and a terminal `outcome` record **after** the committed
state was observed — so an interruption can only ever leave an intent without an
outcome, never an apparent success. Reads are explicitly UTF-8 (a missing file
is a new journal; `EACCES`/`EIO` propagate), and each record is appended with a
single write whose byte count is verified, then `fsync`ed, so a crash can only
truncate the FINAL line. That torn tail is reported and discarded, never treated
as a completed record; malformed complete lines and conflicting records make the
journal untrustworthy, which refuses both resume and rollback. Records hold ids,
keys, hashes, status codes and timestamps only — never Markdown, credentials or
session material.

Identity is `runId + manifestDigest + kind + postId + locale + intendedPath`, so
an outcome can never complete another run's or another manifest's intent.

Apply requires an explicit `BACKFILL_JOURNAL_PATH` (absolute, outside the repo,
owner-only). `--new-run` refuses while the journal holds an unfinished run, and
`--resume` refuses when the journal's unfinished run belongs to a different
manifest — a resume is never silently reinterpreted. Resume re-reads the
committed pointer and re-verifies the stored object bytes for every entry; the
journal is an audit trail, never proof of a completed migration.

## Pending invalidations

A verified pointer switch whose signed invalidation did not return `sent` is
incomplete work: the entry is reported as `REVALIDATION_FAILED` (so the run is
not counted as successful) and its attempt is journalled. `failed` **and**
`skipped` both keep it pending, and a switch recorded with no attempt at all is
pending too (the run stopped after the CAS). `--resume` first retries every
pending invalidation: it re-reads the committed pointer, requires it to still
hold the migrated key, then sends one signed event per post. When the pointer
moved on, the entry is recorded as `superseded` — whatever changed the row owns
that cache — and a retry never uploads an object or writes a pointer.

## Rollback

```bash
BACKFILL_JOURNAL_PATH=… bun run storage:content:dev:backfill:rollback [--run-id=<id>]   # plan (read-only)
BACKFILL_JOURNAL_PATH=… CMS_BACKFILL_ROLLBACK_ACK=yes-rollback-dev-staging \
  bun run storage:content:dev:backfill:rollback --apply --run-id=<id> --expect-project-ref=<ref>
```

Candidates come from the **verified execution record** in the journal (entries
whose switch this run observed), not from a freshly planned digest — after a
successful backfill that digest describes the migrated state, not the original
one. The plan classifies each candidate against the live row: `READY`,
`ALREADY_ROLLED_BACK`, `MISSING`, `BODY_CHANGED` or `POINTER_DRIFTED`, and is
strictly read-only (no CAS call, no journal write, no invalidation).

Execution walks the `READY` candidates in reverse migration order through the
atomic rollback CAS, which refuses when the pointer or the legacy body changed
since the migration; a refusal is reported as a conflict and never forced. It
writes no `body_en`/`body_it`, uploads nothing and removes nothing, journals each
outcome (including its revalidation status), revalidates the affected caches per
post, and supports recovery from an interrupted rollback: entries that already
recorded `ROLLED_BACK` — or whose pointer already holds the previous value — are
skipped on the next run.


## Orphans

An object that exists without a committed pointer is reported in
`orphanCandidates` (sorted, deduplicated) and left in place. The executor issues
upload/download/read/RPC calls only — there is no delete path at all, and no
automatic destructive cleanup.

## Cache invalidation

Reuses the existing signed contract (`src/libs/public-site/revalidation.ts` →
`POST /api/internal/content-revalidate`), so tags stay derived from
`getContentInvalidation` — `post:<kind>:<id>` plus the entity/list tags. EN and
IT of one post are grouped into a single event per post. `sent` is recorded;
`failed` keeps the entry visible as `REVALIDATION_FAILED` with the post listed in
`revalidationPending` for a retry, because a switched pointer with a stale public
cache is incomplete work. Live invalidation was not performed in this phase.

## Tests

- `src/testing/sql/markdownBackfillCas.test.ts` runs the staged SQL against a
  real Postgres (PGlite) on an isolated `dev_staging` schema: APPLIED /
  ALREADY_CURRENT / STALE (`body_changed`, `pointer_drift`) / MISSING, every
  `INVALID_*` refusal, rollback success, rollback refusing a newer CMS body and
  pointer drift, pointers never written when a guard fails, legacy columns never
  written, plus ACL/search-path/SECURITY DEFINER assertions. The funcs are never
  deployed anywhere to test them.
- `src/libs/cms/storage/backfillApply.test.ts` covers the executor with injected
  dependencies: happy path and grouping, existing-object reuse, idempotent
  re-execution, body changed after planning, pointer drift, missing row, upload
  failure, download/verify failure, corrupt existing object, pointer-verify
  failure, CAS refusal, blocked plans, empty locales, revalidation failure
  retention, interruption between upload and CAS (and resume), interruption
  after the CAS (and resume), journal-only records never trusted, torn tail,
  malformed lines, no body/secret leakage, rollback wiring (unchanged state,
  newer CMS update, pointer drift, malformed input), argument mapping, local
  refusals, readiness probe, manifest digest stability and CLI argument
  rejection.

## Required steps before live application

1. Approve and apply the staged CAS SQL to `dev_staging` (procedure above).
2. Confirm `--preflight` reports `cas: { state: 'ready' }`, `ok: true` and the
   expected manifest digest.
3. Confirm `WEBSITE_REVALIDATION_URL` / `WEBSITE_REVALIDATION_SECRET` are
   configured for the CMS server so the invalidation step cannot silently skip.
4. Run `--apply` with the explicit acknowledgement env var, the confirmed digest
   and the expected project reference; then verify the WS actually reads Storage
   for the switched posts (request evidence), and keep the journal.
5. If a cutover must be undone, run the rollback CAS per entry — never a manual
   pointer write.
