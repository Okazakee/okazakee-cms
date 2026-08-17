# CMS Decoupling — Behavior Matrix

Migration checklist produced during Phase 0. Every current CMS capability is
classified so no feature is silently lost during the split.

- **Audited commit (working tree):** `f448986` (`beta` HEAD, tree identical to
  `master` `551c552` — verified via `git diff --name-only master beta` = empty)
- **Audit date:** 2026-08-17
- **Legend:**
  - `PRESERVE` — keep behavior as-is during extraction
  - `FIX DURING EXTRACTION` — keep the feature but fix a confirmed defect
  - `REMOVE INTENTIONALLY` — delete during extraction (dead/disabled)
  - `DEFER` — keep as-is now, address in a documented follow-up

---

## 1. Authentication

| Capability | Status | Evidence / note |
|---|---|---|
| Email/password login | PRESERVE | `src/app/actions/cms/login.ts`; allowlist check before and after `signInWithPassword`; returns `redirectTo: '/cms/auth/ready?next=/cms'`; calls `refresh()` (CMS UI cache) |
| Login rate limiting | FIX DURING EXTRACTION | `src/libs/rateLimiters.ts` uses process-local `Map` + `setInterval`. Not globally consistent across instances. CMS must not reproduce as security boundary. Replaced by durable state before production-ready (Phase 6/14). Keep current behavior during extraction |
| GitHub OAuth start | PRESERVE | `auth/github/start/route.ts`; `signInWithOAuth` redirectTo `${origin}/${locale}/cms/auth/callback?next=...`; origin from `getRequestOrigin()` (request-derived in production — FIX later, see §10) |
| OAuth callback | PRESERVE | `auth/callback/route.ts`; `exchangeCodeForSession`, allowlist check, `syncCmsUserProfile`, redirect to `/cms/auth/ready` |
| Auth-ready redirect | PRESERVE | `auth/ready/route.ts`; re-checks session + allowlist, syncs profile, redirects to `/${locale}${next}` with `getSafeCmsNext()` |
| Logout | PRESERVE | `SidePanel.tsx` — browser client `signOut()`, redirect to `/${locale}/cms/login` |
| Stale session recovery | PRESERVE | `src/utils/supabase/middleware.ts` `updateSession()` in Proxy; clears invalid `sb-*` cookies, redirects unauthenticated users away from protected CMS routes |
| Unauthorized allowlist user rejection | PRESERVE | middleware, login post-check, callback, ready, `getUser()`/`getCmsBootData()` return `unauthorized` |
| Profile sync on login | PRESERVE | `profileSync.ts` — upsert `user_profiles` from auth metadata via elevated client |
| CMS session cookie handling | PRESERVE | `src/utils/supabase/server.ts` (SSR cookie client), `client.ts` (browser client, `detectSessionInUrl: false`) |

## 2. Role-based access control (server-side)

| Capability | Status | Evidence / note |
|---|---|---|
| Admin-only Hero | PRESERVE | `heroActions` `requireAdmin()` on every operation |
| Admin-only Skills | PRESERVE | `skillsActions` `requireAdmin()` + `getCmsActionContext('admin')` on BATCH_PUBLISH |
| Admin-only Career | PRESERVE | `careerActions` `requireAdmin()` + `getCmsActionContext('admin')` |
| Admin-only Contacts | PRESERVE | `contactsActions` `requireAdmin()` + `getCmsActionContext('admin')` |
| Admin-only Layout (i18n header/footer) | PRESERVE | `i18nActions` `getCmsActionContext('admin')` |
| Admin-only Privacy (i18n) | PRESERVE (write path FIXED, see §9) | same `i18nActions` gate |
| Admin-only Users management | FIX DURING EXTRACTION | `usersActions(GET)` only requires `requireAuth()` — editors can list allowlist/profiles (emails, GitHub usernames). Tighten to admin-only unless author-picker needs it (§10) |
| Editor Blog/Portfolio rights | PRESERVE | `requireAllowedPostWriter()` / `getCmsActionContext('post-writer')` (`admin` + `editor`) on all mutations and uploads |
| Last-admin protection | PRESERVE | `updateUserRole` + `removeUser` refuse demote/remove of the final admin |
| Hidden UI is not authorization | PRESERVE (with fix above) | all sensitive mutations already server-authorized |

## 3. Users / authors / account

| Capability | Status | Evidence / note |
|---|---|---|
| List allowlisted users + profiles | FIX DURING EXTRACTION (authz) | `getAllowedUsers()` — includes profile join, GitHub username sync side-effects during GET |
| Add email user (invite) | FIX DURING EXTRACTION | `addEmailUser()` — allowlist insert + `auth.admin.createUser` + `generateLink` (result discarded) + `resetPasswordForEmail`. Redirect targets `NEXT_PUBLIC_SITE_URL` + `/cms` (monolith URL). Move to `CMS_PUBLIC_URL`; drop redundant `generateLink` |
| Add GitHub user | PRESERVE | `addGitHubUser()` — allowlist insert only |
| Add dummy author/user | PRESERVE | `addDummyUser()` — auth user + profile + allowlist, rollback on failure |
| Update role | PRESERVE | `updateUserRole()` |
| Remove user | PRESERVE | `removeUser()` — allowlist delete; profile delete; dummy users also get auth identity deleted; regular users keep auth identity (see account semantics) |
| Update another user's display name | FIX DURING EXTRACTION (public cache) | `updateUserDisplayName()` — no `author:<id>` public invalidation |
| Update another user's avatar | FIX DURING EXTRACTION (format + cache) | `uploadUserAvatar()` — `.webp`/`image/webp` hardcoded though server fallback may produce PNG; no `author:<id>` invalidation |
| Update own display name | FIX DURING EXTRACTION (cache) | `updateMyProfile()` display name branch |
| Update own avatar | FIX DURING EXTRACTION (format + cache) | `updateMyProfile()` avatar branch — same format mismatch |
| Self-delete/revoke access | PRESERVE (document semantics) | `deleteMyAccount()` — removes allowlist row + profile, signs out, does **not** delete Supabase Auth identity. Product meaning = "revoke CMS access". Keep; do not silently convert to full identity deletion |

## 4. Content — Hero

| Capability | Status | Evidence / note |
|---|---|---|
| GET hero + resume data | PRESERVE | `heroActions GET` reuses public cached `getHeroSection()`/`getResumeLink()` — CMS should read uncached after split (Phase 8) |
| Update hero fields | PRESERVE | `updateHero()` — elevated client, `updateTag('hero')` |
| Upload profile image | FIX DURING EXTRACTION | `uploadHeroImage()` — stores `propic: <publicUrl>?t=<ts>` but returns plain `publicUrl` (mismatch); rollback deletes new object on DB failure; old object removed after success |
| Upload EN/IT resume | PRESERVE | `uploadResume()` — fixed path `resumes/{field}.pdf`, `application/pdf`, rollback on DB failure, `updateTag('resume')` + `updateTag('hero_section')` |
| Hero-section translations | PRESERVE | `HeroSection.tsx` via `useSectionTranslations('hero-section')` → `i18nActions` `UPDATE_SECTIONS` |

## 5. Content — Skills

| Capability | Status | Evidence / note |
|---|---|---|
| GET skills + categories | PRESERVE | `skillsActions GET` |
| Create/update/delete skills | PRESERVE | elevated client, `updateTag('skills')` |
| Create/update/delete categories | PRESERVE | elevated client, `updateTag('skills')` |
| Batch publish | PRESERVE | BATCH_PUBLISH returns `success + errors`, emits tags only when something changed |
| Skills-section translations | PRESERVE | `useSectionTranslations('skills-section')` |

## 6. Content — Career

| Capability | Status | Evidence / note |
|---|---|---|
| GET entries | PRESERVE | `careerActions GET` reuses public cached `getCareerEntries()` — CMS reads uncached after split |
| Create/update/delete entries | PRESERVE | elevated client, `updateTag('career')` |
| Logo upload | PRESERVE | `uploadCareerLogo()` — format-aware extension/MIME (uses `prepareImageUpload`), blurhash, replacement cleanup |
| Ordering | PRESERVE | position field |
| Career-section translations | PRESERVE | `useSectionTranslations('career-section')` |
| Date validation | PRESERVE | `isValidDate` |
| URL validation | FIX DURING EXTRACTION | uses generic `isValidUrl` (any scheme) |

## 7. Content — Blog

| Capability | Status | Evidence / note |
|---|---|---|
| GET posts | PRESERVE | `blogActions GET` — `requireAuth()` |
| Create post | PRESERVE | `requireAllowedPostWriter()`; elevated insert; `updateTag('blog')` + `updateTag('posts')`; rollback helper deletes image + row on apply failure |
| Update post | PRESERVE | same auth; `updateTag('blog','posts','post')` |
| Delete post | PRESERVE | removes image object then row; tags |
| Batch publish | PRESERVE | structured `created/updated/errors`; tags only when committed changes exist |
| Hidden flag | PRESERVE | public queries filter `hidden = false` |
| Future date | DEFER (decision) | public filters `created_at <= now` when `VERCEL_ENV=production`; exact scheduled publishing needs a decision (§10) |
| Author assignment | PRESERVE | `author_id`; public `getPost()` embeds author profile |
| Image upload | FIX DURING EXTRACTION | legacy path `uploadBlogImageForNewPost()`/`uploadBlogImage()` hardcode `.webp` filename even when server fallback produced PNG (contentType is format-aware — mismatch). Consolidate on `prepareImageUpload`/`uploadPreparedImage` |
| Tags/markdown | PRESERVE | title/description/tags fields, markdown body |
| Shared `posts-section` translations | PRESERVE | Blog and Portfolio both edit the same `posts-section` block |

## 8. Content — Portfolio

Same profile as Blog:

| Capability | Status | Evidence / note |
|---|---|---|
| CRUD + batch publish | PRESERVE | `portfolioActions`; `requireAllowedPostWriter()`; tags `portfolio`, `posts`, `post` |
| External links / store links | FIX DURING EXTRACTION (validation) | generic `isValidUrl` currently accepts any scheme; use https/http + required store scheme |
| Image upload | FIX DURING EXTRACTION | same `.webp` filename hardcoding as Blog |
| Shared `posts-section` translations | PRESERVE | same block as Blog |

## 9. Content — Contacts / i18n / Layout / Privacy

| Capability | Status | Evidence / note |
|---|---|---|
| Contacts CRUD + reorder | PRESERVE | `contactsActions`; admin-only; `updateTag('contacts')` |
| Contacts batch publish | PRESERVE | structured partial failure |
| **Resume upload from Contacts UI** | PRESERVE | `ContactsSection.tsx` calls `heroActions({type:'UPDATE_WITH_FILES'})` — resumes stored in `hero_section`, tags `resume` + `hero_section`. Do not relocate during extraction |
| Contacts-section translations | PRESERVE | `useSectionTranslations('contacts-section')` |
| Layout header/footer editing | PRESERVE | `LayoutSection.tsx` edits translations blocks `header`/`footer` via `useSectionTranslations` — no dedicated layout backend |
| Public translation update (full) | PRESERVE | `i18nActions UPDATE` — upserts row, `updateTag('translations')` + `updateTag('privacy-policy')` |
| Section translation update | PRESERVE | `UPDATE_SECTION`/`UPDATE_SECTIONS` — merges into `translations` JSON, `updateTag('translations')` |
| **Privacy Policy write** | FIX DURING EXTRACTION | CONFIRMED BUG: Privacy editor saves via `UPDATE_SECTION` with `sectionKey: 'privacy_policy'` → merged into `translations.privacy_policy`, while the `privacy_policy` column is written back unchanged. Public `getPrivacyPolicy()` reads the **column**. CMS privacy edits never reach the public page. Fix: dedicated typed mutation writing the column, invalidate `privacy-policy`, E2E test |

## 10. Confirmed defects / decisions to carry into implementation

| # | Defect | Classification |
|---|---|---|
| 1 | `VERCEL_ENV === 'production'` drives content visibility (`getData.ts`) and cache defaults (`next.config.ts`) | FIX DURING EXTRACTION — explicit `APP_ENV`/`CONTENT_ENFORCE_PUBLISH_DATE`/`ISR_REVALIDATION` |
| 2 | Hard-coded Supabase project hostname fallback in `next.config.ts` | FIX DURING EXTRACTION — derive from `NEXT_PUBLIC_SUPABASE_URL`, fail clearly |
| 3 | Legacy `anon`/`service_role` key names | DEFER — keep during migration; publishable/secret key migration after split (Phase 14) |
| 4 | Process-local login rate limiter | FIX DURING EXTRACTION — durable replacement for standalone CMS |
| 5 | Registration disabled with dead code (`register/page.tsx` commented impl, `signup.ts` redirect) | REMOVE INTENTIONALLY — do not migrate |
| 6 | File size policy 10 MB validators vs Server Action default 1 MB body limit (no `serverActions.bodySizeLimit`) | FIX DURING EXTRACTION — one declared contract, tests at boundaries |
| 7 | Blog/portfolio legacy uploads hardcode `.webp` filename with format-aware contentType | FIX DURING EXTRACTION — consolidate on `prepareImageUpload`/`uploadPreparedImage` |
| 8 | Duplicated elevated Supabase clients (5 constructors: `fileHelpers`, `deleteAccount`, `usersActions` ×2 + inline ×2, `profileSync`) | FIX DURING EXTRACTION — one server-only admin client |
| 9 | Invite/recovery URLs target monolith `NEXT_PUBLIC_SITE_URL` + `/cms` | FIX DURING EXTRACTION — `CMS_PUBLIC_URL`, drop discarded `generateLink` call |
| 10 | OAuth origin derived from request headers in production | FIX DURING EXTRACTION — canonical `CMS_PUBLIC_URL`, strict allowlist |
| 11 | `getPost()` tags everything `post` (global invalidation) | FIX DURING EXTRACTION — add `post:blog:<id>` / `post:portfolio:<id>` (+ retained broad tag) |
| 12 | Future/scheduled publishing has no exact-time trigger | DEFER — document eventual semantics (option A) |
| 13 | Conditional `Header`/`Footer` exist only due to CMS route sharing | REMOVE after cutover (Phase 13) |
| 14 | Public Supabase SSR cookie client used only for anonymous RPC (`getCurrentViews`/`incrementViews`) | DEFER — verify at Phase 13; stateless client likely sufficient |
| 15 | Privacy write bug (see §9) | FIX DURING EXTRACTION |
| 16 | Account deletion = revoke, not identity delete | PRESERVE — document; do not change semantics |
| 17 | `isValidUrl` accepts arbitrary schemes | FIX DURING EXTRACTION — context allowlists |
| 18 | Hero image stores `?t=` URL, returns plain URL | FIX DURING EXTRACTION — canonical representation |
| 19 | Composite publishes lack transaction and precise failure state | FIX DURING EXTRACTION — structured per-step results; tags derived from committed changes |
| 20 | `usersActions(GET)` accessible to editors | FIX DURING EXTRACTION — admin-only (verify author-picker impact) |
| 21 | Avatar upload forces `.webp`/`image/webp` regardless of actual processed format | FIX DURING EXTRACTION |
| 22 | Author profile changes do not invalidate public cached post authors | FIX DURING EXTRACTION — `author:<user-id>` tag |
| 23 | CMS actions scatter `updateTag` ad hoc (8 action files) | FIX DURING EXTRACTION — invalidation descriptors → signed HTTP event |

## 11. Public site behavior (must remain unchanged except listed fixes)

- `/en`, `/it` homepage sections (hero, skills carousel, career timeline, contacts)
- blog/portfolio listings, post detail with author, slug-correction redirect
- search (`search.ts` → `getPosts`), view counter (`incrementViews` RPC)
- privacy policy page (`getPrivacyPolicy`)
- sitemap, robots, SEO metadata
- EN/IT via next-intl with Supabase translations
- resume links, images, theme, Umami analytics
- view-count RPC functions `increment_blog_post_views_bigint` / `increment_portfolio_post_views_bigint`

## 12. Definition of done for this matrix

Every row above is PRESERVE/FIX/REMOVE/DEFER — no capability is silently lost.
Any change to a row requires updating this matrix and the implementation log
first.
