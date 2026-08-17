## 1. Overview

Next.js 16 standalone CMS for [okazakee.dev](https://okazakee.dev). TypeScript
throughout, React 19, Supabase for auth/storage/DB, Tailwind CSS 4 for
styling, Zustand (`cmsStore`, `themeStore`) for client state, and next-intl
for EN/IT i18n. The app router routes all pages under `/[locale]/...` and the
CMS serves ROOT paths — there is no `/cms` route prefix. The public website
lives in a separate repository (`Okazakee/okazakee-ws`, public).

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
    [locale]/
      (app)/                      # Protected dashboard (session required)
        page.tsx                  # CMS dashboard shell (section switcher)
        login/                    # /{locale}/login (public auth route)
        auth/
          github/start/           # /{locale}/auth/github/start
          callback/               # /{locale}/auth/callback
          ready/                  # /{locale}/auth/ready
    actions/
      cms/
        login.ts                  # Email/password login + durable rate limit
        getUser.ts                # Boot data (user + hero preview data)
        deleteAccount.ts          # Self-service account deletion
        utils/
          auth.ts                 # Allowlist matching, GitHub helpers
          fileHelpers.ts          # Auth contexts, image processing, uploads
          profileSync.ts          # user_profiles sync after login/OAuth
        sections/                 # Section actions: blog, portfolio, hero,
                                  # skills, career, contacts, i18n, users
  components/
    cms/sections/                 # Editor components per section
    cms/shared/                   # Shared CMS UI (ErrorBanner, FileDropzone, ...)
    common/cms/                   # PreviewModal, SidePanel, AccountSection, previews
    common/                       # Public-section components reused for previews
    layout/                       # ThemeToggle, MarkdownRenderer, ...
  hooks/cms/                      # useFileUpload, useSectionTranslations, ...
  i18n/                           # next-intl config + static CMS messages
  libs/
    content/cacheTags.ts          # Public cache-tag vocabulary (mirrors public repo)
    cms/
      invalidation.ts             # Content entity -> remote tags
      localInvalidation.ts        # Content entity -> local 'use cache' tags
      mutationResult.ts           # Shared action result contract (client-safe)
      loginRateLimit.ts           # Durable per-IP/per-email limiter client
      supabase/admin.ts           # Service-role client (server-only)
    public-site/revalidation.ts   # Signed revalidation event client
  store/
    cmsStore.ts                   # CMS dashboard state (activeSection, user, ...)
    themeStore.ts
  types/                          # Shared domain types (fetchedData.types)
  utils/
    cms/validation.ts             # Pure validators (sizes, URLs, storage paths)
    cmsRouteMatching.ts           # Pure route rules (public paths, /cms compat)
    getData.ts                    # CMS-local 'use cache' reads (translations)
    imageProcessor.ts             # Client-side WebP preprocessing
    supabase/server.ts            # SSR session client (publishable key)
  proxy.ts                        # Proxy (middleware): locale + session guard
```

> **Repo-wide:** New modules go in `src/` under the directory matching their
> role (components, actions, hooks, utils, store, types, libs). Nothing
> outside `src/` except config files and `supabase/migrations/`.

## 3. Auth

- Allowlist-gated: `cms_allowed_users` (email OR GitHub username) with roles
  `admin` / `editor`. The hidden navigation is never an authorization
  mechanism — every Server Action enforces its role server-side via
  `getCmsActionContext` / `requireAuth` / `requireAdmin` /
  `requireAllowedPostWriter`.
- Public (unauthenticated) routes are EXACT segments only:
  `/login`, `/auth/callback`, `/auth/github/start`, `/auth/ready` (see
  `src/utils/cmsRouteMatching.ts`). Everything else requires a session.
- Email/password + GitHub OAuth. The OAuth/redirect flows are scheduled for a
  dedicated review session — do not redesign them opportunistically.

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
- Local CMS `'use cache'` entries (e.g. `getTranslationsSupabase`) are
  invalidated from Server Actions with `updateTag(tag)` + `refresh()`
  (`src/libs/cms/localInvalidation.ts`); remote invalidation goes through
  `invalidatePublicContent` (signed event, never throws, status returned).

## 5. Commands and Workflows

- Install: `bun install`
- Dev server: `bun run dev`
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

> **Repo-wide:** Biome 2.4 is the formatter and linter. Config lives at
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
- **Server action files:** camelCase with domain prefix. `login.ts`, `getUser.ts`
- **Section action files:** `{section}Actions.ts`. `blogActions.ts`, `careerActions.ts`
- **Component files:** PascalCase matching component name. `SectionHeader.tsx`, `TranslationField.tsx`
- **Hook files:** `use{HookName}.ts`. `useFileUpload.ts`, `useSectionTranslations.ts`
- **Utility files:** camelCase. `getData.ts`, `imageProcessor.ts`
- **Constants at module level:** camelCase (not SCREAMING_SNAKE_CASE). `const revalTime = ...`

## 8. Type Annotations

- **Strict mode:** `tsconfig.json` has `"strict": true`. No `any` permitted.
- **Type imports:** Use `import type { Foo } from '...'` for type-only imports. Runtime imports use regular `import { create } from 'zustand'`.
- **Nullable:** Use `X | null` (not `X | undefined` for missing values).
- **Optional properties:** Use `key?: Type` in interfaces.
- **Union types:** `'admin' | 'editor'`, `RemoteType = 'full' | 'hybrid' | 'onSite'`
- **Export inline types:** Types are defined in the same file where they are primary consumers, not in a separate `.d.ts` unless shared across modules.
- **Return types:** Explicit return types on public API functions. `export async function getUser(): Promise<CMSUser | null>`. Internal helper functions may omit return types.
- **Type assertion with `as`:** Used sparingly for Supabase query results.

```typescript
export type CmsRole = (typeof CMS_ALLOWED_ROLES)[number];

export async function checkLoginRateLimitDurable(
  supabase: Pick<SupabaseClient, 'rpc'>,
  ipHash: string,
  emailHash: string
): Promise<LoginRateResult> {
  // ...
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
  the limiter, revalidation and invalidation libs to explain contracts.
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
mutation result contract, revalidation signature, auth helpers, route
matching, CMS validators (sizes/URLs/storage paths), limiter identifier
derivation, and a PGlite (WASM Postgres) suite that executes the limiter
migration's DDL against a real database (drift-guarded by the
`-- BEGIN GRANTS` / `-- END GRANTS` markers). CI runs lint, test, build, then
typecheck (build first: fresh checkouts need `.next/types`).

## 13. Git

- **Commit prefixes:** Conventional commits are used alongside unprefixed messages. Observed prefixes: `fix:`, `feat:`, `refactor:`, `chore:`, `revert:`, `security:`, `docs:`.
- **Scoped commits:** Rare. Scopes are lowercase: `auth`, `images`, `cms`.
- **Subject length:** p50 is 23 chars, p95 is 72 chars. Keep subjects concise.
- **Body:** Only 13% of commits have a body. No strict convention.
- **Branch naming:** No strict prefix convention observed.
- **Merge strategy:** Merge commits (not squash or rebase).
- **No GPG signing.**

## 14. Dependencies and Tooling

- **Package manager:** bun (`packageManager` in `package.json`). Always use `bun` not `npm`/`yarn`/`pnpm`.
- **Lockfile:** `bun.lock` — committed to the repo.
- **Add dependency:** `bun add <package>` (prod) or `bun add -d <package>` (dev).
- **Linter/Formatter:** Biome 2.4. Config: `biome.json`.
- **Type checker:** `tsc` with `strict: true`. Config: `tsconfig.json`.
- **CSS:** Tailwind CSS 4 with `@tailwindcss/postcss`. Config: `postcss.config.mjs`, `tailwind.config.ts`.
- **Runtime:** Next.js 16 with Turbopack dev server. Config: `next.config.ts`.
  `serverActions.bodySizeLimit` is `'10mb'` — the upload contract (10 MB max
  for images and PDFs) is enforced client-side (`useFileUpload maxSizeMB`),
  server-side (`MAX_UPLOAD_SIZE_BYTES` in `src/utils/cms/validation.ts`) and
  at the framework layer.
- **Environment variables:** Required: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`),
  `SUPABASE_SECRET_KEY` (`sb_secret_…`, server-only, never in public code).
  Optional: `CMS_PUBLIC_URL`, `CMS_AUTH_DEBUG`, `APP_ENV`,
  `WEBSITE_REVALIDATION_URL`, `WEBSITE_REVALIDATION_SECRET`,
  `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_LOCALES`, `NEXT_PUBLIC_DEFAULT_LOCALE`.
  Full list in `.env.local.example`.
- **Database migrations:** `supabase/migrations/` — login rate limiting
  (table, split per-IP/per-email buckets, hardening grants/RLS, scheduled
  purge). Apply with `supabase db push` or the SQL editor; always documented
  as reversible.
- **Deployment:** Vercel with Next.js framework preset. Build output: `.next/`.

## 15. Red Lines

- **Never use double quotes for string literals** in `.ts`/`.tsx` files. Use single quotes. Biome enforces this.
- **Never use tabs for indentation.** Use 2 spaces.
- **Never use `any`.** TypeScript strict mode is enabled. If you need escape-hatch typing, use `unknown` and narrow.
- **Never use relative imports across directory boundaries.** Use `@/` path aliases defined in `tsconfig.json`.
- **Never call Supabase directly from client components (browser).** Use server actions (`'use server'`) to proxy all Supabase calls.
- **Never commit `.env.local`** or any file containing secrets.
- **Never add a `'use server'` directive inside a file that also has `'use client'`.** These directives are mutually exclusive at the file level.
- **Never import server-only modules (like `next/headers`, `next/cache`) into client components.** Keep server and client code separated. Client-safe contracts live in `src/libs/cms/mutationResult.ts` and route/validation utils.
- **Never use `console.log` in production paths.** Use `console.error` for server-side error logging (limiter/revalidation failures are logged with event/identifier context).
- **Never define React component state inline in the JSX render path.** Use Zustand stores for shared state, `useState`/`useReducer` for local state.
- **Never add a dependency with npm/yarn/pnpm** — always use `bun add`.
- **Never export a component as default** unless it is a Next.js page or layout file. Use named exports.
- **Never delete a Storage object before its DB write has committed** (see §4). Storage cleanup after a commit is best-effort and never throws.
- **Never trigger a router refresh from an action that also drives a client navigation** (e.g. login): the competing paths race and cause a transient load error in Firefox. The login flow intentionally has ONE deterministic navigation path — see `src/app/actions/cms/login.test.ts`.
- **Never call the limiter RPCs with the publishable-key client** — execution
  is service_role only (use `getCmsAdminClient`). The legacy single-identifier
  `cms_check_login_rate(text)` and its temporary anon grant were removed by
  `20260818110000_remove_legacy_login_rate_rpc.sql`; do not reintroduce them.
