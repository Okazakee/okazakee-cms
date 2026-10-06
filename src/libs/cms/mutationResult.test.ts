import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CACHE_WARNING,
  errorMessage,
  revalidationWarning,
} from '@/libs/cms/mutationResult';

describe('errorMessage', () => {
  it('returns the message of a thrown Error', () => {
    expect(errorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('returns the message of a PostgREST failure object', () => {
    // Supabase rejects a query with a plain object, not an Error instance.
    expect(
      errorMessage(
        {
          code: '42703',
          details: null,
          hint: null,
          message: 'column hero_section.shape does not exist',
        },
        'fallback'
      )
    ).toBe('column hero_section.shape does not exist');
  });

  it('falls back for values that carry no message', () => {
    expect(errorMessage(null, 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
    expect(errorMessage({ code: '42703' }, 'fallback')).toBe('fallback');
    expect(errorMessage({ message: '' }, 'fallback')).toBe('fallback');
    expect(errorMessage('nope', 'fallback')).toBe('fallback');
  });
});

describe('revalidationWarning', () => {
  it('warns when a successful mutation could not reach the public cache', () => {
    expect(revalidationWarning({ success: true, revalidation: 'failed' })).toBe(
      PUBLIC_CACHE_WARNING
    );
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
