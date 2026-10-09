-- Dev-only content change: the `dev_staging` clone's Skills section becomes the
-- current stack, and each skill fills the `link` column added by
-- `20261004090000_add_skill_link_and_position.sql` (the public tile renders a
-- non-empty link as an external anchor; NULL keeps the plain tile).
--
-- WHY: `dev_staging` is the dataset the staging CMS branch writes and the local
-- website and CMS read (`NEXT_PUBLIC_SUPABASE_DB_SCHEMA=dev_staging`). The
-- three non-AI categories are replaced by:
--
--   Application Engineering   TypeScript, React, Next.js, React Native,
--                             Expo, Node.js
--   Platforms & Integrations  PostgreSQL, Supabase, API Integrations,
--                             Payments & Wallets
--   Systems & Delivery        Linux, Docker, CI/CD, Self-hosting, Networking
--
-- "AI & Agentic Workflow" (category 6) is deliberately untouched: its rows,
-- names, order and NULL positions stay exactly as they are, so a skill the
-- editor already owns is never rewritten by a content migration.
--
-- Category ids 4 / 5 / 3 keep their existing 0 / 1 / 2 positions and are only
-- renamed, so no category may be inserted or deleted and the untouched
-- category 6 keeps position 3.
--
-- Retained rows keep their ids (16 TypeScript, 17 React, 19 Next.js,
-- 18 Expo, 23 PostgreSQL, 13 Supabase, 25 API Integrations, 14 Docker,
-- 27 CI/CD) and are rewritten to their target title, icon, invert flag, link
-- and dense in-category position. Supabase changes category: the old "Tools"
-- category held it, and it now belongs to Platforms & Integrations, so its
-- update also carries the new `category_id`.
--
-- Eight rows leave the section (11 Git, 12 Vercel, 15 Bash, 20 Tailwind CSS,
-- 21 Bun JS, 22 NestJS, 24 SQLite, 26 WebSockets) and six rows join it
-- (React Native, Node.js, Payments & Wallets, Linux, Self-hosting,
-- Networking).
--
-- Links are the skill's own documentation/homepage. Two entries are capability
-- names rather than products and point at the canonical reference for the
-- capability (API Integrations -> MDN HTTP, Networking -> Cloudflare Learning).
-- Icons stay on hosts the site already renders (cdn.jsdelivr.net, uxwing.com)
-- and keep the `invert` convention: true for monochrome black artwork that
-- needs `dark:invert`, false for brand-coloured artwork.
--
-- SCHEMA: every statement is explicitly `dev_staging.`-qualified so it cannot
-- resolve through search_path and cannot reach production content. Against a
-- database without a `dev_staging` schema this file fails loudly instead of
-- touching `public`:
--   dev:  apply as-is (the staging CMS and local dev already resolve
--         dev_staging)
--   prod: do not replay this file; `public` keeps its own skills content
--
-- IDEMPOTENT: category/row updates are keyed on stable ids, the deletes are
-- id-keyed, and the inserts skip a (category_id, title) pair that is already
-- present — re-running converges instead of duplicating rows. An editor's
-- later additions in the same categories are left alone.

update dev_staging.skills_categories
   set name = 'Application Engineering'
 where id = 4;

update dev_staging.skills_categories
   set name = 'Platforms & Integrations'
 where id = 5;

update dev_staging.skills_categories
   set name = 'Systems & Delivery'
 where id = 3;

-- Application Engineering (category 4)
update dev_staging.skills
   set title = 'TypeScript',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/typescript/typescript-original.svg',
       invert = false,
       link = 'https://www.typescriptlang.org/',
       position = 0
 where id = 16;

update dev_staging.skills
   set title = 'React',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/react/react-original.svg',
       invert = false,
       link = 'https://react.dev/',
       position = 1
 where id = 17;

update dev_staging.skills
   set title = 'Next.js',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nextjs/nextjs-plain.svg',
       invert = true,
       link = 'https://nextjs.org/',
       position = 2
 where id = 19;

update dev_staging.skills
   set title = 'Expo',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/expo/expo-original.svg',
       invert = true,
       link = 'https://expo.dev/',
       position = 4
 where id = 18;

-- Platforms & Integrations (category 5)
update dev_staging.skills
   set title = 'PostgreSQL',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/postgresql/postgresql-original.svg',
       invert = false,
       link = 'https://www.postgresql.org/',
       position = 0
 where id = 23;

update dev_staging.skills
   set title = 'Supabase',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/supabase/supabase-original.svg',
       invert = false,
       category_id = 5,
       link = 'https://supabase.com/',
       position = 1
 where id = 13;

update dev_staging.skills
   set title = 'API Integrations',
       icon = 'https://uxwing.com/wp-content/themes/uxwing/download/web-app-development/rest-api-icon.svg',
       invert = true,
       link = 'https://developer.mozilla.org/en-US/docs/Web/HTTP',
       position = 2
 where id = 25;

-- Systems & Delivery (category 3)
update dev_staging.skills
   set title = 'Docker',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/docker/docker-original.svg',
       invert = false,
       link = 'https://docs.docker.com/',
       position = 1
 where id = 14;

update dev_staging.skills
   set title = 'CI/CD',
       icon = 'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/githubactions/githubactions-original.svg',
       invert = false,
       link = 'https://docs.github.com/en/actions',
       position = 2
 where id = 27;

delete from dev_staging.skills
 where id in (11, 12, 15, 20, 21, 22, 24, 26);

insert into dev_staging.skills
  (title, icon, invert, category_id, "blurhashURL", link, position)
select v.title, v.icon, v.invert, v.category_id, '', v.link, v.position
  from (
    values
      ('React Native',
       'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/reactnative/reactnative-original.svg',
       false, 4, 'https://reactnative.dev/', 3),
      ('Node.js',
       'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nodejs/nodejs-original.svg',
       false, 4, 'https://nodejs.org/', 5),
      ('Payments & Wallets',
       'https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/bitcoin.svg',
       true, 5, 'https://bitcoin.org/', 3),
      ('Linux',
       'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/linux/linux-plain.svg',
       true, 3, 'https://www.kernel.org/', 0),
      ('Self-hosting',
       'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/nginx/nginx-original.svg',
       false, 3, 'https://awesome-selfhosted.net/', 3),
      ('Networking',
       'https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/cloudflare/cloudflare-original.svg',
       false, 3, 'https://www.cloudflare.com/learning/networking/', 4)
  ) as v(title, icon, invert, category_id, link, position)
 where not exists (
   select 1
     from dev_staging.skills s
    where s.category_id = v.category_id
      and s.title = v.title
 );

-- REVERSIBLE
-- The pre-change section is the eight-row/two-category shape recorded in
-- `public.skills_categories`/`public.skills` (untouched, still identical to the
-- dev_staging rows this file started from), so restore by copying that data:
--   delete from dev_staging.skills where category_id in (3, 4, 5);
--   insert into dev_staging.skills (id, title, icon, invert, category_id,
--     "blurhashURL", link, position)
--   select id, title, icon, invert, category_id, "blurhashURL", null, null
--     from public.skills where category_id in (3, 4, 5);
--   select setval('dev_staging.skills_id_seq',
--     (select max(id) from dev_staging.skills));
--   update dev_staging.skills_categories set name = 'Frontend & Mobile' where id = 4;
--   update dev_staging.skills_categories set name = 'Backend & Data'   where id = 5;
--   update dev_staging.skills_categories set name = 'Tools'            where id = 3;
-- Category 6 and every ids 28/29/32/33 row are never touched, so the restore
-- cannot disturb them.
