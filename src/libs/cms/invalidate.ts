import { updateTag } from 'next/cache';
import {
  getContentInvalidation,
  type ContentInvalidationArgs,
} from './invalidation';

/**
 * Monolithic adapter: applies descriptor tags via Server Action `updateTag`
 * (one tag per call — Next 16 signature).
 *
 * In the standalone CMS this becomes the signed HTTP revalidation client
 * (src/lib/public-site/revalidation.ts) sending the same descriptor's tags
 * to the public site's internal Route Handler.
 */
export function invalidateContent(args: ContentInvalidationArgs): void {
  for (const tag of getContentInvalidation(args)) {
    updateTag(tag);
  }
}
