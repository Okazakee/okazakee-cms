import { describe, expect, it } from 'vitest';
import { authorTag, cacheTags, postDetailTag } from '@/libs/content/cacheTags';

describe('cacheTags', () => {
  it('exposes the stable public tag vocabulary', () => {
    expect(cacheTags).toMatchObject({
      translations: 'translations',
      privacyPolicy: 'privacy-policy',
      hero: 'hero',
      skills: 'skills',
      career: 'career',
      contacts: 'contacts',
      blog: 'blog',
      portfolio: 'portfolio',
      posts: 'posts',
      resume: 'resume',
      heroSection: 'hero_section',
    });
  });

  it('builds entity post detail tags', () => {
    expect(postDetailTag('blog', 12)).toBe('post:blog:12');
    expect(postDetailTag('portfolio', '42')).toBe('post:portfolio:42');
  });

  it('builds author tags', () => {
    expect(authorTag('user-1')).toBe('author:user-1');
    expect(authorTag(7)).toBe('author:7');
  });
});
