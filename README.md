# Okazakee Website

A modern personal portfolio and blog website built with Next.js 16, featuring an integrated CMS with role-based access control and multi-language support.

## 🚀 Features

**Public Website:**
- Hero section, skills carousel, career timeline
- Portfolio projects and blog posts with search
- Dark/Light/Auto theme, multi-language (EN/IT)
- View tracking, SEO optimization, responsive design

**CMS:**
- Role-based access (Admin/Editor)
- Section management (Hero, Skills, Career, Portfolio, Blog, Contacts, Layout, Privacy Policy)
- Email/Password + GitHub OAuth authentication
- Auto-save, live previews, image optimization, markdown support

## 🛠️ Tech Stack

**Framework:** Next.js 16, TypeScript, React 19  
**Styling:** Tailwind CSS 4, Lucide React  
**Backend:** Supabase (PostgreSQL + Auth + Storage)  
**i18n:** next-intl (EN/IT)  
**State:** Zustand  
**Tools:** Biome, Turbopack

## 🏗️ Architecture

**Routing:** `/[locale]/[post_type]/[id]/[title]` structure with i18n  
**Components:** Server Components for data/SEO, Client Components for interactivity  
**State:** Zustand stores (`layoutStore`, `themeStore`)  
**Supabase:** Server/client clients + middleware for session management

## 🚦 Getting Started

### Prerequisites

- Node.js 18+ and Bun
- Supabase account

### Installation

1. Clone and install:

```bash
git clone <repository-url>
cd okazakee-ws
bun install
```

2. Create `.env.local`:

```env
# Required - Get from Supabase project settings (Settings → API)
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key-here
DOMAIN_URL=http://localhost:3000

# Optional
NEXT_PUBLIC_SITE_URL=http://localhost:3000
UMAMI_ENABLED=false
ISR_REVALIDATION=86400
NEXT_PUBLIC_LOCALES=en,it
NEXT_PUBLIC_DEFAULT_LOCALE=en
```

3. Set up Supabase:
   - Create project and get URL/anon key
   - Create tables: `user_profiles`, `cms_allowed_users`, `blog_posts`, `portfolio_posts`, `skills`, `career_entries`, `contacts`, `hero`, `resume`, `i18n_translations`, `layout_settings`, `privacy_policy`
   - Create functions: `increment_blog_post_views_bigint`, `increment_portfolio_post_views_bigint`
   - Create storage bucket: `website`
   - Configure RLS policies

4. Run dev server:

```bash
bun run dev
```

## 🔐 Environment Variables

**Required:**
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL (from project settings)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anonymous key (from API settings)
- `SUPABASE_SERVICE_ROLE_KEY` - Server-only Supabase admin key used by CMS actions that bypass RLS
- `DOMAIN_URL` - Production domain (e.g., `https://example.com`)

**Optional:**
- `NEXT_PUBLIC_SITE_URL` - Site URL used for invite/reset redirects; optional locally, but should be set on Vercel
- `UMAMI_ENABLED` - Enable Umami analytics (`true`/`false`)
- `ISR_REVALIDATION` - ISR/cache lifetime in seconds for both content caches and the GitHub stars fetch
  (default: `86400` in production, `600` in preview/beta)
- `NEXT_PUBLIC_LOCALES` - Comma-separated locales (default: `en,it`)
- `NEXT_PUBLIC_DEFAULT_LOCALE` - Default locale (default: `en`)

## 📝 Scripts

```bash
bun run dev       # Development server (Turbopack)
bun run build     # Production build
bun run start     # Production server
bun run lint      # Lint code
bun run lint-fix  # Lint and auto-fix
bun run format    # Format code
```

## 🎨 Development

**Structure:**
- `src/components/common/` - Reusable components
- `src/components/common/cms/` - CMS sections and SidePanel
- `src/app/actions/cms/` - Server actions (`'use server'`) and file helpers
- `src/utils/` - Utilities and Supabase clients

**Adding CMS Sections:**
1. Create section component in `src/components/common/cms/`
2. Add actions in `src/app/actions/cms/sections/`
3. Register in `src/app/[locale]/cms/page.tsx` and `src/components/common/cms/SidePanel.tsx`

**i18n:** Translations in Supabase `i18n_translations` table. Use `getTranslations()` (server) or `useTranslations()` (client).

## 🚀 Deployment

1. Build: `bun run build`
2. Set environment variables in your platform (Vercel: Project Settings → Environment Variables)
3. Configure Supabase:
   - Set up tables, functions, RLS policies
   - Configure storage buckets and CORS
   - Configure OAuth (GitHub) with production redirect URLs
4. Deploy: Push to main branch or trigger manual deployment

**Vercel:** Framework Preset: Next.js, Build Command: `bun run build`, Output: `.next`

**Recommended cache setup on Vercel:**
- Production: set `ISR_REVALIDATION=86400`
- Beta preview branch: set `ISR_REVALIDATION=600` with a branch-scoped preview env

## 📖 CMS Usage

**Access:** Navigate to `/[locale]/cms/login`, sign in with email/password or GitHub OAuth.

**Roles:**
- **Admin:** Full access to all sections, user management
- **Editor:** Portfolio and Blog sections only

**Content Management:**
- **Blog/Portfolio:** Create/edit posts with markdown, tags, images
- **Other Sections:** Hero, Skills, Career, Contacts, Layout, Privacy Policy (Admin only)
- **Users:** Add/edit/delete users, manage roles (Admin only)
- **Account:** Update profile, change password, delete account

## 🐛 Troubleshooting

**Build Errors:** Check env vars, Node.js version, clear `.next` folder  
**Auth Issues:** Verify Supabase credentials, check `cms_allowed_users` table, OAuth redirect URLs  
**Database:** Ensure tables exist, check RLS policies, verify functions  
**Images:** Check storage bucket config, policies, file size limits  
**i18n:** Verify translations in database, check locale routing

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes and run `bun run lint && bun run format`
4. Commit and push
5. Open a Pull Request

**Code Style:** TypeScript best practices, Biome linting/formatting, meaningful commits

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

Built with ❤️ using Next.js, TypeScript, and Supabase

---

## Origin

Extracted from `Okazakee/okazakee-ws` at commit `234b064` (beta branch,
2026-08-17) as part of the CMS decoupling migration. The original repository
remains the historical source of truth for pre-extraction history.

See `docs/cms-decoupling/` for the migration plan artifacts.

---

## Auth and account semantics

- **Login:** email/password or GitHub OAuth, allowlist-gated (`cms_allowed_users`:
  email match OR GitHub username match) with roles `admin` / `editor`.
- **Roles:** admin = all sections + user management; editor = blog/portfolio +
  account. Authorization is enforced server-side in every Server Action; the
  hidden navigation is never an authorization mechanism.
- **User management (admin only):** add email user (invite via password reset
  email), add GitHub user, add dummy author, change role, remove user. The
  last admin cannot be demoted or removed.
- **"Delete my account"** revokes CMS access: removes the allowlist row and the
  `user_profiles` row, then signs out. It does NOT delete the Supabase Auth
  identity or historical author attribution. Do not change this semantics
  silently.
- **Dummy authors** are auth users with `dummy-<uuid>@dummy.local` emails used
  purely for post attribution; removing them also deletes the auth identity.
- **Login rate limiting:** 5 attempts/minute, 15-minute lockout. The durable
  Postgres-backed limiter (`supabase/migrations/20260817100000_cms_login_rate_limit.sql`)
  replaces the process-local one before production cutover.
