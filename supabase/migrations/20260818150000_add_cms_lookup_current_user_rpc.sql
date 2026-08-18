-- 20260818150000_add_cms_lookup_current_user_rpc.sql
-- Close the allowlist enumeration hole: the previous
-- cms_lookup_allowed_user(p_email, p_github_username) accepted arbitrary
-- caller-supplied identities, so ANY authenticated user could probe
-- arbitrary email/username against the internal allowlist.
--
-- This replacement takes NO parameters: the identity comes from the
-- caller's JWT (auth.uid()), then matches against cms_allowed_users and
-- returns { role, match_source } or null. An authenticated caller can only
-- ever learn their OWN allowlist status.
--
-- Edge-safe: the Next.js middleware (Edge Runtime) calls this with the
-- session client. EXECUTE granted to authenticated + service_role only.

create or replace function public.cms_lookup_current_user()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_github_username text;
  v_role text;
  v_source text;
begin
  if v_uid is null then
    return null;
  end if;

  -- Resolve the caller's canonical identity from the auth schema.
  select email, raw_user_meta_data->>'user_name'
    into v_email, v_github_username
    from auth.users
    where id = v_uid;

  if v_email is not null then
    select role, 'email'
      into v_role, v_source
      from public.cms_allowed_users
      where email = lower(v_email)
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  if v_github_username is not null then
    select role, 'github'
      into v_role, v_source
      from public.cms_allowed_users
      where github_username = v_github_username
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.cms_lookup_current_user() from public;
-- Supabase grants anon/authenticated EXECUTE on new public functions by
-- default; revoke explicitly so anon cannot call it (401 via PostgREST).
revoke execute on function public.cms_lookup_current_user() from anon, authenticated;
grant execute on function public.cms_lookup_current_user() to authenticated, service_role;