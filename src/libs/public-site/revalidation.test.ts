import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signRevalidationEvent } from '@/libs/public-site/revalidation';

describe('signRevalidationEvent', () => {
  it('matches the public-side contract: v1= + HMAC-SHA256(timestamp.body)', () => {
    const secret = 'shared-secret';
    const timestamp = '2026-08-17T09:00:00.000Z';
    const body = '{"version":1,"tags":["blog"]}';

    const expected = `v1=${createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')}`;

    expect(signRevalidationEvent(secret, timestamp, body)).toBe(expected);
    expect(signRevalidationEvent(secret, timestamp, body)).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
