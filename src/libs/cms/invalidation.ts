/**
 * Public-cache invalidation descriptors.
 *
 * CMS decoupling Phase 2 "strangler" step: CMS section actions stop deciding
 * cache semantics ad hoc and instead derive the affected tag set from a
 * single domain vocabulary (src/libs/content/cacheTags.ts).
 *
 * While monolithic, `invalidateContent` (src/libs/cms/invalidate.ts) feeds
 * these tags to Server Action `updateTag`. After the split, the same
 * descriptor feeds the signed HTTP revalidation event sent to the public
 * site's internal Route Handler.
 */
import { authorTag, cacheTags, postDetailTag } from '@/libs/content/cacheTags';

export type ContentEntity =
  | 'blog'
  | 'portfolio'
  | 'career'
  | 'skills'
  | 'contacts'
  | 'hero'
  | 'resume'
  | 'translations'
  | 'privacy'
  | 'author';

export type ContentOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'publish'
  | 'unpublish'
  | 'asset-update';

export type ContentInvalidationArgs = {
  entity: ContentEntity;
  operation: ContentOperation;
  /** Single-row entity id (post update/delete, author profile). */
  id?: number | string;
  /** Batch ids: every affected row id (composite publishes). */
  ids?: Array<number | string>;
  /** Explicit additional tags (e.g. i18n update touching privacy too). */
  extraTags?: string[];
};

export function getContentInvalidation(
  args: ContentInvalidationArgs
): string[] {
  const tags = new Set<string>();
  const { entity, operation, id, ids, extraTags } = args;

  switch (entity) {
    case 'hero':
      tags.add(cacheTags.hero);
      break;
    case 'resume':
      tags.add(cacheTags.resume);
      tags.add(cacheTags.heroSection);
      break;
    case 'skills':
      tags.add(cacheTags.skills);
      break;
    case 'career':
      tags.add(cacheTags.career);
      break;
    case 'contacts':
      tags.add(cacheTags.contacts);
      break;
    case 'translations':
      tags.add(cacheTags.translations);
      break;
    case 'privacy':
      tags.add(cacheTags.privacyPolicy);
      break;
    case 'author':
      if (id !== undefined) tags.add(authorTag(id));
      break;
    case 'blog':
    case 'portfolio': {
      tags.add(entity);
      tags.add(cacheTags.posts);
      if (operation === 'create') break;

      // update/delete/publish also invalidate post-detail caches
      tags.add(cacheTags.post); // legacy broad tag, kept during migration
      const rowIds = [...(ids ?? []), ...(id !== undefined ? [id] : [])];
      for (const rowId of rowIds) {
        tags.add(postDetailTag(entity, rowId));
      }
      break;
    }
  }

  for (const tag of extraTags ?? []) {
    tags.add(tag);
  }

  return [...tags];
}
