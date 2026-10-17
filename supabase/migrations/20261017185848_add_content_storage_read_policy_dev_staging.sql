-- Dev-only Storage read policy for the private Markdown body bucket.
--
-- WHY: long-form post bodies move into a PRIVATE bucket (`website-content-dev`,
-- created through the Storage API by `bun run storage:content:dev:setup`, never
-- by SQL). This migration adds the single SELECT policy that lets the public dev
-- site download exactly the body objects the caller may already see.
--
-- SCOPE: `storage.objects` only, one SELECT policy. It does not insert/update/
-- delete `storage.buckets`, does not touch the public asset buckets
-- (`website`, `website-dev`), creates no write policy, touches no `public`
-- object, alters no `dev_staging` table or body pointer, mutates no data and
-- changes no grant or function.
--
-- READ MODEL (private bucket, so object reads must be authorized):
--   1. bucket_id = 'website-content-dev'
--   2. the request is an object-download operation — `storage.allow_any_operation`
--      (present on this project version) gates it, so a bucket LISTING is not
--      authorized by a bare `bucket_id = ...` predicate.
--   3. the object name is referenced by a dev post body pointer.
--
-- VISIBILITY INHERITANCE: the predicate deliberately does NOT duplicate
-- `hidden = false` or `created_at <= now()`. The referenced `dev_staging` tables
-- carry `cms_published_read USING (hidden = false)` (migration
-- 20261017165547_harden_post_reads_dev_staging), and those policies apply inside
-- these EXISTS subqueries for the caller. So:
--   * visible unhidden dev pointer  -> downloadable
--   * hidden post pointer           -> NOT downloadable
--   * future unhidden dev pointer   -> downloadable (dev preview)
--   * unreferenced orphan object    -> NOT downloadable
--
-- Service-role/admin access (the CMS) bypasses Storage RLS, so no INSERT/
-- UPDATE/DELETE policy is needed or created.
--
-- IDEMPOTENT: `DROP POLICY IF EXISTS` then `CREATE POLICY`; replay converges on
-- the same single policy.

drop policy if exists website_content_dev_body_read on storage.objects;

create policy website_content_dev_body_read on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'website-content-dev'
    and storage.allow_any_operation (
      array['object.get_authenticated_info', 'object.get_authenticated']
    )
    and (
      exists (
        select 1
          from dev_staging.blog_posts b
         where storage.objects.name in (b.body_en_path, b.body_it_path)
      )
      or exists (
        select 1
          from dev_staging.portfolio_posts p
         where storage.objects.name in (p.body_en_path, p.body_it_path)
      )
    )
  );
