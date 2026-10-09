-- Copy the CMS can no longer edit moves into the site, not the database.
--
-- errors, header, footer and the posts-section chrome are structural, not
-- editorial: an editor retitling "Page not found" or reordering the nav breaks
-- the product rather than the words. They now live in okazakee-ws at
-- src/i18n/messages/site.{en,it}.json and are merged local-over-DB in
-- src/i18n/siteCopy.ts, next to the existing postButtons / requestForm files.
--
-- DEPLOY ORDER: the ws local files must ship in the SAME release as this
-- migration. Applied alone, these namespaces are simply absent from the
-- database and the pages that read them fall back to missing keys.
--
-- What stays editable, and where each key moved:
--   posts-section title1/subtitle1 -> the Portfolio section
--   posts-section title2/subtitle2 -> the Blog section
--   privacyPolicy description      -> the Privacy policy section
--   career-section                 -> untouched (see below)
--
-- career-section is deliberately untouched. Its date and remote-type
-- vocabulary (month/months/year/years/present/remote.*) is already edited
-- from the Career section itself, which is where it belongs: freezing it
-- would delete a working editor and buy nothing.
--
-- header.buttons is index-aligned with navAnchors and must keep one order
-- across both locales. The stored Italian array had Career and Portfolio
-- transposed, which is why NavMenu carried a hardcoded Italian label list;
-- that workaround is gone and the pair is only ever edited together in the
-- site file.
--
-- TWO THINGS THIS FILE MUST KEEP DOING:
--
-- 1. UPDATE, never DELETE. Every row carries all ten namespaces, so
--    `delete from i18n_translations where translations ?| array[...]` does
--    not remove the frozen keys — it removes the en and it ROWS, taking the
--    editable copy with them. Strip keys with the jsonb `-` operator instead.
--
-- 2. Parenthesise the jsonb arrow before subtracting. `->` and `-` share one
--    precedence level, so `translations -> 'ns' - 'key'` parses as
--    `translations -> ('ns' - 'key')` and dies with "operator is not unique:
--    unknown - unknown".
--
-- SCHEMA: this project holds production content in `public` and the cloned
-- working copy in `dev_staging`, in ONE database. Every statement below is
-- deliberately UNQUALIFIED so it resolves through search_path — a hardcoded
-- `public.` would quietly delete production copy when run from the dev
-- workflow. Apply it like this:
--
--   dev:  set search_path = dev_staging;  -- then run this file
--   prod: leave search_path at public      -- after the ws local files ship
--
-- Reversible: restore the previous values from git history at this file's
-- parent commit. header.settings is deliberately not restored — it had no
-- consumer in either repo.

-- Wholesale removal is only correct for namespaces with nothing editable left.
update i18n_translations
   set translations = translations - 'errors' - 'header' - 'footer';

-- posts-section KEEPS title1/title2/subtitle1/subtitle2 — they moved to the
-- Portfolio and Blog sections, they are still editable. Dropping the whole
-- namespace instead throws the headings away with the chrome and every
-- heading on the home and list pages renders as MISSING_MESSAGE.
update i18n_translations
   set translations = jsonb_set(
         translations,
         '{posts-section}',
         (translations -> 'posts-section')
           - 'website'
           - 'source'
           - 'ios'
           - 'store'
           - 'fdroid'
           - 'demo'
           - 'button'
           - 'copyButton'
           - 'preCopy'
           - 'no-posts'
           - 'ratelimit'
           - 'searchbar'
       )
 where translations ? 'posts-section';

-- privacyPolicy keeps description, loses title.
update i18n_translations
   set translations = jsonb_set(
         translations,
         '{privacyPolicy}',
         (translations -> 'privacyPolicy') - 'title'
       )
 where translations ? 'privacyPolicy';