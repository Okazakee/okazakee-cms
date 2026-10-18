/**
 * Phase 9B body state model: "unknown", "loaded" and "modified" Markdown.
 *
 * A list row no longer carries bodies, so `undefined` means NOT LOADED — it must
 * never be treated as an intentionally empty body. Everything here is pure and
 * client-safe so both section components share one implementation.
 *
 * The rules encoded below are the safety core of the lazy-read cut-over:
 * - an unknown body is never dirty, and never published;
 * - a `''` body IS a loaded value and may legitimately be published;
 * - a locale is dirty only when it is loaded AND differs from its baseline;
 * - returning an edited body to its baseline clears the dirty flag again;
 * - a fresh server response replaces the baseline but never silently discards a
 *   locally modified body.
 */

/** Languages a post body can be written in. */
export type BodyLocale = 'en' | 'it';

/** Markdown that may be UNKNOWN: an absent locale was never loaded. */
export type OptionalBodies = { en?: string; it?: string };

/** Both locales present, as returned by the reader. */
export type LoadedBodies = { en: string; it: string };

export type BodyDirtyFlags = { en: boolean; it: boolean };

/**
 * True when a locale holds a loaded value. An empty string is loaded (the author
 * may legitimately save an empty body), `undefined`/`null` is not.
 */
export function isBodyLoaded(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/**
 * Locales whose local Markdown differs from the committed baseline.
 *
 * A locale that is not loaded on both sides can never be dirty: without a
 * baseline there is nothing to compare against, and publishing an unknown body
 * would overwrite committed content with whatever the client happened to hold.
 */
export function dirtyBodyLocales(
  current: OptionalBodies,
  baseline?: OptionalBodies
): BodyDirtyFlags {
  return {
    en:
      isBodyLoaded(current.en) &&
      isBodyLoaded(baseline?.en) &&
      current.en !== baseline.en,
    it:
      isBodyLoaded(current.it) &&
      isBodyLoaded(baseline?.it) &&
      current.it !== baseline.it,
  };
}

/**
 * The body fields an UPDATE may carry: only locales that are loaded AND changed.
 * Clean or unloaded locales are OMITTED entirely (the key is absent), so the
 * server leaves the committed body and its pointer untouched.
 */
export function publishBodyFields(
  current: OptionalBodies,
  baseline?: OptionalBodies
): OptionalBodies {
  const dirty = dirtyBodyLocales(current, baseline);
  const fields: OptionalBodies = {};
  if (dirty.en && isBodyLoaded(current.en)) fields.en = current.en;
  if (dirty.it && isBodyLoaded(current.it)) fields.it = current.it;
  return fields;
}

/**
 * Markdown to hand to the staged body-image filter for one publish: only the
 * languages actually being published, so a staged image referenced solely by a
 * clean language is never uploaded.
 */
export function publishedBodies(
  current: OptionalBodies,
  baseline?: OptionalBodies
): Array<string | undefined> {
  const fields = publishBodyFields(current, baseline);
  return [fields.en, fields.it];
}

/**
 * Applies a fresh reader response without discarding local edits.
 *
 * The fetched Markdown becomes the new baseline. A locale keeps its local value
 * only when that value was already dirty against the previous baseline; a locale
 * that was never edited (or whose edit was reverted) takes the fetched text.
 */
export function mergeFetchedBodies(args: {
  fetched: LoadedBodies;
  baseline?: OptionalBodies;
  local?: OptionalBodies;
}): { baseline: LoadedBodies; current: LoadedBodies } {
  const dirty = dirtyBodyLocales(args.local ?? {}, args.baseline);
  return {
    baseline: { en: args.fetched.en, it: args.fetched.it },
    current: {
      en: dirty.en && isBodyLoaded(args.local?.en) ? args.local.en : args.fetched.en,
      it: dirty.it && isBodyLoaded(args.local?.it) ? args.local.it : args.fetched.it,
    },
  };
}

/**
 * Body fields a freshly fetched LIST row may keep.
 *
 * List rows carry no bodies, so an unresolved LOCAL body edit is the only thing
 * worth carrying across a refetch. Everything else degrades back to "not
 * loaded" — safe, because an unpublished row is never a publish candidate.
 */
export function retainDraftBodies(args: {
  existing?: OptionalBodies;
  baseline?: OptionalBodies;
  /** True while this post still holds an unresolved local draft. */
  modified: boolean;
}): OptionalBodies {
  const kept: OptionalBodies = {};
  if (!args.modified) return kept;
  const dirty = dirtyBodyLocales(args.existing ?? {}, args.baseline);
  if (dirty.en && isBodyLoaded(args.existing?.en)) kept.en = args.existing.en;
  if (dirty.it && isBodyLoaded(args.existing?.it)) kept.it = args.existing.it;
  return kept;
}

/** A post row's Markdown columns, in the DB/payload spelling. */
export type BodyColumns = { body_en?: string; body_it?: string };

/** The locale-keyed view of a row's Markdown, for the helpers above. */
export function rowBodies(row: BodyColumns): OptionalBodies {
  return { en: row.body_en, it: row.body_it };
}

/**
 * Locale-keyed body state -> the `body_en`/`body_it` field names used by list
 * rows and BATCH_PUBLISH payloads. A clean or unloaded locale stays ABSENT:
 * sending it would overwrite committed Markdown with an unknown body.
 */
export function bodyColumnFields(fields: OptionalBodies): BodyColumns {
  const columns: BodyColumns = {};
  if (fields.en !== undefined) columns.body_en = fields.en;
  if (fields.it !== undefined) columns.body_it = fields.it;
  return columns;
}

/**
 * A copy of a row with any Markdown REMOVED (not merely overwritten).
 *
 * Merging a local draft over a metadata-only row can leave a body the row no
 * longer owns, so the field has to be deleted rather than spread over.
 */
export function withoutBodies<TRow extends object>(row: TRow): TRow {
  const next = { ...row } as TRow & BodyColumns;
  delete next.body_en;
  delete next.body_it;
  return next;
}

/**
 * Rebuilds list rows after a metadata-only fetch.
 *
 * The fetched rows carry no Markdown, but a merged local draft snapshot may
 * still hold bodies loaded earlier. Each row is therefore rebuilt WITHOUT any
 * inherited body, and only the locales an unresolved edit still owns are added
 * back — so clean or unmodified Markdown never lingers in list state.
 *
 * A pending create (negative id) is local-only: it was never fetched, so both
 * authored languages are preserved verbatim.
 */
export function reconcileListBodies<
  TRow extends BodyColumns & { id: number },
>(args: {
  rows: TRow[];
  /** The rows currently in state, for the unresolved draft's local bodies. */
  previousRows: ReadonlyArray<TRow>;
  baselineFor: (id: number) => OptionalBodies | undefined;
  isModified: (id: number) => boolean;
}): TRow[] {
  const previous = new Map(args.previousRows.map((row) => [row.id, row]));
  return args.rows.map((row) => {
    if (row.id < 0) return row;
    const existing = previous.get(row.id);
    return {
      ...withoutBodies(row),
      ...bodyColumnFields(
        retainDraftBodies({
          existing: existing ? rowBodies(existing) : undefined,
          baseline: args.baselineFor(row.id),
          modified: args.isModified(row.id),
        })
      ),
    };
  });
}
