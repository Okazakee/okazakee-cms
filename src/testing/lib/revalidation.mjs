/**
 * Isolated fixture — local mirror of the public site's signed revalidation
 * receiver contract.
 *
 * Mirrors src/libs/public-site/revalidation.ts (CMS side) and the public
 * repo's src/libs/content/revalidation.ts:
 *
 *   POST /api/internal/content-revalidate
 *   X-Content-Timestamp: <occurredAt ISO>
 *   X-Content-Signature: v1=<HMAC-SHA256(secret, timestamp + "." + body)>
 *
 * It also enforces the replay window and the cache-tag allowlist, and stores
 * every accepted/rejected event for assertions. It is a standalone test server
 * and is never mounted in the Next application.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  cacheTagVocabulary,
  revalidationReplayWindowSeconds,
} from './config.mjs';

export function signRevalidationEvent(secret, timestamp, rawBody) {
  return `v1=${createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')}`;
}

export function isAllowedTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) return false;
  if (cacheTagVocabulary.baseTags.includes(tag)) return true;
  return cacheTagVocabulary.patterns.some((pattern) => pattern.test(tag));
}

function safeEqual(a, b) {
  const left = Buffer.from(a ?? '', 'utf8');
  const right = Buffer.from(b ?? '', 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @returns {{ ok: boolean, reason?: string, ageSeconds?: number }}
 */
export function verifyRevalidationRequest({
  secret,
  rawBody,
  timestamp,
  signature,
  now = Date.now(),
  replayWindowSeconds = revalidationReplayWindowSeconds,
}) {
  if (!timestamp) return { ok: false, reason: 'missing-timestamp' };
  if (!signature) return { ok: false, reason: 'missing-signature' };

  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return { ok: false, reason: 'invalid-timestamp' };

  const ageSeconds = Math.abs(now - parsed) / 1000;
  if (ageSeconds > replayWindowSeconds) {
    return { ok: false, reason: 'timestamp-out-of-window', ageSeconds };
  }

  const expected = signRevalidationEvent(secret, timestamp, rawBody);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: 'invalid-signature', ageSeconds };
  }
  return { ok: true, ageSeconds };
}

export function validateEventPayload(event) {
  if (!event || typeof event !== 'object') return 'invalid-body';
  if (event.version !== 1) return 'unsupported-version';
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    return 'missing-event-id';
  }
  if (typeof event.occurredAt !== 'string') return 'missing-occurred-at';
  if (!Array.isArray(event.tags) || event.tags.length === 0) {
    return 'missing-tags';
  }
  const invalid = event.tags.filter((tag) => !isAllowedTag(tag));
  if (invalid.length > 0) return `disallowed-tags:${invalid.join(',')}`;
  return null;
}
