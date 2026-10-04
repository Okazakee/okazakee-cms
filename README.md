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

This repository is **write-side only**. It owns editing, auth flows, uploads,
previews and revalidation events; the public website
([Okazakee/okazakee-ws](https://github.com/Okazakee/okazakee-ws)) owns
rendering and caching.

## Highlights

- **Auth** — GitHub OAuth + WebAuthn passkey sign-in (discoverable
  passkeys), gated by an allowlist (`cms_allowed_users`: email OR GitHub
  username) with roles `admin` / `editor`. Email/password login was removed.
- **Role-based access** — admin: all sections + user management; editor:
  blog/portfolio + account. Every mutation is authorized server-side; the UI
  never is the security boundary
- **Sections** — Hero, Skills, Career, Blog, Portfolio, Contacts, Request
  Form copy, Requests, Layout (header/footer), Website Copy, Privacy Policy,
  Users, Account — each with EN/IT translations, draft/publish state, and live
  previews. *Requests* is read-only and has no intake path yet: the public
  form does not submit, so the section renders an explicit "not connected"
  notice until one does. *Request Form copy* is not published to the site
  either — the public form owns those strings until it moves to CMS
  translations.
- **Uploads** — images (client-side WebP preprocessing, server fallback via
  Sharp, SVG rejected) and PDF resumes, stored in the shared `website`
  bucket with format-aware extensions/MIME. Animated WebP skips the
  canvas step and is resized frame-by-frame by Sharp, so animated profile
  pictures keep every frame. BlurHash placeholders are generated with
  [blurkit](https://github.com/Okazakee/blurkit): Sharp handles server-side
  resize/format, Blurkit the placeholder hash (`blurkit/node` on upload,
  `blurkit/browser` client-side)
- **Consistent limits** — 10 MB for images and PDFs, enforced at every layer:
  client (`useFileUpload` `maxSizeMB`), server validators
  (`MAX_UPLOAD_SIZE_BYTES` in `src/utils/cms/validation.ts`) and the
  framework (`serverActions.bodySizeLimit: '10mb'` in `next.config.ts` —
  without it Next's 1 MB default would reject uploads before the action runs)
- **Cache invalidation** — after a committed mutation the CMS sends a signed
  HTTP event to the public site's `/api/internal/content-revalidate`
  (HMAC-SHA256, replay window, hard-coded tag allowlist)

## Architecture

```text
CMS (this repo) ──writes──▶ Supabase ◀──reads── Public website (okazakee-ws)
       │                        │
       └── signed content-change event ──▶ POST /api/internal/content-revalidate
```

- **Supabase** owns content, auth, storage and the allowlist.
- **This repo** owns editing, auth flows, uploads, previews and revalidation
  events.
- **The public repo** owns rendering and caching (Next Cache Components).
  Revalidation uses `revalidateTag(tag, 'max')` there — never `updateTag()`
  across applications (Server-Action-only).

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
| `CMS_PUBLIC_URL` | Canonical CMS origin (OAuth callbacks, recovery links) |
| `NEXT_PUBLIC_SITE_URL` | Public site origin (asset/link generation) |
| `NEXT_PUBLIC_LOCALES` / `NEXT_PUBLIC_DEFAULT_LOCALE` | Locale list / default (e.g. `en,it` / `en`) |

Public-site revalidation (production):

| Variable | Purpose |
| --- | --- |
| `WEBSITE_REVALIDATION_URL` | `https://<public>/api/internal/content-revalidate` |
| `WEBSITE_REVALIDATION_SECRET` | Must equal the public site's `CONTENT_REVALIDATION_SECRET` |

### Supabase Setup

**Tables:** `user_profiles`, `cms_allowed_users`, `blog_posts`,
`portfolio_posts`, `skills`, `skills_categories`, `career_entries`,
`contacts`, `hero_section`, `i18n_translations`. **Storage bucket:** `website`.

**Auth redirect URLs** (Supabase Auth → URL Configuration) must include
exactly these canonical paths — the CMS serves root paths, no `/cms` or
locale prefixes:

- `https://cms.okazakee.dev/auth/callback`
- local dev: `http://localhost:3000/auth/callback`

Legacy monolith-era entries such as
`https://cms.okazakee.dev/en/auth/callback` (or `/it/…`, `/cms/…`) are no
longer generated by any flow and can be removed.

## Auth & Account Semantics

- **Login:** allowlist-gated **GitHub OAuth** or **WebAuthn passkey**
  (discoverable passkeys required); roles `admin` / `editor`. The hidden
  navigation is never an authorization mechanism — every Server Action
  enforces its role server-side.
- **Passkeys:** managed from the Account section (sign-in via
  `window.PublicKeyCredential` platform authenticator; passkeys are
  attachable when supported). A returning user is offered the remembered
  identity from the last successful session.
- **User management (admin only):** add passkey-provisioned users (email
  identifier — no invite email is sent), GitHub OAuth users and dummy
  authors; change roles; remove users. The last admin cannot be demoted or
  removed.
- **"Delete my account"** revokes CMS access: removes the allowlist row and
  the `user_profiles` row, then signs out. It does not delete the Supabase
  Auth identity or historical author attribution.
- **Dummy authors** (`dummy-<uuid>@dummy.local`) are auth users for post
  attribution; removing them also deletes the auth identity.

## Routes

The CMS serves root paths — locale routing was dropped in favor of
client-side language switching:

- `/` — dashboard (redirects to login when unauthenticated)
- `/login` — sign-in (GitHub OAuth + passkey)
- `/auth/github/start`, `/auth/callback` — GitHub OAuth start/callback

Legacy `/{locale}/*` and `/{locale}/cms*` URLs redirect to the equivalent
root paths.

### Auth flows

- **GitHub OAuth** — `/auth/github/start` builds the canonical callback URL
  (`{origin}/auth/callback?next=…`, origin from `CMS_PUBLIC_URL`) and starts
  the provider flow. `/auth/callback` finalizes the whole flow in one request
  boundary: exchanges the code, enforces the allowlist (email OR GitHub
  username, signing out unauthorized identities), syncs the CMS profile and
  redirects directly to `/` (or a validated same-origin `next`). The GitHub
  username is read from Supabase `user_metadata.user_name`
  (`getUserGithubUsername`).
- **Passkey sign-in** — the login page offers a passkey button when the
  browser reports a platform authenticator; sign-in uses discoverable
  credentials and shows passkey-specific error details. Passkeys can be
  added/removed from the Account section.
- All failure paths land on `/login` with a fixed user-safe message. No
  `/auth/ready` hop, no `/cms` routes internally.

## Scripts

```bash
bun run dev       # Development server
bun run build     # Production build
bun run start     # Production server
bun run lint      # Biome lint
bun run test      # Vitest
```

## Tests & CI

Unit/integration tests run with Vitest (`bun run test`); suites cover the
cache-tag vocabulary, invalidation descriptors, the mutation result contract,
route matching, validators and auth helpers.

CI (`.github/workflows/ci.yml`, `main` + PRs) runs install → lint → test →
build → typecheck (`bunx tsc --noEmit`).

## Origin

Extracted from `Okazakee/okazakee-ws` at commit `234b064` (2026-08-17) as part
of the CMS decoupling migration. The original repository remains the
historical source of truth.

## License

MIT