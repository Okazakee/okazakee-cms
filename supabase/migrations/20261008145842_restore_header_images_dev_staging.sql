-- Restore independently editable header images in the development clone only.
-- Nullable columns keep the bundled website images until an upload is published.
-- No production schema, stored VAT, Auth identity, or Storage object is changed.

alter table dev_staging.site_settings
  add column if not exists header_logo_dark text,
  add column if not exists header_logo_light text;

comment on column dev_staging.site_settings.header_logo_dark is
  'Custom dark-theme header image URL. NULL renders the bundled website image.';
comment on column dev_staging.site_settings.header_logo_light is
  'Custom light-theme header image URL. NULL renders the bundled website image.';
