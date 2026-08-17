/**
 * CMS-local cache invalidation for committed mutations.
 *
 * The CMS caches Supabase reads in its own Next Cache (Cache Components):
 * `getTranslationsSupabase` (src/utils/getData.ts) tags its result with
 * `cacheTags.translations` and is used by the CMS shell and previews. After a
 * committed mutation the CMS must invalidate BOTH:
 *
 * - its OWN local `'use cache'` entries — via `updateTag()` from the Server
 *   Action (immediate, same-request freshness for read-your-own-writes);
 * - the REMOTE public site — via the signed revalidation bridge
 *   (src/libs/public-site/revalidation.ts). This module is NOT the remote
 *   contract; it only decides which LOCAL tags a mutation touches.
 *
 * This module maps a content entity to the local cache tags affected, so
 * mutation actions never decide cache semantics ad hoc.
 */
import { cacheTags } from '@/libs/content/cacheTags';
import type { ContentEntity } from '@/libs/cms/invalidation';

export function getLocalInvalidationTags(entity: ContentEntity): string[] {
  switch (entity) {
    case 'translations':
      return [cacheTags.translations];
    // The CMS currently caches the top-level privacy_policy column nowhere,
    // so this is a no-op — kept so the mapping stays correct if a local
    // privacy read cache is ever added. It deliberately does NOT touch the
    // translations cache: privacy updates preserve `translations` untouched.
    case 'privacy':
      return [cacheTags.privacyPolicy];
    default:
      return [];
  }
}
