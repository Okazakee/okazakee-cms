/**
 * Demo-mode fixture dataset (client-safe: no server imports).
 *
 * Fully invented persona ("Demo Dana") with zero network dependencies:
 * every image is an inline SVG data URI, every blurhash is the shared
 * fallback. Nothing here ever touches Supabase — demo edits live and die
 * in memory. Shapes mirror the real section contracts so demo branches
 * stay honest.
 */
import { FALLBACK_BLURHASH } from '@/utils/blurhashUtils';
import type { HeroSettings } from '@/types/fetchedData.types';
import type { ResumeData } from '@/libs/resume/types';
import type { CMSUser } from '@/app/actions/cms/getUser';

function demoSvg(label: string, bg: string, fg = '#ffffff'): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">` +
    `<rect width="640" height="360" fill="${bg}"/>` +
    `<text x="320" y="190" font-family="sans-serif" font-size="42" fill="${fg}" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const DEMO_BLURHASH = FALLBACK_BLURHASH;

export const demoUser: CMSUser = {
  id: 'demo-user',
  email: 'demo@example.com',
  displayName: 'Demo Dana',
  avatarUrl: null,
  role: 'admin',
  authProvider: 'email',
  githubUsername: null,
  githubUserId: null,
};

export const demoHeroSection: HeroSettings = {
  mainImage: demoSvg('DD', '#7c3aed'),
  blurhashURL: FALLBACK_BLURHASH,
  resume_en: null,
  resume_it: null,
  shape: 'pebble',
};

export const demoHeroTranslations = {
  en: {
    'top.name': 'Demo ****Dana****',
    'top.role1': 'Fullstack ****Developer****',
    'top.role2': 'Demo ****Enthusiast****',
    'aboutme.paragraph':
      'This is a *fully fake* profile for showcasing the CMS. Nothing here is saved anywhere — reload and it resets.',
  },
  it: {
    'top.name': 'Demo ****Dana****',
    'top.role1': 'Sviluppatrice ****Fullstack****',
    'top.role2': 'Appassionata ****Demo****',
    'aboutme.paragraph':
      'Questo è un profilo *completamente finto* per mostrare il CMS. Nulla viene salvato — ricarica e si azzera.',
  },
};

export const demoRequestFormTranslations = {
  en: {
    title: 'Start a project',
    subtitle: 'Tell me about your *dream* project.',
    nameLabel: 'Your name',
    requestLabel: 'Project details',
    consent: 'I agree to be contacted about ****this request****.',
    submit: 'Send request',
  },
  it: {
    title: 'Avvia un progetto',
    subtitle: 'Raccontami il tuo progetto *dei sogni*.',
    nameLabel: 'Il tuo nome',
    requestLabel: 'Dettagli progetto',
    consent: 'Accetto di essere contattata per ****questa richiesta****.',
    submit: 'Invia richiesta',
  },
};

export const demoPrivacy = {
  en: '# Demo privacy policy\n\nThis *fake* policy demonstrates the editor.\n\n## Data\n\nNo data is **collected** here.',
  it: '# Informativa demo\n\nQuesta informativa *finta* dimostra l\u2019editor.\n\n## Dati\n\nQui non viene **raccolto** nulla.',
};

export const demoSkills = [
  {
    id: 1,
    name: 'Frontend',
    position: 0,
    skills: [
      {
        id: 11,
        title: 'React',
        icon: demoSvg('R', '#61dafb', '#000000'),
        invert: false,
        category_id: 1,
        blurhashURL: FALLBACK_BLURHASH,
        link: null,
        position: 0,
      },
      {
        id: 12,
        title: 'TypeScript',
        icon: demoSvg('TS', '#3178c6'),
        invert: false,
        category_id: 1,
        blurhashURL: FALLBACK_BLURHASH,
        link: null,
        position: 1,
      },
    ],
  },
  {
    id: 2,
    name: 'Backend',
    position: 1,
    skills: [
      {
        id: 21,
        title: 'PostgreSQL',
        icon: demoSvg('PG', '#4169e1'),
        invert: false,
        category_id: 2,
        blurhashURL: FALLBACK_BLURHASH,
        link: null,
        position: 0,
      },
    ],
  },
];

export const demoCareer = [
  {
    id: 1,
    title: 'Senior Demo Engineer',
    company: 'Fakescale Inc',
    website_url: 'https://example.com',
    logo: demoSvg('FS', '#10b981'),
    blurhashURL: FALLBACK_BLURHASH,
    location_en: 'Demo City (Remote)',
    location_it: 'Città Demo (Remoto)',
    remote: 'full' as const,
    startDate: '2023-01-01',
    endDate: null,
    description_en: 'Building *fake* things at scale.',
    description_it: 'Costruisco cose *finte* su larga scala.',
    skills: 'React, TypeScript',
    created_at: '2023-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    title: 'Junior Placeholder',
    company: 'Lorem Labs',
    website_url: 'https://example.com',
    logo: demoSvg('LL', '#f59e0b'),
    blurhashURL: FALLBACK_BLURHASH,
    location_en: 'Nowhere, Earth (OnSite)',
    location_it: 'Nessun Luogo (In sede)',
    remote: 'onSite' as const,
    startDate: '2021-06-01',
    endDate: '2022-12-31',
    description_en: 'Learned how to ****demo**** properly.',
    description_it: 'Ho imparato a fare ****demo**** per bene.',
    skills: 'HTML, CSS',
    created_at: '2021-06-01T00:00:00.000Z',
  },
];

const demoPostBody = (title: string): string =>
  [
    `## ${title}`,
    `This is a *demo* post body with ****bold**** text.`,
    '',
    '- First point',
    '- Second point',
    '',
    '```ts',
    'const demo = true;',
    '```',
    '',
    `![Demo figure-${FALLBACK_BLURHASH}](${demoSvg('FIG', '#8b5cf6')})`,
    '',
    'Read [more](https://example.com) here.',
  ].join('\n');

export const demoBlogPosts = [
  {
    id: 1,
    created_at: '2024-05-01T00:00:00.000Z',
    title: 'Demo post one',
    title_en: 'Demo post one',
    title_it: 'Articolo demo uno',
    image: demoSvg('B1', '#0ea5e9'),
    description_en: 'First *fake* article.',
    description_it: 'Primo articolo *finto*.',
    body_en: demoPostBody('Hello demo'),
    body_it: demoPostBody('Ciao demo'),
    blurhashURL: FALLBACK_BLURHASH,
    post_tags: '"demo" "cms"',
    views: 123,
    hidden: false,
    author_id: 'demo-user',
  },
  {
    id: 2,
    created_at: '2024-06-15T00:00:00.000Z',
    title: 'Demo post two',
    title_en: 'Demo post two',
    title_it: 'Articolo demo due',
    image: demoSvg('B2', '#ec4899'),
    description_en: 'Second *fake* article.',
    description_it: 'Secondo articolo *finto*.',
    body_en: demoPostBody('Again demo'),
    body_it: demoPostBody('Ancora demo'),
    blurhashURL: FALLBACK_BLURHASH,
    post_tags: '"demo"',
    views: 45,
    hidden: false,
    author_id: 'demo-user',
  },
];

export const demoPortfolioPosts = [
  {
    id: 1,
    created_at: '2024-03-01T00:00:00.000Z',
    title_en: 'Demo project',
    title_it: 'Progetto demo',
    image: demoSvg('P1', '#10b981'),
    description_en: 'A *showcase* project that does nothing.',
    description_it: 'Un progetto *vetrina* che non fa nulla.',
    body_en: demoPostBody('Project demo'),
    body_it: demoPostBody('Demo progetto'),
    blurhashURL: FALLBACK_BLURHASH,
    post_tags: '"demo" "portfolio"',
    buttons: [{ kind: 'source', url: 'https://example.com' }],
    views: 77,
    hidden: false,
    author_id: 'demo-user',
  },
];

export const demoContacts = [
  {
    id: 1,
    position: 0,
    label: 'Email',
    icon: demoSvg('E', '#64748b'),
    link: 'mailto:demo@example.com',
    bg_color: '#64748b',
  },
  {
    id: 2,
    position: 1,
    label: 'GitHub',
    icon: demoSvg('G', '#24292e'),
    link: 'https://example.com',
    bg_color: '#24292e',
  },
];

export const demoSiteSettings = {
  id: 1,
  created_at: '2024-01-01T00:00:00.000Z',
  header_logo_dark: null,
  header_logo_light: null,
  footer_vat_number: null,
};

export const demoUsers = [
  {
    id: 'demo-user',
    role: 'admin',
    email: 'demo@example.com',
    propic: demoSvg('DD', '#7c3aed'),
  },
  {
    id: 'demo-editor',
    role: 'editor',
    email: 'editor@example.com',
    propic: demoSvg('ED', '#0ea5e9'),
  },
];

export const demoRequests = [
  {
    id: 1,
    created_at: '2024-07-01T00:00:00.000Z',
    locale: 'en',
    name: 'Fake Client',
    email: 'client@example.com',
    company: 'Example Co',
    website: 'https://example.com',
    project_type: 'Website',
    budget: '€1–5k',
    timeline: 'Flexible',
    request: 'I would like a *demo* website, please.',
    consent: true,
    archived: false,
    archived_at: null,
  },
  {
    id: 2,
    created_at: '2024-07-02T00:00:00.000Z',
    locale: 'it',
    name: 'Cliente Finto',
    email: 'cliente@example.com',
    company: '',
    website: '',
    project_type: 'Mobile app',
    budget: '€5–15k',
    timeline: 'ASAP',
    request: 'Vorrei un\u2019app *demo*, grazie.',
    consent: true,
    archived: true,
    archived_at: '2024-07-03T00:00:00.000Z',
  },
];

export const demoResumeSources: {
  en: ResumeData;
  it: ResumeData;
  css: string;
} = {
  en: {
    name: 'Demo Dana',
    title: 'Fullstack Developer · Demo Data',
    contacts: [
      { icon: 'location', text: 'Demo City' },
      { icon: 'email', text: 'demo@example.com', href: 'mailto:demo@example.com' },
      { icon: 'website', text: 'demo.example.com', href: 'https://demo.example.com' },
      { icon: 'document', text: 'IT00000000000' },
    ],
    summaryTitle: 'Summary',
    summaryHtml: 'A *fully fake* resume for the CMS demo.',
    skillsTitle: 'Skills',
    skills: [{ label: 'Core', tags: ['TypeScript', 'React'] }],
    experienceTitle: 'Experience',
    experience: [
      {
        title: 'Senior Demo Engineer',
        sub: 'Fakescale Inc',
        meta: '2023 – Now',
        bullets: ['Built <strong>fake</strong> things.'],
      },
    ],
    projectsTitle: 'Projects',
    projects: [
      {
        name: 'Demo Project',
        links: [],
        stack: 'TypeScript',
        bullets: ['Does <strong>nothing</strong>, beautifully.'],
      },
    ],
    educationTitle: 'Education',
    education: [{ degree: 'Demo Studies', school: 'Example U', year: '2020' }],
    languagesTitle: 'Languages',
    languages: [{ name: 'English', level: 'Native' }],
  },
  it: {
    name: 'Demo Dana',
    title: 'Sviluppatrice Fullstack · Dati Demo',
    contacts: [
      { icon: 'location', text: 'Città Demo' },
      { icon: 'email', text: 'demo@example.com', href: 'mailto:demo@example.com' },
      { icon: 'website', text: 'demo.example.com', href: 'https://demo.example.com' },
      { icon: 'document', text: 'IT00000000000' },
    ],
    summaryTitle: 'Profilo',
    summaryHtml: 'Un curriculum *completamente finto* per la demo del CMS.',
    skillsTitle: 'Competenze',
    skills: [{ label: 'Base', tags: ['TypeScript', 'React'] }],
    experienceTitle: 'Esperienza',
    experience: [
      {
        title: 'Senior Demo Engineer',
        sub: 'Fakescale Inc',
        meta: '2023 – Oggi',
        bullets: ['Costruito cose <strong>finte</strong>.'],
      },
    ],
    projectsTitle: 'Progetti',
    projects: [
      {
        name: 'Progetto Demo',
        links: [],
        stack: 'TypeScript',
        bullets: ['Non fa <strong>nulla</strong>, benissimo.'],
      },
    ],
    educationTitle: 'Istruzione',
    education: [{ degree: 'Studi Demo', school: 'Example U', year: '2020' }],
    languagesTitle: 'Lingue',
    languages: [{ name: 'Italiano', level: 'Madrelingua' }],
  },
  css: '',
};
