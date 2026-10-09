-- The dev allowlist table permits service-role inserts, but its cloned ID
-- sequence has no service-role grant. nextval() requires USAGE independently
-- of table permissions and RLS bypass. Leave public and client roles unchanged.
GRANT USAGE ON SEQUENCE dev_staging.cms_allowed_users_id_seq TO service_role;
