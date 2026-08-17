import { describe, expect, it } from 'vitest';
import { getContentInvalidation } from '@/libs/cms/invalidation';

describe('getContentInvalidation', () => {
  it('maps hero mutations to the hero tag', () => {
    expect(
      getContentInvalidation({ entity: 'hero', operation: 'update' })
    ).toEqual(['hero']);
    expect(
      getContentInvalidation({ entity: 'hero', operation: 'asset-update' })
    ).toEqual(['hero']);
  });

  it('maps resume mutations to resume + hero_section', () => {
    expect(
      getContentInvalidation({ entity: 'resume', operation: 'update' })
    ).toEqual(['resume', 'hero_section']);
  });

  it('maps section collections to their collection tag', () => {
    expect(
      getContentInvalidation({ entity: 'skills', operation: 'update' })
    ).toEqual(['skills']);
    expect(
      getContentInvalidation({ entity: 'career', operation: 'update' })
    ).toEqual(['career']);
    expect(
      getContentInvalidation({ entity: 'contacts', operation: 'update' })
    ).toEqual(['contacts']);
    expect(
      getContentInvalidation({ entity: 'translations', operation: 'update' })
    ).toEqual(['translations']);
    expect(
      getContentInvalidation({ entity: 'privacy', operation: 'update' })
    ).toEqual(['privacy-policy']);
  });

  it('blog create invalidates collection + posts list only', () => {
    expect(
      getContentInvalidation({ entity: 'blog', operation: 'create' })
    ).toEqual(['blog', 'posts']);
  });

  it('blog update invalidates collection, list, broad post and entity tag', () => {
    expect(
      getContentInvalidation({ entity: 'blog', operation: 'update', id: 42 })
    ).toEqual(['blog', 'posts', 'post', 'post:blog:42']);
  });

  it('portfolio delete invalidates portfolio entity tag', () => {
    expect(
      getContentInvalidation({
        entity: 'portfolio',
        operation: 'delete',
        id: 7,
      })
    ).toEqual(['portfolio', 'posts', 'post', 'post:portfolio:7']);
  });

  it('batch publish emits one tag per affected row id', () => {
    expect(
      getContentInvalidation({
        entity: 'blog',
        operation: 'publish',
        ids: [1, 2, 3],
      })
    ).toEqual([
      'blog',
      'posts',
      'post',
      'post:blog:1',
      'post:blog:2',
      'post:blog:3',
    ]);
  });

  it('author profile changes invalidate the author entity tag', () => {
    expect(
      getContentInvalidation({
        entity: 'author',
        operation: 'update',
        id: 'user-1',
      })
    ).toEqual(['author:user-1']);
  });

  it('author invalidation without an id emits nothing', () => {
    expect(
      getContentInvalidation({ entity: 'author', operation: 'update' })
    ).toEqual([]);
  });

  it('deduplicates tags and merges extraTags', () => {
    expect(
      getContentInvalidation({
        entity: 'translations',
        operation: 'update',
        extraTags: ['translations', 'privacy-policy'],
      })
    ).toEqual(['translations', 'privacy-policy']);
  });
});
