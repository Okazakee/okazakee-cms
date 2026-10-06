-- Footer identity the CMS owns, next to the header chrome already on the same
-- single-row table: the display name and the VAT number the site renders in
-- its footer.
--
-- SCHEMA: this project holds production content in `public` and the cloned
-- working copy in `dev_staging`, in ONE database. Every statement below is
-- explicitly qualified with `dev_staging.` so it cannot resolve through
-- search_path and cannot reach production copy. Against a database without a
-- `dev_staging` schema this file fails loudly instead of altering `public`:
--   dev:  apply as-is (the CMS dev client already resolves dev_staging)
--   prod: promote deliberately, do not replay this file there
--
-- NULLABLE, NO BACKFILL: both columns stay NULL on the existing row, so this
-- migration is a no-op for the rendered footer. NULL means "never configured"
-- and the site keeps rendering exactly what it rendered before it — the name
-- `Okazakee` and the VAT number `02863310815`. That is what lets the schema
-- ship ahead of the editors that use it.
--
-- footer_vat_number is TEXT, not a numeric type: the leading zero of an
-- Italian VAT number is part of the identifier, and a numeric round trip would
-- silently drop it. The value is displayed and copied verbatim and never
-- parsed, so no country or checksum rule belongs in this file.

alter table dev_staging.site_settings
  add column if not exists footer_name text;

alter table dev_staging.site_settings
  add column if not exists footer_vat_number text;

comment on column dev_staging.site_settings.footer_name is
  'Footer display name. NULL renders the default name the site already shows (Okazakee); an empty string is treated as NULL by the reader.';

comment on column dev_staging.site_settings.footer_vat_number is
  'Footer VAT number, stored as text so a leading zero survives. NULL renders the default number (02863310815); an empty string is treated as NULL by the reader.';

-- REVERSIBLE
--   alter table dev_staging.site_settings drop column if exists footer_vat_number;
--   alter table dev_staging.site_settings drop column if exists footer_name;
-- Dropping both restores the pre-CMS footer identity with nothing to restore:
-- the columns were never backfilled, so no stored value is lost. Grants, RLS
-- and the existing header columns are untouched — this adds columns only.