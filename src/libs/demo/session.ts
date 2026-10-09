'use client';

/**
 * Demo-mode session markers (client-only).
 *
 * Entering demo sets a localStorage flag (reactive store mirrors it) plus
 * a plain `cms_demo=1` cookie so the edge proxy can let `/` through
 * without a Supabase session. Server actions keep enforcing auth
 * regardless — demo sections never call them, so a missed branch fails
 * loudly with Unauthorized instead of leaking data.
 */
const FLAG_KEY = 'cms_demo';
// Duplicated as a literal in src/proxy.ts (edge runtime cannot import
// this client module).
const COOKIE_NAME = 'cms_demo';

export const DEMO_COOKIE_NAME = COOKIE_NAME;

export function isDemoSession(): boolean {
  try {
    return window.localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

export function enterDemoSession(): void {
  try {
    window.localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // ignore: the cookie still lets the proxy through for this visit.
  }
  document.cookie = `${COOKIE_NAME}=1; path=/; max-age=86400; SameSite=Lax`;
}

export function exitDemoSession(): void {
  try {
    window.localStorage.removeItem(FLAG_KEY);
  } catch {
    // ignore
  }
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax`;
}
