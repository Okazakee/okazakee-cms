import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Login-navigation contract guards.
 *
 * The login flow must have ONE deterministic navigation path: the action
 * returns redirectTo and the client performs a single full-page navigation
 * (window.location.href). A router refresh triggered by the action races that
 * navigation and produces a transient "This page couldn't load" interstitial
 * in Firefox (revalidatePath was removed from this flow for the same reason).
 *
 * These guards are source-level on purpose: the race is browser-observable,
 * not unit-testable without a live Supabase login. They fail if a competing
 * refresh mechanism is reintroduced into the login action or page.
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
  it('imports nothing from next/cache (no router refresh mechanism)', () => {
    expect(loginActionSource).not.toMatch(/from\s+'next\/cache'/);
  });

  it('never calls a refresh or revalidation function', () => {
    expect(loginActionSource).not.toMatch(/\brefresh\s*\(/);
    expect(loginActionSource).not.toMatch(/revalidatePath\s*\(/);
  });

  it('still returns the deterministic ready redirect on success', () => {
    expect(loginActionSource).toContain("redirectTo: '/auth/ready?next=/'");
  });
});

describe('login page navigation contract', () => {
  it('performs a single full-page navigation', () => {
    expect(loginPageSource).toContain('window.location.href');
  });

  it('has no router-refresh or router navigation competing path', () => {
    expect(loginPageSource).not.toContain('router.refresh');
    expect(loginPageSource).not.toContain('useRouter');
  });
});
