# Okazakee — Design System Canon

This document is the design contract for the redesigned site. It supersedes the
Stitch-generated brief that used to live here: the redesign is now the canon, and
where the two disagree this file wins.

Provenance of every value below: the approved HTML mockups in
`~/Downloads/stitch_okazakee_hybrid_tui_interface/` (`code.html`, `portfolio.html`,
`privacy-policy.html`, `error.html`, `blog-post.html`, `portfolio-post.html`) plus the
`precall` project for the request form. Values were verified by measuring the rendered
mocks (contrast ratios, box geometry, tap targets), not copied from a tool.

Source, tests and configuration remain authoritative for implementation detail; this
document owns the system: tokens, type, layout, component behaviour and the data rules.

---

## 1. Colour

### 1.1 Token mechanism

Tokens are consumed through CSS custom properties, never as raw hex in
components. The declaration differs by Tailwind version:

```css
/* repo — Tailwind v4: hex values, opacity comes from color-mix */
:root { --c-surface-base: #f4f5f9; }
.dark { --c-surface-base: #0a0a0a; }
```

```js
// repo — v4 resolves `bg-surface-base/85` with color-mix, no placeholder needed
colors: { 'surface-base': 'var(--c-surface-base)' }
```

```css
/* mockups — the Stitch files run the v3 Play CDN, which needs channel triplets */
:root { --c-surface-base: 244 245 249; }
```

```js
// mockups only — `<alpha-value>` keeps v3 opacity modifiers working
colors: { 'surface-base': 'rgb(var(--c-surface-base) / <alpha-value>)' }
```

Rules:

- Components reference token classes only (`bg-surface-card`, `text-text-muted`,
  `border-border-subtle`). No hexes, no arbitrary colour classes.
- `<alpha-value>` is valid **only** inside the Tailwind config. Anywhere else it
  becomes a literal, broken value — this has already bitten once (an inline SVG
  `fill` ended up holding the placeholder).
- Opacity modifiers on tokens work as expected (`bg-surface-base/85`,
  `bg-accent-violet/10`, `border-accent-violet/40`).
- `text-white` is *semantic ink*, not white: in light mode it resolves to near-black.

### 1.2 Token set

| token | role | dark | light |
|---|---|---|---|
| `surface-base` | page canvas, header | `#0a0a0a` | `#e4e7ee` |
| `surface-alt` | band / tinted section | `#0c0d0d` | `#dadee4` |
| `surface-card` | cards, panels | `#111215` | `#f4f7fc` |
| `surface-card-hover` | card hover, inline `code` | `#15171e` | `#e0e4eb` |
| `surface-raised` | chips, pills, secondary buttons | `#181a23` | `#dee2e9` |
| `border-subtle` | default 1px border | `#21242b` | `#d9dce6` |
| `border-hover` | border on interaction | `#353c4b` | `#b6bdcd` |
| `accent-violet` | primary accent | `#9451ff` | `#7c3aed` |
| `accent-violet-light` | accent text / links | `#cdaffd` | `#6d28d9` |
| `accent-violet-deep` | fills, selection | `#6831c0` | `#6831c0` |
| `accent-cyan` | data / tech highlight | `#38bdf8` | `#0369a1` |
| `text-white` | headings | `#f8fafc` | `#0b0e14` |
| `text-main` | body copy | `#e2e8f0` | `#141822` |
| `text-muted` | secondary copy | `#a3aec0` | `#343c4e` |
| `text-dim` | captions, footnotes, footer | `#808d9f` | `#4b5664` |
| `text-on-accent` | ink on an accent fill | `#0a0a0a` | `#f4f7fc` |
| `status-active` | "current" pip only | `#10b981` | `#047857` |
| `code-bg` / `code-fg` | code surfaces | `#08090d` / `#e2e8f0` | `#dde1e7` / `#1b2030` |

The light surfaces are one hue stepped down in small luminance steps, so band /
chip / hover / canvas / card are five distinct planes rather than five names
for the same white. Card is the only near-white surface and nothing reaches
`#ffffff`. Elevation in light mode is *lighter*, so a hover or a chip darkens
from its card; the same classes on dark step lighter. `text-muted` and
`text-dim` step down with the canvas — deepening a canvas without deepening
the ink is what drops captions below their floor.

`text-on-accent` is the one ink that does *not* move with the canvas: it stays
at the card tone in light, because a fill's label must not dim every time the
canvas is retuned.

### 1.3 Contrast floor (measured, must not regress)

| content | dark | light |
|---|---|---|
| body text — `text-main` on canvas | 16.1 | 14.3 |
| paragraphs — `text-main`, canvas → card | 15.2 – 16.1 | 14.3 – 16.5 |
| headings — `text-white`, band → card | 17.9 – 18.6 | 14.3 – 18.0 |
| tag chips — `text-muted` on `surface-raised` | 7.7 | 8.5 |
| footer / captions — `text-dim` on canvas | 5.9 | 6.0 |
| footer — `text-dim` on `surface-alt` | 5.8 | 5.5 |
| captions on card — `text-dim` on `surface-card` | 5.6 | 6.9 |
| accent link — `accent-violet-light` on canvas | 10.5 | 5.7 |
| accent marker — `accent-violet` on card | 4.4 | 5.3 |
| inline code — `accent-cyan` on `surface-card-hover` | 8.4 | 4.7 |
| ink on accent fill — `text-on-accent` on `accent-violet` | 4.6 | 5.3 |
| terminal bar — `text-dim` on `surface-alt/60` over card | 5.7 | 6.1 |

`text-dim` used to sit at 4.2 in both themes — below AA. Treat ~5.5:1 as its floor and
`text-muted` ~8:1. If a new surface makes one fail, fix the token, never the one-off.
`surface-base` is the canvas and `surface-alt` the band; the footer rides the band, so
that pair is floored at 5.5 and pins `text-dim` from both sides.

### 1.4 Off-limits colour

Brand/identity colours that arrive as data stay as they are: contact `bg_color` values
from the DB (LinkedIn `#0A66C2`, Telegram `#27A7E7`, GitHub `#333333`, Email `#8B53FB`),
the terminal traffic-light dots (`#ff5f57` / `#febc2e` / `#28c840`) and `::selection`
(`accent-violet-deep` on white). Do not "tokenise" these.

---

## 2. Typography

- **One family: White Rabbit** — the site's own self-hosted `whiterabbit.woff2`, loaded
  with `next/font/local`. It ships a single weight (400), so semibold/bold are
  synthetic; design around that rather than mixing in a second face.
- Roles are size/tracking/colour, not different fonts: `heading` = headings,
  `body` = prose, `mono` = labels, meta, chips, buttons — all resolving to the same
  family so the "hybrid TUI" reading holds.
- Label convention: uppercase, `tracking-[0.08em]` (controls) to `[0.2em]` (eyebrows),
  `text-[11px]` for the micro tier.
- Scale in use: post/page titles `text-3xl md:text-4xl`; section titles
  `text-2xl sm:text-3xl`; card titles `text-xl`; drawer role titles `text-base`;
  body `0.95rem` at `1.85` line-height; prose captions `0.72rem`.
- No third-party display faces. Material Symbols exists only in the mockups and must be
  replaced by the repo's `lucide-react` + brand SVGs when ported.

---

## 3. Layout, surfaces, motion

- Containers: sections `max-w-5xl mx-auto px-6`; prose `max-w-3xl`; page padding
  `py-24`, hero `pt-24 md:pt-36`.
- **Section header pattern** (used on every section and page): centred title in
  `text-white`, mono subtitle in `accent-violet-light`, then a `40×1px` accent rule.
  The subtitle is always real copy from the CMS translations, never invented.
- Bands: hero and about share `bg-surface-alt/50` and read as one block; career and blog
  use full `bg-surface-alt`; portfolio, skills and contacts are transparent.
- Radii: cards and panels `rounded-2xl` (16px), inner media `rounded-xl` (12px),
  buttons `rounded-lg` (8px), chips `rounded` (4px).
- Borders: always 1px `border-subtle`; interaction raises the border to
  `accent-violet/40–/50`, optionally with a tinted shadow. **No image zoom on hover.**
- Motion: `transition-colors` ~300ms; nothing decorative. `prefers-reduced-motion`
  disables smooth scroll and transitions (mirrors the repo's existing rule).

---

## 4. Header and navigation

- Grid `grid-cols-[1fr_auto_1fr]` with **explicit `col-start-1/2/3`**. Hiding the nav on
  mobile otherwise drops it from the flow and the controls slide into the middle column.
- Logo: title-cms assets (`title-cms.png` 1937×293 dark, `title-cms-lightmode.png`
  1942×294 light), `h-6 w-auto max-w-none shrink-0 object-contain` (136×24 at every
  width), **no hover treatment**, links to the workspace root. Favicon and app
  icon derive from `cms.png`; the social card is `og-cms.png`.
- Mobile header: logo left, theme toggle + hamburger right (`col-start-3
  justify-self-end`, 44×44, `pr-3`) — the same placement as the website
  header. The toggle is the header icon variant (Sun/Moon/Smartphone,
  `Toggle theme`); the button toggles Menu/X in place (`aria-expanded`,
  `aria-controls`); there is no inner menu header and no profile control:
  identity lives only in the sidebar user banner.
- Desktop is headerless: the CMS wordmark sits in its own hairline-bounded block
  at the top of the sidebar, and the full workspace width goes to content.
- User banner: non-interactive `rounded-2xl` card with avatar (or initial
  fallback), display name and the shared `RoleChip` pill. It **closes both
  bottom clusters** — last, after the theme, language, account, Home and logout
  rows — in the desktop sidebar and in the pinned footer block of the fullscreen
  mobile menu (logo omitted there; the mobile header shows it). Keeping the
  interactive controls in one group and the identity last reads as a sidebar
  footer rather than splitting the two. The Account section stays the only
  interactive profile surface. Desktop paints
  it `border-border-subtle bg-surface-card`; **mobile paints it
  `border-border-subtle/60 bg-surface-card/40`** so the frosted panel reads
  through it rather than the banner stopping it dead. It takes no
  `backdrop-blur-*` of its own — that would nest inside the drawer's filter and
  blur the backdrop instead of the panel.
- Sidebar rows come in exactly two shapes, both owned by
  `src/components/layout/sidebarRowStyle.ts`. `SIDEBAR_ROW*` is the desktop
  row — `min-h-11`, `p-3`, `rounded-lg`, always-declared border, `h-5` icon,
  `text-sm font-medium` label — and the **section navigation and the bottom
  cluster (theme, language, account, home, logout) share it**, so only the
  semantic state differs: neutral is a transparent idle that raises to
  `bg-surface-raised` on hover, active is `accent-violet/30` +
  `accent-violet/10` with the label in `accent-violet-light` — the strong
  `accent-violet` stays on the row's border and fill, exactly as the site's
  desktop nav puts it on the underline instead of the text — logout is a red
  hover. No bottom control carries its own
  background fill or its own icon size.
- `SIDEBAR_MOBILE_ROW*` is the fullscreen drawer row: `text-3xl` heading labels
  and hairline dividers, active row `font-semibold text-accent-violet-light`,
  rows stagger in 40ms apart. **Section rows carry a mono `01`–`N` index** over
  one continuous sequence. The `mt-auto` footer block (language, Home link,
  logout) uses that same row shape but sits **outside the sequence and takes no
  index**, so its labels align with the drawer's own left edge instead of the
  indented section labels. Every row answers to a press: the base transition
  covers `background-color` alongside `opacity`/`translate`, idle rows raise to
  `bg-surface-raised`, the active section to `accent-violet/5`, logout to
  `red-500/10`, and `active:` matches each hover so a tap reads as a tap.
- Mobile menu: fullscreen panel under the CMS header (`fixed inset-x-0 top-16
  bottom-0`, `bg-surface-base/70` + `backdrop-blur-md`, `overflow-y-auto`,
  safe-area bottom padding); body scroll lock and focus trap while open;
  closes on section select, link tap and Escape; `aria-expanded` /
  `aria-controls` wired, hidden rows `tabIndex={-1}`. Draft dots,
  `aria-current` and the single-confirm global discard are preserved on both
  mobile and desktop.
- Two rules the panel must not break, because Tailwind resolves conflicting
  utilities by stylesheet order and not by class order: the drawer declares its
  background **once** (the opaque `lg:bg-surface-base` lives on the base, the
  mobile `/70` on the branch), and its transition **once** (the `lg:` overrides
  live on the base, the mobile property list on the branch). An opaque fill at
  mobile opacity, or a `transition-all` racing a property list, silently kills
  the frosted backdrop.
- The first group caption carries no `pt-4`: the panel's own `pt-6` already
  spaces it from the header, and stacking both opens a 40px hole above the
  first row.
- The bespoke `xs:` / `tablet:` / `mdh:` utilities are retired: standard Tailwind tiers
  cover every case. `SkillsCarousel` and the old `ResumeButton` card went with them,

---

## 5. Components

### 5.1 Cards (posts and projects)
Poster (4:3-ish, `md:w-72`/`md:w-80`, full-bleed), then body: title (`group-hover` →
`accent-violet-light`), 2–3 line description, then chips. Floating badges: view count
(eye + real `views`) bottom-right; star count only where a public repo exists. The whole
card is a link to `/{locale}/{type}/{id}/{slug}`; no hover zoom.

### 5.2 Chips / tags
`inline-flex items-center gap-1 rounded border border-border-subtle bg-surface-raised
px-2 py-0.5 font-mono text-xs text-text-muted`, with the Tag glyph tinted
`text-accent-violet/70`. Chips wrap; the live marquee behaviour is not part of the
redesign.

### 5.3 Career timeline
- One card per **company** (same company = same job, role upgrades grouped): newest role
  featured, older roles nested under a divider with their own title, dates, bullets and
  chips, all aligned to the same left edge (no indent).
- Date pill sits at the **card's top-right**, in the header row next to the logo/company;
  older roles keep an inline pill on their own row.
- Active role wears a `status-active` pip inside the pill.
- The line is drawn **dot-to-dot** per entry (`top-[13px]`, `-bottom-[61px]`, last entry
  none) so it starts at the first dot centre and ends at the last, and shares the dots' x
  axis — the old full-height border overshot 13px above and 261px below.
- Each card links to the company website; the logo is not a separate link.
- Logos: `max-h-10 w-auto object-contain` — constrain height only, so 3:1 marks render
  121×40 instead of being letterboxed into a 40×40 box.

### 5.4 Contacts and the project request form
- Contacts are the four real rows (Email, LinkedIn, GitHub, Telegram) with the DB
  `bg_color` as the tile accent. The résumé is the **header's** action, not a
  contact row: the site renders it from `hero_section.resume_${locale}`, and both
  PDFs are edited from **Layout** — Contacts owns its rows and its translations only.
- The request form is mock-only for now and will be built on `precall` (a library where
  the consumer owns the form and each field carries policy metadata such as
  `sendToAI`; email is the obvious not-to-AI field). Fields: Name, Email, Company,
  existing website/repo, Project type, Budget range, Desired timeline, "What are you
  building?", consent checkbox linking the privacy page, submit.
- Form header block, consent row and submit button are **centred, each on its own row**.
- A diagonal "Coming soon!" band overlays the card, translucent enough to read the form
  and applied with `aria-hidden`.

### 5.5 Footer
Left: `Made with ❤️ by` + the name **linked to the GitHub profile**, then `Source Code`
linking the repo — both with the violet hover. Middle: the VAT value as a
copy affordance carrying `footer.buttonTitle`. Right: CMS and Privacy Policy links.

Everything in that sentence except two values is frozen chrome (§8). The **display
name** and the **VAT number** are data — `site_settings.footer_name` and
`footer_vat_number`, both nullable `TEXT` — and they render the literals `Okazakee`
and `02863310815` whenever a column is null or blank, so an unconfigured row is
indistinguishable from the footer before the CMS existed. One resolved string feeds
both the label and the clipboard, so a leading zero survives, and the GitHub, repo,
CMS and privacy hrefs stay site-owned: a custom name never retargets them.

### 5.6 Back to top
Fixed bottom-right, inverted fill (`bg-text-main` on `text-surface-base`), `rounded-xl`,
mono `Top` label (kept for clarity over the live "Go back up"), fades in on scroll and
lifts near the page end.

### 5.7 Code blocks and prose
Fenced code renders with the "Code" header bar and a copy affordance. Prose:
headings `text-white`, body `text-main` (this was the fix — muted
tone was too weak), lists with violet markers, links `accent-violet-light` underlined,
tables as bordered rounded panels with mono uppercase headers, figures with mono
captions and the blurhash as the placeholder background.

### 5.8 CMS editor surfaces

The editor is a different app from the page it edits, but it answers to the same
canon. Every section renders through the shared pieces rather than its own markup,
so a new section cannot drift into a private look:

- **Page head** — `SectionHeader`: `font-heading text-2xl sm:text-3xl` title,
  mono `text-accent-violet-light` description and a 10×2 accent rule, centred. It
  renders at every breakpoint; the mobile header carries only the wordmark, so a
  section that hides its own title leaves mobile with no heading at all.
- **Body groups** — `EditorGroup` / `EditorToolbar` from
  `src/components/cms/shared/EditorBody.tsx` own headings, optional counts,
  descriptions and contextual actions. Groups use `rounded-2xl border
  border-border-subtle bg-surface-card p-4 sm:p-6`, neutral `text-text-white`
  headings and 24px spacing. Related fields have 16px spacing; short pairs
  may share a row, but long-form text keeps the full width. Compact collection
  rows and nested editors use `rounded-xl`; the danger zone remains a
  separate `rounded-2xl border border-red-500/30 bg-red-500/5` panel.
- **Fields** — label `block text-sm font-medium text-text-main mb-1`; control
  `w-full px-3 py-2 bg-surface-base border border-border-subtle rounded-lg text-sm
  text-text-main focus:border-accent-violet focus:outline-none`. Borders are
  `border-subtle` until the field is interacted with, never `accent-violet` at rest.
- **Choice controls** — author, remote type, portrait shape, button kind and
  role render through the shared `Dropdown`
  (`@/components/cms/shared/Dropdown`) so a choice wears the field canon and reads
  like its sibling inputs. The menu is portalled to `document.body`, so a section's
  `overflow` can never clip it; the highlighted row is `accent-violet/10`, the
  selected row `accent-violet-light` + a check, and `triggerClassName` replaces the
  trigger chrome (the role pill keeps its coloured pill).
- **Body actions** — shared primary/secondary button classes from `EditorBody`
  use 44px minimum hit targets, violet for the main action and neutral surfaces
  for secondary actions. Row actions follow reorder → edit → delete where
  supported, with boundary moves disabled and localized accessible names.
  On narrow screens, row actions sit below the identity/content instead of
  squeezing names between thumbnails and buttons. Existing `SectionHeader`
  titles/subtitles and `SectionActions` Revert/Publish controls stay unchanged.
  Content composers say **Add to draft / Apply to draft**; these never publish.
  Requests, Users and Account explicitly identify their immediate operations
  and do not join the draft queue.
  Destructive confirmations keep the red treatment.
- **Status** — `ErrorBanner` for any failure, both the page-level one and a
  scoped one inside a card. Never a hand-rolled `bg-red-500/10` block.
- **Spinners** — `border-2 border-<colour> border-t-transparent`, never `border-b-2`.
- **Role** — `RoleChip` / `RoleSelect` from `@/components/cms/shared/RoleChip`, one
  source of truth for how a role reads. The prop is `cmsRole`, **not** `role`:
  `role` is a reserved ARIA attribute, and a literal `role="admin"` on a component
  fails `useValidAriaRole` and is invalid ARIA if it ever reaches a DOM node.
- Read-only values are rendered with the field classes on a `<span>` inside a
  bordered `bg-surface-base` panel, so a value and its editable twin read as the
  same object.
- **Body patterns** — Hero uses Identity → Roles → About → Portrait (image and
  shape together). Career, Portfolio and Blog have compact summary lists and
  full-width grouped composers, not drawers or public-style card galleries.
  Portfolio/Blog separate title/summary, body, cover and publication details;
  Portfolio also has ordered project links. Skills keeps category → skill
  hierarchy with inline editing; Contacts uses the same field order for
  creation and inline editing. Requests exposes compact summaries and native
  expandable details while keeping archive/delete actions reachable. Account
  separates Profile, read-only Identity/access, Passkeys and the final Danger
  zone; Users keeps identity/access separate from role/actions.
- **Localization** — one EN/IT switch per localized editor context; field
  labels remain neutral and the selected language is shown separately. Both
  locale drafts survive switches. Collection summaries use the UI locale
  with English fallback. Shared settings such as Contacts/Skills/Layout have
  no content-language switch. Request-form copy is grouped into Introduction,
  field labels/hints/options, Consent/submission and Additional copy; unknown
  keys from either locale remain editable. Static lookup records and localized
  getters check own keys so names such as `constructor`/`toString` cannot be
  mistaken for inherited members.
- **Assets** — `FileDropzone` owns preview and Replace/Open/Copy/Download/Remove
  controls. Pending/current status comes from the explicit selected-file flag,
  not from the presence of a preview URL (committed assets also have previews).
  PDF previews, technical URLs and formatting help use native disclosure
  controls. Layout groups matching dark/light header-image panels and footer
  VAT. Resume has matching EN/IT PDF panels, both visible and stacked on mobile.
- **Content ownership** — Hero edits the name, ordered roles, about paragraph
  and portrait/shape; Privacy edits policy bodies. Structural headings and
  vocabulary remain website-local. Layout owns header images and textual VAT;
  System → Resume owns PDFs. The standalone Website copy section remains gone.
  Request-form copy keeps its planned/no-live-site-effect warning.
- **Copy editors are addressed by their namespace key**, never by DOM position. A
  section that embeds a `CopyEditor` must give its own body control an `aria-label`,
  and tests select on that: `querySelector('textarea')` silently retargets to
  whichever copy editor mounted first.
- **Navigation state** — a fresh store starts with no active section so boot
  can restore an allowed `cms_active_section`, otherwise choosing the first
  allowed section. Visited editors stay mounted while hidden: navigation must
  preserve local drafts and raw Publish All callbacks.

---

## 6. Page patterns

- **Home**: hero → about → skills → career → portfolio → blog → contacts (+ request
  form). The six nav buttons are site-side: their labels are frozen copy in the
  site repo and each links to its own section id, so nothing about the nav is
  stored or editable here.
- **List pages**: section header, search field, then cards. Search states (empty,
  rate-limited) still need designing.
- **Post detail** (one route, both post types, blocks rendered conditionally):
  - desktop: title → description → tags → poster → meta row (quick links for portfolio,
    author for blog, date, stars, views, share pushed right) → prose.
  - mobile: same down to the poster, meta row shows date/views/share, and the
    conditional blocks move **below** it — portfolio quick links as rows of two
    full-width buttons, blog author as its own row. This mirrors the live page exactly.
- **Privacy**: numbered sections (`01`, `4.1`) via CSS counters — free, no parser work —
  long-form prose, no table of contents. `Last updated` sits under the title.
- **Error**: terminal-window card, vertically centred in the space between header and
  footer, with retry + home actions.

---

## 7. Responsive canon

- **Standard Tailwind tiers only** (sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536).
  The repo's bespoke `xs:` (400–1100px) and `tablet:` (768–1279px) utilities and the
  height-based media queries are **retired** — they existed to paper over edge cases the
  redesign removes. Porting therefore means remapping ~22 `xs:`/`tablet:` usages onto the
  standard tiers.
- Breakpoint decisions: desktop nav at `lg`; cards switch to their horizontal layout at
  `md`; prose stays single-column at every width.
- Mobile specifics: tap targets ≥ 44px, header right padding 12px, logo 136×24, skill
  tiles 96px (three per row), drawer rows 44px, no horizontal overflow at 390.
- Verified clean at 390 / 768 / 1024 / 1440 in both themes.

---

## 8. Data fidelity rules

Every string and value in the UI comes from the database or an existing translation key.
Invented copy is a defect, not a placeholder.

**Sources of truth**

| UI | source |
|---|---|
| all copy | `i18n_translations.translations`, editable namespaces only: `hero-section`, `skills-section`, `career-section`, `contacts-section`, `posts-section` (headings only), `privacyPolicy` (description only), `request-form` |
| frozen copy | `header`, `footer`, `errors` and the `posts-section` chrome are **not** in the database any more: they are site invariants and live in `okazakee-ws` at `src/i18n/messages/site.{en,it}.json`, merged one namespace deep with **local winning** (`src/i18n/siteCopy.ts`). Migration `20261005120000_freeze_static_site_copy.sql` drops them. **The ws local files must deploy in the same release as the migration** — applied alone, those namespaces are simply absent. Same rule, same shape, as `requestForm` and `postButtons` |
| hero name/about | `hero-section.top.name`, `hero-section.aboutme.*` |
| hero roles | `hero-section.top.roles.0…` as a numeric index map (`top.roles.1`, `top.roles.2`, …) when the list exists; the singular `hero-section.top.role` stays as the live fallback for content written before the list and is never migrated away |
| hero portrait/animation | `hero_section.shape` (`pebble` \| `square` \| `rounded` \| `squircle`, null = pebble), `hero_section.typewriter`, `hero_section.typewriter_target` (`role1` \| `role2` \| `all`, null = role1) |
| skills | `skills_categories` (ordered by `position`) + nested `skills` (`icon` URL, `invert`, optional `link` URL, `position` inside its category; `position` NULL sorts last with an id tiebreak) |
| career | `career_entries` (`logo`, `website_url`, `location_*`, `remote`, `startDate`/`endDate`, `description_*`, `skills`) |
| contacts | `contacts` rows (`label`, `link`, `icon`, `bg_color`) |
| posts | `blog_posts` / `portfolio_posts` (`title_en` + `title_${locale}`, `description_*`, `body_*`, `image` + `blurhashURL`, `post_tags`, `views`); project quick links come from `portfolio_posts.buttons` |
| post buttons | `portfolio_posts.buttons` — an ordered jsonb array of `{ kind, url, label? }`, `kind` ∈ `website` \| `source` \| `demo` \| `store` \| `fdroid` \| `ios` \| `custom`. **Array order is render order.** The editor owns the order and the URL only: the label and icon of a preset belong to the public site, so `label` is read only for `custom` and is required there. `url` must be an absolute http(s) URL. Blog posts have no buttons — the column is portfolio-only |
| legacy link columns | `website` / `source_link` / `demo_link` / `store_link` / `fdroid_link` / `ios_store_link` stay in the table but are no longer written. They are the fallback: a row with null/empty `buttons` renders from them (website, source, demo, store, fdroid, ios), which is what makes the migration a no-op for existing content. Migration `20261004111000_backfill_post_buttons.sql` populates `buttons` from them; dropping the columns is a separate, later decision |
| author | `user_profiles` via `author_id` (`display_name`, `avatar_url`) |
| chrome configuration | `site_settings` — one row: `header_logo_dark` / `header_logo_light` (absolute URL, NULL = the bundled `title-ws*.png` asset, resolved per theme) and the footer identity (`footer_name`, `footer_vat_number`). These are configuration, not copy, so they live in their own table rather than in the `i18n_translations` jsonb, and every one of them is edited from the single **Layout** section |
| navigation | site-side only: the six nav buttons' labels are frozen copy in `okazakee-ws/src/i18n/messages/site.{en,it}.json`, and each button links to its own section id. Nothing about the nav is stored or editable in the CMS — the legacy `site_settings.nav_anchors` jsonb column is left in place, unread and unwritten |
| footer identity | `site_settings.footer_name` / `footer_vat_number` — nullable `TEXT` (the leading zero of an Italian VAT number is part of the identifier, so the value is never parsed and never numeric); NULL or blank stores NULL and renders the defaults the site already ships, `Okazakee` and `02863310815`. Added by `20261005150208_add_site_settings_footer_identity.sql` (renamed from `20261005145655_...`, identical statement bytes): explicitly `dev_staging.`-qualified, nullable columns with **no backfill**, so it is a no-op for the rendered footer and `public` is untouched. Dev authority lives in `dev_staging.cms_migration_audit` (`verified_existing` = schema effects + source hash audited, not original execution provenance). No automatic apply exists; future DB changes stay explicitly reviewed/manual and the 7 original public/unqualified historical sources must never be replayed against shared `public` |
| resume | `hero_section.resume_en` / `resume_it` — the columns are unchanged, but the **Layout** section owns them: the editors moved here from Contacts, which now edits contact rows and its translations only |
| project requests | `project_requests` (`locale`, `name`, `email`, `company`, `website`, `project_type`, `budget`, `timeline`, `request`, `consent`, `created_at`, `archived`, `archived_at`) — **personal data**: service_role only, no anon/authenticated grant, never in the public cache-tag vocabulary. Rows arrive from `okazakee-ws` `POST /api/requests`, which re-validates the payload server-side and writes through the service-role client; the CMS inbox is the only reader |

**Custom formatting to honour**

- `****text****` → violet-tinted `<label>` (the site's `formatLabels`) — hero name/role, the about
  paragraph and section subtitles. Only words the DB actually wraps are tinted.
- `post_tags` is a quoted list (`["Docker","Bun"]`) parsed by regex; unquoted fragments
  (e.g. a stray `Tags` token in one row) are ignored.
- Markdown images use `![caption-blurhash](url)`: the caption before the first `-`, the
  remainder as the blur placeholder; images open in the lightbox with a "Click to view"
  hint.
- Code fences → the "Code" block with copy; markdown tables render as panels.

**Known quirks** found while porting:

- Fixed: `GitHubStars` now ignores profile/organisation links (`source_link` for
  MinePanel is an org URL, which used to fetch a repo that 404s and render ★ 0).
- Open: the 404 routes answer **HTTP 200** (soft 404). The dev server also logs
  `Could not validate 'instant' …` on that path. Both predate the redesign and come from
  how unknown single-segment paths land on `/[post_type]` and call `notFound()`.
- Open: `sitemap.ts` slugs posts differently from the card link helper, so it advertises
  `/blog/12/dear-mom...` while the card links `/blog/12/dear-mom`.

**Writing CMS copy:** read the current `translations` object, merge the change and patch
it back. Patching from an older snapshot silently reverts whatever was added in between —
that already cost the `request-form` namespace and the `Top` label once.

**Ordered lists in translations** (`hero-section.top.roles`, the
`request-form` `typeOptions`): they are stored as a numeric index map, because
the section DELTA merges arrays per index and can never shorten one. Removing
the last entry therefore leaves a `null` at that index rather than truncating
the array — every reader (the site, the roles editor) skips
blank/`null` slots, so the hole is invisible. The singular `hero-section.top.role`
is deliberately left in place as the fallback for content that predates the list.

**Project-request inbox** (`RequestsSection`, admin-only, no Publish All callback):

- **Archive is a boolean, not a status column.** `archived` plus `archived_at` is
  the whole model: the inbox has exactly two slices (active / archived) and one
  predicate. An enum-shaped status would add a vocabulary — and a CHECK
  constraint — for a distinction the product never draws. Archiving moves a row
  between slices; deleting removes it. Both mutations return
  `BatchCommitEvidence`, and a zero-row outcome is reported as a failure: a
  "success" that changed nothing is a defect, not a no-op.
- **Editors cannot see requests.** Every row carries a name, an email address
  and free text a visitor typed, so the inbox is personal data, not editorial
  content. `requestEntriesActions` calls `requireAdmin()` before touching the
  service-role client, so hiding the nav entry is presentation, not the
  control.
- **No revalidation.** Requests are private operational data and are kept out
  of the cache-tag vocabulary entirely — a saved request never fires an
  `invalidatePublicContent` event.
- The form's own copy is a site invariant (see `okazakee-ws`
  `src/i18n/messages/requestForm.{en,it}.json`), like the post-button labels:
  an editor must not be able to retitle a validation message. The option
  VALUES are storage (`project_type` / `budget` / `timeline`) and stay English
  in both locales; only their display labels are translated.

**The drawer `Language` label** (`header.language`) is frozen in the site copy and
read from both navs; nothing in the drawer is English-only any more.

---

## 9. Accessibility

Contrast floors per §1.3; 44px minimum tap targets; visible focus states via the accent
border; `aria-expanded`/`aria-controls` on the drawer toggle and `aria-label` on icon
buttons; Escape closes the drawer; body scroll locked while it is open; decorative
overlays marked `aria-hidden`; `prefers-reduced-motion` honoured.

---

## 10. What is mock-only

The mockups are HTML files: Tailwind Play CDN with an inline config, Material Symbols,
Google-hosted fonts, inline scripts and static data. In the repo the equivalents are the
JS Tailwind config, `lucide-react` + brand SVGs, `next/font/local`, client components and
DB reads. Nothing from the mocks' plumbing ships — only their structure, tokens and
behaviour.

Still undesigned: search result states, the blog list page mock, detail-page
  interactions (lightbox, share, view increment) and blur-up placeholder states.
