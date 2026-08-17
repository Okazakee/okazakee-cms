import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CACHE_WARNING,
  revalidationWarning,
} from '@/libs/cms/mutationResult';

describe('revalidationWarning', () => {
  it('warns when a successful mutation could not reach the public cache', () => {
    expect(
      revalidationWarning({ success: true, revalidation: 'failed' })
    ).toBe(PUBLIC_CACHE_WARNING);
  });

  it('stays quiet when propagation was sent', () => {
    expect(
      revalidationWarning({ success: true, revalidation: 'sent' })
    ).toBeNull();
  });

  it('stays quiet when propagation was skipped', () => {
    expect(
      revalidationWarning({ success: true, revalidation: 'skipped' })
    ).toBeNull();
  });

  it('stays quiet when the mutation itself failed', () => {
    expect(
      revalidationWarning({ success: false, revalidation: 'failed' })
    ).toBeNull();
  });

  it('stays quiet when no propagation status is present', () => {
    expect(revalidationWarning({ success: true })).toBeNull();
    expect(revalidationWarning({ success: false })).toBeNull();
  });
});
