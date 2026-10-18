/**
 * Narrow server-side readers for the production backfill and rollback tools.
 *
 * Both commands read exactly two columns per call — the committed legacy body
 * and the committed pointer for one locale of one post — through plain selects
 * on an explicit projection. There is no write surface in the type they are
 * consumed through (`BackfillExecutorDeps.readCommittedBody` /
 * `.readCommittedPointer`), so no caller can reach an update through them.
 *
 * The DEV CLIs declare the same two readers inline; they are shared here
 * because the production executor AND the production rollback need them
 * identically, and a divergence between the two would silently change which row
 * a CAS guard is verified against.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { POST_BODY_TABLES } from '@/libs/cms/storage/backfillPlan';
import type {
  BodyContentKind,
  BodyContentLocale,
} from '@/libs/cms/storage/bodyContent';

export type CommittedBodyReaders = {
  readBody(
    kind: BodyContentKind,
    postId: number,
    locale: BodyContentLocale
  ): Promise<string | null>;
  readPointer(
    kind: BodyContentKind,
    postId: number,
    locale: BodyContentLocale
  ): Promise<string | null>;
};

/**
 * Wraps the admin client into the two readers. A Postgrest error is rethrown
 * with its message: a failed read must stop the run, never read as "no body".
 */
export function createCommittedBodyReaders(
  client: SupabaseClient,
  label: string
): CommittedBodyReaders {
  const read = async (
    kind: BodyContentKind,
    postId: number,
    column: string
  ): Promise<string | null> => {
    const table = POST_BODY_TABLES[kind];
    if (!table) {
      throw new Error(`[${label}] unknown entity '${String(kind)}'`);
    }
    const res = await client
      .from(table)
      .select(column)
      .eq('id', postId)
      .maybeSingle();
    if (res.error) {
      throw new Error(`[${label}] read ${column} failed: ${res.error.message}`);
    }
    const row = res.data as Record<string, unknown> | null;
    const value = row?.[column];
    return typeof value === 'string' ? value : null;
  };

  return {
    readBody: (kind, postId, locale) => read(kind, postId, `body_${locale}`),
    readPointer: (kind, postId, locale) =>
      read(kind, postId, `body_${locale}_path`),
  };
}
