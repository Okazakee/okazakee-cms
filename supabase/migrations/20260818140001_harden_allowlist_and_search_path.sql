-- 20260818140001_harden_allowlist_and_search_path.sql
-- Phase 2 (apply AFTER the code referencing cms_lookup_allowed_user is live).
--
-- 1. Make cms_allowed_users genuinely internal: no anon/authenticated access
--    at all (SELECT included). The app now reaches it via service_role
--    (server actions) or the cms_lookup_allowed_user RPC (middleware).
-- 2. Drop all RLS policies on cms_allowed_users (no grants left to enforce).
-- 3. Drop the now-useless permissive authenticated write policies on
--    hero_section (grants were revoked in 20260818120000; leftover policies
--    would be a footgun if write grants are ever re-added). Admin-gated
--    policies (hero_section_*_admins) are kept intentionally.
-- 4. Fix function_search_path_mutable on the 5 SECURITY DEFINER functions:
--    explicit `search_path = ''` with fully qualified table names
--    (Supabase recommendation for definer functions).

-- ── 1+2. cms_allowed_users: fully internal ──────────────────────────────
revoke all on table public.cms_allowed_users from anon, authenticated;

drop policy if exists "Users can check their own allowlist status" on public.cms_allowed_users;
drop policy if exists "Auth users can read" on public.cms_allowed_users;
drop policy if exists "Admins can insert" on public.cms_allowed_users;
drop policy if exists "Admins can update" on public.cms_allowed_users;
drop policy if exists "Admins can delete" on public.cms_allowed_users;

-- ── 3. hero_section: drop permissive authenticated write policies ──────
drop policy if exists "Allow authenticated users to insert into hero_section"
  on public.hero_section;
drop policy if exists "Allow authenticated users to update hero_section"
  on public.hero_section;
drop policy if exists "Allow authenticated users to delete from hero_section"
  on public.hero_section;

-- ── 4. Fix search_path on SECURITY DEFINER functions ───────────────────
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path = ''
as $function$
BEGIN
  INSERT INTO public.user_profiles (id, email, display_name, avatar_url, auth_provider, github_username)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'user_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url',
    COALESCE(NEW.raw_app_meta_data->>'provider', 'email'),
    NEW.raw_user_meta_data->>'user_name'
  );
  RETURN NEW;
END;
$function$;

create or replace function public.increment_blog_post_views_bigint(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $function$
BEGIN
  UPDATE public.blog_posts
  SET views = COALESCE(views, 0) + 1
  WHERE id = p_id;
END;
$function$;

create or replace function public.increment_portfolio_post_views_bigint(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path = ''
as $function$
BEGIN
  UPDATE public.portfolio_posts
  SET views = COALESCE(views, 0) + 1
  WHERE id = p_id;
END;
$function$;

-- is_admin_user(): qualify cms_allowed_users (auth.users / auth.uid() are
-- already qualified) and pin search_path.
create or replace function public.is_admin_user()
 returns boolean
 language plpgsql
 security definer
 set search_path = ''
as $function$
DECLARE
  user_email TEXT;
  user_github_username TEXT;
  user_role TEXT;
BEGIN
  SELECT
    email,
    raw_user_meta_data->>'user_name'
  INTO
    user_email,
    user_github_username
  FROM auth.users
  WHERE id = auth.uid();

  IF user_email IS NULL AND user_github_username IS NULL THEN
    RETURN FALSE;
  END IF;

  IF user_email IS NOT NULL THEN
    SELECT role INTO user_role
    FROM public.cms_allowed_users
    WHERE email = LOWER(user_email)
    LIMIT 1;

    IF user_role = 'admin' THEN
      RETURN TRUE;
    END IF;
  END IF;

  IF user_github_username IS NOT NULL THEN
    SELECT role INTO user_role
    FROM public.cms_allowed_users
    WHERE github_username = user_github_username
    LIMIT 1;

    IF user_role = 'admin' THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$function$;

-- is_admin_user(uuid): already fully qualified, pin search_path.
create or replace function public.is_admin_user(p_user_id uuid)
 returns boolean
 language plpgsql
 set search_path = ''
as $function$
DECLARE
  _is_admin boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_user_id AND ur.role = 'admin'
  ) INTO _is_admin;

  RETURN _is_admin;
END;
$function$;