import { supabasePublishableKey, supabaseUrl } from './shared';

/**
 * CMS application configuration (server + client safe; no secrets here).
 * Server-only secrets (e.g. the elevated Supabase key) are read in
 * src/libs/cms/supabase/admin.ts.
 */
export const cmsConfig = {
  supabaseUrl,
  supabasePublishableKey,

  /** Canonical public origin of the standalone CMS (OAuth/recovery links). */
  cmsPublicUrl: process.env.CMS_PUBLIC_URL ?? '',

  /** Verbose CMS auth logging (also enabled automatically in development). */
  cmsAuthDebug: process.env.CMS_AUTH_DEBUG === 'true',
} as const;
