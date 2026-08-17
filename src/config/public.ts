import {
  appEnv,
  isProductionEnv,
  parsePositiveInt,
  supabasePublishableKey,
  supabaseUrl,
} from './shared';

const ISR_DEFAULT_SECONDS = isProductionEnv ? 60 * 60 * 24 : 60 * 10;

export const publicConfig = {
  supabaseUrl,
  supabasePublishableKey,

  /**
   * Supabase project hostname used for image remote patterns / preconnect.
   * Derived from the configured URL; no project-specific literal fallback.
   */
  supabaseHostname: supabaseUrl ? new URL(supabaseUrl).hostname : '',

  /**
   * Whether future-dated posts are hidden from public reads.
   * Explicit `CONTENT_ENFORCE_PUBLISH_DATE` wins; unset defaults to
   * production semantics. Set `CONTENT_ENFORCE_PUBLISH_DATE=false` on
   * staging/preview if future posts must be visible there.
   */
  contentEnforcePublishDate:
    process.env.CONTENT_ENFORCE_PUBLISH_DATE === 'true' ||
    (process.env.CONTENT_ENFORCE_PUBLISH_DATE === undefined && isProductionEnv),

  /**
   * Cache revalidation lifetime in seconds (public content + GitHub stars).
   * Defaults: production 86400, otherwise 600. Explicit ISR_REVALIDATION wins.
   */
  isrRevalidationSeconds:
    parsePositiveInt(process.env.ISR_REVALIDATION) ?? ISR_DEFAULT_SECONDS,

  umamiEnabled: process.env.UMAMI_ENABLED === 'true',

  appEnv,
} as const;
