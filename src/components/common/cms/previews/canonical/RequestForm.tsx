'use client';

import Link from 'next/link';
import { useLocale, useMessages, useTranslations } from 'next-intl';
import { ErrorDiv } from '@/components/common/ErrorDiv';
import { getLayoutCopy } from './layoutCopy';

/**
 * Canonical project request form (docs/DESIGN.md §5.4) rendered as a preview:
 * the fields and the "coming soon" band are identical to the public site, but
 * submit is inert and the privacy link opens in a new tab, so a preview cannot
 * navigate or mutate anything. When the public `request-form` messages are not
 * available, the CMS error banner is shown instead of an invented copy.
 *
 * The privacy link label is frozen site-side copy like the layout chrome, so it
 * comes from `getLayoutCopy` rather than a `footer` translation namespace.
 */
export function RequestFormPreview() {
  const messages = useMessages();

  if (!messages['request-form']) {
    return <ErrorDiv>Request form preview unavailable</ErrorDiv>;
  }

  return <RequestFormPreviewInner />;
}

function RequestFormPreviewInner() {
  const t = useTranslations('request-form');
  const currentLocale = useLocale();

  const tr = (key: string) => (t.has(key) ? t(key) : '');
  const options = (key: string) => (t.has(key) ? (t.raw(key) as string[]) : []);

  const fieldClass =
    'w-full rounded-lg border border-border-subtle bg-surface-base px-3 py-2.5 font-mono text-xs text-text-main placeholder:text-text-dim focus:border-accent-violet/60 focus:outline-none';
  // Mock's select: native appearance off, a chevron 8px from the right edge
  // and a 16px line box (see .request-select in globals.css).
  const selectClass = `${fieldClass} request-select`;
  const labelClass =
    'mb-2 block font-mono text-[11px] uppercase tracking-[0.08em] text-text-dim';

  return (
    <div className="relative mt-14 overflow-hidden rounded-2xl border border-border-subtle bg-surface-card p-6 sm:p-8">
      <p className="text-center font-mono text-[11px] uppercase tracking-[0.2em] text-accent-violet">
        {tr('eyebrow')}
      </p>
      <h3 className="mt-3 text-center font-heading text-xl font-semibold text-text-white">
        {tr('title')}
      </h3>
      <p className="mx-auto mt-2 max-w-xl text-center text-sm leading-relaxed text-text-muted">
        {tr('subtitle')}
      </p>

      <form
        className="mt-7 grid grid-cols-1 gap-5 sm:grid-cols-2"
        onSubmit={(event) => event.preventDefault()}
      >
        <div>
          <label className={labelClass} htmlFor="request-name">
            {tr('name')}
          </label>
          <input
            className={fieldClass}
            id="request-name"
            name="name"
            placeholder={tr('namePlaceholder')}
            type="text"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="request-email">
            {tr('email')}
          </label>
          <input
            className={fieldClass}
            id="request-email"
            name="email"
            placeholder={tr('emailPlaceholder')}
            type="email"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="request-company">
            {tr('company')}
          </label>
          <input
            className={fieldClass}
            id="request-company"
            name="company"
            placeholder={tr('companyPlaceholder')}
            type="text"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="request-website">
            {tr('website')}
          </label>
          <input
            className={fieldClass}
            id="request-website"
            name="website"
            placeholder={tr('websitePlaceholder')}
            type="url"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="request-type">
            {tr('type')}
          </label>
          <select className={selectClass} id="request-type" name="type">
            {options('typeOptions').map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="request-budget">
            {tr('budget')}
          </label>
          <select className={selectClass} id="request-budget" name="budget">
            {options('budgetOptions').map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="request-timeline">
            {tr('timeline')}
          </label>
          <select className={selectClass} id="request-timeline" name="timeline">
            {options('timelineOptions').map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="request-body">
            {tr('request')}
          </label>
          <textarea
            className={`${fieldClass} leading-relaxed`}
            id="request-body"
            name="request"
            placeholder={tr('requestPlaceholder')}
            rows={5}
          />
        </div>

        <div className="flex justify-center sm:col-span-2">
          <label className="flex max-w-md items-start gap-2 text-xs leading-relaxed text-text-dim">
            <input
              className="request-consent mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-border-subtle bg-surface-base"
              name="consent"
              type="checkbox"
            />
            <span>
              {tr('consent')}{' '}
              <Link
                className="text-accent-violet-light underline underline-offset-2"
                href={`/${currentLocale}/privacy-policy`}
                rel="noopener noreferrer"
                target="_blank"
              >
                {getLayoutCopy(currentLocale).footer.privacyPolicy}
              </Link>
              .
            </span>
          </label>
        </div>

        <div className="flex justify-center sm:col-span-2">
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-accent-violet px-6 py-3 font-mono text-xs uppercase tracking-[0.08em] text-surface-base transition-colors hover:bg-accent-violet-light"
            type="submit"
          >
            {tr('submit')}
          </button>
        </div>
      </form>

      {/* Preview state until PreCall is wired up */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-surface-base/45 backdrop-blur-[1px]"
      >
        <span className="-rotate-[7deg] w-[150%] border-y border-accent-violet/30 bg-surface-base/80 py-3 text-center font-mono text-sm uppercase tracking-[0.3em] text-accent-violet-light">
          {tr('comingSoon')}
        </span>
      </div>
    </div>
  );
}
