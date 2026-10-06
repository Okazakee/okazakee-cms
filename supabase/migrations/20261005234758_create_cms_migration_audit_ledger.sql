-- Dev-only ledger bootstrap (dev_staging scope only; no public writes).
-- Creates dev_staging.cms_migration_audit and records the 8 observed-existing
-- content sources as verified_existing with actual source sha256 bytes.
-- This does NOT claim the 7 public/unqualified sources were executed; it
-- records source-derived verification already proved by the 93-check audit.
-- Footer row tracks the renamed source 20261005150208 (bytes identical to
-- the former 20261005145655 record; global history row untouched by this file).

create table dev_staging.cms_migration_audit (
  version text primary key,
  name text not null,
  source_file text not null,
  source_sha256 text not null,
  execution_mode text not null,
  recorded_at timestamptz not null default now(),
  constraint cms_migration_audit_version_14digits check (version ~ '^[0-9]{14}$'),
  constraint cms_migration_audit_sha256_hex check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint cms_migration_audit_execution_mode check (execution_mode in ('verified_existing', 'applied'))
);

alter table dev_staging.cms_migration_audit enable row level security;

revoke all on table dev_staging.cms_migration_audit from public, anon, authenticated;

grant select on table dev_staging.cms_migration_audit to service_role;

insert into dev_staging.cms_migration_audit (version, name, source_file, source_sha256, execution_mode) values
  ('20261004090000', 'add_skill_link_and_position', 'supabase/migrations/20261004090000_add_skill_link_and_position.sql', '5310ac38e4757ca3443f9b2414088a87b11992670fbdb9556d7b6cd92c7572fa', 'verified_existing'),
  ('20261004101500', 'add_hero_display_options', 'supabase/migrations/20261004101500_add_hero_display_options.sql', 'e7cc0d070425a79dcf8b21d3663886ff919075eff8c32976545be53915304d61', 'verified_existing'),
  ('20261004110000', 'add_post_buttons', 'supabase/migrations/20261004110000_add_post_buttons.sql', 'ad0c36864452bed54c571ab9a6ae92d8317e0ec68bd55d68aae5fbedcfcb289d', 'verified_existing'),
  ('20261004111000', 'backfill_post_buttons', 'supabase/migrations/20261004111000_backfill_post_buttons.sql', '1e95e560396caeff4b7a2717892e373044d06b57a9cb91a4ea009fd18869521b', 'verified_existing'),
  ('20261004120000', 'add_site_settings', 'supabase/migrations/20261004120000_add_site_settings.sql', 'eb354baac881f9913cc13f5e52a0a5d3d39d9aca7de1e82b4990583e31b3cf29', 'verified_existing'),
  ('20261004130000', 'add_project_requests', 'supabase/migrations/20261004130000_add_project_requests.sql', '24ac6c817738848f817ab71e4b7fdf871388db9cfbc0b95b693776fc725c4f22', 'verified_existing'),
  ('20261005120000', 'freeze_static_site_copy', 'supabase/migrations/20261005120000_freeze_static_site_copy.sql', 'c13434676eeb0eb099887ad76af426c62fb6dd8a2a3c82ffe9f1c596141f1feb', 'verified_existing'),
  ('20261005150208', 'add_site_settings_footer_identity', 'supabase/migrations/20261005150208_add_site_settings_footer_identity.sql', 'a9f2683a8cc9404ff50d73815d5d940f915488c50486f833da97838fc924bc75', 'verified_existing');
