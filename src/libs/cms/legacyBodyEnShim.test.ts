import { describe, expect, it } from 'vitest';
import {
  LEGACY_BODY_EN_SHIM_FLAG,
  LEGACY_BODY_EN_SHIM_PLACEHOLDER,
  legacyBodyEnShimFields,
} from '@/libs/cms/legacyBodyEnShim';

/**
 * The rollout shim is intentionally tiny and env-injected so its whole
 * contract (default ON, `body_it` never written, non-Markdown placeholder) is
 * pinned here. Deleting this file together with the shim is the cleanup step
 * after the legacy columns are dropped.
 */
describe('legacy body_en shim', () => {
  it('fills body_en by default and never touches body_it', () => {
    const fields = legacyBodyEnShimFields({});
    expect(fields).toEqual({ body_en: LEGACY_BODY_EN_SHIM_PLACEHOLDER });
    expect(Object.hasOwn(fields, 'body_it')).toBe(false);
    // The placeholder must never look like real Markdown.
    expect(LEGACY_BODY_EN_SHIM_PLACEHOLDER.startsWith('#')).toBe(false);
  });

  it('stops writing the column only when explicitly disabled', () => {
    expect(
      legacyBodyEnShimFields({ [LEGACY_BODY_EN_SHIM_FLAG]: 'false' })
    ).toEqual({});
    // Anything that is not exactly 'false' keeps the default (ON).
    expect(legacyBodyEnShimFields({ [LEGACY_BODY_EN_SHIM_FLAG]: '' })).toEqual({
      body_en: LEGACY_BODY_EN_SHIM_PLACEHOLDER,
    });
    expect(legacyBodyEnShimFields({ [LEGACY_BODY_EN_SHIM_FLAG]: '0' })).toEqual(
      { body_en: LEGACY_BODY_EN_SHIM_PLACEHOLDER }
    );
  });
});
