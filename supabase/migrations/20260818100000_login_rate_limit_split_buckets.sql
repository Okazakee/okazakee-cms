-- Split the login rate limiter into independent per-IP and per-email
-- buckets.
--
-- PROBLEM
-- The base limiter keys on a combined "ip + email" identifier. Rotating the
-- email against one IP (or the IP against one target email) creates a fresh
-- bucket every time, so an attacker can bypass the limiter by varying either
-- side. A successful login also leaves the combined bucket's failure count
-- in place, penalizing the legitimate user.
--
-- POLICY
-- Two independent buckets per attempt:
--   * per-IP:  5 failures / minute, 15-minute lockout;
--   * per-email: 5 failures / minute, 15-minute lockout.
-- An attempt is allowed only when BOTH buckets allow it. A failure increments
-- both buckets, so neither rotating emails against one IP nor rotating IPs
-- against one account bypasses the limiter. Lockouts stay bounded (15
-- minutes, no permanent bans).
--
-- cms_clear_login_rate() resets both buckets after a successful login so the
-- legitimate user is never left penalized. Identifiers remain hashes of
-- prefixed raw values (loginIp:<ip>, loginEmail:<email>); the raw values are
-- never persisted.
--
-- The single-argument cms_check_login_rate(text) is replaced by the
-- two-argument form. Grants mirror the hardening migration: execution is
-- service_role only.
--
-- REVERSIBLE
--   drop function cms_check_login_rate(text, text);
--   drop function cms_clear_login_rate(text, text);
--   drop function cms_check_login_single(text);
--   -- recreate cms_check_login_rate(text) from 20260817100000_cms_login_rate_limit.sql

-- Per-identifier evaluation: records one attempt and returns the bucket
-- status. Shared by the per-IP and per-email buckets.
create or replace function cms_check_login_single(p_identifier text)
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

-- Records one attempt against BOTH buckets and returns the combined status:
-- allowed only when both allow; lockout_remaining is the longest active
-- lockout; remaining_attempts the fewest.
create or replace function cms_check_login_rate(p_ip text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_allowed boolean := true;
  v_remaining int := 5;
  v_lockout int := 0;
  v_identifier text;
begin
  -- Dedupe so one attempt never counts twice against a single bucket (the
  -- app always passes distinct prefixed hashes, this is defense in depth).
  for v_identifier in
    select distinct unnest(array[p_ip, p_email])
  loop
    v_result := cms_check_login_single(v_identifier);
    if not (v_result->>'allowed')::boolean then
      v_allowed := false;
    end if;
    v_remaining := least(v_remaining, (v_result->>'remaining_attempts')::int);
    v_lockout := greatest(v_lockout, (v_result->>'lockout_remaining')::int);
  end loop;

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining_attempts', v_remaining,
    'lockout_remaining', v_lockout
  );
end;
$$;

-- Resets both buckets after a successful login (best-effort caller side).
create or replace function cms_clear_login_rate(p_ip text, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from cms_login_attempts where identifier in (p_ip, p_email);
end;
$$;

-- The old combined-identifier RPC is replaced by the two-bucket form.
drop function if exists cms_check_login_rate(text);

-- BEGIN GRANTS (excluded from unit tests: pglite has no anon/authenticated)
revoke execute on function cms_check_login_rate(text, text) from anon, authenticated;
revoke execute on function cms_check_login_rate(text, text) from public;
revoke execute on function cms_clear_login_rate(text, text) from anon, authenticated;
revoke execute on function cms_clear_login_rate(text, text) from public;
revoke execute on function cms_check_login_single(text) from anon, authenticated;
revoke execute on function cms_check_login_single(text) from public;

grant execute on function cms_check_login_rate(text, text) to service_role;
grant execute on function cms_clear_login_rate(text, text) to service_role;
-- END GRANTS
