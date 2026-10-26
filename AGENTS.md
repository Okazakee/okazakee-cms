## 1. Overview

Next.js 16 standalone CMS for [okazakee.dev](https://okazakee.dev). TypeScript
throughout, React 19, Supabase for auth/storage/DB, Tailwind CSS 4 for
styling, Zustand (`cmsStore`, `themeStore`) for client state, and next-intl
for EN/IT i18n. Routes are served at the ROOT (`/`, `/login`, `/auth/...`)
with client-side language switching — there is no `/cms` or locale route
prefix. The public website lives in a separate repository
(`Okazakee/okazakee-ws`, public).

> **CMS decoupled (2026-08):** this repo is the standalone content editor.
> The public repo renders content and owns the signed revalidation endpoint.
> The CMS writes content to the shared Supabase project, then sends a signed
> content-change event to the public site's `/api/internal/content-revalidate`
> (HMAC-SHA256, replay window, tag allowlist) so the public cache is purged.
> The public cache-tag vocabulary mirrors `src/libs/content/cacheTags.ts`.

## 2. Repository Structure

```
src/
  app/
    (app)/                        # Protected dashboard (session required)
      page.tsx                    # CMS dashboard shell (section switcher)
      login/                      # /login (public auth route)
      auth/
        github/start/             # /auth/github/start
        callback/                 # /auth/callback
        confirm/                  # /auth/confirm (public invite landing)
        setup/                    # /auth/setup (protected passkey setup)
    actions/
      cms/
        getUser.ts                # Boot data (user + hero section data)
        deleteAccount.ts          # Self-service account deletion
        onboardingActions.ts      # Invite confirmation (fragment/token_hash)
        utils/
          auth.ts                 # Allowlist matching, schema-aware RPC
          fileHelpers.ts          # Auth contexts, image/PDF uploads
          profileSync.ts          # user_profiles sync after login/OAuth
                                  # skills, career, contacts, i18n, users,
                                  # requests (project-request inbox)
  components/
    cms/sections/                 # Editor components per section
    cms/shared/                   # Shared CMS UI (ErrorBanner, FileDropzone,
                                  # Dropdown, ...)
    common/cms/                   # SidePanel, AccountSection
    common/                       # Public-section components reused here
    layout/                       # ThemeToggle, NextImage, ...
  hooks/cms/                      # useFileUpload, useSectionTranslations,
                                  # useRequestEntries (inbox loader + mutations)
  i18n/                           # next-intl config + static CMS messages
  libs/
    content/cacheTags.ts          # Public cache-tag vocabulary (mirrors public repo)
    cms/
      invalidation.ts             # Content entity -> remote tags
      localInvalidation.ts        # Content entity -> local 'use cache' tags
      mutationResult.ts           # Shared action result contract (client-safe)
      onboarding/invite.ts        # Supabase invitation send + outcome
      supabase/admin.ts           # Service-role client (server-only)
    public-site/revalidation.ts   # Signed revalidation event client
  store/
    cmsStore.ts                   # CMS dashboard state (activeSection, user, ...)
    themeStore.ts
  types/                          # Shared domain types (fetchedData.types)
  utils/
    cms/roles.ts                  # CmsRole vocabulary + capability predicates
    cms/validation.ts             # Pure validators (sizes, URLs, storage paths)
    cms/fileSignatures.ts         # Magic-byte/container checks (images, PDF)
    cmsRouteMatching.ts           # Pure route rules (public paths, /cms compat)
    imageProcessor.ts             # Client-side WebP preprocessing
    supabase/middleware.ts        # Session + schema-aware allowlist gate
    supabase/server.ts            # SSR session client (publishable key)
  proxy.ts                        # Proxy (middleware): compat redirects, session
```

> **Repo-wide:** New modules go in `src/` under the directory matching their
> role (components, actions, hooks, utils, store, types, libs). Nothing
> outside `src/` except config files and `supabase/migrations/`.

## 3. Auth

- Allowlist-gated: `cms_allowed_users` (email OR GitHub username) with roles
  `editor` / `admin` / `superadmin`. `src/utils/cms/roles.ts` is the single
  client-safe vocabulary (`isCmsRole`, `isCmsAdminRole`, `canManageCmsRole`,
  `canAssignCmsRole`); server code imports it and also enforces the DB
  reality. The hidden navigation is never an authorization mechanism — every
  Server Action enforces its role server-side via `getCmsActionContext` /
  `requireAuth` / `requireAdmin` / `requireAllowedPostWriter`.
- Capability policy: all three roles share editorial collaboration (read,
  create, update, delete, upload and publish every blog/portfolio post, and
  choose any existing profile as author). `admin` and `superadmin` add global
  content, the private request inbox and user management; `superadmin` also
  manages admin targets. No CMS action grants, changes, or removes
  `superadmin` — bootstrap is one-off SQL by the owner. Admin cannot touch an
  admin peer or a superadmin, dummy authors are editor-only, and profile
  mutation requires an allowlist binding. The full matrix lives in
  README §Roles and permissions.
- Public (unauthenticated) routes are EXACT segments only:
  `/login`, `/auth/callback`, `/auth/github/start`, `/auth/confirm` (see
  `src/utils/cmsRouteMatching.ts`). `/auth/setup` is deliberately protected.
  Everything else requires a session.
- Sign-in is GitHub OAuth + WebAuthn passkey only; there is no password
  credential, password form or login limiter. GitHub OAuth:
  `/auth/github/start` → Supabase → `/auth/callback`, which finalizes the flow
  in one request boundary (code exchange, allowlist enforcement with sign-out
  on unauthorized identities, profile sync, canonical `/` redirect) — no
  `/auth/ready` hop and no legacy `/cms` path used internally.
- Email onboarding: `ADD_EMAIL` inserts the allowlist row first, then asks
  Supabase Auth to invite the address. `sendCmsInvitation` reports
  `sent` / `existing-account` / `failed`; the row commit is the action's
  success and `invited_at` is stamped only on `sent`. `sent` means GoTrue
  accepted the send, not that mail arrived — custom SMTP is the deployment
  prerequisite. Existing identities (confirmed or not) are never mailed a
  duplicate invite and failures leave the row for an explicit `RESEND_INVITE`.
  `/auth/confirm` is public and accepts either the default invite fragment
  (`access_token`/`refresh_token`) or `?token_hash=…&type=invite`; the page
  scrubs the URL before the Server Action re-validates, enforces the allowlist,
  signs unauthorized users out (including any session established before a
  failed check) and redirects to the protected `/auth/setup`, which only
  offers passkey enrollment.
- Server Actions are POST by design: the request body is the action's
  argument list, so `[{ type: 'GET' }]` is the user-directory read operation,
  not an HTTP method override. Never add ad-hoc POST blocking or a
  method-override shim; security is the authenticated action plus its
  server-side role gate (with the framework's Server Action origin/CSRF
  checking). The demo cookie only admits GET/HEAD `/` for the shell and opens
  no data or actions; the removed `x-redirected` header is not coming back.
- Supabase Auth is project-global and shared with the public site: a dev
  `dev_staging` invite creates a real `auth.users` identity and can send real
  mail. `cms_allowed_users` is per-schema. The middleware resolves the role
  through the single `public.cms_lookup_current_user(p_schema text default
  'public')` RPC, passing `supabaseSchema`; the whitelist is exactly `public`
  and `dev_staging` (missing table or any other value returns NULL, never a
  public fallback), and there are no dev copies of the identity functions.
  The legacy no-arg call still resolves through the default during rollout.

## 4. Mutations, storage ordering and revalidation

- Every mutation returns the shared contract from
  `src/libs/cms/mutationResult.ts`: `success` describes the DATABASE write
  only; `revalidation` (`'sent' | 'skipped' | 'failed'`) carries the outcome
  of propagating the change to the public cache. The UI surfaces a
  non-blocking warning when propagation failed.
- Storage ordering invariants (MUST keep):
  - Replacement: validate → upload (upsert) → commit DB row → remove old
    object best-effort AFTER commit. Never delete the old object before the
    DB write commits (a failed write would leave a broken reference).
  - Delete: commit the DB row delete FIRST, then remove the Storage object
    best-effort (`removePublicFileIfPresent` / `removeStorageObjectBestEffort`
    never throw).
  - Bytes before storage: `prepareImageUpload` and `uploadPdfBuffer` are the
    shared chokepoints every image/PDF path uses. They validate magic bytes,
    declared-MIME agreement and container completeness (`fileSignatures.ts`)
    before any Storage write, so a rejected or spoofed file writes nothing.
    Raster formats are JPEG/PNG/WebP/GIF/AVIF only; SVG/HTML text is rejected
    even under an image MIME. WebP must be a complete RIFF container AND
    genuinely decode: static passthrough keeps the bytes only after a real
    decode, and an animation's fits-bounds passthrough decodes every frame.
    PDFs need the `%PDF-` header in the first 1 KiB plus `%%EOF`. Uploaded
    filenames never choose the stored key, extension, or content type, so
    multi-dot names cannot change how an object is served. These checks prove
    format/decode/completeness, not safety: the CMS is not a malware/content
    scanner and PDFs are served as inert documents.
- Image uploads keep animations: the browser canvas preprocessor
  (`src/utils/imageProcessor.ts`) returns an animated WebP untouched — a
  canvas round-trip keeps only the first frame — and the server pipeline
  (`processImage` in `src/app/actions/cms/utils/fileHelpers.ts`) resizes it
  frame-by-frame when it exceeds the requested bounds. Static WebP stays
  passthrough (never re-encoded). Detection lives in
  `src/utils/cms/webpAnimation.ts` and must be used by any new upload path.
  Animated frames are decoded into one tall surface, so an animation above
  32 MPx total is rejected before decoding.
- The CMS's own cache invalidation runs from Server Actions via
  `updateTag(tag)` + `refresh()` (`src/libs/cms/localInvalidation.ts`); remote
  invalidation goes through `invalidatePublicContent` (signed event, never
  throws, status returned).

- CMS ownership: Hero name, ordered localized roles, about paragraph and
  portrait shape; ordered Skills categories/entries; Career/Portfolio/Blog
  entries; ordered Contacts with SVG URLs; privacy-policy bodies. Structural
  headings/vocabulary and the privacy subtitle are website-local i18n.
- System → Resume owns EN/IT PDFs and invalidates
  `resume` / `hero_section` after publication. Layout owns the two optional
  theme header images (`site_settings.header_logo_dark` / `header_logo_light`,
  aspect-preserving uploads that fall back to that theme's bundled site image
  when null) plus the textual VAT. No animation-target or footer-name editor
  remains.
- Individual Publish and Publish All require confirmation; registered callbacks
  remain raw so Publish All confirms once. User removal confirms identity,
  commits profile deletion before owned-avatar cleanup, and never deletes
  shared Auth identities from non-public schemas — non-dummy shared identities
  are never deleted from the CMS at all (the allowlist row is the authority).

## 5. Commands and Workflows

- Install: `bun install`
- Dev server: `bun run dev` (pinned to port 3001; the public site owns 3000)
- Build: `bun run build`
- Start production: `bun run start`
- Lint: `bun run lint` (runs `biome lint .`)
- Lint + auto-fix: `bun run lint-fix` (runs `biome check . --write --unsafe`)
- Format: `bun run format` (runs `biome format . --write`)
- Test: `bun run test` (runs `vitest run`)
- Type check: `bunx tsc --noEmit`

CI (`.github/workflows/ci.yml`, `main` + PRs) runs install → lint → test →
build → typecheck (build before typecheck: fresh checkouts need `.next/types`).

## 6. Code Formatting

> **Repo-wide:** Biome 2.6.3 is the formatter and linter. Config lives at
> `biome.json`. The editorconfig at `.editorconfig` mirrors
> indent/line-ending settings.

### TypeScript / TSX

```typescript
// biome.json excerpt
//   indentStyle: "space", indentWidth: 2, lineWidth: 80
//   quoteStyle: "single", trailingCommas: "es5"
```

- **Indentation:** 2 spaces. Never tabs.
- **Line length:** 80 characters (Biome configured limit). Actual p95 is 86 chars.
- **Quote style:** Single quotes for strings. Double quotes only when the string contains a single quote.
- **Semicolons:** Always present at end of statements.
- **Trailing commas:** ES5-style (multi-line objects, arrays, function params).
- **Brace placement:** Same-line (K&R) for all constructs.
- **Blank lines between top-level definitions:** 1 blank line.
- **Blank lines between methods/functions:** 1 blank line (rarely observed).
- **Blank lines after imports:** 1 blank line before first definition.
- **Trailing newline:** Always present at EOF.
- **Trailing whitespace:** Never present (Biome strips it).
- **Spacing — operators:** `x = 1` (single space around `=`, `+`, `-`, etc.).
- **Spacing — inside brackets:** `f(x)` not `f( x )`. `{ key: value }` not `{key:value}`.
- **Spacing — after commas:** `a, b` (single space after comma).
- **Spacing — colons in types:** `key: Type` (space after colon, no space before).
- **Import block formatting:** One import per line (default Biome behavior with `organizeImports: "on"`).
- **Line continuation:** Implicit via open bracket/parenthesis (no backslash).

Real snippet demonstrating the composite style:

```typescript
import { create } from 'zustand';
import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  description?: string;
  meta?: string;
  actions?: ReactNode;
}

export function SectionHeader({
  title,
  description,
  meta,
  actions,
}: SectionHeaderProps) {
  return (
    <div className="mb-6">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  );
}
```

## 7. Naming Conventions

### TypeScript

- **Variables:** camelCase. `const rateLimit = ...`
- **Functions:** camelCase. Prefer `get`/`handle`/`use` prefixes where semantically appropriate. `getUser()`, `handleSubmit()`, `useDraft()`
- **React components:** PascalCase, named exports. `export function BlogSection(...)`
- **Component props interfaces:** `{ComponentName}Props`. `SectionHeaderProps`, `ErrorBannerProps`
- **Types and interfaces:** PascalCase. `CMSUser`, `CMSBootData`, `ThemeState`
- **Type aliases for discriminated unions:** `{Entity}Result` for operation results. `ContactsResult`, `I18nResult` (all extend `MutationResult`)
- **Data types:** `{Entity}Data` suffix. `CMSHeroBootData`, `CreateContactData`
- **Zustand stores:** `use{Name}Store`. `useCmsStore`, `useThemeStore`
- **Server action files:** camelCase with domain prefix. `getUser.ts`, `onboardingActions.ts`
- **Section action files:** `{section}Actions.ts`. `blogActions.ts`, `careerActions.ts`
- **Component files:** PascalCase matching component name. `SectionHeader.tsx`, `TranslationField.tsx`
- **Hook files:** `use{HookName}.ts`. `useFileUpload.ts`, `useSectionTranslations.ts`
- **Utility files:** camelCase. `blurhashUtils.ts`, `imageProcessor.ts`
- **Constants at module level:** camelCase (not SCREAMING_SNAKE_CASE). `const revalTime = ...`

## 8. Type Annotations

- **Strict mode:** `tsconfig.json` has `"strict": true`. No `any` permitted.
- **Type imports:** Use `import type { Foo } from '...'` for type-only imports. Runtime imports use regular `import { create } from 'zustand'`.
- **Nullable:** Use `X | null` (not `X | undefined` for missing values).
- **Optional properties:** Use `key?: Type` in interfaces.
- **Union types:** `'editor' | 'admin' | 'superadmin'` (the canonical `CmsRole`), `RemoteType = 'full' | 'hybrid' | 'onSite'`
- **Export inline types:** Types are defined in the same file where they are primary consumers, not in a separate `.d.ts` unless shared across modules.
- **Return types:** Explicit return types on public API functions. `export async function getUser(): Promise<CMSUser | null>`. Internal helper functions may omit return types.
- **Type assertion with `as`:** Used sparingly for Supabase query results.

```typescript
export const CMS_ROLES = ['editor', 'admin', 'superadmin'] as const;

export type CmsRole = (typeof CMS_ROLES)[number];

export function canManageCmsRole(actor: CmsRole, target: CmsRole): boolean {
  if (target === 'superadmin') return false;
  if (actor === 'superadmin') return true;
  return actor === 'admin' && target === 'editor';
}
```

## 9. Imports

- **Ordering:** third-party packages first, then `@/` aliased local imports. Biome's `organizeImports` handles exact ordering.
- **Side-effect imports** (like `import '../globals.css'`) go at the top.
- **Path aliases** defined in `tsconfig.json`:

| Alias | Maps to |
|---|---|
| `@/*` | `./src/*` |
| `@components/*` | `./src/components/*` |
| `@store/*` | `./src/store/*` |
| `@utils/*` | `./src/utils/*` |
| `@types/*` | `./src/types/*` |
| `@libs/*` | `./src/libs/*` |
| `@app/*` | `./src/app/*` |
| `@layout/*` | `./src/components/layout/*` |

- **Supabase clients:** Session client (Server Actions / middleware):
  `import { createClient } from '@/utils/supabase/server'` (publishable key,
  cookie-based). Elevated client (service role, bypasses RLS, server-only):
  `import { getCmsAdminClient } from '@/libs/cms/supabase/admin'` — callers
  MUST authorize the current user first (`getCmsActionContext` /
  `requireAdmin` / `requireAllowedPostWriter`).
- **Never use relative imports** for anything outside the immediate sibling directory. Always use `@/` aliases.

```typescript
// Canonical import block
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { blogActions } from '@/app/actions/cms/sections/blogActions';
import { SectionHeader } from '@/components/cms/shared/SectionHeader';
import { revalidationWarning } from '@/libs/cms/mutationResult';
import { useCmsStore } from '@/store/cmsStore';
```

## 10. Error Handling

- **Server actions** use try/catch with `console.error` and return the shared
  `MutationResult` shape (`{ success: false, error }`). A committed DB write
  is NEVER reported as failed because cross-app revalidation failed — the
  outcome goes in the `revalidation` field.
- **Client components** catch errors from server action calls and display via
  UI state (often `ErrorBanner` component); `revalidationWarning(result)`
  surfaces non-blocking cache-propagation failures.
- **Supabase `PGRST116`** (zero rows from `.single()`) is handled as a non-error: return `null`.
- **Bare `catch`** (without error variable) is used when the error is intentionally ignored (e.g., Supabase `setAll` in server component cookie handler).
- **Storage cleanup after a committed write** is best-effort and never throws
  (`removeStorageObjectBestEffort`).
- **No global error boundary** is configured. Each route handles its own error state.

## 11. Comments and Docstrings

- **Docstrings:** Not used systematically. Module-level docstrings exist on
  the validator, invitation, revalidation and invalidation libs to explain
  contracts.
- **Inline comments:** `//` style, used sparingly to explain intent or
  document edge cases, not what the code does. Storage-ordering comments
  document the upload/delete invariants.
- **No module-level docstrings** in components/actions (keep to the libs).
- **No commented-out code.** Biome linter likely prevents dead code.
- **Supabase/RPC comments:** Keep inline comments when the API behavior is non-obvious.

```typescript
// No pre-upload deletion: the new image is uploaded with `upsert` to the
// same pathBase (replacing any same-format variant), and a previous
// other-format variant is removed AFTER the DB commit.
```

## 12. Testing

Vitest is configured (`vitest.config.ts`, node environment). Tests live next
to sources as `*.test.ts`. Run with `bun run test` (`vitest run`). Existing
suites: cache-tag vocabulary, invalidation descriptors, local invalidation,
mutation result contract, revalidation signature, auth helpers
(schema-aware allowlist RPC + role vocabulary), route matching,
CMS validators (sizes/URLs/storage paths), file-signature/WebP-container
checks, invitation sending and invite-confirmation flows, and PGlite (WASM
Postgres) suites that execute migration DDL — role CHECK, last-superadmin
guard trigger, grants — against a real database. CI runs lint, test, build,
then typecheck (build first: fresh checkouts need `.next/types`).

## 13. Git

### 13.1 Branch and PR workflow (mandatory)

`main` is the integration branch and must stay releasable. Every change —
feature, fix, refactor, docs, dependency bump — is made on a dedicated branch
and merged through a pull request.

**Two owner gates.** Nothing opens or merges on the agent's own initiative:
the PR is opened only after the owner confirms the branch is complete, and
the merge follows review. Pushing a branch is not permission to open a PR,
and being asked to make a change is not permission to open one either.

1. Branch from the latest `main`: `<type>/<short-slug>`, e.g.
   `fix/animated-webp-upload`, `feat/passkey-signin`.
2. Commit only on that branch. `main` never receives direct commits.
3. Push the branch when the work is ready — and stop there.
4. Open the PR against `main` with `gh pr create` only after the owner
   confirms the branch is done. The body describes the change, the affected
   contract, and the checks run.
5. CI (`.github/workflows/ci.yml`) must be green before merge.
6. Merge with a merge commit (`gh pr merge --merge`); never squash or rebase,
   never force-push `main`.
7. Delete the merged branch.

**Exception — you ask for it.** A direct commit/push to `main` is allowed
only when you explicitly ask for one in the session (for example "push this
to main"). That request is the authorization; the agent never decides on its
own that a direct push is warranted. When it happens:

- keep the diff to the minimum that resolves the issue, with a commit
  message that states why it went straight to the branch;
- no force-push, history rewrite, or unrelated cleanup in the same commit;
- open a follow-up PR (or review) if the result is not trivially verifiable.

Without that explicit request, work goes through a branch and a PR, however
urgent it feels.

### 13.2 Commit and merge conventions

- **Commit prefixes:** Conventional commits are used alongside unprefixed messages. Observed prefixes: `fix:`, `feat:`, `refactor:`, `chore:`, `revert:`, `security:`, `docs:`.
- **Scoped commits:** Rare. Scopes are lowercase: `auth`, `images`, `cms`.
- **Subject length:** p50 is 23 chars, p95 is 72 chars. Keep subjects concise.
- **Body:** Only 13% of commits have a body. No strict convention.
- **Branch naming:** `<type>/<short-slug>` (lowercase), see §13.1.
- **Merge strategy:** Merge commits (not squash or rebase), always via PR.
- **No GPG signing.**

## 14. Dependencies and Tooling

- **Package manager:** bun (`packageManager` in `package.json`). Always use `bun` not `npm`/`yarn`/`pnpm`.
- **Lockfile:** `bun.lock` — committed to the repo.
- **Add dependency:** `bun add <package>` (prod) or `bun add -d <package>` (dev).
- **Linter/Formatter:** Biome 2.6.3. Config: `biome.json`.
- **Type checker:** `tsc` with `strict: true`. Config: `tsconfig.json`.
- **CSS:** Tailwind CSS 4 with `@tailwindcss/postcss`. Config: `postcss.config.mjs`, `tailwind.config.ts`.
- **Runtime:** Next.js 16.4.3 with Turbopack dev server (`>=16.4.1` is the
  security floor: the patched line carrying the October 2026 RCE/DoS fixes),
  React 19.3.1, `sharp >=0.35.5`. Config: `next.config.ts`.
  `serverActions.bodySizeLimit` is `'10mb'` — the upload contract (10 MB max
  for images and PDFs) is enforced client-side (`useFileUpload maxSizeMB`),
  server-side (`MAX_UPLOAD_SIZE_BYTES` in `src/utils/cms/validation.ts`) and
  at the framework layer. `happy-dom 21.0.4` backs the DOM test environment.
- **Environment variables:** Required: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`),
  `SUPABASE_SECRET_KEY` (`sb_secret_…`, server-only, never in public code).
  `CMS_PUBLIC_URL` is required in production and for invitations; the rest are
  optional: `CMS_AUTH_DEBUG`, `APP_ENV`,
  `WEBSITE_REVALIDATION_URL`, `WEBSITE_REVALIDATION_SECRET`,
  `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_LOCALES`, `NEXT_PUBLIC_DEFAULT_LOCALE`.
  Full list in `.env.local.example`.
- **Local values live in the Vercel project's Development environment**, pulled
  with `vercel env pull` (it merges: keys the target defines are overwritten,
  local-only keys are kept). `.env.development.local` — loaded before
  `.env.local`, ignored by `next build`/`next start` — is the guard against
  pulling another environment: `--environment=production` overwrites
  `WEBSITE_REVALIDATION_URL` with the deployed origin and drops
  `NEXT_PUBLIC_SUPABASE_DB_SCHEMA`, after which `src/config/shared.ts` falls back
  to `public` and every local edit writes production content. With the deployed
  revalidation origin, a local edit purges production's cache while the local
  public site keeps serving the pre-edit render — the symptom is a CMS value
  that appears not to be used at all.
- **Database verification:** read-only `bun run db:dev:check [--scope dev_staging]`
  (`src/utils/cms/devMigrations.ts`;
  `src/libs/cms/devMigrations/devCheck.ts`; registry
  `src/libs/cms/devMigrations/registry.json`, 20 `{version,name,sourceFile}`
  entries) plus content tables and the dev-only `dev_staging.cms_migration_audit`
  ledger, which must hold one source-hash record per registry entry
  (`verified_existing` = schema effects + hash audited, `applied` = executed
  under review). Source hashes certify immutable bytes; live effect checks
  include service-role sequence usage and the dev RBAC mirror (role CHECK,
  guard trigger, no allowlist client grants). The public role CHECK, public
  function bodies and auth-side effects are not certified.
  Native Supabase history is mixed-scope, not proof of content state.
  Historical public/unqualified sources must never be replayed against
  shared `public`. Link once (`supabase login`, `supabase link --project-ref
  <ref>`); green ends `dev check: N pass / 0 fail / M info`. `--scope` must
  equal `dev_staging`; the CLI exposes only a read-only `check` command.
  Future changes remain explicitly reviewed/manual: never `supabase db push`,
  `migration repair`, or search-path fallback apply.
- **Role-hierarchy migration:** `20261026125511_cms_superadmin_role.sql`
  touches `public` too (role CHECK, schema-aware
  `cms_lookup_current_user(p_schema)`, `is_admin_user`, last-superadmin
  trigger) and mirrors only the CHECK + trigger in `dev_staging`. Apply it
  manually FIRST, then deploy the matching code, then bootstrap exactly one
  named identity by SQL `id` subselect — never `where role='admin'`, which
  would promote every admin. The trigger's advisory transaction lock keeps
  two concurrent demotions from both passing. No migration promotes anyone.
- **Deployment:** Vercel with Next.js framework preset. Build output: `.next/`.

## 15. Red Lines

- **Never use double quotes for string literals** in `.ts`/`.tsx` files. Use single quotes. Biome enforces this.
- **Never use tabs for indentation.** Use 2 spaces.
- **Never use `any`.** TypeScript strict mode is enabled. If you need escape-hatch typing, use `unknown` and narrow.
- **Never use relative imports across directory boundaries.** Use `@/` path aliases defined in `tsconfig.json`.
- **Never call Supabase directly from client components (browser).** Use server actions (`'use server'`) to proxy all Supabase calls.
- **Never commit `.env.local`** or any file containing secrets.
- **Branch selection:** if the user's initial request explicitly names a
  branch, use it subject to normal safety checks. If it does not say whether
  to work on the production branch or another branch, ASK which branch before
  modifying files, committing, or switching branches. Never silently default
  to `staging`, `main`, or a feature branch; do not ask again once the user
  has specified. (§13.1)
- **Never commit or push directly to `main`.** Work on a branch and open a PR — the only exception is a direct push you explicitly asked for in the session (§13.1).
- **Never open a PR, or merge one, without the owner's go-ahead.** A pushed branch is not a PR request; wait for confirmation (§13.1).
- **Never add a `'use server'` directive inside a file that also has `'use client'`.** These directives are mutually exclusive at the file level.
- **Never import server-only modules (like `next/headers`, `next/cache`) into client components.** Keep server and client code separated. Client-safe contracts live in `src/libs/cms/mutationResult.ts`, `src/utils/cms/roles.ts`, `src/utils/cms/fileSignatures.ts` and route/validation utils.
- **Never use `console.log` in production paths.** Use `console.error` for server-side error logging (invitation/revalidation failures are logged with event/identifier context).
- **Never define React component state inline in the JSX render path.** Use Zustand stores for shared state, `useState`/`useReducer` for local state.
- **Never add a dependency with npm/yarn/pnpm** — always use `bun add`.
- **Never export a component as default** unless it is a Next.js page or layout file. Use named exports.
- **Never delete a Storage object before its DB write has committed** (see §4). Storage cleanup after a commit is best-effort and never throws.
- **Never write an upload to Storage before byte-signature/container validation.**
  `prepareImageUpload` and `uploadPdfBuffer` are the shared chokepoints; do not
  add an image/PDF path that bypasses them. The checks prove format and
  completeness only — never describe them as malware or content scanning.
- **Never add a password credential, password login or password limiter.**
  Invitation confirmation ends at passkey enrollment; existing users sign in
  with GitHub OAuth or a passkey.
- **Never grant, change, or remove `superadmin` from application code or a
  migration.** It is provisioned only by the owner's one-off SQL bootstrap of
  a single named row; there is no auto-promotion, and the last-superadmin
  trigger is the atomic backstop.
- **Never derive production auth or invitation origins from a forwarded host
  header.** Production OAuth callbacks and all invite redirects use
  `CMS_PUBLIC_URL` (the invitation helper validates it as a bare http(s)
  origin); development OAuth is the only request-origin fallback.
- **Account deletion owns its navigation in the Server Action** — `deleteMyAccount`
  redirects to the canonical `/login` after the commit, and the client treats
  the `NEXT_REDIRECT` rejection as control flow (`deleteAccount.test.ts`).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
