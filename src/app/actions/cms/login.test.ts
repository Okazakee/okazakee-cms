import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Login-navigation contract guards.
 *
 * Successful email/password login must have ONE deterministic,
 * framework-owned navigation path: the Server Action authenticates, syncs
 * the profile and calls redirect() itself. The client never navigates on the
 * success path and no router refresh mechanism exists in the action.
 *
 * Previously the action returned redirectTo and the client performed a hard
 * navigation, racing the action's RSC/cookie lifecycle and producing a
 * transient "This page couldn't load" interstitial (and an aborted
 * action-response stream) in Firefox.
 *
 * These guards are source-level on purpose: the race is browser-observable,
 * not unit-testable without a live Supabase login.
 */
const loginActionSource = readFileSync(
  fileURLToPath(new URL('./login.ts', import.meta.url)),
  'utf8'
);

const loginPageSource = readFileSync(
  fileURLToPath(
    new URL('../../../app/[locale]/(app)/login/page.tsx', import.meta.url)
  ),
  'utf8'
);

describe('login action navigation contract', () => {
  it('owns the success navigation via redirect() from next/navigation', () => {
    expect(loginActionSource).toMatch(/from\s+'next\/navigation'/);
    expect(loginActionSource).toMatch(/redirect\(/);
  });

  it('imports nothing from next/cache (no router refresh mechanism)', () => {
    expect(loginActionSource).not.toMatch(/from\s+'next\/cache'/);
  });

  it('never calls a refresh or revalidation function', () => {
    expect(loginActionSource).not.toMatch(/\brefresh\s*\(/);
    expect(loginActionSource).not.toMatch(/revalidatePath\s*\(/);
  });

  it('redirects to the canonical /{locale} target (no trailing slash)', () => {
    expect(loginActionSource).toMatch(/redirect\(`\/\$\{safeLocale\}`\)/);
    expect(loginActionSource).not.toMatch(/\/\{\/auth\/ready/);
  });

  it('performs no client navigation from the action', () => {
    expect(loginActionSource).not.toContain('window.location');
  });

  it('failed credentials still return typed errors to the form', () => {
    expect(loginActionSource).toContain('return { error:');
  });
});

describe('login page navigation contract', () => {
  it('has no client navigation on the password success path', () => {
    expect(loginPageSource).not.toContain('result.redirectTo');
    // The ONLY window.location usage is the GitHub OAuth start navigation.
    const occurrences = loginPageSource.match(/window\.location\.href/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(loginPageSource).toContain('/auth/github/start');
  });

  it('passes the locale so the action redirects to the canonical path', () => {
    expect(loginPageSource).toContain('login(email, password, locale)');
  });

  it('recognizes the framework NEXT_REDIRECT rejection as control flow', () => {
    expect(loginPageSource).toContain('NEXT_REDIRECT');
  });

  it('has no router-refresh competing path', () => {
    expect(loginPageSource).not.toContain('router.refresh');
    expect(loginPageSource).not.toContain('useRouter');
  });
});
