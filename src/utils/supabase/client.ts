import { createBrowserClient } from '@supabase/ssr';
import { supabasePublishableKey, supabaseUrl } from '@/config/shared';

export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      detectSessionInUrl: false,
      // Passkey (WebAuthn) ceremonies run in the browser only; sessions are
      // persisted to cookies and picked up by the SSR session middleware.
      experimental: { passkey: true },
    },
  });
}
