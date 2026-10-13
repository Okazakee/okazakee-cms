-- 20261013120000_view_counter_returning.sql
-- Atomic increment-and-return for the public view counters.
--
-- The two increment RPCs previously returned void, forcing the public
-- site into a non-atomic "RPC then SELECT" sequence per counted view.
-- They now return the new total (UPDATE ... RETURNING), so one call both
-- counts and resolves the authoritative number.
--
-- Scope: public RPC definitions + EXECUTE grants only. No tables, RLS
-- policies, storage objects or rows are touched.
--
-- Return-type change requires DROP + CREATE (CREATE OR REPLACE cannot
-- change a return type); grants are re-asserted explicitly afterwards,
-- matching 20261006060140. The public site calls these RPCs with the
-- publishable key, so anon/authenticated/service_role EXECUTE is
-- preserved. Safe to apply before the site code that reads the return
-- value: old callers ignore it.
-- Idempotent: re-runs converge (DROP IF EXISTS + CREATE + GRANT).

drop function if exists public.increment_blog_post_views_bigint(bigint);

create function public.increment_blog_post_views_bigint(p_id bigint)
 returns bigint
 language plpgsql
 security definer
 set search_path = ''
as $function$
declare
  v_views bigint;
begin
  update public.blog_posts
  set views = coalesce(views, 0) + 1
  where id = p_id
  returning views into v_views;
  return v_views;
end;
$function$;

drop function if exists public.increment_portfolio_post_views_bigint(bigint);

create function public.increment_portfolio_post_views_bigint(p_id bigint)
 returns bigint
 language plpgsql
 security definer
 set search_path = ''
as $function$
declare
  v_views bigint;
begin
  update public.portfolio_posts
  set views = coalesce(views, 0) + 1
  where id = p_id
  returning views into v_views;
  return v_views;
end;
$function$;

-- CREATE above does not inherit the pre-existing grants (the functions
-- were dropped first), so re-assert the public-site EXECUTE grants.
grant execute on function public.increment_blog_post_views_bigint(bigint)
  to anon, authenticated, service_role;
grant execute on function public.increment_portfolio_post_views_bigint(bigint)
  to anon, authenticated, service_role;
