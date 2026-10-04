import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { sortSkillsByPosition } from './canonical/skillOrder';
import { SkillsPreview } from './SkillsPreview';

vi.mock('next-intl', () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { has: () => true }),
}));
vi.mock('next/image', async () => {
  const React = await import('react');
  return {
    default: (props: { src?: string; alt?: string; className?: string }) =>
      React.createElement('img', {
        src: props.src,
        alt: props.alt,
        className: props.className,
      }),
  };
});
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: (props: Record<string, unknown>) =>
      React.createElement('a', props),
  };
});

type PreviewSkill = Parameters<
  typeof SkillsPreview
>[0]['categories'][number]['skills'][number];

const tileClasses =
  'group flex aspect-square w-24 flex-col items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface-card p-3 transition-colors hover:border-accent-violet/50 hover:bg-surface-card-hover sm:w-32 md:w-[150px]';

function skill(
  id: number,
  overrides: Partial<PreviewSkill> = {}
): PreviewSkill {
  return {
    id,
    title: `Skill ${id}`,
    icon: `https://cdn.example.com/${id}.svg`,
    invert: false,
    blurhashURL: '',
    link: null,
    position: null,
    ...overrides,
  };
}

function render(skills: PreviewSkill[]) {
  return renderToStaticMarkup(
    createElement(SkillsPreview, {
      categories: [{ id: 1, name: 'Languages', skills }],
    })
  );
}

describe('canonical skill order', () => {
  it('sorts positioned rows ascending and unpositioned rows last by id', () => {
    const ordered = sortSkillsByPosition([
      skill(7, { position: null }),
      skill(4, { position: 1 }),
      skill(9, { position: null }),
      skill(2, { position: 0 }),
    ]);

    expect(ordered.map((s) => s.id)).toEqual([2, 4, 7, 9]);
  });
});

describe('SkillsPreview tiles', () => {
  it('renders an unlinked tile as a plain div', () => {
    const markup = render([skill(1)]);

    expect(markup).toContain(`<div class="${tileClasses}">`);
    expect(markup).not.toContain('<a ');
  });

  it('renders a linked tile as an external anchor', () => {
    const markup = render([skill(1, { link: 'https://go.dev/' })]);

    expect(markup).toContain(
      `<a class="${tileClasses}" href="https://go.dev/" rel="noopener noreferrer" target="_blank">`
    );
    expect(markup).not.toContain(`<div class="${tileClasses}">`);
  });

  it('treats a blank link as no link', () => {
    const markup = render([skill(1, { link: '  ' })]);

    expect(markup).not.toContain('<a ');
    expect(markup).toContain(`<div class="${tileClasses}">`);
  });

  it('renders skills in the canonical order regardless of row order', () => {
    const markup = render([
      skill(3, { position: null }),
      skill(2, { position: 0 }),
      skill(1, { position: 1 }),
    ]);

    expect(markup.indexOf('Skill 2')).toBeLessThan(markup.indexOf('Skill 1'));
    expect(markup.indexOf('Skill 1')).toBeLessThan(markup.indexOf('Skill 3'));
  });
});
