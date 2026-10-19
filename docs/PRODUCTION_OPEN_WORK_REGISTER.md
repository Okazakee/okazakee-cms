# Production cutover — cumulative outstanding-work register

Single source of truth for everything still open in the Markdown cutover, kept
with the runbook (`docs/PRODUCTION_MARKDOWN_CUTOVER.md`) and the deployment
record (`docs/PRODUCTION_DEPLOYMENT_RECORD.md`).

> **Retired 2026-10-19.** The `CMS_BODY_POINTER_COLUMNS` flag and the production
> backfill CLIs named in BW-3/BW-5 were removed from the repository once the
> cutover completed; the rows below are kept as the historical record.

Status values: **PASS** (verified with execution evidence) · **DEFERRED** (not
yet due; checkpoint named) · **BLOCKED** (cannot proceed). Nothing here may be
marked PASS without actual execution evidence. The authenticated CMS editor
check (BW-6) was **not executed** during CP-1B: no authorized CMS session was
available, so it is recorded as DEFERRED rather than PASS.

`Mutation?` says whether closing the item requires a production mutation.

## Closed in this phase

| ID | Task | Status | Evidence | Mutation? |
|---|---|---|---|---|
| R1 | Replace the obsolete `S-bucket-prod-absent` dev-check assertion with a lifecycle-aware Storage isolation contract | PASS | `bun run db:dev:check` → **129 pass / 0 fail / 9 info**, exit 0; the old assertion is gone (asserted by a test) and the production findings fail loudly on pre-CP-1/misconfigured/partial states; new regression cases cover pre-CP-1, the contracted plane, bucket misconfiguration, cross-environment contamination, partial infrastructure and the completed DEV migration. After the legacy body contraction the production-plane contract is the CONTRACTED one: bucket + read policy + 4 pointer columns + 4 canonical CHECKs present, with the legacy `body_en`/`body_it` columns and the `prod_backfill_*` CAS functions asserted ABSENT (`S-prod-legacy-columns` / `S-prod-cas`), so a resurrected function or a surviving legacy column fails by name | No |
| R2 | Reconcile contradictory CP-0/CP-1 audit evidence (migration-history counts, metadata fingerprints, browser page count) | PASS | `docs/PRODUCTION_EVIDENCE_RECONCILIATION.md` | No |
| R3 | Durable repository-side provenance for the CP-1 installation | PASS | `docs/PRODUCTION_DEPLOYMENT_RECORD.md` | No |
| CP-1 | Pointer columns, CHECK constraints, CAS functions and privileges installed | PASS | CP-1 report; re-audited read-only | — (done) |
| CP-1 | Private `website-content` bucket provisioned | PASS | `status: created` → re-read `already-correct`; `public=false`, 1 MiB, `text/markdown` | — (done) |
| CP-1 | Production Storage read policy installed | PASS | 1 policy `website_content_body_read`, `SELECT`, anon+authenticated, exact bucket/visibility/pointer predicates; dev policy untouched | — (done) |
| CP-1 | Legacy data integrity after installation | PASS | 17 rows, 275 670 bytes, inventory digest identical to the CP-0 approval | — (done) |

## CP-1B — backward-compatible application deployment

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| BW-1 | Deploy reviewed CMS + WS with Storage-first reads and dual-write disabled | PASS | CMS `dpl_9xSf1zh6RCSG5Wq9HeogEv2x94Bf` (aliased `cms.okazakee.dev`, Ready) and WS `dpl_BDEVkzpTUASLc1J49pL5dYttVtAi` (aliased `okazakee.dev`); GitHub commit statuses independently reproduced (`Vercel: success`) for `368588e` and `d61014e`; both apps health-check 200 on the legacy path | No (deploy only) | Separate deployment authorization |
| BW-2 | Real-browser regression on production after deployment | PASS | 24/24 visible detail pages (12 posts × EN+IT) returned 200 with correct Markdown, 0 broken images, 0 console errors, 0 content-bucket requests and no pointer references in the HTML; 10/10 hidden portfolio routes returned 404; listings discovered 6+6+6+6 links; mobile 390×844 with 0 overflow. Rendering matches the CP-0 baseline exactly (h1 + text length on all four sampled pages). One pre-existing third-party `api.github.com` 404 on `/it/portfolio/21` — not an application or Storage failure | No | CP-1B |
| BW-3 | Enable `CMS_BODY_POINTER_COLUMNS=true` **only** after independently confirmed schema readiness | PASS | Schema reverified (4 nullable columns, 4 validated canonical CHECKs, 2 secured CAS functions) before the change; the flag is now the **only** `CMS_BODY_*` variable in Production; redeployed to `dpl_9xSf1zh6RCSG5Wq9HeogEv2x94Bf` and health verified. Stale-pointer clearing and metadata-only preservation are covered by the automated suites; the live write-path proof remains BW-4 | No (flag change) | CP-1B |
| BW-4 | CMS write-path proof that a legacy body edit cannot leave a stale pointer | DEFERRED | when migrated pointers exist, with separately authorized reversible content | Approved disposable/reversible test content only — never live content edited to manufacture evidence | Yes (test content) | CP-1B + explicit approval |
| BW-5 | Production configuration and deployment-revision checks | PASS | Effective environment listing shows only the pointer flag present and the three read/dual-write flags absent (values are platform secrets, never printed); each production alias resolves to its recorded deployment ID; deployed revisions attributed via the GitHub commit-status API rather than deployment timestamps | No | CP-1B |
| BW-6 | Authenticated CMS editor read-only observations (blog and portfolio editors, EN/IT body loading, hidden-post visibility, metadata and images, console/API errors) | DEFERRED | next authorized CMS session | Observations only — nothing saved or published, no content modified | No | CP-1B or later |

## CP-2 — authorized production Markdown backfill

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| BF-1 | Production revalidation endpoint + signing-secret readiness | DEFERRED | CP-2 | `WEBSITE_REVALIDATION_URL` https on an origin allow-listed in `CMS_PROD_REVALIDATION_ORIGINS` and on `/api/internal/content-revalidate`; secret present | No | CP-2 |
| BF-2 | Production **execution-host** journal (not the local prepared file) | DEFERRED | CP-2 | `PROD_BACKFILL_JOURNAL_PATH` on the host: absolute, outside both repos, `0600`, refused when group/world readable | No | CP-2 |
| BF-3 | Fresh manifest recompiled immediately before the run, compared to the approved snapshot | DEFERRED | CP-2 | Source hashes recomputed live; digest compared; 34 bodies or explicit drift report | No | CP-2 |
| BF-4 | Authorized backfill execution | PASS | run `2ff5a39b-ffd8-4fec-a909-c67378d9afd1` on manifest `0ed666f4…3947ca`: 34/34 `UPLOADED_AND_POINTED`, 34 pointer switches, 34 objects, **0 failures, 0 revalidation failures**; journal 103 lines | Yes (executed) | CP-2 (granted) |
| BF-5 | Independent verification of every object and pointer | PASS | independently: 34 pointer rows, 34/34 objects downloaded and SHA-256-matched to the committed legacy bodies, 34/34 path hashes match, 34/34 byte lengths match, 0 missing, 0 orphans, legacy bytes 275 670 unchanged | No | CP-2 (granted) |
| BF-6 | Read-only rollback candidate plan from the recorded run | PASS | `rollback --run-id=2ff5a39b…` → 34 planned / **34 READY** / 0 conflicts (exit 0) | No | CP-2 (granted) |
| BF-7 | Signed invalidation acknowledgments | PASS | 0 revalidation failures across all 34 entries at write time | No | CP-2 (granted) |

## CP-2 / CP-3 — Storage RLS behaviour with real objects

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| RL-1 | Positive download of a *referenced* object by an anonymous reader | PASS | publishable-key GET of a referenced visible object → **200**, exact bytes | No | CP-3 (granted) |
| RL-2 | Hidden post's object denied to anonymous readers | PASS | publishable-key GET of a referenced hidden object (`portfolio/5/en/5c32bfd2…md`) → **denied, no content**; the same object reads 200 under `service_role` | No | CP-3 (granted) |
| RL-3 | Unreferenced object denied | DEFERRED | no naturally unreferenced object exists and none was manufactured; the policy predicate was validated structurally. An accidental `service_role` write-probe was deleted immediately (DELETE 200) and the bucket re-verified at 34 objects | No | CP-2/CP-3 |
| RL-4 | Prefix-listing denial | PASS | anonymous listing at the bucket root, `blog/` and `portfolio/5/` returned **0 objects** | No | CP-3 (granted) |
| RL-5 | Anonymous write denial / public buckets unaffected | PASS | anonymous POST to `website-content` → denied (400); no new anon write policy; public asset buckets unchanged | No | CP-3 (granted) |

These were **not** verifiable during CP-1 because production has no Markdown
objects and no populated pointers; they were not manufactured with test objects.

## CP-3 — read activation

| ID | Task | Status | Checkpoint | Evidence required | Mutation? | Authorization |
|---|---|---|---|---|---|---|
| AC-1 | CMS Storage-first reads enabled | PASS | `CMS_BODY_STORAGE_READ_ENABLED=true`; deployment `dpl_Do83LQBExtDdfKTZSASVv8HWVWEc` Ready and aliased to `cms.okazakee.dev`; CMS login 200 | No (flag) | CP-3 (granted) |
| AC-2 | WS Storage-first reads enabled | PASS | `WS_BODY_STORAGE_READ_ENABLED=true`; deployment `dpl_E35oWnb18cyPu95RhSVyZiat475R` Ready, `okazakee.dev` aliased; 24/24 pages render with byte-identical text to the pre-activation baseline | No (flag) | CP-3 (granted) |
| AC-3 | CMS dual-write enabled | PASS | `CMS_BODY_DUAL_WRITE_ENABLED=true`; deployment `dpl_BCbFAUDHZF9WRnhAjC3HLUrjJYfm` Ready; automated dual-write suites green (CMS 1180 tests) | No (flag) | CP-3 (granted) |
| AC-4 | Browser E2E over the production content surface | PASS | post-activation: 24/24 visible detail pages 200 and clean (0 console errors, 0 broken images, 0 bad app requests, 0 pointer leakage), 10/10 hidden routes 404, listings 6+6+6+6 links, mobile 0 overflow; one pre-existing third-party GitHub 404 | No | CP-3 (granted) |
| AC-5 | Correlated server-side Storage access evidence | DEFERRED | requires runtime log correlation, which is not available in this environment; the read flags are verified effective and rendering is byte-identical | No | CP-3 or later |
| AC-6 | Authorized CMS write-path test | DEFERRED | CP-3 | Approved disposable content; pointer + object + invalidation correct | **Yes** | CP-3 + explicit approval |
| AC-7 | Cache correctness | PASS (backfill) / DEFERRED (post-write) | all 34 signed invalidations were acknowledged at write time; post-write cache-staleness was not independently measured | No | CP-3 |
| AC-8 | Monitoring and rollback readiness | PASS (readiness) / DEFERRED (monitoring) | rollback plan 34 READY / 0 conflicts; the D6 monitoring wiring is not deployed | No | CP-3 |

## Cross-cutting

| ID | Task | Status | Checkpoint | Evidence required | Mutation? |
|---|---|---|---|---|---|
| X-1 | Migration-history reconciliation strategy for the unrecorded production schema | DEFERRED | before any future production schema change | Explicit decision: keep staging artifacts (guard-idempotent) or promote a reconciled migration; **never** `db push`, never a synthetic history row | No |
| X-2 | Retire the CP-1 "no migration row" caveat once X-1 is decided | DEFERRED | with X-1 | Updated deployment record | No |
| X-3 | `20261013120000_view_counter_returning.sql` is genuinely unapplied: both view-increment RPCs still return `void`, while the application expects a returned value. Found by the R2A reconciliation; **unrelated to the Markdown cutover** | DEFERRED | its own workstream, not the cutover | Reviewed migration applied through the approved path — never a bulk sync | Yes (schema) |
