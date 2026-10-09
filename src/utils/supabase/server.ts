import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import {
  supabasePublishableKey,
  supabaseSchema,
  supabaseUrl,
} from '@/config/shared';

export async function createClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  // Widening cast for the same reason as the browser client: the runtime
  // schema makes the inferred generic broader than `SupabaseClient`, and every
  // caller annotates against that name.
  return createServerClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: supabaseSchema },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
  }) as SupabaseClient;
}
