<p align="center">
  <img src="src/app/public/title-cms.png" alt="Okazakee CMS" width="340" />
</p>

<p align="center">
  <strong>Content management for okazakee.dev</strong>
  <br />
  <a href="https://cms.okazakee.dev">cms.okazakee.dev</a> &nbsp;·&nbsp; renders
  on the public site <a href="https://github.com/Okazakee/okazakee-ws">okazakee-ws</a>
</p>

---

## Overview

The standalone content management system for
[okazakee.dev](https://okazakee.dev). A Next.js 16 application that authors
the portfolio/blog content stored in a shared Supabase project — sections,
translations, uploads, user management — then notifies the public site to
refresh its caches.

This repository is **write-side only**. It owns editing, auth flows, uploads
and revalidation events; the public website
([Okazakee/okazakee-ws](https://github.com/Okazakee/okazakee-ws)) owns
rendering and caching.

## Highlights

- **Auth** — GitHub OAuth + WebAuthn passkey sign-in (discoverable
  passkeys), gated by an allowlist (`cms_allowed_users`: email OR GitHub
  username) with roles `editor` / `admin` / `superadmin`. There is no password
  credential: adding an email user authorizes it and sends a Supabase
  invitation whose confirmation ends at passkey enrollment. Every Server
  Action re-checks the role server-side.
- **Role-based access** — editors write all blog/portfolio posts; admins add
  global content, the private request inbox and editor-only user management;
  `superadmin` is bootstrap-only and additionally manages admins. The full
  matrix is [Roles and permissions](#roles-and-permissions); every mutation is
  authorized server-side and the UI is never the security boundary
- **Sections** — Hero identity/content and portrait; Skills categories and
  ordered entries; Career, Blog and Portfolio entries; ordered Contacts with
  SVG icon URLs; Layout (theme header images + VAT). System groups Resume PDFs, Request Form
  copy, Privacy Policy and Users. Structural section headings, career
  vocabulary and the privacy subtitle live in the website's local EN/IT files.
  Localized entry fields and privacy-policy bodies remain CMS-owned.
- **Publishing** — individual Publish and Publish All require confirmation.
  Publish All confirms once and preserves drafts that fail to commit.
- **Uploads** — images (client-side WebP preprocessing, server fallback via
  Sharp, SVG rejected by image upload validators) and PDF resumes. Every
  upload is validated by magic bytes and container completeness before any
  Storage write: JPEG/PNG/WebP/GIF/AVIF only, declared MIME must agree with
  the bytes (`image/jpg` is the accepted JPEG alias), SVG/HTML spoofs are
  rejected, WebP is walked as a complete RIFF container, and PDFs need the
  `%PDF-` header plus `%%EOF` trailer. This proves file format/completeness,
  not safety: the CMS is not a malware or content scanner. Production
  uses `website`; staging uses the isolated `website-dev` bucket. Contacts
  render editor-supplied SVG URLs rather than uploading SVG through Sharp.
  Animated WebP skips the
  canvas step and is resized frame-by-frame by Sharp, so animated profile
  pictures keep every frame. Blur placeholders are generated with
  [blurkit](https://github.com/Okazakee/blurkit): Sharp handles server-side
  resize/format, Blurkit the ready-to-use placeholder data URL
  (`blurkit/node` on upload, `blurkit/browser` client-side)
- **Consistent limits** — 10 MB for images and PDFs, enforced at every layer:
  client (`useFileUpload` `maxSizeMB`), server validators
  (`MAX_UPLOAD_SIZE_BYTES` in `src/utils/cms/validation.ts`) and the
  framework (`serverActions.bodySizeLimit: '10mb'` in `next.config.ts` —
  without it Next's 1 MB default would reject uploads before the action runs)
- **Cache invalidation** — after a committed mutation the CMS sends a signed
  HTTP event to the public site's `/api/internal/content-revalidate`
  (HMAC-SHA256, replay window, hard-coded tag allowlist)

## Roles and permissions

`src/utils/cms/roles.ts` is the single client-safe source of truth
(`CmsRole`, `isCmsRole`, `isCmsAdminRole`, `canManageCmsRole`,
`canAssignCmsRole`). The allowlist CHECK and the last-superadmin trigger are
the database backstop; the Server Action gates are the authority.

| Capability | editor | admin | superadmin |
| --- | --- | --- | --- |
| Blog/portfolio posts: read, create, update, delete, upload, batch publish; choose any existing profile as author | ✓ | ✓ | ✓ |
| Global content: Hero, Skills, Career, Contacts, Layout/site settings, Resume, Privacy/i18n | — | ✓ | ✓ |
| Request inbox (visitor personal data) | — | ✓ | ✓ |
| Directory: add/resend/remove editors and dummy authors; rename/avatar manageable allowlisted profiles | — | ✓ | ✓ |
| Assign the `editor` role | — | ✓ | ✓ |
| Assign `admin`, change/remove an existing admin | — | — | ✓ |
| Grant, change, or remove `superadmin` | — | — | — (SQL bootstrap only) |
| Own profile name/avatar and passkeys | ✓ | ✓ | ✓ |
| Delete own account | ✓ | ✓ | — (refused) |

- Editorial collaboration is deliberately shared: all three roles can manage
  every post and pick an existing profile as author; there is no owner-only
  editing rule.
- Admin cannot mint another admin, demote/remove an admin peer, touch a
  superadmin, or edit an arbitrary profile. The profile routes bind the target
  to an allowlist row (immutable GitHub ID → verified email → legacy handle
  only when no immutable ID exists); changing your own name/avatar goes
  through `updateMyProfile` only.
- Dummy authors (`dummy-…@dummy.local`) are editor-only and can never be
  promoted. They are excluded from the "last usable admin" count.
- No CMS path creates, changes, or removes a superadmin; the owner provisions
  that row out of band. A superadmin cannot delete its own account either.
- The last superadmin can never be demoted or removed: a `BEFORE UPDATE OR
  DELETE` trigger takes an advisory transaction lock before counting, so two
  concurrent demotions cannot both pass. The user-management last-admin guard
  is a softer app-level check and excludes dummy rows.

## Layout and System Resume

**Layout** (admin and superadmin) owns the two theme header images and the footer VAT
number: `site_settings.header_logo_dark`, `header_logo_light` and
`footer_vat_number`. Each header image is optional and independent — a null one
renders that theme's bundled website image, so clearing one theme never affects
the other. Uploads keep their aspect ratio (bounded, never cropped), use
immutable `header/dark/` and `header/light/` objects in the CMS's selected
bucket, and only take effect after a confirmed Publish; the replaced object is
deleted after the database commit. VAT is nullable `TEXT`: leading zeroes
survive storage, display and copying, and blank input stores `NULL`, which
renders no VAT number on the website — the CMS is the single source, with no
local fallback value. Navigation and the footer name
`Okazakee` are website-owned.

**System → Resume** manages the EN/IT PDFs in `hero_section.resume_en` and
`resume_it`. It uses `heroActions` (`UPDATE_WITH_FILES`) with the existing
10 MB PDF validation and immutable upload → database commit → old-file cleanup
ordering. Publishing a PDF invalidates `resume` and `hero_section`; a combined
portrait/PDF change also invalidates `hero`.

**Hero → Identity & content** edits localized names, ordered roles and the
about paragraph. One nonblank role types once and stops; multiple roles cycle
in order. Blank entries stay editable but do not enter the animation. Portrait
shape remains editable; there are no animation or role-target switches.

Structural Skills, Career, Portfolio, Blog and Contacts copy, along with the
privacy subtitle, lives in `okazakee-ws/src/i18n/messages/site.{en,it}.json`.
The local-over-database merge prevents old rows from overriding those strings.
Category names, entries, links/icons, exact positions and policy bodies remain
editorial data.

User removal requires an identity-specific confirmation. Profile deletion
commits before cleanup of its exact owned avatar URL; external avatars and
wrong-bucket URLs are untouched. Non-public schemas never delete shared Auth
identities.

## Architecture

```text
CMS (this repo) ──writes──▶ Supabase ◀──reads── Public website (okazakee-ws)
       │                        │
       └── signed content-change event ──▶ POST /api/internal/content-revalidate
```

- **Supabase** owns content, auth, storage and the allowlist.
- **This repo** owns editing, auth flows, uploads and revalidation
  events.
- **The public repo** owns rendering and caching (Next Cache Components).
  Revalidation uses `revalidateTag(tag, { expire: 0 })` there — immediate
  expiry for an external caller, so a committed edit is never followed by a
  stale render. `updateTag()` is never used across applications
  (Server-Action-only, unavailable to an incoming HTTP request).

## Getting Started

### Prerequisites

- Bun 1.3+
- A Supabase project shared with the public site

### Install

```bash
git clone https://github.com/Okazakee/okazakee-cms.git
cd okazakee-cms
bun install
cp .env.local.example .env.local   # then fill in the values below
bun run dev
```

### Environment

See `.env.local.example`. Required:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key (`sb_publishable_…`) |
| `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_…`) — server-only, never in public code |
| `CMS_PUBLIC_URL` | Canonical CMS origin used in production to build OAuth callbacks and always for invitation redirects; never derived from a forwarded `Host`. Development OAuth falls back to the request origin. |
| `NEXT_PUBLIC_SITE_URL` | Public site origin (asset/link generation) |
| `NEXT_PUBLIC_LOCALES` / `NEXT_PUBLIC_DEFAULT_LOCALE` | Locale list / default (e.g. `en,it` / `en`) |

Public-site revalidation (production):

| Variable | Purpose |
| --- | --- |
| `WEBSITE_REVALIDATION_URL` | `https://<public>/api/internal/content-revalidate` |
| `WEBSITE_REVALIDATION_SECRET` | Must equal the public site's `CONTENT_REVALIDATION_SECRET` |

### Local development: the Development environment

Local values live in the Vercel project's **Development** environment, so a
checkout is configured with `vercel env pull` alone:

| Project | Development values that drive the local loop |
| --- | --- |
| `okazakee-cms` | `WEBSITE_REVALIDATION_URL=http://localhost:3000/api/internal/content-revalidate`, `NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging` |
| `okazakee-ws` | `CONTENT_REVALIDATION_SECRET` (the same value as the CMS's `WEBSITE_REVALIDATION_SECRET`), `NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging` |

`vercel env pull` **merges**: keys the pulled environment defines are
overwritten, keys that exist only locally are kept. The hazard is pulling the
*wrong* environment — `vercel env pull --environment=production` overwrites
`WEBSITE_REVALIDATION_URL` with the deployed origin and drops
`NEXT_PUBLIC_SUPABASE_DB_SCHEMA`, so `src/config/shared.ts` falls back to
`public` and local edits are written straight into production content.

**`.env.development.local`** guards against that: Next.js loads it before
`.env.local`, and `next build` / `next start` ignore it.

```bash
# .env.development.local
NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging
WEBSITE_REVALIDATION_URL=http://localhost:3000/api/internal/content-revalidate
```

`WEBSITE_REVALIDATION_URL` must name the public site you are actually looking
at. With the deployed origin, a local edit signs its invalidation event for
production, the local `okazakee-ws` cache is never purged, and the site keeps
serving the pre-edit render — hero portrait shape, copy, posts — until its own
cache window lapses, which looks exactly like "the CMS value is not used here".

### Supabase Setup

**Tables:** `user_profiles`, `cms_allowed_users`, `blog_posts`,
`portfolio_posts`, `skills`, `skills_categories`, `career_entries`,
`contacts`, `hero_section`, `site_settings`, `i18n_translations`.
**Storage buckets:** `website` in production, `website-dev` otherwise.

`site_settings` is one row: the two theme header image URLs and the textual
VAT number. Header/footer chrome and fixed section copy are not editable
translation namespaces.

**Auth redirect URLs** (Supabase Auth → URL Configuration) must include
exactly these canonical paths — the CMS serves root paths, no `/cms` or
locale prefixes:

- `https://cms.okazakee.dev/auth/callback`
- `https://cms.okazakee.dev/auth/confirm`
- local dev: `http://localhost:3001/auth/callback` and
  `http://localhost:3001/auth/confirm`

`/auth/callback` finalizes GitHub OAuth. `/auth/confirm` is the public
invitation landing: the redirect target is always
`${CMS_PUBLIC_URL}/auth/confirm`, and the CMS accepts either the default
Supabase invite template (session tokens in the URL fragment) or an optional
custom template using `?token_hash=…&type=invite`. `/auth/setup` is **not** a
redirect target — it is protected and requires the confirmed, allowlisted
session.

Invitation delivery needs a **custom SMTP server** configured in Supabase.
The built-in SMTP only delivers to project team members at a low rate, and a
successful GoTrue response means "accepted for delivery", not "mail arrived".
Until SMTP is configured, only `ADD_EMAIL`'s explicit
`existing-account`/`failed` outcomes and the Auth logs are reliable signals.

Legacy monolith-era entries such as
`https://cms.okazakee.dev/en/auth/callback` (or `/it/…`, `/cms/…`) are no
longer generated by any flow and can be removed.

### Database schema: `dev_staging`, never `public`

**`public` holds production content. Local development reads `dev_staging`, a
cloned schema inside the same Supabase project.** Set this before the first
`bun run dev`, or every CMS edit writes straight to production:

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging
```

`src/config/shared.ts` reads that variable and **falls back to `public`** when it
is unset — there is no safe default, so an `.env.local` copied from a Vercel
preview env (which omits it) points at production. Both this app and
`okazakee-ws` must set it for local work to stay off production, and it belongs
in `.env.development.local` so a `vercel env pull` cannot drop it (see
[Local development overrides](#local-development-overrides-envdevelopmentlocal)).

`dev_staging` must also be listed in the project's **exposed schemas**
(Dashboard → Data API settings); otherwise PostgREST answers
`permission denied for schema`.

### Dev database verification: `db:dev:check` (read-only)

Never run a blind `supabase db push`, `migration repair`, or
`search_path`-fallback apply: `public` holds production content and is
off-limits for dev work. The reviewed content cutover
`20261008135608_cms_content_controls_dev_staging.sql` is explicitly
`dev_staging.`-qualified: it migrates singular roles, removes obsolete
animation/logo/name columns and site-owned copy, converts contact SVG URLs
and backfills dense positions. The follow-up
`20261008145842_restore_header_images_dev_staging.sql` re-adds the two
nullable header-image columns that Layout owns. Neither implies a production
schema change.

Link once per machine, then verify (`src/utils/cms/devMigrations.ts`;
`src/libs/cms/devMigrations/devCheck.ts`; registry
`src/libs/cms/devMigrations/registry.json`, 20 `{version,name,sourceFile}`
entries):

```bash
supabase login
supabase link --project-ref <ref>
bun run db:dev:check [--scope dev_staging]
```

That is the only database command. There is no apply command: the CLI
accepts `check` only and rejects any unknown/`apply` action without any DB
writes. Future database changes stay explicitly reviewed/manual — no
automatic apply exists, and there is no pending or interim implementation.
The role migration is deliberately not auto-applied: until its reviewed
manual apply and ledger record, `db:dev:check` reports that `H-<version>`
ledger row missing by design.
The 7 original public/unqualified historical sources must never be replayed
against the shared project's `public`: the safe manual boundary is to leave
pre-existing `public`/unqualified history alone and change `dev_staging`
only through reviewed SQL + a fresh read-only check.
`--scope` defaults to and must equal `dev_staging`; anything else is an
immediate `FAIL`. The check is read-only (project-local
`supabase db query --linked --output-format json` metadata `SELECT`s plus
local source-file reads; `public` is never queried for certification).

Green check prints `PASS H-<version>` per row (ledger hash == source bytes +
mode), the `C/K/X/P/A/Q` column/constraint/index/policy/ACL findings, the
footer `F` comment statements verbatim, the `D` data-invariant findings, and
ends `dev check: N pass / 0 fail / M info`. Drift fails with exit 1, e.g.
`FAIL H-<v>.hash source DRIFTED… never reapply changed history`,
`FAIL H-<v>.ledger ledger MISSING…`, `FAIL C-/K-/X-/P-/A-/Q-… diverges`,
`FAIL …unregistered…`, `FAIL ledger.read/catalog.read` (with a login/link
hint) — plus the shared-auth NOT-certified note.

Owner knows the development state is good when the check reports `0 fail`
with all 20 `H-<version>` records matching: source bytes immutable, ledger
hash matches, live `dev_staging` effects match. `verified_existing` means
the 93-check audit proved that source's schema effects plus its byte hash —
it does not prove original execution provenance, and it certifies nothing
about `public`, shared auth, or pre-existing history.

Native `supabase_migrations` history is mixed-scope and does not certify
content effects. Dev authority lives in `dev_staging.cms_migration_audit`:
each registry entry has exactly one record whose `source_sha256` must equal
the file bytes, tagged `verified_existing` (schema effects plus hash audited)
or `applied` (executed under review). The newest entry,
`20261026125511_cms_superadmin_role.sql`, is applied-class: record it only
after the reviewed manual apply below. Live catalog/data checks include the
allowlist sequence's service-role `USAGE`, with no client-role access.
Historical source files are never rewritten or replayed against `public`.
Source bytes are immutable: a changed registered file
fails verification, never re-applies. The ledger bootstrap
(`20261005234758_create_cms_migration_audit_ledger.sql`) is dev-only DDL
with its own history row, not one of the audited app records. Baseline (inferred
fixture, not production parity) and shared auth/storage (`auth.users`
sessions carry over, buckets are project-level) stay outside this
certification.
Two things are *not* certified by this check:

- **Storage** — buckets are project-level. Use a separate bucket
  (`website-dev`, selected by `getCmsStorageBucket`) so a test upload cannot land in the live one.
- **Auth** — `auth.users` is shared, so a signed-in browser session carries over
  between schemas; `cms_allowed_users` does not, and must be seeded per schema.

User creation needs both table `INSERT` and sequence `USAGE`: RLS bypass
does not bypass sequence privileges. The scoped sequence grant fixes
`permission denied for sequence cms_allowed_users_id_seq` without opening
the allowlist to browser roles. User actions preserve PostgREST error
messages instead of collapsing plain database error objects into an
unknown-error fallback.

### Role-hierarchy migration: apply, deploy, bootstrap

`20261026125511_cms_superadmin_role.sql` is the registry entry that touches
`public` as well as `dev_staging`: it widens the allowlist role CHECK to
`editor`/`admin`/`superadmin`, replaces `public.cms_lookup_current_user()`
with one `p_schema text default 'public'` RPC (whitelist `public` and
`dev_staging`, table-existence check, no public fallback), makes
`is_admin_user()` accept superadmin, and adds the last-superadmin guard
trigger. It promotes no row. `dev_staging` gets the CHECK plus the trigger
only; it never grows copies of the public identity functions.

Applied on 2026-10-26 to both schemas in one reviewed transaction, with the
source hash recorded in `dev_staging.cms_migration_audit`:
`1006dec784789e948700152c4e061894ef3e95fdcec774f6816f714e000dcf52`.
The post-apply read-only check reported 134 pass, 0 fail, 10 info; both live
role CHECKs admit exactly `editor`, `admin`, and `superadmin`. Owner promotion
must still follow the compatible-code deployment step below.

Order is load-bearing:

1. Apply the migration manually (reviewed SQL; `db:dev:check` is read-only).
   It is backward compatible: no superadmin row exists yet, and an existing
   no-argument `cms_lookup_current_user()` call resolves through the default
   parameter.
2. Deploy the CMS code that understands `superadmin` and passes
   `supabaseSchema` to the RPC.
3. Bootstrap exactly one named identity as the owner, in SQL:
   `update public.cms_allowed_users set role='superadmin' where id = (select
   id from public.cms_allowed_users where lower(email) = lower('<OWNER>')
   and role='admin') returning id, email, role;` — it must return exactly one
   row. Never `update … where role='admin'`: that promotes every admin, and
   no migration performs this update.
4. Verify: middleware resolves `superadmin`, admin sections render for that
   session, a second admin cannot demote/remove it, and the last-superadmin
   guard rejects a demotion/removal.

Rollback is a new migration that drops the guard trigger before allowing
zero superadmins and restores the previous CHECK/function bodies.

## Auth & Account Semantics

- **Login:** allowlist-gated **GitHub OAuth** or **WebAuthn passkey**
  (discoverable passkeys required); roles `editor` / `admin` / `superadmin`.
  There is no password credential, password login, or password limiter in the
  product. The hidden navigation is never an authorization mechanism — every
  Server Action re-checks the canonical role from `src/utils/cms/roles.ts`.
- **Email invitation (`ADD_EMAIL`):** admin-level only (admin may add editors;
  only superadmin may add admins). The action validates/normalizes the
  address, refuses duplicates, inserts the `cms_allowed_users` row FIRST, then
  asks Supabase Auth to send the invitation to
  `${CMS_PUBLIC_URL}/auth/confirm`. Authorization exists before any usable
  link does.
  - The allowlist insert is the success condition. The invitation outcome is
    reported separately as `sent`, `existing-account`, or `failed`.
  - `sent` means GoTrue accepted the send for delivery, not that mail arrived;
    confirm with the Auth logs or SMTP provider. It stamps `invited_at`; a
    failed timestamp write is logged and does not fail the operation.
  - `existing-account` means Auth rejected an invitation to an already
    confirmed identity: no duplicate account or misleading send-success is
    reported, and the operator is told to use the existing sign-in method.
  - `failed` (SMTP/network/429) leaves the row in place and returns a fixed
    message. `RESEND_INVITE` is the retry path for an invited-but-not-yet-
    onboarded row: it re-reads the stored email, re-checks manage permission,
    and reports the same three outcomes. Unconfirmed invitations can be sent
    again; a confirmed identity remains `existing-account`. Dummy and
    no-email rows are refused.
- **Invitation confirmation:** the default Supabase invite template lands on
  `/auth/confirm` with `access_token`/`refresh_token` in the URL fragment; an
  optional custom template may send `?token_hash=…&type=invite`. The public
  page captures the values, scrubs the address bar with
  `history.replaceState` before any request, and posts them once to
  `confirmCmsInvite`. The Server Action accepts only those two invite shapes,
  re-validates the tokens, establishes the session (`setSession` or
  `verifyOtp({ type: 'invite' })`), re-reads the user, enforces the allowlist
  with the same helper as OAuth (signing unauthorized identities out), syncs
  the profile, and lets the framework redirect to `/auth/setup`. Any session
  established before a failed or unauthorized check is signed out, so a
  failed onboarding never leaves an authenticated request behind. Tokens and
  raw provider errors are never stored, logged, or rendered.
- **Post-invite setup:** `/auth/setup` is protected and offers passkey
  enrollment through the existing `registerPasskey` API. There is no password
  to set; invitation confirmation already established the allowlisted session
  and future sign-ins are passkey or GitHub OAuth.
- **Passkeys:** managed from Account (sign-in via `window.PublicKeyCredential`
  platform authenticator; enrollment is offered when supported). A returning
  user is offered the remembered identity from the last successful session.
- **User management (admin-level; see the matrix):** list the directory with
  explicit columns, add email/GitHub/dummy users, resend invitations, change
  roles, and remove users through a confirmation modal. Editors only manage
  themselves (`updateMyProfile`); an admin cannot target another admin, a
  superadmin, or a profile without an allowlist binding.
- **"Delete my account"** revokes CMS access: removes the allowlist row and
  the `user_profiles` row, then signs out. It never deletes the Supabase Auth
  identity or historical author attribution. Admin deletion is refused when
  it would leave zero admins; superadmin deletion is always refused by the
  CMS.
- **Dummy authors** (`dummy-<uuid>@dummy.local`) are auth users for post
  attribution and are editor-only. Their Auth identity is deleted only when
  removing them from the `public` schema; staging removal cannot cascade
  production rows.

## Routes

The CMS serves root paths — locale routing was dropped in favor of
client-side language switching:

- `/` — dashboard (redirects to login when unauthenticated)
- `/login` — sign-in (GitHub OAuth + passkey)
- `/auth/github/start`, `/auth/callback` — GitHub OAuth start/callback
- `/auth/confirm` — public invitation landing (fragment or invite token hash)
- `/auth/setup` — protected post-invitation passkey enrollment

Public (unauthenticated) routes are EXACT segments only: `/login`,
`/auth/callback`, `/auth/github/start`, `/auth/confirm`. Every other path,
including `/auth/setup`, requires a session.

Legacy `/{locale}/*` and `/{locale}/cms*` URLs redirect to the equivalent
root paths.

### Auth flows

- **GitHub OAuth** — `/auth/github/start` builds the canonical callback URL
  (`{origin}/auth/callback?next=…`; production origin from `CMS_PUBLIC_URL`,
  development falls back to the request origin) and starts the provider flow.
  `/auth/callback` finalizes the whole flow in one request
  boundary: exchanges the code, enforces the allowlist (email OR GitHub
  username, signing out unauthorized identities), syncs the CMS profile and
  redirects directly to `/` (or a validated same-origin `next`). The GitHub
  username comes from the provider-verified `user.identities` entry
  (`identity_data.user_name` / `preferred_username` / `login`), never editable
  `user_metadata`; a legacy handle row only matches when the session has no
  verified email, and a present-but-unmatched verified email fails closed.
- **Invitation email** — adding an email user authorizes it first, then sends
  the Supabase invite whose `redirectTo` is `${CMS_PUBLIC_URL}/auth/confirm`.
  Confirmation handles the default fragment and the optional invite
  `token_hash`, enforces the allowlist, signs unauthorized users out, and
  redirects to the protected `/auth/setup` passkey enrollment. A user who
  already has an Auth account is never sent a second invite; the CMS reports
  `existing-account` and the user signs in with the existing method.
- **Passkey sign-in** — the login page offers a passkey button when the
  browser reports a platform authenticator; sign-in uses discoverable
  credentials and shows passkey-specific error details. Passkeys can be
  added/removed from the Account section.
- All failure paths land on `/login` with a fixed user-safe message. No
  `/auth/ready` hop, no `/cms` routes internally.

### Server Actions are POST, by design

Every Server Action is a POST request whose JSON body is the action's
argument list; the user-management payload `[{ type: 'GET' }]` is the
directory-read operation, not an HTTP method override. Reads are not exposed
as GET endpoints, and posting an action ID does nothing without the session
and server-side role gate. CSRF/origin checking is the framework's
(Next.js Server Actions; the repo runs the security-patched Next line), and
the removed `x-redirected` header is no longer used. The demo cookie only
lets GET/HEAD load the dashboard shell at `/` without a session — it opens no
data and never executes an action.

The CMS shares its Supabase project with the public site: `auth.users` is
project-level, so a local `dev_staging` invitation creates a real shared Auth
identity and sends real mail. `cms_allowed_users` is per-schema, so the
invitee is authorized only in the schema that was seeded. Do not expect dev
invitations to stay inside `dev_staging` Auth. The middleware resolves the
role through the single `public.cms_lookup_current_user(p_schema text default
'public')` RPC, passing the app's active `NEXT_PUBLIC_SUPABASE_DB_SCHEMA`;
only `public` and `dev_staging` are accepted (missing table or any other value
returns NULL, never a public fallback), and there are no dev copies of the
identity functions. That is what keeps a dev-only invitee signed in instead
of being resolved against production.

## Scripts

```bash
bun run dev       # Development server
bun run build     # Production build
bun run start     # Production server
bun run lint      # Biome lint
bun run test      # Vitest
```

Security floors: Next.js `>=16.4.1` (the repo tracks `16.4.3`, the patched
line that carries the October 2026 RCE/DoS fixes), `sharp >=0.35.5`, and
Biome `2.6.3` for lint/format. Keep `bun.lock` in sync with `bun add`.

## Tests & CI

Unit/integration tests run with Vitest (`bun run test`); suites cover the
cache-tag vocabulary, invalidation descriptors, the mutation result contract,
route matching (including `/auth/confirm` public and `/auth/setup`
protected), file-signature/upload validators, invitation and invite
confirmation flows, CMS role helpers, and PGlite schema suites for the role
CHECK plus last-superadmin trigger.

CI (`.github/workflows/ci.yml`, `main` + PRs) runs install → lint → test →
build → typecheck (`bunx tsc --noEmit`).

## Origin

Extracted from `Okazakee/okazakee-ws` at commit `234b064` (2026-08-17) as part
of the CMS decoupling migration. The original repository remains the
historical source of truth.

## License

MIT