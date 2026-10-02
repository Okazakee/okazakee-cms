/**
 * Isolated fixture — standalone test server.
 *
 * Two responsibilities, both OUTSIDE the Next application:
 *   1. signed revalidation receiver that mirrors the public-site contract
 *      (HMAC, replay window, tag allowlist) and records every event;
 *   2. fixture control API to reset data, inject revalidation failures, read
 *      observed writes/snapshots, and seed browser sessions.
 *
 * It is only ever created by start-isolated.mjs; nothing imports it from the
 * application routes.
 */
import { createServer } from 'node:http';
import { accountByKey } from './auth.mjs';
import { revalidationPath } from './config.mjs';
import {
  isAllowedTag,
  signRevalidationEvent,
  validateEventPayload,
  verifyRevalidationRequest,
} from './revalidation.mjs';
import { readJsonBody } from './util.mjs';

const failureModes = new Set(['none', 'http-500', 'timeout', 'reject']);

export function createFixtureServer(context) {
  const events = [];
  const state = { failureMode: 'none' };
  let resetting = false;

  const server = createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      context.logger.error('fixture request failed:', error.message);
      sendJson(response, 500, { error: error.message });
    }
  });

  async function route(request, response) {
    const url = new URL(request.url, context.fixtureUrl);
    if (url.pathname === revalidationPath) {
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: 'method-not-allowed' });
      }
      return handleRevalidation(request, response);
    }
    if (url.pathname === '/health') {
      return sendJson(response, 200, {
        ok: true,
        events: events.length,
        failureMode: state.failureMode,
      });
    }
    if (url.pathname === '/__fixture/events') {
      if (request.method === 'DELETE') {
        events.length = 0;
        return sendJson(response, 200, { cleared: true });
      }
      return sendJson(response, 200, { events });
    }
    if (url.pathname === '/__fixture/fail') {
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const mode = body?.mode ?? 'none';
        if (!failureModes.has(mode)) {
          return sendJson(response, 400, { error: 'unknown-failure-mode' });
        }
        state.failureMode = mode;
        return sendJson(response, 200, { mode });
      }
      return sendJson(response, 200, { mode: state.failureMode });
    }
    if (url.pathname === '/__fixture/snapshot') {
      const tables = url.searchParams.get('tables');
      const snapshot = await context.snapshot(
        tables ? tables.split(',').filter(Boolean) : undefined
      );
      return sendJson(response, 200, { tables: snapshot });
    }
    if (url.pathname === '/__fixture/writes') {
      if (request.method === 'DELETE') {
        await context.clearWrites();
        return sendJson(response, 200, { cleared: true });
      }
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return sendJson(response, 200, {
        writes: await context.writes(limit),
      });
    }
    if (url.pathname === '/__fixture/reset') {
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: 'method-not-allowed' });
      }
      if (resetting) {
        return sendJson(response, 409, { error: 'reset-in-progress' });
      }
      resetting = true;
      try {
        await context.reset();
        events.length = 0;
        return sendJson(response, 200, { reset: true });
      } finally {
        resetting = false;
      }
    }
    if (url.pathname === '/__fixture/session') {
      return handleSession(url, response);
    }
    if (url.pathname === '/__fixture/accounts') {
      return sendJson(response, 200, {
        accounts: context.accounts.map((account) => ({
          key: account.key,
          email: account.email,
          role: account.role,
        })),
      });
    }
    if (url.pathname === '/__fixture/runtime') {
      return sendJson(response, 200, {
        nextUrl: context.nextUrl,
        fixtureUrl: context.fixtureUrl,
        supabaseUrl: context.supabaseUrl,
        revalidationUrl: `${context.fixtureUrl}${revalidationPath}`,
      });
    }
    return sendJson(response, 404, { error: 'not-found' });
  }

  async function handleRevalidation(request, response) {
    const mode = state.failureMode;
    const rawBody = await readRawBody(request);
    const timestamp = request.headers['x-content-timestamp'];
    const signature = request.headers['x-content-signature'];

    const verification = verifyRevalidationRequest({
      secret: context.secret,
      rawBody,
      timestamp,
      signature,
    });

    let event = null;
    try {
      event = JSON.parse(rawBody);
    } catch {
      event = null;
    }

    const record = {
      receivedAt: new Date().toISOString(),
      failureMode: mode,
      verified: verification.ok,
      reason: verification.reason ?? null,
      ageSeconds: verification.ageSeconds ?? null,
      timestamp: timestamp ?? null,
      tags: event?.tags ?? null,
      payloadError: verification.ok ? validateEventPayload(event) : null,
      event,
      rawBodyLength: rawBody.length,
    };

    if (mode === 'http-500') {
      record.reason = 'injected-http-500';
      events.push(record);
      return sendJson(response, 500, { ok: false, error: 'injected' });
    }
    if (mode === 'timeout') {
      record.reason = 'injected-timeout';
      events.push(record);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      return sendJson(response, 200, { ok: true, note: 'late' });
    }
    if (mode === 'reject') {
      record.reason = 'injected-reject';
      events.push(record);
      return sendJson(response, 400, { ok: false, error: 'rejected' });
    }

    if (!verification.ok) {
      events.push(record);
      return sendJson(response, 401, {
        ok: false,
        error: verification.reason,
      });
    }
    const payloadError = validateEventPayload(event);
    if (payloadError) {
      record.reason = payloadError;
      events.push(record);
      return sendJson(response, 400, { ok: false, error: payloadError });
    }

    events.push(record);
    return sendJson(response, 200, { ok: true, eventId: event.eventId });
  }

  async function handleSession(url, response) {
    const key = url.searchParams.get('user') ?? 'admin';
    const account = accountByKey(key);
    if (!account) {
      return sendJson(response, 404, { error: 'unknown-user' });
    }
    const headerParam = url.searchParams.get('header');
    if (headerParam && !['1', 'true'].includes(headerParam)) {
      return sendJson(response, 400, { error: 'invalid-header-param' });
    }
    const { cookies } = await context.mintSession(account);
    for (const cookie of cookies) {
      response.setHeader(
        'set-cookie',
        [
          ...(response.getHeader('set-cookie') ?? []),
          serializeSessionCookie(cookie),
        ].flat()
      );
    }

    const redirect = resolveRedirect(url, context.nextUrl);
    if (url.searchParams.get('format') === 'json') {
      return sendJson(response, 200, {
        user: account.key,
        cookieNames: cookies.map((cookie) => cookie.name),
        nextUrl: redirect,
      });
    }
    response.writeHead(302, { location: redirect });
    response.end();
  }

  function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(context.fixturePort, '127.0.0.1', () => resolve());
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    events,
    state,
  };
}

function resolveRedirect(url, nextUrl) {
  const providerBase = `${url.protocol}//${url.host}`;
  const requested = url.searchParams.get('redirect');
  if (!requested) return `${nextUrl}/`;
  try {
    const parsed = new URL(requested, providerBase);
    // Only redirect back into loopback app origins.
    const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (!allowed.has(parsed.hostname)) return `${nextUrl}/`;
    return parsed.toString();
  } catch {
    return `${nextUrl}/`;
  }
}

function serializeSessionCookie({ name, value }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`;
}

async function readRawBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Re-exported so the guard test can exercise signing/allowlisting.
export { isAllowedTag, signRevalidationEvent };
