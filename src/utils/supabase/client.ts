import { createBrowserClient } from '@supabase/ssr';
import { supabasePublishableKey, supabaseUrl } from '@/config/shared';

export function createClient() {
  return createBrowserClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        detectSessionInUrl: false,
      },
    }
  );
}
