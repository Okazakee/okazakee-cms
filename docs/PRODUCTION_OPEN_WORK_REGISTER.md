# Production cutover — cumulative outstanding-work register

Single source of truth for everything still open in the Markdown cutover, kept
with the runbook (`docs/PRODUCTION_MARKDOWN_CUTOVER.md`) and the deployment
record (`docs/PRODUCTION_DEPLOYMENT_RECORD.md`).

Status values: **PASS** (verified with execution evidence) · **DEFERRED** (not
yet due; checkpoint named) · **BLOCKED** (cannot proceed). Nothing here may be
marked PASS without actual execution evidence.

`Mutation?` says whether closing the item requires a production mutation.

## Closed in this phase

| ID | Task | Status | Evidence | Mutation? |
|---|---|---|---|---|
| R1 | Replace the obsolete `S-bucket-prod-absent` dev-check assertion with a lifecycle-aware Storage isolation contract | PASS | `bun run db:dev:check` → **128 pass / 0 fail / 9 info**, exit 0; the old assertion is gone (asserted by a test) and 8 new production findings fail loudly on pre-CP-1/post-CP-1/misconfigured/partial states; new regression cases cover pre-CP-1, post-CP-1, bucket misconfiguration, cross-environment contamination, partial infrastructure and the completed DEV migration | No |
| R2 | Reconcile contradictory CP-0/CP-1 audit evidence (migration-history counts, metadata fingerprints, browser page count) | PASS | `docs/PRODUCTION_EVIDENCE_RECONCILIATION.md` | No |
| R3 | Durable repository-side provenance for the CP-1 installation | PASS | `docs/PRODUCTION_DEPLOYMENT_RECORD.md` | No |
| CP-1 | Pointer columns, CHECK constraints, CAS functions and privileges installed | PASS | CP-1 report; re-audited read-only | — (done) |
| CP-1 | Private `website-content` bucket provisioned | PASS | `status: created` → re-read `already-correct`; `public=false`, 1 MiB, `text/markdown` | — (done) |
| CP-1 | Production Storage read policy installed | PASS | 1 policy `website_content_body_read`, `SELECT`, anon+authenticated, exact bucket/visibility/pointer predicates; dev policy untouched | — (done) |
| CP-1 | Legacy data integrity after installation | PASS | 17 rows, 275 670 bytes, inventory digest identical to the CP-0 approval | — (done) |

## CP-1B — backward-compatible application deployment

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| BW-1 | Deploy reviewed CMS + WS with Storage-first reads and dual-write disabled | DEFERRED | CP-1B | Deployment revision IDs; both apps healthy on the legacy path | No (deploy only) | Separate deployment authorization |
| BW-2 | Real-browser regression on production after deployment | DEFERRED | CP-1B | Per-page 200s, EN+IT, zero console errors, zero failed requests, hidden routes still 404 | No | CP-1B |
| BW-3 | Enable `CMS_BODY_POINTER_COLUMNS=true` **only** after independently confirmed schema readiness | DEFERRED | CP-1B | Schema re-verification (4 columns, 4 CHECKs) then the flag; legacy metadata-only edits keep pointers, legacy-only body edits clear the edited locale | No (flag change) | CP-1B |
| BW-4 | CMS write-path proof that a legacy body edit cannot leave a stale pointer | DEFERRED | CP-1B | Approved disposable/reversible test content only — never live content edited to manufacture evidence | Yes (test content) | CP-1B + explicit approval |
| BW-5 | Production configuration and deployment-revision checks | DEFERRED | CP-1B | Effective env/config per app; revision matches the reviewed commit | No | CP-1B |

## CP-2 — authorized production Markdown backfill

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| BF-1 | Production revalidation endpoint + signing-secret readiness | DEFERRED | CP-2 | `WEBSITE_REVALIDATION_URL` https on an origin allow-listed in `CMS_PROD_REVALIDATION_ORIGINS` and on `/api/internal/content-revalidate`; secret present | No | CP-2 |
| BF-2 | Production **execution-host** journal (not the local prepared file) | DEFERRED | CP-2 | `PROD_BACKFILL_JOURNAL_PATH` on the host: absolute, outside both repos, `0600`, refused when group/world readable | No | CP-2 |
| BF-3 | Fresh manifest recompiled immediately before the run, compared to the approved snapshot | DEFERRED | CP-2 | Source hashes recomputed live; digest compared; 34 bodies or explicit drift report | No | CP-2 |
| BF-4 | Authorized backfill execution | DEFERRED | CP-2 | Per-entry: source verified → upload without upsert → download+hash → CAS → pointer verified → signed invalidation acked → journaled | **Yes** | CP-2, bound to the fresh manifest digest |
| BF-5 | Independent verification of every object and pointer | DEFERRED | CP-2 | 34/34 objects byte-verified; 34/34 pointers canonical and hash-matching | No | CP-2 |
| BF-6 | Read-only rollback candidate plan from the recorded run | DEFERRED | CP-2 | `storage:content:prod:backfill:rollback --run-id=…` shows candidates with conflicts resolved/zero | No | CP-2 |
| BF-7 | Signed invalidation acknowledgments | DEFERRED | CP-2 | All required invalidations acknowledged | No | CP-2 |

## CP-2 / CP-3 — Storage RLS behaviour with real objects

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| RL-1 | Positive download of a *referenced* object by an anonymous reader | DEFERRED | CP-2/CP-3 | Anon/publishable-key fetch returns the exact bytes for a visible post | No | CP-2/CP-3 |
| RL-2 | Hidden post's object denied to anonymous readers | DEFERRED | CP-2/CP-3 | Fetch of a hidden post's object is denied | No | CP-2/CP-3 |
| RL-3 | Unreferenced object denied | DEFERRED | CP-2/CP-3 | Fetch of an object no visible row points at is denied | No | CP-2/CP-3 |
| RL-4 | Prefix-listing denial | DEFERRED | CP-2/CP-3 | Bare and prefix listing return no objects | No | CP-2/CP-3 |
| RL-5 | Public reader permissions unchanged elsewhere | DEFERRED | CP-2/CP-3 | Public asset buckets keep working; no new anon write grant | No | CP-2/CP-3 |

These were **not** verifiable during CP-1 because production has no Markdown
objects and no populated pointers; they were not manufactured with test objects.

## CP-3 — read activation

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| AC-1 | CMS Storage-first reads enabled | DEFERRED | CP-3 | Reads serve the Storage body for every post/locale; legacy agreement check holds | No (flag) | CP-3 |
| AC-2 | WS Storage-first reads enabled | DEFERRED | CP-3 | Public pages render from Storage; visible/hidden behaviour unchanged | No (flag) | CP-3 |
| AC-3 | CMS dual-write enabled | DEFERRED | CP-3 | New/edited bodies land as immutable objects with pointers | No (flag) | CP-3 |
| AC-4 | Browser E2E over all relevant production pages in EN and IT | DEFERRED | CP-3 | Per-page status, rendering, images, links, console and network cleanliness, desktop + mobile | No | CP-3 |
| AC-5 | Correlated server-side Storage access evidence | DEFERRED | CP-3 | Runtime logs tying page renders to Storage reads | No | CP-3 |
| AC-6 | Authorized CMS write-path test | DEFERRED | CP-3 | Approved disposable content; pointer + object + invalidation correct | **Yes** | CP-3 + explicit approval |
| AC-7 | Cache correctness | DEFERRED | CP-3 | No stale content after a write; invalidations acknowledged | No | CP-3 |
| AC-8 | Final monitoring and rollback readiness | DEFERRED | CP-3 | The D6 metrics wired; rollback path armed and documented | No | CP-3 |

## Cross-cutting

| ID | Task | Status | Checkpoint | Evidence required | Mutation? |
|---|---|---|---|---|---|
| X-1 | Migration-history reconciliation strategy for the unrecorded production schema | DEFERRED | before any future production schema change | Explicit decision: keep staging artifacts (guard-idempotent) or promote a reconciled migration; **never** `db push`, never a synthetic history row | No |
| X-2 | Retire the CP-1 "no migration row" caveat once X-1 is decided | DEFERRED | with X-1 | Updated deployment record | No |
| X-3 | `20261013120000_view_counter_returning.sql` is genuinely unapplied: both view-increment RPCs still return `void`, while the application expects a returned value. Found by the R2A reconciliation; **unrelated to the Markdown cutover** | DEFERRED | its own workstream, not the cutover | Reviewed migration applied through the approved path — never a bulk sync | Yes (schema) |
