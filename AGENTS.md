## 1. Overview

Next.js 16 personal portfolio, blog, and CMS. TypeScript throughout, React 19, Supabase for auth/storage/DB, Tailwind CSS 4 for styling, Zustand for client state, and next-intl for EN/IT i18n. The app router routes all pages under `/[locale]/...`.

## 2. Repository Structure

```
src/
  app/
    [locale]/                       # Next.js app router pages (i18n route group)
      cms/                          # CMS auth (login, register, OAuth callbacks) and admin dashboard
      [post_type]/[id]/[title]/     # Blog/portfolio post detail pages
    actions/                        # Server actions ('use server')
      cms/                          # CMS actions: auth, CRUD per section, file helpers, profile sync
      getCurrentViews.ts            # View count fetcher
      incrementViews.ts             # View count incrementer
      search.ts                     # Search action
    hooks/                          # Shared client hooks (useAutoSave, useZoom)
    providers.tsx                   # Client providers (ThemeProvider)
  components/
    cms/sections/                   # CMS editor components per section (Blog, Career, Contacts, Hero, Layout, Portfolio, Privacy, Skills, Users)
    cms/shared/                     # Shared CMS UI (TranslationField, FileDropzone, PublishBar, ConfirmDialog, etc.)
    common/                         # Reusable public components (PostCard, Searchbar, ImageModal, etc.)
    common/cms/                     # CMS shared components (AccountSection, SidePanel, Previews)
    layout/                         # Layout components (Header, Footer, NavMenu, ThemeToggle, LanguageToggle, NextImage, MarkdownRenderer)
    layout/mainPage/                # Page-specific sections (Hero, Skills, Career, Contacts, PostSections)
  hooks/cms/                        # CMS-specific client hooks (useDraft, useFileUpload, useFormValidation, useSectionTranslations, etc.)
  i18n/                             # next-intl config (routing, request) + static CMS JSON messages
  libs/                             # Shared libs (rateLimiters)
  store/                            # Zustand stores (layoutStore, themeStore)
  types/                            # Shared domain types (fetchedData.types)
  utils/                            # Utilities (getData, imageProcessor, tokenBucket, blurhash, Supabase clients)
  proxy.ts                          # Proxy handler for Vercel deployment (not app code)
```

> **Repo-wide:** New modules go in `src/` under the directory matching their role (components, actions, hooks, utils, store, types, libs). Nothing outside `src/` except config files.

## 5. Commands and Workflows

- Install: `bun install`
- Dev server: `bun run dev`
- Build: `bun run build`
- Start production: `bun run start`
- Lint: `bun run lint` (runs `biome lint .`)
- Lint + auto-fix: `bun run lint-fix` (runs `biome check . --write --unsafe`)
- Format: `bun run format` (runs `biome format . --write`)
- Type check: `bunx tsc --noEmit`

There is no `test` command — the repo has no test files and no test framework configured. There is no CI pipeline (no `.github/workflows/` directory).

## 6. Code Formatting

> **Repo-wide:** Biome 2.4 is the formatter and linter. Config lives at `biome.json`. The editorconfig at `.editorconfig` mirrors indent/line-ending settings.

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
- **Spacing — decorators/semicolons:** No blank line before decorator; no decorators used in this codebase.
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

- **Variables:** camelCase. `const rateLimitKey = ...`
- **Functions:** camelCase. Prefer `get`/`handle`/`use` prefixes where semantically appropriate. `getUser()`, `handleSubmit()`, `useDraft()`
- **React components:** PascalCase, named exports. `export function SectionHeader(...)`
- **Component props interfaces:** `{ComponentName}Props`. `SectionHeaderProps`, `ErrorBannerProps`
- **Types and interfaces:** PascalCase. `CMSUser`, `CMSBootData`, `ThemeState`, `PostAuthor`
- **Type aliases for discriminated unions:** `{Entity}Result` for operation results. `ContactsResult`, `I18nResult`
- **Data types:** `{Entity}Data` suffix. `CMSHeroBootData`, `CreateContactData`
- **Zustand stores:** `use{Name}Store`. `useThemeStore`, `useLayoutStore`
- **Server action files:** camelCase with domain prefix. `login.ts`, `signup.ts`, `getUser.ts`
- **Section action files:** `{section}Actions.ts`. `blogActions.ts`, `careerActions.ts`
- **Component files:** PascalCase matching component name. `SectionHeader.tsx`, `TranslationField.tsx`
- **Hook files:** `use{HookName}.ts`. `useDraft.ts`, `useFileUpload.ts`
- **Utility files:** camelCase. `getData.ts`, `rateLimiters.ts`, `imageProcessor.ts`
- **Constants at module level:** camelCase (not SCREAMING_SNAKE_CASE). `const production = ...`, `const revalTime = ...`

## 8. Type Annotations

- **Strict mode:** `tsconfig.json` has `"strict": true`. No `any` permitted.
- **Type imports:** Use `import type { Foo } from '...'` for type-only imports. Runtime imports use regular `import { create } from 'zustand'`.
- **Nullable:** Use `X | null` (not `X | undefined` for missing values).
- **Optional properties:** Use `key?: Type` in interfaces.
- **Union types:** `'admin' | 'editor'`, `RemoteType = 'full' | 'hybrid' | 'onSite'`
- **Export inline types:** Types are defined in the same file where they are primary consumers, not in a separate `.d.ts` unless shared across modules.
- **Return types:** Explicit return types on public API functions. `export async function signup(...): Promise<...>`. Internal helper functions may omit return types.
- **Type assertion with `as`:** Used sparingly for Supabase query results.

```typescript
export type CmsRole = (typeof CMS_ALLOWED_ROLES)[number];

interface ThemeState {
  mode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
}

export async function getUser(): Promise<CMSUser | null> {
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

- **Supabase clients:** Server client: `import { createClient } from '@/utils/supabase/server'`. Client-side: `import { createClient } from '@/utils/supabase/client'`. Admin/browser client: `import { createClient as createAdminClient } from '@supabase/supabase-js'`.
- **Never use relative imports** for anything outside the immediate sibling directory. Always use `@/` aliases.

```typescript
// Canonical import block
import '../globals.css';
import { SpeedInsights } from '@vercel/speed-insights/next';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import Script from 'next/script';
import { NextIntlClientProvider } from 'next-intl';
import { Suspense } from 'react';
import ConditionalFooter from '@/components/layout/ConditionalFooter';
import ConditionalHeader from '@/components/layout/ConditionalHeader';
import ScrollTop from '@/components/layout/ScrollTop';
import { getTranslationsSupabase } from '@/utils/getData';
```

## 10. Error Handling

- **Server actions** use try/catch with `console.error` and return `{ success: false, error: string }`:

```typescript
export async function getCurrentViews(postId: string, postType: 'blog' | 'portfolio') {
  try {
    const supabase = await createClient();
    // ...
    if (error) {
      console.error('Error fetching current views:', error);
      return { success: false, error: error.message };
    }
    return { success: true, views: data?.views || 0 };
  } catch (error) {
    console.error('Error in getCurrentViews:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

- **Client components** catch errors from server action calls and display via UI state (often `ErrorBanner` component).
- **Supabase `PGRST116`** (zero rows from `.single()`) is handled as a non-error: return `null`.
- **Bare `catch`** (without error variable) is used when the error is intentionally ignored (e.g., Supabase `setAll` in server component cookie handler).
- **No global error boundary** is configured. Each route handles its own error state.
- **Custom errors** are not defined. The codebase uses `Error` instances and string messages.

## 11. Comments and Docstrings

- **Docstrings:** Not used systematically. A single JSDoc block in `login.ts` for the function description.
- **Inline comments:** `//` style, used sparingly to explain intent or document edge cases, not what the code does.
- **No module-level docstrings.**
- **No commented-out code** in observed files. Biome linter likely prevents dead code.
- **Supabase/RPC comments:** Keep inline comments when the API behavior is non-obvious.

```typescript
// Rate limit by both IP and email
const rateLimitKey = `login:${clientIp}:${email.toLowerCase()}`;

// Do not revalidatePath here: it can trigger layout refetch before the client
// redirects, causing a client-side exception.
return { success: true };
```

## 12. Testing

There are zero test files in the repository. No test framework (Jest, Vitest) is configured. There is no `test` script in `package.json`. When tests are added, follow existing conventions for file placement, naming, and structure.

## 13. Git

- **Commit prefixes:** Conventional commits are used alongside unprefixed messages. Observed prefixes: `fix:`, `feat:`, `refactor:`, `chore:`, `revert:`, `security:`, `docs:`.
- **Scoped commits:** Rare (3.7% of commits). Scopes are lowercase: `auth`, `images`, `cms`.
- **Subject length:** p50 is 23 chars, p95 is 72 chars. Keep subjects concise.
- **Body:** Only 13% of commits have a body. No strict convention.
- **Branch naming:** No strict prefix convention observed. Active branches use descriptive names like `beta`.
- **Merge strategy:** Merge commits (not squash or rebase).
- **No GPG signing.**

## 14. Dependencies and Tooling

- **Package manager:** bun (`packageManager: "bun@1.3.7"` in `package.json`). Always use `bun` not `npm`/`yarn`/`pnpm`.
- **Lockfile:** `bun.lock` — committed to the repo.
- **Add dependency:** `bun add <package>` (prod) or `bun add -d <package>` (dev).
- **Linter/Formatter:** Biome 2.4. Config: `biome.json`.
- **Type checker:** `tsc` with `strict: true`. Config: `tsconfig.json`.
- **CSS:** Tailwind CSS 4 with `@tailwindcss/postcss`. Config: `postcss.config.mjs`, `tailwind.config.ts`.
- **Runtime:** Next.js 16 with Turbopack dev server. Config: `next.config.ts`.
- **Environment variables:** Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DOMAIN_URL`. Full list in `.env.local.example`.
- **Deployment:** Vercel with Next.js framework preset. Build output: `.next/`.

## 15. Red Lines

- **Never use double quotes for string literals** in `.ts`/`.tsx` files. Use single quotes. Biome enforces this.
- **Never use tabs for indentation.** Use 2 spaces.
- **Never use `any`.** TypeScript strict mode is enabled. If you need escape-hatch typing, use `unknown` and narrow.
- **Never use relative imports across directory boundaries.** Use `@/` path aliases defined in `tsconfig.json`.
- **Never call Supabase directly from client components (browser).** Use server actions (`'use server'`) to proxy all Supabase calls.
- **Never commit `.env.local`** or any file containing secrets.
- **Never add a `'use server'` directive inside a file that also has `'use client'`.** These directives are mutually exclusive at the file level.
- **Never import server-only modules (like `next/headers`, `next/cache`) into client components.** Keep server and client code separated.
- **Never use `console.log` in production paths.** Use `console.error` for server-side error logging.
- **Never define React component state inline in the JSX render path.** Use Zustand stores for shared state, `useState`/`useReducer` for local state.
- **Never add a dependency with npm/yarn/pnpm** — always use `bun add`.
- **Never export a component as default** unless it is a Next.js page or layout file. Use named exports.
