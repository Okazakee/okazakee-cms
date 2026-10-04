/**
 * Isolated CMS fixture — constants.
 *
 * Everything here is loopback-only and disposable. The credentials are local,
 * non-secret test values created inside the throwaway GoTrue instance; they
 * are intentionally fixed so a browser driver can sign in deterministically.
 */

export const loopbackHosts = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/** Local Supabase API gateway port (config.toml [api] port). */
export const defaultSupabaseApiPort = 54321;
/** Auth/PostgREST/Storage all sit behind the API gateway. */
export const defaultSupabaseApiUrl = `http://127.0.0.1:${defaultSupabaseApiPort}`;

/** Next.js dev server. */
export const defaultNextPort = 3100;
/** Standalone fixture/revalidation server (never part of the app). */
export const defaultFixturePort = 3200;

/** Path of the public-site revalidation endpoint (mirrored locally). */
export const revalidationPath = '/api/internal/content-revalidate';

/** Max age accepted for the signed revalidation timestamp (seconds). */
export const revalidationReplayWindowSeconds = 300;

/** Local, non-secret test identities seeded into GoTrue. */
export const testAccounts = [
  {
    key: 'admin',
    email: 'admin@isolated.test',
    password: 'isolated-admin-pw',
    role: 'admin',
    githubUsername: 'fixture-admin',
    displayName: 'Fixture Admin',
  },
  {
    key: 'editor',
    email: 'editor@isolated.test',
    password: 'isolated-editor-pw',
    role: 'editor',
    githubUsername: 'fixture-editor',
    displayName: 'Fixture Editor',
  },
  {
    // Authenticates successfully but is NOT on the CMS allowlist: used to
    // prove the middleware/RLS deny path without prod credentials.
    key: 'outsider',
    email: 'outsider@isolated.test',
    password: 'isolated-outsider-pw',
    role: null,
    githubUsername: 'fixture-outsider',
    displayName: 'Fixture Outsider',
  },
];

/** Storage bucket that mirrors the production asset bucket. */
export const storageBucket = 'website';

/** Small deterministic assets uploaded to loopback Storage. */
export const storageAssets = [
  {
    path: 'avatar/avatar.png',
    contentType: 'image/png',
    // 1x1 transparent PNG.
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  {
    path: 'blog/post-1.png',
    contentType: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  {
    path: 'blog/post-2.png',
    contentType: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  {
    path: 'portfolio/app.png',
    contentType: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  {
    path: 'resume/resume_en.pdf',
    contentType: 'application/pdf',
    base64: minimalPdfBase64('Fixture resume (en)'),
  },
  {
    path: 'resume/resume_it.pdf',
    contentType: 'application/pdf',
    base64: minimalPdfBase64('Fixture resume (it)'),
  },
];

/** A syntactically valid single-page PDF; content is build-time generated. */
function minimalPdfBase64(text) {
  const body = [
    '%PDF-1.4',
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj',
    `4 0 obj<< /Length ${text.length + 40} >>stream`,
    `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`,
    'endstream',
    'endobj',
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj',
    'trailer<< /Root 1 0 R >>',
    '%%EOF',
  ].join('\n');
  return Buffer.from(body, 'utf8').toString('base64');
}

/** Tag vocabulary mirroring src/libs/content/cacheTags.ts (see the guard test). */
export const cacheTagVocabulary = {
  baseTags: [
    'translations',
    'privacy-policy',
    'hero',
    'skills',
    'career',
    'contacts',
    'blog',
    'portfolio',
    'posts',
    'resume',
    'hero_section',
    'site-settings',
  ],
  patterns: [/^post:(blog|portfolio):[^:]+$/, /^author:[^:]+$/],
};
