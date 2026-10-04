import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'selector',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        whiterabt: 'var(--font-whiterabt)',
        body: 'var(--font-whiterabt)',
        heading: 'var(--font-whiterabt)',
        mono: 'var(--font-whiterabt)',
      },
      colors: {
        // Redesign canon (docs/DESIGN.md §1). Values live in globals.css as
        // --c-* custom properties, one palette per theme; Tailwind v4 applies
        // opacity modifiers with color-mix, so `bg-surface-card/85` works.
        'surface-base': 'var(--c-surface-base)',
        'surface-alt': 'var(--c-surface-alt)',
        'surface-card': 'var(--c-surface-card)',
        'surface-card-hover': 'var(--c-surface-card-hover)',
        'surface-raised': 'var(--c-surface-raised)',
        'border-subtle': 'var(--c-border-subtle)',
        'border-hover': 'var(--c-border-hover)',
        'accent-violet': 'var(--c-accent-violet)',
        'accent-violet-light': 'var(--c-accent-violet-light)',
        'accent-violet-deep': 'var(--c-accent-violet-deep)',
        'accent-cyan': 'var(--c-accent-cyan)',
        'text-white': 'var(--c-text-white)',
        'text-main': 'var(--c-text-main)',
        'text-muted': 'var(--c-text-muted)',
        'text-dim': 'var(--c-text-dim)',
        'text-on-accent': 'var(--c-text-on-accent)',
        'status-active': 'var(--c-status-active)',
        'code-bg': 'var(--c-code-bg)',
        'code-fg': 'var(--c-code-fg)',
      },
    },
  },
};

export default config;
