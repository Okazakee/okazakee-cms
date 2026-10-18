# Production evidence reconciliation — Gate R2

Phase 14, Gate R2 (`local://paste-33.md`). Reconciles three contradictory evidence
sets produced by CP-0 (pre-production audit) and CP-1 (production infrastructure):

| Item | CP-0 | CP-1 | Reconciled |
|---|---|---|---|
| R2A — migration inventory | — | `42` entries, max version `20261017185848` | union of two sources; **remote history = 33 rows, max `20261017191000`** |
| R2B — metadata digest | `34a543b6…` (sha256) | `d63422a9…` (md5) | **both reproduce exactly from current data — different algorithms over the same unchanged rows** |
| R2C — browser pages | `12 visible pages` | — | **12 is correct; the parenthetical detail was wrong, not the count** |

## 0. Method, environment and boundaries

- Project `mtvwynyikouqzmhqespl`, target schema `public` (production) plus the
  read-only comparison of `dev_staging`. PostgreSQL `17.6`.
- CMS repository `Okazakee/okazakee-cms` at HEAD
  `f0f028645dd0706702b821f7b669ab5ef99d7f52`.
- Production reads were performed through the repository's sanctioned read-only
  runner — `bun node_modules/supabase/dist/supabase.js db query --linked
  --file <sql> --output-format json` — and through the CLI migration reader
  `… migration list --linked`. No other database surface was used.
- CP-0 evidence is authoritative and was read from its preserved artifacts, not
  from the reports: `/tmp/cp0-prod-audit/audit-report.json`,
  `/tmp/cp0-prod-audit/baseline.json`, `/tmp/cp0-prod-audit/dev-audit-report.json`,
  and the CP-0 snapshot at
  `~/okazakee-cutover/prod-legacy-snapshot-2026-10-18T14-38-25-099Z/`
  (`blog_posts.jsonl`, `portfolio_posts.jsonl`, `fingerprints.json`,
  `MANIFEST.sha256`).
- **Nothing was mutated**: no DDL/DML, no Storage operation, no migration-history
  write, no `migration repair`, no `db push`, no deploy, no flag change, no
  backfill, no rollback, no test object. Every statement in this document is a
  `SELECT`, a read-only CLI listing, a local hash computation, or a diff against
  preserved evidence.
- No secret appears in this document: no key, token, connection string or
  service-role credential was read into any output, log or file.

---

# R2A — Migration inventory: 42 entries vs 33 rows

## A.1 What each source is

| Source | What it actually contains | Count |
|---|---|---|
| `supabase migration list --linked` | **A union/merge**: one entry per *version string* seen in either the local `supabase/migrations/` filenames or the remote `supabase_migrations.schema_migrations` rows. Each entry carries `local`, `remote` and `time`; a version present on only one side has `""` on the other | **42 entries** |
| `supabase/migrations/` (working tree) | One file per migration, version = filename prefix | **36 files**, max `20261017185848` |
| `supabase_migrations.schema_migrations` (remote history) | One row per *applied* migration recorded in the target project | **33 rows**, max `20261017191000` |
| `dev_staging.cms_migration_audit` (DEV ledger) | DEV-side provenance: `version`, `name`, `source_file`, `source_sha256`, `execution_mode`, `recorded_at` | 19 rows |

The union is `42 = 27 paired + 9 local-only + 6 remote-only`, and
`27 + 9 = 36` local versions, `27 + 6 = 33` remote versions — i.e. the 42 count is
the length of the merge, and each of the two real inventories is reproduced inside
it.

## A.2 Exact commands and raw observed values

Both commands were run from `…/okazakee-cms` on the linked project.

**Command A — the union count (the source of the `42`)**

```bash
bun node_modules/supabase/dist/supabase.js migration list --linked
```

Exit 0, single-line JSON payload:

```
{"migrations":[{...42 objects...}]}
```

Observed with an exact parse of that payload:

```text
entry keys present : exactly ('local', 'remote', 'time') on every entry
array length       : 42
both non-empty     : 27
local-only (remote "" ): 9
remote-only (local ""): 6
max(local)         : 20261017185848
max(remote)        : 20261017191000
```

The payload has **no `version` key**. A parser reading `version` or `local` (the
shape CP-1 used) therefore:
* counts the union (`42`) — correct for the merge, wrong for the history; and
* sums only the `local` column, whose maximum is `20261017185848` — it cannot see
  `20261017191000`, because that version exists **only** on the remote side.

That single combination is the entire discrepancy.

**Command B — the remote history count (the source of the `33`)**

```sql
select count(*) as total_rows, max(version) as max_version
  from supabase_migrations.schema_migrations;
```

```json
{ "total_rows": 33, "max_version": "20261017191000" }
```

**Command C — the remote history itself**

```sql
select version, name, coalesce(array_length(statements,1),0) as stmts
  from supabase_migrations.schema_migrations order by version;
```

Returns 33 rows. The six newest:

| version | name |
|---|---|
| `20261017135406` | `optimize_indexes_dev_staging` |
| `20261017140941` | `normalize_rls_dev_staging` |
| `20261017161645` | `isolate_dev_author_profile_policy` |
| `20261017170344` | `harden_post_reads_dev_staging` |
| `20261017185336` | `add_body_storage_paths_dev_staging` |
| `20261017191000` | `add_content_storage_read_policy_dev_staging` |

The full 33-row listing is in Appendix C.

**Command D — the local tree**

```bash
ls supabase/migrations | wc -l   # 36
ls supabase/migrations | sort | tail -1
# 20261017185848_add_content_storage_read_policy_dev_staging.sql
```

## A.3 Reconciliation

| | Union (`migration list --linked`) | Local tree | Remote history |
|---|---|---|---|
| count | 42 | 36 | 33 |
| max version | `20261017191000` (remote side) / `20261017185848` (local side) | `20261017185848` | `20261017191000` |
| newest row/file | — | `…185848_add_content_storage_read_policy_dev_staging.sql` | `20261017191000 add_content_storage_read_policy_dev_staging` |

**The two reports are both internally correct; neither is the history.** The
`42`/`20261017185848` pair describes the *merge* counted at its full length with
only the *local* column's maximum; the `33`/`20261017191000` pair describes the
actual remote history. There is no contradiction in the data.

## A.4 A real, separate finding: six rows drifted between the file tree and history

The six remote-only versions are not foreign migrations — each is the *same
migration* as one of the nine local-only files, recorded under a different
version:

| remote history version | remote history name | local file | local version |
|---|---|---|---|
| `20261017135406` | `optimize_indexes_dev_staging` | `…optimize_indexes_dev_staging.sql` | `20261017134507` |
| `20261017140941` | `normalize_rls_dev_staging` | `…normalize_rls_dev_staging.sql` | `20261017140338` |
| `20261017161645` | `isolate_dev_author_profile_policy` | `…isolate_dev_author_profile_policy.sql` | `20261017160247` |
| `20261017170344` | `harden_post_reads_dev_staging` | `…harden_post_reads_dev_staging.sql` | `20261017165547` |
| `20261017185336` | `add_body_storage_paths_dev_staging` | `…add_body_storage_paths_dev_staging.sql` | `20261017170828` |
| `20261017191000` | `add_content_storage_read_policy_dev_staging` | `…add_content_storage_read_policy_dev_staging.sql` | `20261017185848` |

Evidence that the two sides are the same migration:

```sql
select version, name, array_length(statements,1) as n,
       length(statements[1]) as len1, md5(statements[1]) as md5_1
  from supabase_migrations.schema_migrations
 where version in ('20261017135406','20261017140941','20261017161645',
                   '20261017170344','20261017185336','20261017191000')
 order by version;
```

* Three of the six have **identical statement text** to their local file
  (`md5(statements[1])` equals `md5(<file bytes>)` for
  `optimize_indexes_dev_staging`, `normalize_rls_dev_staging`,
  `isolate_dev_author_profile_policy`).
* The other three differ **only by an explanatory comment header** added to the
  file after it was applied: after removing comment lines, the SQL text is
  byte-identical in **6/6** cases (verified by diff, not by inspection).
* The six differences are therefore *bookkeeping*, not divergent SQL: same
  statements, different version prefix, plus later-added comments.

Where the recorded version came from: the DEV ledger
`dev_staging.cms_migration_audit` records the **local** version and a
`recorded_at` that lands 4–8 seconds **after** the remote version:

| ledger `version` (local) | ledger `recorded_at` (UTC) | remote history version |
|---|---|---|
| `20261017134507` | `2026-10-17T13:54:14.346598+00:00` | `20261017135406` |
| `20261017140338` | `2026-10-17T14:09:46.842749+00:00` | `20261017140941` |
| `20261017160247` | `2026-10-17T16:16:50.758342+00:00` | `20261017161645` |
| `20261017165547` | `2026-10-17T17:03:49.684957+00:00` | `20261017170344` |
| `20261017170828` | `2026-10-17T18:53:42.849777+00:00` | `20261017185336` |
| `20261017185848` | `2026-10-17T19:10:04.526827+00:00` | `20261017191000` |

So the remote version is an **apply-time timestamp**, generated a few seconds
before the ledger row was written, while the repository and the DEV ledger both
carry the authored filename version. `[INFERENCE]` the apply generated a
timestamped migration name at execution time rather than using the committed
filename; the exact tool/actor cannot be recovered from the repository, because
the CMS repo has **no apply path at all**:

* `src/utils/cms/devMigrations.ts` documents and implements
  `db:dev:check` as read-only ("Check is read-only: ledger + source hashes +
  dev_staging effect proof. Unknown actions are rejected; **no apply path
  exists**. Verified-existing history is never replayed; `db push` / global
  repair are never invoked.").
* `supabase/migrations/` files were each added once under their current name
  (`git log --follow` shows a single `A` entry and no rename for all six).
* `okazakee-ws` has never contained a `supabase/migrations/` tree.
* No code in either repository reads `supabase_migrations.schema_migrations`
  (verified by a repo-wide search for that identifier, excluding `node_modules`,
  `.git` and `.next`); the only occurrence outside this document is prose in
  `docs/PRODUCTION_DEPLOYMENT_RECORD.md`.

**Classification of the nine local-only versions:**

| local-only version | file | status |
|---|---|---|
| `20261010000000` | `restore_public_content_objects.sql` | unrecorded in history; its premise is stale (`public.site_settings` and `public.project_requests` both exist, and the paired history rows `20261004120000`/`20261004130000` are present) |
| `20261013120000` | `view_counter_returning.sql` | **genuinely pending** — `increment_blog_post_views_bigint` / `increment_portfolio_post_views_bigint` still return `void`, whereas the file `DROP`+`CREATE`s them returning the new total |
| `20261017134507` `20261017140338` `20261017160247` `20261017165547` `20261017170828` `20261017185848` | the six DEV migrations above | applied to the project, recorded under the apply-time versions listed in A.4 |
| `20261017161925` | `optimize_indexes_public.sql` | **parked, unapplied** (see A.5) |

## A.5 Is `20261017161925_optimize_indexes_public.sql` still unapplied?

**Yes — still parked and local-only.**

```sql
select version, name from supabase_migrations.schema_migrations
 where version = '20261017161925' or name like '%optimize_indexes_public%';
```

returns **0 rows**. The file is also unchanged:

```bash
sha256sum supabase/migrations/20261017161925_optimize_indexes_public.sql
# 48b77789de1d65b3c0d4d95b0779203382e3e68d660d129f9bfba9eaf4185581
```

which equals the checksum pinned in the runbook
(`docs/PRODUCTION_MARKDOWN_CUTOVER.md`) and in
`docs/PRODUCTION_DEPLOYMENT_RECORD.md`; `git status` reports the file clean, and
its only commit is `b6351b1` ("db: prepare production fk indexes").

## A.6 Does any production-Markdown migration row exist?

**No — zero.**

```sql
select version, name,
       (statements::text ilike '%website-content%')        as refs_prod_bucket,
       (statements::text ilike '%prod_backfill_body_pointer%') as refs_prod_cas,
       (statements::text ilike '%public.blog_posts%')      as refs_public_blog,
       (statements::text ilike '%body_en_path%')           as refs_body_paths
  from supabase_migrations.schema_migrations
 where statements::text ilike '%website-content%'
    or statements::text ilike '%prod_backfill_body_pointer%'
    or statements::text ilike '%public.blog_posts%'
 order by version;
```

6 rows returned, and none of them is a production-Markdown record:

| version | name | prod bucket | prod CAS | body paths |
|---|---|---|---|---|
| `20260818120000` | `revoke_public_write_grants` | no | no | no |
| `20260818140001` | `harden_allowlist_and_search_path` | no | no | no |
| `20261006060140` | `harden_unified_identity_privacy` | no | no | no |
| `20261017140941` | `normalize_rls_dev_staging` | no | no | no |
| `20261017161645` | `isolate_dev_author_profile_policy` | no | no | no |
| `20261017191000` | `add_content_storage_read_policy_dev_staging` | *substring only* (`website-content-dev`) | no | DEV-scoped (`dev_staging.blog_posts`) |

`refs_prod_cas` is false for **all 33 rows**: the CP-1 CAS functions
(`prod_backfill_body_pointer_cas` / `_rollback`) have no history row, exactly as
`docs/PRODUCTION_DEPLOYMENT_RECORD.md` states. The pointer columns, the CAS
functions, the `website-content` bucket and the `website_content_body_read`
policy are therefore **not represented in migration history** — deliberately, and
consistently with the deployment record.

## A.7 Is a migration-history repair needed?

**No history repair is required, and none was performed or is recommended.**

* The history is internally consistent: 33 rows, monotonic, no duplicate
  versions, no synthetic row, no entry for an artifact that was applied outside
  the mechanism.
* The production schema's absence from history is an intentional, documented
  decision (`docs/PRODUCTION_DEPLOYMENT_RECORD.md`, register item X-1) and must
  not be "fixed" by writing a synthetic row.
* The six version-drift pairs are a **repository-side** bookkeeping mismatch, not
  a history defect. Their practical consequence: a version-based bulk sync
  (`db push` / `migration up`) would treat the six local files as pending and
  replay them (`20261010000000` and `20261013120000` are also genuinely pending,
  and `20261017161925` is intentionally parked). That is precisely why the
  standing prohibition on bulk syncs must be respected.
* If the drift is ever to be closed, the correct direction is *repository-side*
  (re-timestamp the six DEV files to the recorded history versions, as has
  already been done once for `20261005145655 → 20261005150208` per
  `docs/DESIGN.md`), with the DEV ledger/registry updated in the same change —
  never a history write. That change is outside this Gate's scope and is not
  required for correctness.

## A.8 Corrected report wording (R2A)

The incorrect line exists only in the CP-1 report (final-report item 4, *"Actual
live migration-history count and explanation of discrepancies"*). No repository
document contains the `42`/`20261017185848` figure — `docs/PRODUCTION_MARKDOWN_CUTOVER.md`,
`docs/PRODUCTION_OPEN_WORK_REGISTER.md` and `docs/PRODUCTION_DEPLOYMENT_RECORD.md`
were re-checked and contain no migration count — so no committed document needs
editing.

Replace:

> Actual live migration-history count and explanation of discrepancies: 42
> migration entries; maximum version 20261017185848.

with:

> Actual live migration history: **33 rows** in
> `supabase_migrations.schema_migrations`, maximum version **20261017191000**
> (`add_content_storage_read_policy_dev_staging`), **0** production-Markdown
> rows. The `42` figure is the *union* returned by `supabase migration list
> --linked` (27 paired + 9 local-only + 6 remote-only), and `20261017185848` is
> the maximum of the *local* column only; the local tree holds 36 files. The six
> remote-only versions are the same six DEV migrations as six of the local-only
> files, recorded under apply-time versions rather than the committed filename
> versions. `20261017161925_optimize_indexes_public.sql` remains unapplied
> (sha256 `48b77789…5581`). No migration-history repair is needed and none was
> performed.

---

# R2B — Metadata fingerprints: `34a543b6…` vs `d63422a9…`

Both digests were recovered from the sessions that produced them (CP-0's audit
script and CP-1's verification query) **and** then independently reproduced from
current read-only production data. They are two different fingerprints over the
**same 17 unchanged rows**; neither supersedes the other and they are not
comparable to each other.

## B.1 CP-0 fingerprint (`34a543b6b370324b9078fe04bdd8e9b43e09fba44e5a83d6664e47566ff95422`)

Algorithm (CP-0 audit script, reconstructed and verified 17/17 — see B.4):

```js
const METADATA_KEYS_BLOG = [
  'id','hidden','title_en','title_it','description_en','description_it',
  'post_tags','image','blurhashURL','created_at','author_id',
];
const METADATA_KEYS_PORTFOLIO = [...METADATA_KEYS_BLOG,
  'website','source_link','store_link','demo_link','fdroid_link','ios_store_link','buttons'];

const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

function fingerprint(row, keys) {
  const picked = {};
  for (const k of keys) picked[k] = row[k] ?? null;   // missing → null
  return sha256(canonical(picked));
}
```

* **Digest function**: SHA-256, lowercase hex, per post.
* **Fields**: 11 for blog, 18 for portfolio (the blog set plus the seven
  portfolio-only fields). `views` is deliberately excluded; `body_en` /
  `body_it` are excluded (they are covered by per-locale body hashes).
* **Sorting**: keys sorted ascending; the timestamped rows are sorted by
  `(kind, id)` for the global digest.
* **Serialization**: JSON **array of `[key, value]` pairs** (not an object) —
  `[["author_id","…"],["blurhashURL","…"],…]` — compact separators, non-ASCII
  left unescaped, values taken exactly as the PostgREST response typed them.
* **Global digest**: `sha256(JSON.stringify(rows))` where
  `rows = [[kind, id, hidden, metadataFingerprint]]` sorted by `(kind, id)`
  (JSON with `", "` / `": "` separators), computed in CP-0 in Python and stored
  as `metadataFingerprintDigest` in `/tmp/cp0-prod-audit/baseline.json`.

## B.2 CP-1 fingerprint (`d63422a9ed99584fdffa8de205458596`)

Algorithm (CP-1 verification query, executed verbatim and reproduced — see B.4):

```sql
'meta_digest', (
  select md5(string_agg(x, '|' order by x)) from (
    select format('%s|%s|%s|%s|%s|%s', id, coalesce(hidden::text,''), coalesce(title_en,''),
                  coalesce(title_it,''), coalesce(description_en,''), coalesce(description_it,'')) as x
      from public.blog_posts
    union all
    select format('%s|%s|%s|%s|%s|%s', id, coalesce(hidden::text,''), coalesce(title_en,''),
                  coalesce(title_it,''), coalesce(description_en,''), coalesce(description_it,''))
      from public.portfolio_posts
  ) t
)
```

* **Digest function**: MD5, lowercase hex (32 chars), over the whole 17-row set.
* **Fields**: 6 — `id`, `hidden`, `title_en`, `title_it`, `description_en`,
  `description_it`. Not included: `post_tags`, `image`, `blurhashURL`,
  `created_at`, `author_id`, all portfolio-specific fields, and the bodies.
* **Serialization**: a `|`-joined delimited string per row, no JSON escaping;
  NULL/empty rendered as the empty string; **no table discriminator** — a blog
  row and a portfolio row with equal values produce the same string.
* **Ordering**: `order by x` — lexicographic on the formatted string, **not**
  `(kind, id)`. Deterministic, but a different ordering rule from CP-0's.
* CP-1 used it as an A/B self-check before and after installing the schema
  ("my own pre-install metadata fingerprint"), not as a reproduction of CP-0's
  digest — CP-1 explicitly recorded that reproducing CP-0's digest would require
  CP-0's algorithm and that the body inventory digest
  (`0ed666f4…47ca`) was the stronger comparison.

## B.3 Why the two values differ (and why that was never a divergence)

They are not two measurements of one quantity: SHA-256 vs MD5, 11–18 JSON fields
vs 6 delimited fields, array-of-pairs JSON vs `|`-joined text, `(kind,id)` sort vs
lexicographic sort, `34a543b6` over per-post sub-digests vs `d63422a9` over raw
row text. Equal-field, equal-algorithm comparisons would be required to read
anything into a mismatch — so the fact that the two strings differ says nothing
about whether metadata changed. The question is resolved by recomputation (B.4).

## B.4 Independent recomputation from current production data

Both algorithms were re-run against production as it stands today, read-only.

**Inputs** (exact queries — not `select *`, see B.5 for why):

```sql
-- portfolio (the blog query is the same minus the portfolio-only fields)
select id, hidden, title_en, title_it, description_en, description_it, post_tags, image,
       "blurhashURL", (to_jsonb(created_at))::text as created_at, author_id, website,
       source_link, store_link, demo_link, fdroid_link, ios_store_link, buttons::text as buttons
  from public.portfolio_posts order by id;
```

`buttons::text` is parsed as JSON and `to_jsonb(created_at)::text` is unquoted, so
the values match the PostgREST representation the CP-0 audit consumed.

**Raw observed results:**

```text
current production reproduces CP-0 per-post fingerprints : 17 / 17
recomputed CP-0 global digest : 34a543b6b370324b9078fe04bdd8e9b43e09fba44e5a83d6664e47566ff95422
CP-0 recorded digest          : 34a543b6b370324b9078fe04bdd8e9b43e09fba44e5a83d6664e47566ff95422
match                         : True

recomputed CP-1 meta digest   : d63422a9ed99584fdffa8de205458596
CP-1 recorded digest          : d63422a9ed99584fdffa8de205458596
match                         : True
meta_digest_inputs            : 17
```

**Both digests, produced by two unrelated algorithms over independent read paths,
reproduce their recorded values exactly.** The same was re-verified against CP-0's
own captured rows (`~/okazakee-cutover/prod-legacy-snapshot-…/blog_posts.jsonl`,
`portfolio_posts.jsonl`): the reconstructed algorithm yields **17/17** of CP-0's
per-post fingerprints from CP-0's own bytes, confirming the algorithm is the one
CP-0 actually ran and not an approximation.

## B.5 Representation pitfalls (documented so future reconciliation is exact)

Two *representation* mismatches cost nothing in correctness but will silently
break a naive recomputation:

1. **`buttons` is `jsonb`.** A whole-row fetch (`select json_agg(t) from (select *
   from public.portfolio_posts) t` through the CLI) returned the nested objects
   with their keys in insertion order (`kind` before `url`), whereas PostgREST and
   the jsonb text form return the jsonb-normalized order (`url` before `kind`).
   Result: 11/11 portfolio fingerprints mismatch while blog's 6 match. Using
   `buttons::text` (jsonb text) restores the PostgREST order. Causes no data
   difference — the same keys and values, only member order.
2. **`created_at` is `timestamptz`.** A bare column select yields the Postgres
   text form `2023-05-25 00:00:00+00`; PostgREST and `to_jsonb()` yield ISO-8601
   `2023-05-25T00:00:00+00:00`. Using `to_jsonb(created_at)::text` restores the
   ISO form.

With both corrections in place, all 17 rows reproduce. Neither pitfall indicates a
metadata change.

## B.6 Hidden / visible state per post

```sql
select hidden_blog_ids, visible_blog_ids, hidden_portfolio_ids, visible_portfolio_ids … ;
```

Raw observed values:

```json
{ "hidden_blog_ids": [],
  "visible_blog_ids": [1,8,9,12,18,19],
  "hidden_portfolio_ids": [1,2,3,4,5],
  "visible_portfolio_ids": [21,22,23,24,25,26] }
```

This matches CP-0 exactly (blog ids `1,8,9,12,18,19` with none hidden; portfolio
ids `1,2,3,4,5,21…26` with `1,2,3,4,5` hidden). The conclusion is stronger than a
count match: `hidden` is **inside** the CP-0 per-post fingerprint key set, so the
17/17 reproduction independently proves per-post visibility is unchanged.

Supporting live state (read-only, same query):

```text
blog_rows 6 · portfolio_rows 11 · meta_rows 17
prod_bytes_octet 275670
prod_pointer_rows 0 · prod_pointer_cols_nonnull 0
prod_objects 0 · dev_objects 34
buckets  website,website-content,website-content-dev,website-dev
```

## B.7 Conclusion (R2B)

**No metadata or visibility change occurred.** No unexpected modification was
found, so there is no blocker from R2B: both digests are correct for their own
algorithms, both reproduce from current data, and CP-0's per-post fingerprints —
which include `hidden` — reproduce 17/17.

## B.8 Corrected report wording (R2B)

Replace:

> CP-0 metadata digest `34a543b6…` vs CP-1 metadata digest `d63422a9…` (unreconciled).

with:

> The two metadata digests are different fingerprints of the same unchanged rows,
> not competing values. CP-0's is `sha256` over a JSON array of `[key,value]`
> pairs per post (11 blog / 18 portfolio fields, `views` excluded), globally
> `sha256([[kind,id,hidden,metadataFingerprint]] sorted by (kind,id))`. CP-1's is
> `md5(string_agg('id|hidden|title_en|title_it|description_en|description_it',
> '|' order by …))` over both post tables. Both recomputed from read-only
> production data on 2026-10-18 reproduce their recorded values exactly
> (`34a543b6…5422` and `d63422a9…8596`), and CP-0's 17 per-post fingerprints (which
> include `hidden`) reproduce 17/17, so metadata and visibility are unchanged
> between CP-0, CP-1 and now.

---

# R2C — Browser verification count: 12 or 14?

## C.1 Navigations actually performed in the CP-0 session

Reconstructed from the CP-0 session's own browser evidence (the two `eval`
browser cells and their recorded request/console/status output), not from the
report's summary.

**Pass 1 — discovery + blog pages**

| # | navigation | measurement |
|---|---|---|
| 1–4 | `/en/blog`, `/it/blog`, `/en/portfolio`, `/it/portfolio` | listing pages, navigated for link extraction only — status/console/network were **not** recorded for them |
| 5 | `/en/blog/19/why-buy-a-raspberry-when-you-have-a-redmi` | 200 · console `[]` · failed requests `[]` |
| 6 | `/en/blog/18/preparing-for-mythos` | 200 · `[]` · `[]` |
| 7 | `/en/blog/12/dear-mom` | 200 · `[]` · `[]` |
| 8 | `/it/blog/19/perch-comprare-un-raspberry-quando-hai-un-redmi` | 200 · `[]` · `[]` |
| 9 | `/it/blog/18/prepararsi-a-mythos` | 200 · `[]` · `[]` |
| 10 | `/it/blog/12/cara-mamma` | 200 · `[]` · `[]` |
| 11 | `/en/blog/19/…` (repeat, desktop screenshot navigation) | not re-measured |

**Pass 2 — portfolio, older blog and mobile**

| # | navigation | measurement |
|---|---|---|
| 12 | `/en/portfolio/26/minepanel` | 200 · `[]` · `[]` |
| 13 | `/it/portfolio/26/minepanel` | 200 · `[]` · `[]` |
| 14 | `/en/portfolio/25/pearlift` | 200 · `[]` · `[]` |
| 15 | `/it/portfolio/24/blurkit` | 200 · `[]` · `[]` |
| 16 | `/en/blog/1/from-technology-enthusiast-to-web-developer` | 200 · `[]` · `[]` |
| 17 | `/it/blog/1/da-appassionato-di-tecnologia-a-web-developer` | 200 · `[]` · `[]` |
| 18 | `/en/blog/19/…` under 390×844 mobile emulation (repeat) | 200 · overflow `0 px` · 0 broken images · console `[]` |

Every measured content page returned **200** with zero console errors, zero
failed requests and zero broken images.

## C.2 Reconciliation: 12 is correct — the detail was wrong

Distinct locale-specific **content** pages measured: **12**

| group | locale-pages | count |
|---|---|---|
| blog id 19 | EN + IT | 2 |
| blog id 18 | EN + IT | 2 |
| blog id 12 | EN + IT | 2 |
| blog id 1 | EN + IT | 2 |
| portfolio id 26 | EN + IT | 2 |
| portfolio id 25 | **EN only** | 1 |
| portfolio id 24 | **IT only** | 1 |
| **total** | | **12** |

The `14` reading comes from assuming four blog ids × two locales (8) plus three
portfolio ids × two locales (6). That is not what was executed: **not every
portfolio post was visited in both locales** — `25` was visited only in EN and
`24` only in IT (the CP-0 pass-2 link list was a fixed six-URL list:
`26` EN+IT, `25` EN, `24` IT, blog `1` EN+IT). 8 blog locale-pages + 4 portfolio
locale-pages = **12**.

Reported separately (they are real observations but not content-page checks):

* **4 listing navigations** (`/en/blog`, `/it/blog`, `/en/portfolio`,
  `/it/portfolio`) — discovery only; no per-page status/console accounting was
  recorded, so they must not be counted as verified visits.
* **1 mobile re-visit** of `/en/blog/19/…` (390×844 emulation) and **1 desktop
  screenshot re-navigation** of the same page — repeats of an already-measured
  page.
* In total 18 navigations over 16 distinct URLs; 12 of those URLs are the measured
  content pages.

## C.3 Hidden-route control (same CP-0 session)

* 5 hidden portfolio posts (ids 1–5) × both locales → **404** with the locale's
  "page not found" page, in both languages — hidden content is not exposed.
* **Control**: a *visible* post requested with a wrong slug → **200** after a
  canonicalising redirect. The route matches by id and canonicalises the slug, so
  the hidden-id 404s are genuine visibility denials, not slug-mismatch artifacts.

## C.4 Corrected report wording (R2C)

Replace:

> Browser baseline: 12 visible pages 200 (blog 19/18/12/1 EN+IT, portfolio
> 26/25/24 EN+IT), 0 console errors, 0 failed requests.

with:

> Browser baseline: **12 distinct locale-specific content pages** measured, all
> 200 with zero console errors, zero failed requests and zero broken images —
> 8 blog locale-pages (ids 19, 18, 12 and 1, each in EN and IT) and 4 portfolio
> locale-pages (id 26 in EN and IT; id 25 **EN only**; id 24 **IT only**; not
> every portfolio post was visited in both locales, so the total is 12, not 14).
> Separately: 4 listing pages (`/en/blog`, `/it/blog`, `/en/portfolio`,
> `/it/portfolio`) were navigated for link discovery without per-page status or
> console accounting, and `/en/blog/19/…` was revisited once under a 390×844
> mobile emulation (0 px horizontal overflow, 0 broken images, no console errors)
> plus one desktop screenshot repeat. The 5 hidden portfolio posts (ids 1–5)
> returned 404 in both locales, with a control showing a visible post behind a
> wrong slug returning 200 after canonicalising — i.e. the 404s are visibility
> denials, not slug mismatches.

---

# Anything still unexplained

| Item | Status |
|---|---|
| **R2A** — the exact tool/actor that recorded the six DEV migrations under apply-time versions instead of their committed filename versions | **Not recoverable from the repository.** The CMS repo has no apply path (the dev CLI is read-only by construction), the WS repo never had a migrations tree, and no code reads the history table. The DEV ledger timestamps place the recorded version 4–8 s before the ledger write, which is consistent with a timestamped name generated at apply time. `[INFERENCE]`, not asserted. This does not affect any count, the parked migration, or the production schema. |
| **R2A** — whether `20261010000000_restore_public_content_objects.sql` has any remaining effect | Its stated premise is stale: `public.site_settings` and `public.project_requests` both exist and the paired history rows `20261004120000`/`20261004130000` are present. No action proposed; recorded for completeness. |
| **R2A** — `20261013120000_view_counter_returning.sql` | Fully explained and **still pending**: both increment RPCs still return `void`. Not part of CP-1/CP-2; flagged so it is not lost. |
| **R2B** | **Nothing unexplained** — both digests and all 17 per-post fingerprints reproduce exactly. The two representation pitfalls (B.5) are documented so the next recomputation is bit-exact. |
| **R2C** | **Nothing unexplained** — the CP-0 session evidence accounts for all 18 navigations; the count 12 stands and the parenthetical detail was the error. |

No blocker arises from Gate R2. No migration history was modified, and neither
production nor DEV was mutated.

---

# Appendix A — exact commands and queries used

```bash
# from /home/okazakee/Desktop/Projects/okazakee-website/okazakee-cms
bun node_modules/supabase/dist/supabase.js migration list --linked            # A.2 command A
ls supabase/migrations | wc -l                                                # 36
ls supabase/migrations | sort | tail -1                                       # max local version
sha256sum supabase/migrations/20261017161925_optimize_indexes_public.sql
git log --all --oneline --name-status --diff-filter=AD -- supabase/migrations
git log --oneline --follow --name-status -- <migration file>

bun node_modules/supabase/dist/supabase.js db query --linked \
  --file /tmp/r2ev/<query>.sql --output-format json
```

Queries executed (all read-only; full text in the transcript of this Gate):

| id | purpose |
|---|---|
| `q_history.sql` | `count(*)` + `max(version)` of `supabase_migrations.schema_migrations` |
| `q_full.sql` | all 33 history rows (`version`, `name`, statement count) |
| `q_rows.sql` | newest 12 history rows with their statement text |
| `q_stmtlen.sql` | per-row `array_length(statements,1)`, `length(statements[1])`, `md5(statements[1])` for the six drifted versions |
| `q_prod.md.sql` | search for any production-Markdown / body-pointer / `public`-scoped history row |
| `q_leak.sql` | rows referencing the production bucket, the CAS functions or `public.blog_posts` |
| `q_metadigest.sql` | CP-1's `meta_digest` expression, verbatim |
| `q_state.sql` | row counts, hidden/visible ids, pointer counts, byte total, objects, buckets |
| `q_blog3.sql`, `q_port3.sql` | metadata rows in PostgREST-compatible representation (`to_jsonb(created_at)::text`, `buttons::text`) |
| `q_unapplied.sql` | existence of `public.site_settings` / `public.project_requests`; increment-RPC return types |
| `q_ledger.sql` | `dev_staging.cms_migration_audit` (DEV ledger) |
| `q_buttons.sql` | `pg_typeof(buttons)`, `buttons::text`, nested jsonb ordering probe |

Local recomputation (Python, standard library only; SHA-256 and MD5 over the
documented canonical forms) and diffs against
`/tmp/cp0-prod-audit/baseline.json`, `/tmp/cp0-prod-audit/audit-report.json` and
the CP-0 snapshot.

# Appendix B — per-post metadata fingerprints (current = CP-0, 17/17)

CP-0 algorithm (B.1) applied to current read-only production data. Every value is
byte-identical to `/tmp/cp0-prod-audit/baseline.json`.

| kind | id | hidden | metadata fingerprint |
|---|---|---|---|
| blog | 1 | no | `663bcb5e5ee04c460ed26c61f42c8d922b8e2c4a39577d1e05ac539484541172` |
| blog | 8 | no | `43b8b0a80cddffbb514c5412acb77cfeb91705c3cc5f668ce3986d9542db8266` |
| blog | 9 | no | `de5dddd37b9a0fcefa7f596f11029e484f2ef56b830bf215c5b7c50d23deb18f` |
| blog | 12 | no | `bff420ddc1528acb4fae6f73f87680ce1e98f8d6d61f1debca5f8113465bb78d` |
| blog | 18 | no | `078ccbac265826e1cad08ff70657ee89e94e961f513901e7c0774e1c9ee5c465` |
| blog | 19 | no | `5822be490e026ed3bb17c2cd7aeffa5bdcd685afb61217f47b374b2dc293bc8c` |
| portfolio | 1 | yes | `7b58acb49ec10b19fcff6c9733310abf2ef6d1d583c6f4bdf052f19c7edb8039` |
| portfolio | 2 | yes | `28b31e2a793dae03ded3d58e0eb4363c58d71c307c3bf1b5cb420ac3f1527120` |
| portfolio | 3 | yes | `340b2f0999a9a7f2c4641d1ce480cb448328a6f62e939d3c7ca23fd434c4edf4` |
| portfolio | 4 | yes | `69599c6a281c085201c8fb39ea0bd92e8f6d3f6f6ab5064c15f86767119dd86b` |
| portfolio | 5 | yes | `f076bf63d0dabe175b4dd1eecf94c1a71e1d7fba2431af2561aa0705109c4342` |
| portfolio | 21 | no | `a3e76b6783194be33f7a1e4051ebc359aaf79192713099187eb9469944569fb3` |
| portfolio | 22 | no | `b451a0f3d3d67c70f4b79bcf68c4449e3239171f561cbe4c19a4f0ee9b1fcbc3` |
| portfolio | 23 | no | `c8d56c5ecfa5bf3e2c6192f3c0b8d4ac6243b469d1d76e73065478f6f5f5e6cb` |
| portfolio | 24 | no | `989ac9adc6e5abd8fe8d6027b11904e90bf0b1d992694aa0f4f5f80354efc4da` |
| portfolio | 25 | no | `f328353f5a41de1128e074073510c4c910bee81169e48da6cabdd5746c4785ea` |
| portfolio | 26 | no | `6eab0dddced8cbc970401a7cc24c9618dd8ba7959bfa51b8148c17f9bea0ce7e` |

Global digest: `34a543b6b370324b9078fe04bdd8e9b43e09fba44e5a83d6664e47566ff95422`
(CP-0 recorded · recomputed · equal).
CP-1 `meta_digest`: `d63422a9ed99584fdffa8de205458596` (recorded · recomputed · equal).
Body inventory digest (unchanged since CP-0, for context):
`0ed666f425668578cb9249974865abdb54c52a89146049ec8f9247b0b63947ca`.

# Appendix C — remote migration history (33 rows, as observed)

| # | version | name |
|---|---|---|
| 1 | `20260817100000` | `cms_login_rate_limit` |
| 2 | `20260818090000` | `harden_login_rate_limit` |
| 3 | `20260818100000` | `login_rate_limit_split_buckets` |
| 4 | `20260818110000` | `remove_legacy_login_rate_rpc` |
| 5 | `20260818120000` | `revoke_public_write_grants` |
| 6 | `20260818140000` | `add_cms_lookup_rpc` |
| 7 | `20260818140001` | `harden_allowlist_and_search_path` |
| 8 | `20260818140002` | `revoke_public_select_on_allowlist` |
| 9 | `20260818150000` | `add_cms_lookup_current_user_rpc` |
| 10 | `20260818150001` | `drop_enumerable_rpc_and_dead_function` |
| 11 | `20260825090000` | `remove_password_login_rate_limit` |
| 12 | `20261004090000` | `add_skill_link_and_position` |
| 13 | `20261004101500` | `add_hero_display_options` |
| 14 | `20261004110000` | `add_post_buttons` |
| 15 | `20261004111000` | `backfill_post_buttons` |
| 16 | `20261004120000` | `add_site_settings` |
| 17 | `20261004130000` | `add_project_requests` |
| 18 | `20261005120000` | `freeze_static_site_copy` |
| 19 | `20261005150208` | `add_site_settings_footer_identity` |
| 20 | `20261005234758` | `create_cms_migration_audit_ledger` |
| 21 | `20261006040745` | `harden_storage_website_policies_and_limits` |
| 22 | `20261006060140` | `harden_unified_identity_privacy` |
| 23 | `20261006233000` | `add_identity_github_subject_dev_staging` |
| 24 | `20261008122200` | `reseed_skills_section_dev_staging` |
| 25 | `20261008135608` | `cms_content_controls_dev_staging` |
| 26 | `20261008145842` | `restore_header_images_dev_staging` |
| 27 | `20261008213304` | `cms_allowed_users_sequence_usage` |
| 28 | `20261017135406` | `optimize_indexes_dev_staging` |
| 29 | `20261017140941` | `normalize_rls_dev_staging` |
| 30 | `20261017161645` | `isolate_dev_author_profile_policy` |
| 31 | `20261017170344` | `harden_post_reads_dev_staging` |
| 32 | `20261017185336` | `add_body_storage_paths_dev_staging` |
| 33 | `20261017191000` | `add_content_storage_read_policy_dev_staging` |
