import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Account-deletion navigation contract guards.
 *
 * Successful account deletion must have ONE deterministic,
 * framework-owned navigation: the Server Action deletes the account, clears
 * the session and calls redirect() itself; the client never navigates on the
 * success path and no router refresh mechanism exists in the action.
 *
 * Previously the action called refresh() and AccountSection performed
 * router.push — the same competing-navigation architecture that produced the
 * transient load failure in the password login flow.
 *
 * Source-level on purpose: the flow depends on a live Supabase session.
 */
const actionSource = readFileSync(
  fileURLToPath(new URL('./deleteAccount.ts', import.meta.url)),
  'utf8'
);

const accountSectionSource = readFileSync(
  fileURLToPath(
    new URL('../../../components/common/cms/AccountSection.tsx', import.meta.url)
  ),
  'utf8'
);

describe('deleteMyAccount navigation contract', () => {
  it('owns the success navigation via redirect() from next/navigation', () => {
    expect(actionSource).toMatch(/from\s+'next\/navigation'/);
    expect(actionSource).toMatch(/redirect\(/);
  });

  it('redirects to the canonical /{locale}/login target', () => {
    expect(actionSource).toMatch(/redirect\(`\/\$\{safeLocale\}\/login`\)/);
  });

  it('validates the locale like the password login flow', () => {
    expect(actionSource).toContain('isValidLocale');
    expect(actionSource).toContain('defaultLocale');
  });

  it('imports nothing from next/cache (no router refresh mechanism)', () => {
    expect(actionSource).not.toMatch(/from\s+'next\/cache'/);
  });

  it('never calls a refresh or revalidation function', () => {
    expect(actionSource).not.toMatch(/\brefresh\s*\(/);
    expect(actionSource).not.toMatch(/revalidatePath\s*\(/);
  });

  it('places the redirect OUTSIDE the try/catch (control flow escapes)', () => {
    // redirect() throws NEXT_REDIRECT; if it were inside the try block the
    // error handler would swallow it and turn success into a typed error.
    // Assert the source order: try ... catch ... redirect.
    const tryIdx = actionSource.indexOf('try {');
    const catchIdx = actionSource.indexOf('} catch (');
    const redirectIdx = actionSource.indexOf('redirect(`');
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    expect(redirectIdx).toBeGreaterThan(catchIdx);
  });

  it('failure paths still return typed errors', () => {
    expect(actionSource).toContain('return { success: false, error:');
  });
});

describe('AccountSection navigation contract', () => {
  it('has no client navigation on the deletion success path', () => {
    expect(accountSectionSource).not.toContain('router.push');
    expect(accountSectionSource).not.toContain('useRouter');
    expect(accountSectionSource).not.toContain('window.location');
  });

  it('passes the locale so the action redirects canonically', () => {
    expect(accountSectionSource).toContain('deleteMyAccount(locale)');
  });

  it('recognizes the framework NEXT_REDIRECT rejection as control flow', () => {
    expect(accountSectionSource).toContain('NEXT_REDIRECT');
  });
});
