import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { supabaseUrl } from '@/config/shared';

const supabaseServerSecret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

let cachedClient: SupabaseClient | null = null;

/**
 * Canonical server-only elevated Supabase client (bypasses RLS).
 *
 * - server code only (never imported by client components);
 * - session persistence disabled, never reads browser cookies;
 * - module-level cache is safe: the client is stateless (service key).
 *
 * Callers MUST authorize the current CMS user before using this client for
 * user-triggered mutations (see getCmsActionContext / requireAdmin /
 * requireAllowedPostWriter in src/app/actions/cms/utils/auth.ts and
 * fileHelpers.ts).
 */
export function getCmsAdminClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseServerSecret) {
    throw new Error('Missing Supabase admin credentials');
  }
  if (!cachedClient) {
    cachedClient = createSupabaseClient(supabaseUrl, supabaseServerSecret, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedClient;
}
