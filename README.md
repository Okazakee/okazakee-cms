# Okazakee CMS

Standalone content management system for [okazakee.dev](https://okazakee.dev) —
a Next.js 16 application that edits the portfolio/blog content stored in
Supabase. The public website lives in a separate repository
([Okazakee/okazakee-ws](https://github.com/Okazakee/okazakee-ws)).

## Features

- **Auth:** email/password + GitHub OAuth, gated by an allowlist
  (`cms_allowed_users` — email OR GitHub username match) with roles
  `admin` / `editor`.
- **Role-based access:** admin = all sections + user management; editor =
  blog/portfolio + account. Every mutation is authorized server-side.
- **Sections:** Hero, Skills, Career, Blog, Portfolio, Contacts, Layout
  (header/footer), Privacy Policy, Users, Account — with EN/IT translations,
  draft/publish state, and live previews.
- **Uploads:** images (client WebP preprocessing, server fallback via Sharp,
  SVG rejected) and PDF resumes, stored in the shared Supabase `website`
  bucket with format-aware extensions/MIME.
- **Upload limit:** 10 MB for images and PDFs, enforced consistently across
  the client (`useFileUpload` `maxSizeMB`), the server validators
  (`MAX_UPLOAD_SIZE_BYTES` in `src/utils/cms/validation.ts`) and the
  framework (`serverActions.bodySizeLimit: '10mb'` in `next.config.ts` —
  without it Next's 1 MB default would reject uploads before the action
  runs). Supabase Storage object limits (default 50 MB) exceed the
  application contract.
- **Cache invalidation:** after a committed content mutation the CMS sends a
  signed HTTP event to the public site's
  `/api/internal/content-revalidate` endpoint (HMAC-SHA256, replay window,
  hard-coded tag allowlist).

## Architecture

```text
CMS (this repo) ──writes──▶ Supabase ◀──reads── Public website (okazakee-ws)
       │                        │
       └── signed content-change event ──▶ POST /api/internal/content-revalidate
```

- **Supabase** owns content, auth, storage and the allowlist.
- **This repo** owns editing, auth flows, uploads, previews and revalidation
  events.
- The **public repo** owns rendering, caching (Next Cache Components) and the
  signed revalidation endpoint. `revalidateTag(tag, 'max')` is used there —
  never `updateTag()` across applications (Server-Action-only).

## Getting started

### Prerequisites

- Bun 1.3+
- A Supabase project shared with the public site

### Install

```bash
bun install
cp .env.local.example .env.local
bun run dev
```

### Environment

See `.env.local.example`. Required:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`)
- `SUPABASE_SECRET_KEY` (`sb_secret_…`) — server-only, never in public code
- `CMS_PUBLIC_URL` — canonical CMS origin (OAuth callbacks, recovery links)

Public-site revalidation (production):

- `WEBSITE_REVALIDATION_URL` — `https://<public>/api/internal/content-revalidate`
- `WEBSITE_REVALIDATION_SECRET` — must equal the public site's
  `CONTENT_REVALIDATION_SECRET`

### Supabase setup

Tables: `user_profiles`, `cms_allowed_users`, `blog_posts`, `portfolio_posts`,
`skills`, `skills_categories`, `career_entries`, `contacts`, `hero_section`,
`i18n_translations`. Storage bucket: `website`. Auth redirect URLs must
include the CMS callback paths (e.g. `https://cms.okazakee.dev/en/auth/callback`).

Apply the migration in `supabase/migrations/` for durable login rate limiting
(`cms_check_login_rate` RPC — 5 attempts/minute, 15-minute lockout, hashed
identifiers).

## Scripts

```bash
bun run dev       # Development server
bun run build     # Production build
bun run start     # Production server
bun run lint      # Biome lint
bun run test      # Vitest
```

## Routes

The CMS serves root paths (no `/cms` prefix):

- `/en`, `/it` — dashboard (redirects to login when unauthenticated)
- `/en/login` — sign-in
- `/en/auth/*` — GitHub OAuth start/callback, auth-ready redirect

Legacy `/{locale}/cms*` URLs 307-redirect to the equivalent root paths.

## Auth and account semantics

- **Login:** allowlist-gated email/password or GitHub OAuth; roles
  `admin` / `editor`. The hidden navigation is never an authorization
  mechanism — every Server Action enforces its role server-side.
- **User management (admin only):** add email users (invite via password
  reset), GitHub users, dummy authors; change roles; remove users. The last
  admin cannot be demoted or removed.
- **"Delete my account"** revokes CMS access: removes the allowlist row and
  the `user_profiles` row, then signs out. It does not delete the Supabase
  Auth identity or historical author attribution.
- **Dummy authors** (`dummy-<uuid>@dummy.local`) are auth users for post
  attribution; removing them also deletes the auth identity.
- **Login rate limiting:** durable Postgres-backed limiter (5/min,
  15-minute lockout).

## Origin

Extracted from `Okazakee/okazakee-ws` at commit `234b064` (2026-08-17) as
part of the CMS decoupling migration. The original repository remains the
historical source of truth; see its `docs/cms-decoupling/` directory for the
migration plan, behavior matrix and cutover checklist.

## License

MIT
