-- 20261004090000_add_hero_display_options.sql
-- Hero presentation settings that are NOT copy: the portrait shape preset,
-- the typewriter toggle and the line it animates. They live on the single
-- hero_section row next to the propic they act on.
--
-- Every column is additive and defaulted, which is what keeps existing rows
-- rendering exactly as before with no backfill: a null shape is the pebble
-- portrait and a false typewriter is the static role line. The public site
-- (okazakee-ws, read-only) selects these columns and normalises unknown
-- values back to those same defaults.

alter table public.hero_section
  add column if not exists shape text,
  add column if not exists typewriter boolean not null default false,
  add column if not exists typewriter_target text;

comment on column public.hero_section.shape is
  'Portrait preset: pebble | square | rounded | squircle. Null renders pebble.';
comment on column public.hero_section.typewriter is
  'Typewriter animation on the hero role line.';
comment on column public.hero_section.typewriter_target is
  'Role line that is typed: role1 | role2 | all. Null behaves as role1.';

-- Rollback (reversible, no data dependency):
--
-- alter table public.hero_section
--   drop column if exists shape,
--   drop column if exists typewriter,
--   drop column if exists typewriter_target;