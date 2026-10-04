-- 20261004111000_backfill_post_buttons.sql
-- Populate portfolio_posts.buttons from the six legacy link columns.
--
-- The public site renders `buttons` when it is non-empty and otherwise falls
-- back to the legacy columns, so this backfill is an optimisation for
-- correctness of intent rather than a requirement: a row left NULL keeps
-- rendering exactly as it did before. Running it makes the editor show the
-- buttons instead of a derived list, and makes JSON-LD and the GitHub-stars
-- widget read the same array as the quick links.
--
-- The order matches what the page has always rendered: website, source,
-- demo, store, fdroid, ios. Empty/null legacy values are skipped so a blank
-- input never becomes a button pointing nowhere.
--
-- IDEMPOTENT: only rows whose buttons is NULL or an empty array are touched,
-- so re-running never overwrites an arrangement an editor has since made, and
-- is a no-op once every row is populated. Rows with no legacy links at all
-- become an empty array (never NULL), which also renders nothing.

update public.portfolio_posts p
set buttons = coalesce(
    (
      select jsonb_agg(
               jsonb_build_object('kind', v.kind, 'url', btrim(v.url))
               order by v.ord
             )
      from (
        values
          (1, 'website', p.website),
          (2, 'source',  p.source_link),
          (3, 'demo',    p.demo_link),
          (4, 'store',   p.store_link),
          (5, 'fdroid',  p.fdroid_link),
          (6, 'ios',     p.ios_store_link)
      ) as v(ord, kind, url)
      where v.url is not null and btrim(v.url) <> ''
    ),
    '[]'::jsonb
  )
where p.buttons is null or p.buttons = '[]'::jsonb;

-- REVERSIBLE
--   update public.portfolio_posts set buttons = null;
--   (the legacy columns are still intact, so the public site falls back to
--   them and renders exactly as it did before this backfill)