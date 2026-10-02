# Isolated integration / browser fixture

This document describes `src/testing/start-isolated.mjs`, a disposable,
**loopback-only** stack that runs the real CMS (Next.js, Server Actions,
middleware, Supabase client code) against a real local Supabase instance.

It exists so integration and browser tests (for example an Obscura-driven
flow) can exercise authentication, authorization, mutations, Storage uploads,
cache invalidation and the signed public-site revalidation bridge without
touching production data or credentials.

## What it is

- A throwaway Supabase CLI project initialized under a fixture workdir
  (`/tmp/okazakee-cms-isolated` by default) using Docker.
- The **inferred baseline schema** (`src/testing/sql/0001_baseline_schema.sql`)
  plus the repository's own `supabase/migrations/*.sql`, applied in order.
- Deterministic seed content and translations
  (`src/testing/sql/0002_seed_content.sql`) whose asset URLs point at loopback
  Storage.
- Real GoTrue identities (admin / editor / non-allowlisted outsider) created
  with local, non-secret test passwords, and real `@supabase/ssr` session
  cookies for browser seeding.
- The real Next.js application, snapshotted into a `/tmp` overlay, on
  `http://localhost:3100`.
- A standalone test server on `http://localhost:3200` that mirrors the public
  site's signed revalidation receiver and exposes a fixture control API.

## What it is not

- It never reads `.env.local`, never links a Supabase project, and never calls
  `db pull` / `db dump --linked` / `db push`.
- It never enables an authentication bypass. `CMS_ISOLATED_TEST=1` only adds
  loopback image remote patterns to the generated overlay `next.config`; every
  Server Action and the proxy/middleware still enforce the same server-side
  authorization and the same allowlist RPC.
- The baseline schema is inferred from source (`src/types`,
  `src/app/actions/cms/**`, `src/libs/**`) because the authoritative schema
  lives in the shared production project. It is a test fixture, not a
  migration.

## Prerequisites

- Docker running.
- Supabase CLI on `PATH` (`supabase --version`; 2.105+ tested).
- Dependencies installed (`bun install`). The fixture reuses the repository's
  `node_modules` via a symlink.

## Quick start

```bash
# from the repository root
node src/testing/start-isolated.mjs
```

The command prints a summary and stays in the foreground. Ctrl+C stops Next,
the fixture server, and (unless `ISOLATED_KEEP_SUPABASE=1`) the local Supabase
containers.

```bash
node src/testing/start-isolated.mjs --status   # ping a running fixture
node src/testing/start-isolated.mjs --stop     # stop everything
node src/testing/start-isolated.mjs --help
```

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `ISOLATED_WORKDIR` | `/tmp/okazakee-cms-isolated` | Disposable project + overlay root |
| `ISOLATED_SUPABASE_API_PORT` | `54321` | Local Supabase API gateway port |
| `ISOLATED_NEXT_PORT` | `3100` | Next dev port |
| `ISOLATED_FIXTURE_PORT` | `3200` | Fixture/revalidation port |
| `ISOLATED_KEEP_SUPABASE` | `0` | `1` keeps Supabase running on exit |

All four URLs are asserted to be loopback before anything is spawned.

## Browser session seeding

Open either of these in the browser/driver before navigating to the CMS. The
response sets the session cookie for `localhost` and redirects to Next; **no
token value is ever printed or returned as text**.

```
http://localhost:3200/__fixture/session?user=admin
http://localhost:3200/__fixture/session?user=editor
http://localhost:3200/__fixture/session?user=outsider
```

- `format=json` returns only `{ user, cookieNames, nextUrl }` (no values).
- `redirect=<loopback-url>` controls the redirect target.
- The same cookies are also written to `<workdir>/sessions/<user>.cookie`
  with mode `0600` (name = value pairs, suitable for a `Cookie` header).

Use `http://localhost:...` (not `127.0.0.1`) for both the fixture and Next so
the host-only session cookie is shared across ports.

Accounts (local, non-secret test credentials):

| Key | Email | Password | Allowlist role |
|---|---|---|---|
| `admin` | `admin@isolated.test` | `isolated-admin-pw` | `admin` |
| `editor` | `editor@isolated.test` | `isolated-editor-pw` | `editor` |
| `outsider` | `outsider@isolated.test` | `isolated-outsider-pw` | none (denied) |

## Fixture control API (`http://localhost:3200`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + event count + failure mode |
| `GET` | `/__fixture/runtime` | Ports/URLs (no secrets) |
| `GET` | `/__fixture/accounts` | Seeded identities and roles |
| `GET` | `/__fixture/session?user=...` | Seed browser session (302 or JSON) |
| `POST` | `/api/internal/content-revalidate` | Signed revalidation receiver |
| `GET` | `/__fixture/events` | Stored revalidation events |
| `DELETE` | `/__fixture/events` | Clear stored events |
| `GET` | `/__fixture/fail` | Current failure injection mode |
| `POST` | `/__fixture/fail` | `{"mode":"none\|http-500\|timeout\|reject"}` |
| `GET` | `/__fixture/snapshot?tables=a,b` | Service-role table snapshot |
| `GET` | `/__fixture/writes?limit=N` | Observed committed DB writes |
| `DELETE` | `/__fixture/writes` | Clear observed writes |
| `POST` | `/__fixture/reset` | Re-run migrations + seed, re-create users/storage, clear events |

Observed writes come from a fixture-only audit table
(`public._fixture_writes`) and a trigger attached to every content table, so
you can assert exactly which rows the real Server Actions changed and with
which role.

## Revalidation receiver

The receiver mirrors the public-site contract used by
`src/libs/public-site/revalidation.ts`:

- `POST /api/internal/content-revalidate`
- `X-Content-Timestamp: <occurredAt ISO string>`
- `X-Content-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`
- Body: `{ version: 1, eventId, occurredAt, source, operation, entity, eventId?, tags: [...] }`
- Replay window: 300 seconds.
- Tag allowlist: the shared vocabulary in
  `src/libs/content/cacheTags.ts` plus `post:<blog|portfolio>:<id>` and
  `author:<id>` patterns. Drift is guarded by
  `src/testing/lib/revalidation.test.ts`.

The fixture generates a random per-run secret (written to `runtime.json`,
mode `0600`) and passes it to the app as `WEBSITE_REVALIDATION_SECRET`.

## Typical workflow

1. Start the fixture and seed a session (see above).
2. Drive the UI (or invoke a Server Action) with the seeded cookie.
3. Assert against the control API:
   - `GET /__fixture/writes` for committed rows,
   - `GET /__fixture/snapshot?tables=...` for final state,
   - `GET /__fixture/events` for the signed public-cache event.
4. Inject a failure (`POST /__fixture/fail {"mode":"http-500"}`) and assert the
   action still commits while reporting `revalidation: 'failed'`.
5. `POST /__fixture/reset` between scenarios, then re-seed the session.

## Limitations / notes

- The app overlay is a **snapshot of `src`** taken at startup. Browser evidence
  is invalid for new changes until the overlay is refreshed; refresh it with
  the guarded `cp src → <workdir>/app/src` snippet (source only, no env files)
  rather than a casual fixture restart, which resets disposable data/sessions.
  Config/dependency/deletion changes need guarded overlay preparation or a
  deliberate restart. The current fixture workdir is
  `/tmp/okazakee-cms-isolated-verification` (older
  `/tmp/okazakee-cms-isolated` paths are historical).
- The overlay runs `next dev --webpack` bound to `127.0.0.1`. Turbopack rejects
  the `node_modules` symlink that keeps the `/tmp` overlay lightweight.
  Disposable Docker stacks default to a loopback-only bridge network; verify
  host publications stay loopback-only before browser runs.
- The overlay adds loopback HTTP image patterns to a copy of
  `next.config.ts`; the repository's own config is not modified. If the root
  config later grows the same `CMS_ISOLATED_TEST`-gated loopback patterns, the
  overlay can drop them.
- The inferred baseline is the weakest fidelity point; it reproduces the
  columns, RPCs and RLS behavior the CMS depends on, not the full production
  schema. Production schema/RLS parity is not proven here.
- A database reset invalidates existing sessions; re-seed via
  `/__fixture/session`.
- The repository build (`bun run build`) is intentionally **not** run in the
  repository: it would evaluate `'use cache'` reads against whatever Supabase
  URL is ambient. Use the protected helper, which prepares a separate
  `build-app` copy, excludes repository env files, supplies only local fixture
  endpoints/keys, copies real dependencies with `verbatimSymlinks: true`, and
  does not mutate the running `app` snapshot:
  `ISOLATED_WORKDIR=<workdir> node src/testing/build-isolated.mjs`.
  It requires the fixture to be running.
- Section translation loaders are latest-request guarded
  (`src/hooks/cms/useLatestRequest.ts`): only the latest mounted load may
  replace editor state or clear its spinner, so StrictMode duplicate loads and
  stale responses cannot overwrite newer drafts.

## Verification performed

- `bun run lint` → exit 0 (Biome schema-version info only).
- `bun run test` → **28 files / 258 tests passed** (includes dispatcher,
  translation-delta/CAS, reconciliation, preview-contract, fixture-guard, and
  latest-request ordering regressions).
- `bunx tsc --noEmit` → exit 0; `git diff --check` → exit 0.
- Isolated production build via `build-isolated.mjs` → exit 0 (Next 16.3.1,
  Turbopack, 9/9 static pages; warns about missing `metadataBase` falling back
  to the local fixture origin).
- Browser (disposable fixture, real Chromium): copy/privacy/Layout publication
  + 64 preview combinations (`src/testing/verify-copy-browser.mjs`) exit 0
  with 0 page errors; supplementary Users/roles/category-rename run: 31
  required assertions pass; backend mutation matrix: 23 pass with the
  historical category-rename placeholder now covered by the supplementary run
  (the old `backend.mjs` placeholder text is stale and must not be edited in
  its historical results JSON).
