-- 20260818140002_revoke_public_select_on_allowlist.sql
-- cms_allowed_users must be genuinely internal: the app reaches it only via
-- service_role (server actions) or the cms_lookup_allowed_user RPC
-- (middleware). Supabase tables default to `=r/postgres` (SELECT granted to
-- PUBLIC, which anon/authenticated inherit). Revoke that too so no client
-- role has any direct table grant — closing the footgun even if RLS is
-- ever disabled or a permissive policy is re-added.

revoke select on table public.cms_allowed_users from public;