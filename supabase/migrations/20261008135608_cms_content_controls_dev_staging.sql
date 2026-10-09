-- Dev-only CMS content cutover. Every content statement targets dev_staging;
-- public content, shared Auth identities and production Storage are untouched.
-- Contact SVGs must already exist in website-dev/content-controls/20261008135608.

alter table dev_staging.hero_section
  drop column if exists typewriter,
  drop column if exists typewriter_target;

alter table dev_staging.site_settings
  drop column if exists header_logo_dark,
  drop column if exists header_logo_light,
  drop column if exists nav_anchors,
  drop column if exists footer_name;

-- Preserve an existing role list, including an intentionally empty list.
-- Only legacy rows without a list inherit their singular role.
update dev_staging.i18n_translations
set translations = jsonb_set(
  translations,
  '{hero-section,top}',
  (coalesce(translations #> '{hero-section,top}', '{}'::jsonb) - 'role')
    || jsonb_build_object('roles',
      case
        when (translations #> '{hero-section,top}') ? 'roles'
          then translations #> '{hero-section,top,roles}'
        when nullif(btrim(translations #>> '{hero-section,top,role}'), '') is not null
          then jsonb_build_array(translations #>> '{hero-section,top,role}')
        else '[]'::jsonb
      end
    ),
  true
)
where translations ? 'hero-section';

-- Structural headings and vocabulary now belong to the website's EN/IT files.
update dev_staging.i18n_translations
set translations = translations - array[
  'errors', 'header', 'footer', 'skills-section', 'career-section',
  'posts-section', 'contacts-section', 'privacyPolicy'
];

-- Resolve the project's Storage origin from its existing portrait URL instead
-- of baking a generated project ID into a data migration. These assets are
-- isolated from the website production bucket.
with origin as (
  select substring(propic from '^(https?://[^/]+)') as url
  from dev_staging.hero_section
  order by id
  limit 1
), icons(name, filename) as (
  values
    ('MailPlus', 'contact-mail-plus.svg'),
    ('linkedin', 'contact-linkedin.svg'),
    ('github', 'contact-github.svg'),
    ('send', 'contact-send.svg')
)
update dev_staging.contacts c
set icon = origin.url
  || '/storage/v1/object/public/website-dev/content-controls/20261008135608/'
  || icons.filename
from origin, icons
where c.icon = icons.name and origin.url is not null;

-- Backfill dense positions without changing the existing position/id order.
with ordered as (
  select id, row_number() over (order by position nulls last, id) - 1 as position
  from dev_staging.contacts
)
update dev_staging.contacts c set position = ordered.position
from ordered where c.id = ordered.id;

with ordered as (
  select id, row_number() over (order by position nulls last, id) - 1 as position
  from dev_staging.skills_categories
)
update dev_staging.skills_categories c set position = ordered.position
from ordered where c.id = ordered.id;

with ordered as (
  select id, row_number() over (
    partition by category_id order by position nulls last, id
  ) - 1 as position
  from dev_staging.skills
)
update dev_staging.skills s set position = ordered.position
from ordered where s.id = ordered.id;
