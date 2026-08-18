-- Durable login rate limiting for the standalone CMS.
--
-- Replaces the process-local in-memory limiter (src/libs/rateLimiters.ts):
-- 5 attempts / minute, 15-minute lockout, per identifier.
--
-- APPLY BEFORE PRODUCTION CUTOVER:
--   supabase db push
-- or run this file via the Supabase SQL editor.

create table if not exists cms_login_attempts (
  identifier text primary key,
  attempt_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

-- Records an attempt and returns the current status atomically.
create or replace function cms_check_login_rate(p_identifier text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row cms_login_attempts%rowtype;
  v_now timestamptz := now();
begin
  select * into v_row
    from cms_login_attempts
    where identifier = p_identifier
    for update;

  if not found then
    insert into cms_login_attempts (identifier, attempt_count, window_started_at)
    values (p_identifier, 1, v_now);
    return jsonb_build_object(
      'allowed', true,
      'remaining_attempts', 4,
      'lockout_remaining', 0
    );
  end if;

  -- Active lockout
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object(
      'allowed', false,
      'remaining_attempts', 0,
      'lockout_remaining',
      least(900, greatest(0, ceil(extract(epoch from (v_row.locked_until - v_now)))::int))
    );
  end if;

  -- Window expired: reset the counter
  if v_row.window_started_at + interval '1 minute' < v_now then
    update cms_login_attempts
      set attempt_count = 1, window_started_at = v_now, locked_until = null
      where identifier = p_identifier;
    return jsonb_build_object(
      'allowed', true, 'remaining_attempts', 4, 'lockout_remaining', 0
    );
  end if;

  -- Record attempt
  v_row.attempt_count := v_row.attempt_count + 1;

  if v_row.attempt_count >= 5 then
    update cms_login_attempts
      set attempt_count = v_row.attempt_count,
          locked_until = v_now + interval '15 minutes'
      where identifier = p_identifier;
    return jsonb_build_object(
      'allowed', false, 'remaining_attempts', 0, 'lockout_remaining', 900
    );
  end if;

  update cms_login_attempts
    set attempt_count = v_row.attempt_count
    where identifier = p_identifier;

  return jsonb_build_object(
    'allowed', true,
    'remaining_attempts', 5 - v_row.attempt_count,
    'lockout_remaining', 0
  );
end;
$$;

-- The CMS session client calls this with the publishable (anon) key.
grant execute on function cms_check_login_rate(text) to anon, authenticated;
revoke execute on function cms_check_login_rate(text) from public;

-- Ops: purge stale rows (scheduled job / manual).
create or replace function cms_purge_login_attempts()
returns void
language sql
security definer
set search_path = public
as $$
  delete from cms_login_attempts
  where locked_until is null
    and window_started_at < now() - interval '1 hour';
$$;
