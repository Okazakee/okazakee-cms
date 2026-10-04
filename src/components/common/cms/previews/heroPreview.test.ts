import { type AbstractIntlMessages, NextIntlClientProvider } from 'next-intl';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import cmsEn from '@/i18n/messages/cms.en.json';
import type { HeroShape, TypewriterTarget } from '@/types/fetchedData.types';
import { HeroPreview } from './HeroPreview';

const IntlProvider = NextIntlClientProvider as unknown as ComponentType<{
  locale: string;
  timeZone: string;
  messages: AbstractIntlMessages;
}>;

type HeroMessages = {
  top?: {
    name?: string;
    role?: string;
    roles?: string[] | Record<string, string>;
  };
  aboutme?: { title?: string; paragraph?: string };
};

const render = (
  messages: HeroMessages,
  overrides: {
    shape?: HeroShape;
    typewriter?: boolean;
    typewriterTarget?: TypewriterTarget;
  } = {}
) =>
  renderToStaticMarkup(
    createElement(
      IntlProvider,
      {
        locale: 'en',
        timeZone: 'Europe/Rome',
        messages: {
          cms: cmsEn,
          'hero-section': messages,
        } as unknown as AbstractIntlMessages,
      },
      createElement(HeroPreview, {
        mainImage: 'https://example.test/propic.webp',
        blurhashURL: '',
        shape: overrides.shape ?? 'pebble',
        typewriter: overrides.typewriter ?? false,
        typewriterTarget: overrides.typewriterTarget ?? 'role1',
      })
    )
  );

const roleLines = (markup: string) =>
  [...markup.matchAll(/<p class="font-mono[^"]*">([\s\S]*?)<\/p>/g)].map(
    (match) => match[1]
  );

describe('HeroPreview', () => {
  it('renders the pebble portrait and the singular role exactly as before', () => {
    const markup = render({
      top: { name: 'Ada', role: 'Fullstack ****Developer****' },
      aboutme: { title: 'About', paragraph: 'One.\n\nTwo.' },
    });

    expect(markup).toContain('clip-pebble relative h-full w-full');
    expect(markup).toContain('id="pebble-clip"');
    expect(roleLines(markup)).toEqual(['Fullstack <label>Developer</label>']);
    // A single role keeps the historic single line: no list spacing.
    expect(markup).toContain('max-w-2xl text-center');
  });

  it('renders one line per stored role, in index order', () => {
    const markup = render({
      top: { name: 'Ada', role: 'Legacy', roles: ['First', 'Second'] },
    });

    expect(roleLines(markup)).toEqual(['First', 'Second']);
    expect(markup).toContain('max-w-2xl space-y-1 text-center');
  });

  it('renders the squircle clip the website ships', () => {
    const markup = render(
      { top: { name: 'Ada', role: 'Dev' } },
      { shape: 'squircle' }
    );

    expect(markup).toContain('clip-squircle relative h-full w-full');
    expect(markup).toContain('id="squircle-clip"');
  });

  it('marks the configured line and spells out the setting without typing', () => {
    const markup = render(
      { top: { name: 'Ada', roles: ['First', 'Second'] } },
      { typewriter: true, typewriterTarget: 'role2' }
    );

    expect(roleLines(markup)).toEqual([
      'First',
      '<span class="contents" data-hero-typewriter="true">Second</span>',
    ]);
    expect(markup).toContain('Typewriter (static in preview) · Second role');
  });

  it('shows no typewriter note while the animation is off', () => {
    const markup = render({ top: { name: 'Ada', role: 'Dev' } });

    expect(markup).not.toContain('data-hero-typewriter');
    expect(markup).not.toContain('Typewriter (static in preview)');
  });
});
