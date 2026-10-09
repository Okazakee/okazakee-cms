import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  supabasePublishableKey,
  supabaseSchema,
  supabaseUrl,
} from '@/config/shared';

export function createClient(): SupabaseClient {
  // The client is created with a runtime schema, so its inferred generic is
  // wider than `SupabaseClient` (whose schema parameter defaults to the
  // literal "public"). Callers across the CMS annotate against
  // `SupabaseClient`, so the widening is asserted here once, at the single
  // point the schema is configured.
  return createBrowserClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: supabaseSchema },
    auth: {
      detectSessionInUrl: false,
      // Passkey (WebAuthn) ceremonies run in the browser only; sessions are
      // persisted to cookies and picked up by the SSR session middleware.
      experimental: { passkey: true },
    },
  }) as SupabaseClient;
}
