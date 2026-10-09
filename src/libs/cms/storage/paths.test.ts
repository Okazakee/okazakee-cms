import { describe, expect, it } from 'vitest';
import {
  BLOG_STAGING_PREFIX,
  PORTFOLIO_STAGING_PREFIX,
  avatarPrefixForProfile,
  basenameOfStoragePath,
  blogPostPrefix,
  finalizedPostAssetPath,
  portfolioPostPrefix,
} from './paths';

describe('post storage paths', () => {
  it('builds per-post prefixes', () => {
    expect(blogPostPrefix(1)).toBe('blog/1');
    expect(portfolioPostPrefix(21)).toBe('portfolio/21');
  });

  it('exposes staging prefixes for pre-insert uploads', () => {
    expect(BLOG_STAGING_PREFIX).toBe('blog/staging');
    expect(PORTFOLIO_STAGING_PREFIX).toBe('portfolio/staging');
  });

  it('finalizes a staged upload under its post prefix', () => {
    expect(
      finalizedPostAssetPath('blog/7', 'blog/staging/123-uuid-cover.webp')
    ).toBe('blog/7/123-uuid-cover.webp');
  });

  it('takes the basename of a storage path', () => {
    expect(basenameOfStoragePath('blog/18/banner.webp')).toBe('banner.webp');
    expect(basenameOfStoragePath('plain.webp')).toBe('plain.webp');
  });

  it('builds per-profile avatar prefixes', () => {
    expect(avatarPrefixForProfile('user-1')).toBe('avatars/user-1');
  });
});
