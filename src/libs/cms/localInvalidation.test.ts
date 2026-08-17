import { describe, expect, it } from 'vitest';
import { getLocalInvalidationTags } from '@/libs/cms/localInvalidation';

describe('getLocalInvalidationTags', () => {
  it('maps translation mutations to the local translations cache tag', () => {
    expect(getLocalInvalidationTags('translations')).toEqual(['translations']);
  });

  it('maps privacy mutations to the privacy tag, never the translations tag', () => {
    // Privacy updates preserve the `translations` JSON untouched, so the CMS
    // shell's cached translations must survive a privacy-only save.
    expect(getLocalInvalidationTags('privacy')).toEqual(['privacy-policy']);
    expect(getLocalInvalidationTags('privacy')).not.toContain('translations');
  });

  it('returns no local tags for entities the CMS does not cache locally', () => {
    for (const entity of [
      'blog',
      'portfolio',
      'career',
      'skills',
      'contacts',
      'hero',
      'resume',
      'author',
    ] as const) {
      expect(getLocalInvalidationTags(entity)).toEqual([]);
    }
  });
});
