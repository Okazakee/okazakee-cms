/**
 * Public-site revalidation client (standalone CMS side).
 *
 * After a successful content mutation the CMS derives the affected cache tags
 * from the shared descriptor vocabulary (src/libs/cms/invalidation.ts) and
 * sends ONE signed HTTP event to the public website's internal Route Handler:
 *
 *   POST /api/internal/content-revalidate
 *   X-Content-Timestamp: <occurredAt ISO>
 *   X-Content-Signature: v1=<HMAC-SHA256(secret, timestamp + "." + body)>
 *
 * Contract mirror: src/libs/content/revalidation.ts in the public repo.
 * Keep both sides in sync (signature format, allowed tags, replay window).
 */
import { createHmac } from 'node:crypto';
import {
  getContentInvalidation,
  type ContentInvalidationArgs,
} from '@/libs/cms/invalidation';

const REVALIDATION_URL = process.env.WEBSITE_REVALIDATION_URL ?? '';
const REVALIDATION_SECRET = process.env.WEBSITE_REVALIDATION_SECRET ?? '';
const REQUEST_TIMEOUT_MS = 5000;

export type RevalidationStatus = 'sent' | 'skipped' | 'failed';

export function signRevalidationEvent(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return `v1=${hmac.digest('hex')}`;
}

/**
 * Sends one deduplicated invalidation event for the committed changes.
 * NEVER throws: a valid committed mutation must not be reported as a failed
 * DB write because the cross-app request failed. Failures are logged with
 * the event id for retry/debug.
 */
export async function invalidatePublicContent(
  args: ContentInvalidationArgs
): Promise<RevalidationStatus> {
  const tags = getContentInvalidation(args);
  if (tags.length === 0) return 'skipped';

  if (!REVALIDATION_URL || !REVALIDATION_SECRET) {
    console.warn(
      '[revalidation] skipped: WEBSITE_REVALIDATION_URL/WEBSITE_REVALIDATION_SECRET not configured'
    );
    return 'skipped';
  }

  const occurredAt = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const event = {
    version: 1,
    eventId,
    occurredAt,
    source: 'okazakee-cms',
    operation: args.operation,
    entity: args.entity,
    entityId: args.id,
    tags,
  };

  const rawBody = JSON.stringify(event);
  const signature = signRevalidationEvent(
    REVALIDATION_SECRET,
    occurredAt,
    rawBody
  );

  try {
    const response = await fetch(REVALIDATION_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-content-timestamp': occurredAt,
        'x-content-signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(
        '[revalidation] rejected by public site:',
        eventId,
        response.status,
        await response.text().catch(() => '')
      );
      return 'failed';
    }

    return 'sent';
  } catch (error) {
    console.error(
      '[revalidation] request failed:',
      eventId,
      error instanceof Error ? error.message : 'Unknown error'
    );
    return 'failed';
  }
}
