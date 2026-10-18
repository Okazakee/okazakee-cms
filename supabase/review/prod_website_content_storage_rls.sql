-- REVIEW-ONLY — DO NOT AUTO-APPLY. Phase 13B.3 staged artifact.
--
-- Production Storage read policy for the PRIVATE Markdown body bucket
-- (`website-content` on project mtvwynyikouqzmhqespl). This file lives in
-- supabase/review/, so no `supabase db push` / `db reset` / CI path picks it
-- up; it must be reviewed and deliberately promoted before it can ever run.
-- IT HAS NOT BEEN APPLIED, and this phase must not apply it.
--
-- SOURCE OF TRUTH: supabase/migrations/20261017185848_add_content_storage_read_policy_dev_staging.sql
-- (`website-content-dev` / `dev_staging`, deployed and asserted live by
-- devCheck's storage contract) plus the table-level visibility contract of
-- supabase/migrations/20261006060140_harden_unified_identity_privacy.sql §7
-- (`cms_published_read USING (hidden = false)` on both post tables). Only the
-- schema (`dev_staging` -> `public`), the bucket (`website-content-dev` ->
-- `website-content`) and the policy name (`website_content_dev_body_read` ->
-- `website_content_body_read`) change, plus the ONE deliberate predicate delta
-- documented under "DEPARTURE FROM THE DEV POLICY" below.
--
-- WHY THIS EXISTS
--   Long-form post bodies move out of `public.blog_posts.body_en/body_it` into
--   a PRIVATE bucket whose metadata is created through the Storage API by the
--   production provisioning command (Phase 13B.2), never by SQL. A private
--   bucket authorizes every object read, so without this policy the
--   publishable/anon path (what the public website uses) could not download a
--   single body. With it, a caller can download exactly the body objects that
--   belong to a post the caller may already read.
--
-- SCOPE
--   * `storage.objects` ONLY: one `DROP POLICY IF EXISTS` + one `CREATE POLICY`.
--   * It does NOT insert/update/delete `storage.buckets`, does not create,
--     alter or configure the bucket, and never references `storage.buckets`.
--   * It touches neither public asset bucket (`website`, `website-dev`), adds
--     NO write policy for any role, alters no other `storage` policy, changes
--     no grant, no column, no function and no `public` object or policy.
--   * It mutates no row: no INSERT/UPDATE/DELETE/TRUNCATE against any table.
--
-- READ MODEL (private bucket -> every object read must be authorized)
--   1. `bucket_id = 'website-content'` — an object in `website-content-dev`,
--      `website-dev` or `website` is never authorized by this policy, so the
--      production policy can never serve dev/asset objects and the two content
--      buckets stay strictly separated exactly like the application's
--      environment->bucket resolution.
--   2. The request is an object-DOWNLOAD operation, gated by
--      `storage.allow_any_operation` (the operation-aware Storage helper that
--      is present on this project version). A bare prefix LISTING does not
--      carry one of those operation values, so a listing is NOT authorized by
--      a `bucket_id = ...` predicate alone.
--   3. The object name is EXACTLY the `body_en_path` / `body_it_path` of a post
--      that is VISIBLE (`hidden = false`) on one of the two public content
--      tables. Pointers are content-addressed
--      (`blog/<id>/<locale>/<64 hex>.md`, `portfolio/<id>/<locale>/<64 hex>.md`),
--      and the comparison is equality (IN a two-element list), never a LIKE or
--      prefix match, so a caller cannot widen its reach by asking for a prefix.
--
-- VISIBILITY (what a caller can and cannot download)
--   * visible post (hidden = false) + referenced object -> downloadable
--   * hidden post (hidden = true) + referenced object   -> NOT downloadable
--   * unreferenced orphan object (no visible pointer)   -> NOT downloadable
--   * object in another bucket, or another bucket's object with a colliding
--     name                                            -> NOT downloadable
--   * a post whose pointers are NULL (legacy body still in `body_*` text)
--     contributes nothing: `name IN (NULL, NULL)` is NULL, which is not true.
--   * NO publish-date (`created_at <= now()`) predicate is added, matching
--     `cms_published_read`. Scheduling stays application-level
--     (CONTENT_ENFORCE_PUBLISH_DATE): a future-dated but unhidden post is
--     already readable row-wise, so its body is readable too — an already
--     published unhidden row (including its legacy `body_en` text) is not made
--     any more public by this policy.
--
-- DEPARTURE FROM THE DEV POLICY (deliberate, production-only)
--   The dev policy deliberately does NOT duplicate `hidden = false` and
--   inherits it from `dev_staging.*.cms_published_read`. This production file
--   DUPLICATES it in the object predicate. WHY: the dev clone's read policy is
--   creation-only and cannot be widened without a migration, but this predicate
--   is the only thing standing between a private production object and the
--   publishable/anon key, so it must not silently degrade if some later change
--   widens (or adds an OR'ed permissive policy to) the table-level read path.
--   The duplicate is strictly narrowing: the referenced tables' RLS still
--   applies for the caller inside these EXISTS subqueries (the only SELECT
--   policy on `public.blog_posts` / `public.portfolio_posts` is
--   `cms_published_read USING (hidden = false)`), so the effective predicate is
--   the INTERSECTION of the two. A table policy can therefore only narrow
--   object visibility, never widen it. The isolated suite proves both halves:
--   the hidden object is denied under the real table policy AND it stays denied
--   when the table policy is replaced with `USING (true)` (regression case).
--
-- WRITES AND ADMINISTRATIVE ACCESS
--   * No INSERT/UPDATE/DELETE policy is created for any role. `anon` and
--     `authenticated` can only read, and only download-authorized objects:
--     an INSERT fails with `new row violates row-level security policy`, while
--     UPDATE/DELETE simply match no row (nothing is visible for those
--     commands), so this file cannot make a body object writable.
--   * `service_role` (the CMS server path) carries BYPASSRLS, so object
--     management — upload, overwrite, delete, listing the bucket — keeps
--     working unchanged and is NOT governed by this policy. That is also why
--     no write policy is needed here.
--
-- ACTIVATION ORDER (Phase 14 runbook must honour it)
--   1. Apply supabase/review/prod_markdown_backfill_cas.sql (Phase 13B.1) —
--      it creates `public.blog_posts.body_en_path` / `body_it_path` and the
--      CHECK constraints. This policy's expression references those columns, so
--      it CANNOT be created before them (the CREATE POLICY would fail to parse).
--   2. Provision the `website-content` bucket through the Storage API
--      (Phase 13B.2). The bucket must exist before any body upload.
--   3. Apply THIS file, then verify with the queries below.
--   4. Only after 1-3 may the read flags be enabled
--      (CMS_BODY_STORAGE_READ_ENABLED) — a flag is a deployment assertion, not
--      proof, and enabling it creates nothing.
--
-- VERIFY AFTER APPLYING (read-only; run against the production project)
--   select policyname, cmd, roles, qual
--     from pg_policies
--    where schemaname = 'storage' and tablename = 'objects';
--   Expect exactly one new row, `website_content_body_read / SELECT /
--   {anon,authenticated}`, whose `qual` mentions `website-content`,
--   `storage.allow_any_operation` and both `public` post tables — and does NOT
--   mention `website-content-dev`. Expect NO new INSERT/UPDATE/DELETE/ALL row,
--   and no change to the pre-existing `storage.objects` / `storage.buckets`
--   policies.
--   Then, as an anonymous caller, download a visible post's body (200) and a
--   hidden post's body (400/404) through the Storage API.
--
-- ROLLBACK
--   drop policy if exists website_content_body_read on storage.objects;
--   (The bucket and its objects are untouched by this file, so rollback is
--   policy-only; delete objects separately if the bodies must go away.)
--
-- IDEMPOTENT: `DROP POLICY IF EXISTS` then `CREATE POLICY`; a retried or
-- resumed apply converges on the same single policy and changes nothing else.

drop policy if exists website_content_body_read on storage.objects;

create policy website_content_body_read on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'website-content'
    and storage.allow_any_operation (
      array['object.get_authenticated_info', 'object.get_authenticated']
    )
    and (
      exists (
        select 1
          from public.blog_posts b
         where b.hidden = false
           and storage.objects.name in (b.body_en_path, b.body_it_path)
      )
      or exists (
        select 1
          from public.portfolio_posts p
         where p.hidden = false
           and storage.objects.name in (p.body_en_path, p.body_it_path)
      )
    )
  );
