import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { PostCard } from './PostCard';
import { getPostHref, slugifyTitle } from './postHref';

vi.mock('next/image', async () => {
  const React = await import('react');
  return {
    default: (props: { src?: string; alt?: string }) =>
      React.createElement('img', { alt: props.alt, src: props.src }),
  };
});

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: (props: {
      href?: string;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) =>
      React.createElement('a', { ...props, href: props.href }, props.children),
  };
});

const blogPost: BlogPost = {
  title: 'Hello World',
  id: 7,
  created_at: '2026-01-02T00:00:00.000Z',
  title_en: 'Hello World',
  title_it: 'Ciao Mondo',
  image: 'https://example.com/cover.webp',
  description_en: 'An english description',
  description_it: 'Una descrizione',
  body_en: '',
  body_it: '',
  blurhashURL: '',
  post_tags: '"typescript" "react"',
  views: 42,
  hidden: false,
};

const portfolioPost: PortfolioPost = {
  id: 9,
  created_at: '2026-01-02T00:00:00.000Z',
  title_en: 'Project X',
  title_it: 'Progetto X',
  image: 'https://example.com/project.webp',
  source_link: 'https://github.com/owner/repo',
  demo_link: 'https://example.com',
  description_en: 'A project description',
  description_it: 'Una descrizione progetto',
  body_en: '',
  body_it: '',
  blurhashURL: '',
  post_tags: '"nextjs"',
  store_link: '',
  fdroid_link: null,
  website: null,
  ios_store_link: null,
  views: 5,
  hidden: false,
};

describe('slugifyTitle / getPostHref', () => {
  it('builds the canonical detail href', () => {
    expect(
      getPostHref({
        locale: 'en',
        postType: 'blog',
        id: 7,
        title: 'Hello World!',
      })
    ).toBe('/en/blog/7/hello-world');
  });

  it('strips non-ascii characters', () => {
    expect(slugifyTitle('Caffè & Latte')).toBe('caff-latte');
  });
});

describe('PostCard render parity', () => {
  it('renders the canonical blog card link and meta', () => {
    const html = renderToStaticMarkup(
      createElement(PostCard, { post: blogPost, locale: 'en' })
    );

    expect(html).toContain('href="/en/blog/7/hello-world"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Hello World');
    expect(html).toContain('An english description');
    expect(html).toContain('42');
    expect(html).toContain('typescript');
    expect(html).toContain('rounded-2xl');
    const classes = html.match(/<a class="([^"]*)"/)?.[1].split(/\s+/);
    expect(classes).toContain('md:flex-row');
    expect(classes).toContain('hover:shadow-xl');
    expect(classes).not.toContain('hover:md:flex-row');
  });

  it('uses the portfolio source title and localised copy', () => {
    const html = renderToStaticMarkup(
      createElement(PostCard, { post: portfolioPost, locale: 'it' })
    );

    expect(html).toContain('href="/it/portfolio/9/project-x"');
    expect(html).toContain('Project X');
    expect(html).toContain('Una descrizione progetto');
    expect(html).toContain('nextjs');
  });
});
