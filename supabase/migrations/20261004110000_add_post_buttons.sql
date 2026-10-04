-- 20261004110000_add_post_buttons.sql
-- Ordered buttons on a portfolio post.
--
-- Replaces the six fixed link columns (website, source_link, demo_link,
-- store_link, fdroid_link, ios_store_link) as the thing an editor arranges:
-- one ordered jsonb array whose order IS render order. Each entry is
--
--   { kind: 'website'|'source'|'demo'|'store'|'fdroid'|'ios'|'custom',
--     url:  string,          -- absolute http(s) URL
--     label?: string }       -- required for 'custom', ignored for presets
--
-- The label and the icon of a preset belong to the public site
-- (okazakee-ws), not to CMS-editable translations, so an editor cannot
-- retitle "Source code". Only `custom` carries a label.
--
-- The column is nullable and defaults to NULL on purpose: NULL means "never
-- arranged", and the public site falls back to the legacy columns in the
-- order it has always rendered them. The separate backfill migration
-- (20261004111000) populates it for existing rows; until it has run, and for
-- any row it leaves NULL, nothing changes on the public site.
--
-- The legacy columns are deliberately NOT dropped here — they stay in place
-- so the fallback keeps working and so the change can be reverted. Dropping
-- them is a separate, later decision.

alter table public.portfolio_posts
  add column if not exists buttons jsonb;

comment on column public.portfolio_posts.buttons is
  'Ordered quick-link buttons: [{kind, url, label?}] where kind is website|source|demo|store|fdroid|ios|custom. Array order is render order; label is read only for custom. NULL/empty falls back to the legacy link columns.';

-- REVERSIBLE
--   alter table public.portfolio_posts drop column if exists buttons;