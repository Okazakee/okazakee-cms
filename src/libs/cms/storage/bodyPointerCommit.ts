/**
 * Storage-only Markdown write path: stage immutable objects, then commit the
 * row's pointer with ONE guarded UPDATE.
 *
 * Order of operations for every save (create and edit):
 *   1. turn the final Markdown into exact UTF-8 bytes and hash them;
 *   2. upload immutably (`upsert: false`) to `<kind>/<id>/<locale>/<sha256>.md`;
 *   3. read the object back and prove it hashes to the hash in its own key;
 *   4. ONLY THEN commit `body_<locale>_path` (and, on create, the intended
 *      visibility) in a single UPDATE guarded on the pointer value this save
 *      observed.
 *
 * Because uploads precede the commit, a failed upload can never leave a pointer
 * set, and a failed commit can never point at bytes that were not proven to be
 * in place — the row simply keeps its previous pointer (or stays unpointed).
 *
 * PostgreSQL and Storage share NO transaction. There is no way to roll an
 * object back when the row write fails, so the failure modes are documented
 * instead of hidden:
 *
 *   (a) upload ok + pointer commit failed
 *       -> the row still holds the pointer it held before (the guarded UPDATE
 *          matched no row or errored, and PostgreSQL applied nothing). The new
 *          object is unreferenced and is left to the Storage garbage collector;
 *          the save is reported as failed, never as committed.
 *   (b) upload failed
 *       -> no pointer was touched; the previously committed body stays
 *          authoritative for that locale.
 *   (c) commit ok + cache invalidation failed
 *       -> the write IS committed and reported as successful; the invalidation
 *          outcome is surfaced separately (`revalidation: 'failed'`) and is
 *          safely retryable, because re-running invalidation has no write side
 *          effects.
 *
 * Optimistic concurrency replaces the retired `prod_backfill_body_pointer_cas`
 * database function: the commit is conditional on `body_<locale>_path` still
 * holding the value this save read, NULL included (`is null`). Zero rows means
 * someone else changed the row, so there is NO blind retry: the conflict is
 * reported and the caller must reload and re-apply.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type BodyContentKind,
  type BodyContentLocale,
  type BodyContentStorageApi,
  prepareBodyContent,
  readBodyContentBytes,
  sha256Hex,
  uploadBodyContent,
} from '@/libs/cms/storage/bodyContent';

export type PostBodyKind = BodyContentKind;
export type PostBodyLocale = BodyContentLocale;

/** Every locale a post can carry, in write order. */
const BODY_LOCALES: PostBodyLocale[] = ['en', 'it'];

/** Server-generated pointer columns clients must never supply. */
const BODY_POINTER_FIELDS = ['body_en_path', 'body_it_path'] as const;

/**
 * Legacy Markdown columns retired by this migration. A save never writes body
 * content into them: Markdown lives in the content bucket, and a second copy in
 * the row could silently disagree with the committed pointer.
 */
const RETIRED_BODY_COLUMNS = ['body_en', 'body_it'] as const;

/**
 * Client action payloads are typed but not validated at runtime, and several
 * paths spread them into DB writes. Own-property detection only: an inherited
 * `body_en_path` (e.g. from a prototype) is not a payload field.
 *
 * Returns an error message, or null when the payload is clean. Pointer paths are
 * always generated server-side from the final body and the real row id.
 */
export function clientBodyPointerRejection(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  for (const field of BODY_POINTER_FIELDS) {
    if (Object.hasOwn(data, field)) {
      return `${field} is server-generated and cannot be supplied by clients`;
    }
  }
  return null;
}

/** The row fields a save may write: everything except the retired body columns. */
export function stripRetiredBodyColumns(
  data: Record<string, unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...data };
  for (const column of RETIRED_BODY_COLUMNS) delete fields[column];
  return fields;
}

/**
 * Per-language request:
 *   undefined -> not part of this save (pointer preserved by the caller)
 *   null/''   -> clear this language's pointer (the object is left to the GC)
 *   string    -> store these exact bytes
 */
export type PostBodyRequest = {
  locale: PostBodyLocale;
  body: string | null | undefined;
};

/** Committed pointer values this save observed, per locale (NULL included). */
export type PriorBodyPointers = Partial<Record<PostBodyLocale, string | null>>;

export type StagedBodyWrite = {
  /** Pointer to commit per touched locale: a canonical path, or null to clear. */
  pointers: Partial<Record<PostBodyLocale, string | null>>;
  /** Locales whose bytes were already at the committed pointer (no upload). */
  reused: PostBodyLocale[];
};

/**
 * Which languages a save modifies, derived from the loosely-typed action
 * payload: an explicit `undefined` means "not part of this save".
 */
export function modifiedLocales(data: {
  body_en?: string | null;
  body_it?: string | null;
}): PostBodyRequest[] {
  const requests: PostBodyRequest[] = [];
  for (const locale of BODY_LOCALES) {
    const body = locale === 'en' ? data.body_en : data.body_it;
    if (body !== undefined) requests.push({ locale, body });
  }
  return requests;
}

/**
 * Uploads the modified languages and returns the pointer values to commit.
 *
 * `prior` is the committed pointer state read from the same row, so an
 * unchanged body — same bytes, therefore the same content-addressed key — is
 * recognised as a no-op and performs ZERO Storage calls. Nothing here writes to
 * the database; a failure throws before any pointer can move.
 */
export async function stagePostBodies(
  storage: BodyContentStorageApi,
  kind: PostBodyKind,
  postId: number,
  requests: PostBodyRequest[],
  prior: PriorBodyPointers = {}
): Promise<StagedBodyWrite> {
  const pointers: Partial<Record<PostBodyLocale, string | null>> = {};
  const reused: PostBodyLocale[] = [];

  for (const { locale, body } of requests) {
    if (body === undefined) continue;
    if (body === null || body === '') {
      pointers[locale] = null;
      continue;
    }

    const prepared = prepareBodyContent(kind, postId, locale, body);
    if (prior[locale] === prepared.path) {
      // Content addressing makes path equality byte equality: the committed row
      // already points at these exact bytes.
      pointers[locale] = prepared.path;
      reused.push(locale);
      continue;
    }

    const uploaded = await uploadBodyContent(storage, prepared);
    if (uploaded.status === 'uploaded') {
      // `existing` was already byte-compared against `prepared.bytes` by
      // uploadBodyContent, so only a fresh write needs the read-back proof.
      const stored = await readBodyContentBytes(storage, prepared.path);
      const storedHash = sha256Hex(stored);
      if (storedHash !== prepared.hash || stored.length !== prepared.size) {
        throw new Error(
          `[body-write] integrity failure at ${prepared.path}: stored ${stored.length} bytes hash to ${storedHash}, expected ${prepared.size} bytes hashing to ${prepared.hash}`
        );
      }
    }
    pointers[locale] = uploaded.path;
  }

  return { pointers, reused };
}

function bodyPointerColumn(locale: PostBodyLocale): string {
  return `body_${locale}_path`;
}

/**
 * The Markdown that the pointers being replaced used to name, for asset-orphan
 * cleanup. Storage — not the retired DB columns — is the only source of a
 * post's body, and this reads only the locales whose pointer actually moves.
 *
 * Best-effort by contract: an unreadable previous object yields nothing for
 * that locale instead of failing the save, because this feeds a cleanup of
 * body-image assets and never the body itself. The object is still there when
 * this runs (nothing has deleted it), so a read failure means real corruption,
 * which the read path reports separately.
 */
export async function replacedBodyMarkdown(
  storage: BodyContentStorageApi,
  requests: PostBodyRequest[],
  prior: PriorBodyPointers,
  pointers: Partial<Record<PostBodyLocale, string | null>>
): Promise<Array<string | undefined>> {
  const previous: Array<string | undefined> = [];
  for (const { locale } of requests) {
    // Only the locales whose pointer this save actually writes: a locale left
    // untouched by the payload must not be read (metadata-only saves read
    // nothing at all, and an EN edit never reads the IT object).
    if (!Object.hasOwn(pointers, locale)) continue;
    const path = prior[locale];
    if (!path || pointers[locale] === path) continue;
    try {
      const bytes = await readBodyContentBytes(storage, path);
      previous.push(bytes.toString('utf8'));
    } catch (error) {
      console.error(
        `[body-write] previous object ${path} unreadable; skipping asset cleanup for it:`,
        error
      );
    }
  }
  return previous;
}

/** Pointer columns the commit writes, for the languages this save touched. */
export function pointerCommitFields(
  pointers: Partial<Record<PostBodyLocale, string | null>>
): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  for (const locale of BODY_LOCALES) {
    if (Object.hasOwn(pointers, locale)) {
      fields[bodyPointerColumn(locale)] = pointers[locale] ?? null;
    }
  }
  return fields;
}

/**
 * One PostgREST filter that pins a pointer column to the value this save read.
 * `expected === null` becomes `is null` (PostgREST's `eq.null` compares to the
 * literal string, not to SQL NULL, so it must not be used here).
 */
export type PointerGuard = { column: string; expected: string | null };

/**
 * Guards for the languages this save writes. A locale the save does not touch
 * contributes NO filter, so an EN-only edit can never be rejected — or
 * modified — because of the IT pointer.
 */
export function pointerGuards(
  pointers: Partial<Record<PostBodyLocale, string | null>>,
  prior: PriorBodyPointers
): PointerGuard[] {
  const guards: PointerGuard[] = [];
  for (const locale of BODY_LOCALES) {
    if (!Object.hasOwn(pointers, locale)) continue;
    guards.push({
      column: bodyPointerColumn(locale),
      expected: prior[locale] ?? null,
    });
  }
  return guards;
}

/** Surfaced when the guarded commit matched no row. */
export const POINTER_CONFLICT_MESSAGE =
  'Conflicting concurrent edit: the post changed while this save was in flight. Nothing was written — reload the post and apply the change again.';

/**
 * Structural view of a supabase-js filter chain: the real builder's generics
 * cannot express a guard list chosen at runtime, and the fake client in tests
 * implements exactly this shape.
 */
type GuardableQuery = {
  eq(column: string, value: string): GuardableQuery;
  is(column: string, value: null): GuardableQuery;
  select(columns?: string): PromiseLike<{ data: unknown; error: unknown }>;
};

export function applyPointerGuards<Q>(query: Q, guards: PointerGuard[]): Q {
  let guarded = query as unknown as GuardableQuery;
  for (const guard of guards) {
    guarded =
      guard.expected === null
        ? guarded.is(guard.column, null)
        : guarded.eq(guard.column, guard.expected);
  }
  return guarded as unknown as Q;
}

export type RowCommitOutcome =
  /** The UPDATE applied; `row` is the committed row as returned by PostgREST. */
  | { status: 'committed'; row: Record<string, unknown> | null }
  /** The UPDATE matched no row: the guard no longer holds (or the row is gone). */
  | { status: 'conflict' }
  /** The UPDATE failed; PostgreSQL applied nothing. */
  | { status: 'failed'; error: unknown };

/**
 * The single guarded UPDATE that commits a write: pointer columns plus any
 * other row fields (metadata, visibility) in one statement, filtered on the
 * observed pointer values. A zero-row result is a conflict, never a retry.
 */
export async function commitGuardedRow(
  admin: SupabaseClient,
  table: string,
  id: number,
  fields: Record<string, unknown>,
  guards: PointerGuard[]
): Promise<RowCommitOutcome> {
  const base = admin
    .from(table)
    .update(fields)
    .eq('id', id) as unknown as GuardableQuery;
  const { data, error } = await applyPointerGuards(base, guards).select();
  if (error) return { status: 'failed', error };
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  if (rows.length === 0) return { status: 'conflict' };
  return { status: 'committed', row: rows[0] ?? null };
}
