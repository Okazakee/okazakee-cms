import { describe, expect, it } from 'vitest';
import { cacheTags } from '@/libs/content/cacheTags';
import { cacheTagVocabulary } from './config.mjs';
import {
  isAllowedTag,
  signRevalidationEvent,
  validateEventPayload,
  verifyRevalidationRequest,
} from './revalidation.mjs';

/**
 * The local receiver must mirror the public-site revalidation contract and the
 * shared cache-tag vocabulary. These guards fail if either drifts.
 */
describe('revalidation receiver contract', () => {
  it('mirrors the shared cache-tag vocabulary exactly', () => {
    expect([...cacheTagVocabulary.baseTags].sort()).toEqual(
      Object.values(cacheTags).sort()
    );
  });

  it('accepts base tags, post detail tags and author tags only', () => {
    expect(isAllowedTag('blog')).toBe(true);
    expect(isAllowedTag('hero_section')).toBe(true);
    expect(isAllowedTag('post:blog:12')).toBe(true);
    expect(isAllowedTag('post:portfolio:7')).toBe(true);
    expect(isAllowedTag('author:abc')).toBe(true);
    expect(isAllowedTag('post:unknown:1')).toBe(false);
    expect(isAllowedTag('../../etc/passwd')).toBe(false);
  });

  it('verifies a correctly signed request', () => {
    const secret = 'local-secret';
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ version: 1, tags: ['blog'] });
    const signature = signRevalidationEvent(secret, timestamp, body);
    const result = verifyRevalidationRequest({
      secret,
      rawBody: body,
      timestamp,
      signature,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid signature and a stale timestamp', () => {
    const secret = 'local-secret';
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ version: 1, tags: ['blog'] });
    expect(
      verifyRevalidationRequest({
        secret,
        rawBody: body,
        timestamp,
        signature: 'v1=00',
      }).ok
    ).toBe(false);

    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleSignature = signRevalidationEvent(secret, stale, body);
    expect(
      verifyRevalidationRequest({
        secret,
        rawBody: body,
        timestamp: stale,
        signature: staleSignature,
      }).reason
    ).toBe('timestamp-out-of-window');
  });

  it('rejects payloads with disallowed tags', () => {
    expect(
      validateEventPayload({
        version: 1,
        eventId: 'e',
        occurredAt: 't',
        tags: [],
      })
    ).toBe('missing-tags');
    expect(
      validateEventPayload({
        version: 1,
        eventId: 'e',
        occurredAt: 't',
        tags: ['blog', 'evil'],
      })
    ).toBe('disallowed-tags:evil');
  });
});
