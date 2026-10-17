-- Production (`public`) FK-support index hardening — PREPARED ONLY.
--
-- WHY: the Supabase performance advisor reports exactly three unindexed foreign
-- keys under `public`:
--   public.blog_posts.author_id
--   public.portfolio_posts.author_id
--   public.skills.category_id
-- The equivalent dev_staging gaps were already fixed by
-- 20261017134507_optimize_indexes_dev_staging; this file brings production to
-- the same FK-support shape.
--
-- SCOPE: `public` only, three additive CREATE INDEX statements and nothing
-- else. No DROP, no data mutation, no RLS policy, no grant, no function/RPC, no
-- Storage, no dev_staging object, no search_path reliance (every table target
-- is schema-qualified). Existing production indexes are all KEPT, including the
-- historically named ones (`idx_blog_posts_views`, `idx_portfolio_posts_views`,
-- `idx_skills_categories_position`) and the non-standard primary-key names
-- (`posts_pkey`, `skills_pkey1`, `skill_categories_pkey`) — naming is cosmetic
-- and deliberately not normalized here.
--
-- SKILLS INDEX CHOICE: one composite index (category_id, position, id) both
-- satisfies the FK-support requirement (its leading column is category_id, so no
-- separate standalone category_id index is created) and matches the
-- application's category-scoped ordered skills access pattern.
--
-- REPLAY-SAFE: `create index if not exists` converges on re-run.
--
-- APPLY: prepared in-repo only. The coordinator applies it to production after
-- explicit approval; normal Supabase migration history records it.

create index if not exists blog_posts_author_id_idx
  on public.blog_posts (author_id);

create index if not exists portfolio_posts_author_id_idx
  on public.portfolio_posts (author_id);

create index if not exists skills_category_position_id_idx
  on public.skills (category_id, position, id);
