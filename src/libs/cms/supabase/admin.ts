import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from '@supabase/supabase-js';
import {
  supabaseSchema,
  supabaseServerSecret,
  supabaseUrl,
} from '@/config/shared';

function createAdminClient() {
  return createSupabaseClient(supabaseUrl, supabaseServerSecret, {
    db: { schema: supabaseSchema },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// The client is configured with a runtime schema, so the value returned by the
// factory is generically wider than `SupabaseClient`, whose schema parameter
// defaults to the literal "public". The public signature stays
// `SupabaseClient`; the single widening cast is applied where the value is
// created so callers are unaffected.
type CmsAdminClient = SupabaseClient;

let cachedClient: CmsAdminClient | null = null;

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
    cachedClient = createAdminClient() as CmsAdminClient;
  }
  return cachedClient;
}
