/**
 * Isolated fixture — read-only database observation helpers.
 *
 * Uses the local service_role key only. Never reads production credentials or
 * data; the URL is validated as loopback by the orchestrator before this runs.
 */
import { createAdminClient } from './auth.mjs';

export const contentTables = [
  'hero_section',
  'i18n_translations',
  'contacts',
  'skills_categories',
  'skills',
  'career_entries',
  'blog_posts',
  'portfolio_posts',
  'cms_allowed_users',
  'user_profiles',
];

export function createServiceClient(status) {
  return createAdminClient(status);
}

export async function snapshotTables(
  status,
  tables = contentTables,
  limit = 100
) {
  const client = createServiceClient(status);
  const snapshot = {};
  for (const table of tables) {
    const { data, error } = await client.from(table).select('*').limit(limit);
    snapshot[table] = error ? { error: error.message } : (data ?? []);
  }
  return snapshot;
}

export async function readWrites(status, limit = 200) {
  const client = createServiceClient(status);
  const { data, error } = await client
    .from('_fixture_writes')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`failed to read writes: ${error.message}`);
  return data ?? [];
}

export async function clearWrites(status) {
  const client = createServiceClient(status);
  const { error } = await client.from('_fixture_writes').delete().gte('id', 0);
  if (error) throw new Error(`failed to clear writes: ${error.message}`);
}
