-- Dev-only body-to-Storage pointer schema for the `dev_staging` clone.
--
-- WHY: the post-body migration moves Markdown bodies from the `body_en` /
-- `body_it` text columns into private Storage objects, keeping Postgres as the
-- metadata source of truth. This migration adds only the nullable content-
-- addressed pointers; it does NOT create a bucket, move any content, backfill
-- anything, or touch the legacy columns.
--
-- POINTER CONTRACT (immutable, content-addressed, no leading slash):
--   blog/<id>/en/<sha256>.md
--   blog/<id>/it/<sha256>.md
--   portfolio/<id>/en/<sha256>.md
--   portfolio/<id>/it/<sha256>.md
-- where <id> is the row's own numeric id, <sha256> is exactly 64 lowercase hex
-- characters, and the extension is exactly `.md`.
--
-- COMPATIBILITY: legacy `body_en` (text NOT NULL) and `body_it` (text NULL) are
-- left completely untouched — no drop, no rename, no default, no backfill, no
-- value change. The new columns stay NULL on every existing row and neither
-- application reads them yet, so current CMS/WS behaviour is unchanged.
-- `body_en_path` is deliberately NOT NULL-able-free: it starts nullable so the
-- transition can proceed incrementally.
--
-- SCOPE: dev_staging only. No `public` object, no `storage.*` object, no bucket,
-- no Storage RLS policy, no grant, no function/RPC, no index, no post-visibility
-- policy, no data mutation. Tables are explicitly schema-qualified, so nothing
-- resolves through search_path.
--
-- IDEMPOTENT: column adds use IF NOT EXISTS; each CHECK is added from a scoped
-- DO block only when `pg_constraint` does not already carry that name for the
-- table, because PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.

-- ── columns ──────────────────────────────────────────────────────────────
alter table dev_staging.blog_posts
  add column if not exists body_en_path text,
  add column if not exists body_it_path text;

alter table dev_staging.portfolio_posts
  add column if not exists body_en_path text,
  add column if not exists body_it_path text;

-- ── path integrity constraints ───────────────────────────────────────────
-- Each constraint pins a non-NULL pointer to this row's own id, its content
-- type and its language, with a 64-lowercase-hex hash and a `.md` extension.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'blog_posts_body_en_path_check'
       and conrelid = 'dev_staging.blog_posts'::regclass
  ) then
    alter table dev_staging.blog_posts
      add constraint blog_posts_body_en_path_check check (
        body_en_path is null
        or body_en_path ~ ('^blog/' || id::text || '/en/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'blog_posts_body_it_path_check'
       and conrelid = 'dev_staging.blog_posts'::regclass
  ) then
    alter table dev_staging.blog_posts
      add constraint blog_posts_body_it_path_check check (
        body_it_path is null
        or body_it_path ~ ('^blog/' || id::text || '/it/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'portfolio_posts_body_en_path_check'
       and conrelid = 'dev_staging.portfolio_posts'::regclass
  ) then
    alter table dev_staging.portfolio_posts
      add constraint portfolio_posts_body_en_path_check check (
        body_en_path is null
        or body_en_path ~ ('^portfolio/' || id::text || '/en/[0-9a-f]{64}\.md$')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'portfolio_posts_body_it_path_check'
       and conrelid = 'dev_staging.portfolio_posts'::regclass
  ) then
    alter table dev_staging.portfolio_posts
      add constraint portfolio_posts_body_it_path_check check (
        body_it_path is null
        or body_it_path ~ ('^portfolio/' || id::text || '/it/[0-9a-f]{64}\.md$')
      );
  end if;
end $$;
