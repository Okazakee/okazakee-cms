-- 20260818140000_add_cms_lookup_rpc.sql
-- Edge-safe allowlist lookup for the Next.js middleware (Edge Runtime).
--
-- The middleware cannot use service_role (server secret in the edge bundle)
-- and anon/authenticated no longer have SELECT on cms_allowed_users (see
-- 20260818140001). This SECURITY DEFINER RPC exposes ONLY the role for a
-- given email OR GitHub username, with a fixed search_path and fully
-- qualified table names (Supabase recommendation for definer functions).
--
-- Executable by `authenticated` only; anon has no path to the allowlist.

create or replace function public.cms_lookup_allowed_user(
  p_email text default null,
  p_github_username text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_source text;
begin
  if p_email is not null then
    select role, 'email'
      into v_role, v_source
      from public.cms_allowed_users
      where email = lower(p_email)
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  if p_github_username is not null then
    select role, 'github'
      into v_role, v_source
      from public.cms_allowed_users
      where github_username = p_github_username
      limit 1;
    if v_role is not null then
      return jsonb_build_object('role', v_role, 'match_source', v_source);
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.cms_lookup_allowed_user from public;
-- Supabase grants anon/authenticated EXECUTE on new public functions by
-- default; revoke explicitly so the allowlist RPC is not callable by anon.
revoke execute on function public.cms_lookup_allowed_user(text, text) from anon, authenticated;
grant execute on function public.cms_lookup_allowed_user(text, text) to authenticated, service_role;