/**
 * Row <-> entry mapping for `project_requests`.
 *
 * Client-safe (no server imports): the Server Action maps rows to entries and
 * the inbox list renders them, so both sides share one translation. The only
 * rename is the form's `type` field, stored as `project_type` to keep it off
 * the bare SQL keyword list.
 *
 * `mapRequestRow` is total: it returns null for a row it cannot read rather
 * than throwing, so one malformed row cannot blank the whole inbox. Callers
 * report those ids instead of dropping them silently.
 */
import {
  REQUEST_BUDGET_OPTIONS,
  REQUEST_TIMELINE_OPTIONS,
  REQUEST_TYPE_OPTIONS,
  type RequestBudget,
  type RequestEntry,
  type RequestTimeline,
  type RequestType,
} from '@/types/requestEntry.types';

type Row = Record<string, unknown>;

const LOCALE_PATTERN = /^(en|it)$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the primary key.
 *
 * `project_requests.id` is a `bigint`, so PostgREST hands it back as a JSON
 * number; a `typeof value === 'string'` guard would reject every real row and
 * silently blank the inbox. Both forms are accepted and normalized to the
 * string shape `RequestEntry.id` uses.
 */
function asRowId(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : '';
  }
  return typeof value === 'string' ? value : '';
}

function asIsoString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function asOption<T extends string>(
  value: unknown,
  options: readonly T[]
): T | null {
  return options.includes(value as T) ? (value as T) : null;
}

/** Reads a `project_requests` row into the inbox shape, or null if unusable. */
export function mapRequestRow(row: unknown): RequestEntry | null {
  if (typeof row !== 'object' || row === null) return null;
  const source = row as Row;

  const id = asRowId(source.id);
  const createdAt = asIsoString(source.created_at);
  const email = asString(source.email).trim();
  if (id === '' || createdAt === null || !EMAIL_PATTERN.test(email)) {
    return null;
  }

  const type: RequestType | null = asOption(
    source.project_type,
    REQUEST_TYPE_OPTIONS
  );
  const budget: RequestBudget | null = asOption(
    source.budget,
    REQUEST_BUDGET_OPTIONS
  );
  const timeline: RequestTimeline | null = asOption(
    source.timeline,
    REQUEST_TIMELINE_OPTIONS
  );
  if (type === null || budget === null || timeline === null) return null;

  return {
    id,
    createdAt,
    locale: LOCALE_PATTERN.test(asString(source.locale))
      ? (asString(source.locale) as 'en' | 'it')
      : 'en',
    name: asString(source.name),
    email,
    company: asString(source.company),
    website: asString(source.website),
    type,
    budget,
    timeline,
    request: asString(source.request),
    consent: source.consent === true,
    archived: source.archived === true,
    archivedAt: asIsoString(source.archived_at),
  };
}
