/**
 * Incoming project-request entries.
 *
 * The field names mirror the public request form one-for-one
 * (`okazakee-ws/src/components/layout/mainPage/RequestForm.tsx`), so a stored
 * entry maps back onto the submitted payload without translation. The option
 * sets are re-declared here because the public form owns its own copy
 * in-component; they are the values a submitter can actually send today, and
 * they are CHECK-constrained on `project_requests`.
 *
 * Intake is live: the public form posts to `okazakee-ws /api/requests`, which
 * writes through the service-role client (the table has no anon/authenticated
 * grant). This module is the single source of truth for the shape the CMS
 * inbox renders; `archived` is the storage flag, not a CMS-only notion.
 */

export const REQUEST_TYPE_OPTIONS = [
  'Website',
  'Web app',
  'Mobile app',
  'Other',
] as const;

export const REQUEST_BUDGET_OPTIONS = [
  '< €1k',
  '€1–5k',
  '€5–15k',
  '€15k+',
] as const;

export const REQUEST_TIMELINE_OPTIONS = [
  'ASAP',
  '1–2 months',
  '3–6 months',
  'Flexible',
] as const;

export type RequestType = (typeof REQUEST_TYPE_OPTIONS)[number];
export type RequestBudget = (typeof REQUEST_BUDGET_OPTIONS)[number];
export type RequestTimeline = (typeof REQUEST_TIMELINE_OPTIONS)[number];

export type RequestEntry = {
  id: string;
  /** ISO 8601. The public form carries no timestamp; intake assigns it. */
  createdAt: string;
  /** Which locale the submitter was browsing when they sent the request. */
  locale: 'en' | 'it';
  name: string;
  email: string;
  company: string;
  website: string;
  type: RequestType;
  budget: RequestBudget;
  timeline: RequestTimeline;
  /** Free-text "Project details" message. */
  request: string;
  /** The submitter accepted the privacy policy. */
  consent: boolean;
  /** Archived requests stay readable but leave the active inbox. */
  archived: boolean;
  /** ISO 8601 archive timestamp, null while the entry is active. */
  archivedAt: string | null;
};

/** Which slice of the inbox the list is showing. */
export type RequestEntryFilter = 'active' | 'archived';

export type RequestEntryDraft = Omit<
  RequestEntry,
  'id' | 'createdAt' | 'archived' | 'archivedAt'
>;
