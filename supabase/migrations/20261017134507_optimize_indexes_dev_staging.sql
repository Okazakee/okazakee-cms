-- Dev-only index optimization for the `dev_staging` clone.
--
-- WHY: the Supabase performance advisor flags three missing FK-support indexes
-- in dev_staging (blog_posts.author_id, portfolio_posts.author_id,
-- skills.category_id). The same gap exists in `public`, but production is NOT
-- part of this phase, so every statement here is scoped to the clone.
--
-- While adding those, three live dev indexes are pure write cost for the
-- current query model and are removed:
--   * blog_posts_views_idx / portfolio_posts_views_idx — no application query
--     filters or orders posts by `views` (source audit) and the public view
--     counter updates rows by primary key; both indexes showed idx_scan = 0.
--     Indexing `views` only adds write amplification to one of the most
--     frequently updated post columns.
--   * site_settings_single_row_idx (id) — structurally identical to the
--     primary-key index on (id); PostgreSQL keeps using the PK after removal.
--
-- Explicitly KEPT (verified in use; out of this file's scope):
--   * project_requests_active_idx (archived, created_at DESC)
--   * skills_categories_position_idx (position)
--   * every primary key and every other pre-existing index (untouched).
--
-- SKILLS INDEX CHOICE: a single composite index (category_id, position, id)
-- both satisfies the FK-support requirement — its leading column is
-- category_id, so no separate standalone category_id index is created — and
-- matches the nested skills read the application already issues, which scopes
-- to a category and orders by (position NULLS LAST, id): see okazakee-ws
-- getSkillsCategories and the CMS getSkills embed.
--
-- SCHEMA: every statement targets `dev_staging` explicitly (schema-qualified
-- table and index names) so nothing can resolve through search_path and can
-- never reach production content. Against a database without a `dev_staging`
-- schema this file fails loudly instead of altering `public`.
--
-- IDEMPOTENT: CREATE INDEX IF NOT EXISTS / DROP INDEX IF EXISTS converge on
-- re-run, so a retried or resumed apply is a no-op.
--
-- REVERSIBLE
--   drop index if exists dev_staging.blog_posts_author_id_idx;
--   drop index if exists dev_staging.portfolio_posts_author_id_idx;
--   drop index if exists dev_staging.skills_category_position_id_idx;
--   create index if not exists blog_posts_views_idx on dev_staging.blog_posts (views);
--   create index if not exists portfolio_posts_views_idx on dev_staging.portfolio_posts (views);
--   create index if not exists site_settings_single_row_idx on dev_staging.site_settings (id);
-- (restoring the dropped indexes is optional: they served no application
-- query, so a rollback only needs the three added indexes removed.)

-- ── ADD: FK-support + composite ordering indexes ─────────────────────────
-- The CREATE INDEX name is deliberately bare: PostgreSQL takes an index's
-- schema from its table, so `dev_staging.blog_posts` below places the index in
-- dev_staging (a schema-qualified index name is a syntax error). DROP INDEX,
-- further down, does accept a qualified name.
create index if not exists blog_posts_author_id_idx
  on dev_staging.blog_posts (author_id);

create index if not exists portfolio_posts_author_id_idx
  on dev_staging.portfolio_posts (author_id);

-- Covers the skills.category_id FK (leading column) and the nesting order.
create index if not exists skills_category_position_id_idx
  on dev_staging.skills (category_id, position, id);

-- ── REMOVE: redundant / unused indexes (primary keys untouched) ──────────
drop index if exists dev_staging.blog_posts_views_idx;
drop index if exists dev_staging.portfolio_posts_views_idx;
drop index if exists dev_staging.site_settings_single_row_idx;
