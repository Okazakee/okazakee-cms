-- Per-skill link and per-skill ordering inside its category.
--
-- Two capabilities the CMS could not express before:
--
--   * link      — optional http(s) URL. When set, the public site renders the
--                 skill tile as an external anchor; when NULL (or empty) the
--                 tile renders exactly as it does today, with no markup change.
--                 Existing rows stay NULL, so the deployment is a no-op until
--                 an editor fills the field in.
--   * position  — order of the skill inside its own category, mirroring the
--                 `skills_categories.position` convention (0-based, dense).
--                 NULL means "never ordered": the public read layer sorts
--                 NULLs last with an id tiebreak, so un-ordered rows keep
--                 their current relative order instead of jumping around.
--
-- Existing rows are deliberately left NULL (no backfill): the CMS assigns
-- dense positions for a category the first time an editor reorders it.
--
-- REVERSIBLE
--   alter table public.skills drop column link;
--   alter table public.skills drop column position;

alter table public.skills
  add column if not exists link text;

alter table public.skills
  add column if not exists position integer;

comment on column public.skills.link is
  'Optional http(s) URL rendered as an external link on the public skill tile.';
comment on column public.skills.position is
  'Order of the skill inside its category; NULL sorts last (never ordered).';