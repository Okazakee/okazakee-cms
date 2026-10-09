import { describe, expect, it } from 'vitest';
import {
  type PostButton,
  deriveButtonsFromPost,
  validatePostButtons,
} from './postButtons';

const legacyRow = {
  website: 'https://pearlift.app',
  source_link: 'https://github.com/okazakee/pearlift',
  demo_link: 'https://demo.pearlift.app',
  store_link: 'https://play.google.com/store/apps/details?id=x',
  fdroid_link: 'https://f-droid.org/packages/x',
  ios_store_link: 'https://apps.apple.com/app/x',
};

describe('deriveButtonsFromPost', () => {
  it('derives the legacy columns in the order the site always rendered', () => {
    expect(deriveButtonsFromPost(legacyRow)).toEqual([
      { kind: 'website', url: 'https://pearlift.app' },
      { kind: 'source', url: 'https://github.com/okazakee/pearlift' },
      { kind: 'demo', url: 'https://demo.pearlift.app' },
      { kind: 'store', url: 'https://play.google.com/store/apps/details?id=x' },
      { kind: 'fdroid', url: 'https://f-droid.org/packages/x' },
      { kind: 'ios', url: 'https://apps.apple.com/app/x' },
    ]);
  });

  it('skips blank legacy values so an emptied input is not a button', () => {
    expect(
      deriveButtonsFromPost({
        website: null,
        source_link: '',
        demo_link: '   ',
        store_link: null,
      })
    ).toEqual([]);
  });

  it('prefers the stored list and ignores the legacy columns', () => {
    const buttons: PostButton[] = [
      { kind: 'demo', url: 'https://demo.pearlift.app' },
      { kind: 'source', url: 'https://github.com/okazakee/pearlift' },
    ];
    expect(deriveButtonsFromPost({ ...legacyRow, buttons })).toEqual(buttons);
  });

  it('falls back when the stored list is empty', () => {
    expect(deriveButtonsFromPost({ ...legacyRow, buttons: [] })).toHaveLength(
      6
    );
  });

  it('keeps the stored order verbatim', () => {
    const buttons: PostButton[] = [
      {
        kind: 'custom',
        url: 'https://changelog.pearlift.app',
        label: 'Changelog',
      },
      { kind: 'ios', url: 'https://apps.apple.com/app/x' },
      { kind: 'website', url: 'https://pearlift.app' },
    ];
    expect(deriveButtonsFromPost({ ...legacyRow, buttons })).toEqual(buttons);
  });
});

describe('validatePostButtons', () => {
  it('accepts an ordered preset list and drops the label a preset ignores', () => {
    const result = validatePostButtons([
      { kind: 'demo', url: 'https://demo.pearlift.app' },
      {
        kind: 'source',
        url: ' https://github.com/okazakee/pearlift ',
        label: 'Ignored by the site',
      },
    ]);
    expect(result).toEqual({
      isValid: true,
      buttons: [
        { kind: 'demo', url: 'https://demo.pearlift.app' },
        { kind: 'source', url: 'https://github.com/okazakee/pearlift' },
      ],
    });
  });

  it('keeps the label of a custom button', () => {
    expect(
      validatePostButtons([
        {
          kind: 'custom',
          url: 'https://changelog.pearlift.app',
          label: '  Changelog  ',
        },
      ])
    ).toEqual({
      isValid: true,
      buttons: [
        {
          kind: 'custom',
          url: 'https://changelog.pearlift.app',
          label: 'Changelog',
        },
      ],
    });
  });

  it('rejects a url that is not an absolute http(s) URL', () => {
    for (const url of [
      'github.com/okazakee',
      'javascript:alert(1)',
      'ftp://x.dev',
      '',
    ]) {
      const result = validatePostButtons([{ kind: 'demo', url }]);
      expect(result.isValid).toBe(false);
    }
  });

  it('rejects a custom button with no label and an unknown kind', () => {
    expect(
      validatePostButtons([{ kind: 'custom', url: 'https://example.com' }])
    ).toEqual({
      isValid: false,
      error: 'Button 1 needs a label',
    });
    expect(
      validatePostButtons([
        { kind: 'playstation', url: 'https://store.example.com' },
      ])
    ).toEqual({ isValid: false, error: 'Button 1 has no valid type' });
  });

  it('reports the 1-based position of the offending button', () => {
    expect(
      validatePostButtons([
        { kind: 'source', url: 'https://github.com/okazakee/pearlift' },
        { kind: 'demo', url: 'nope' },
      ])
    ).toEqual({
      isValid: false,
      error: 'Button 2 needs an absolute http(s) URL',
    });
  });

  it('treats a missing list as no buttons and rejects a non-list', () => {
    expect(validatePostButtons(undefined)).toEqual({
      isValid: true,
      buttons: [],
    });
    expect(validatePostButtons(null)).toEqual({ isValid: true, buttons: [] });
    expect(validatePostButtons({ kind: 'demo' })).toEqual({
      isValid: false,
      error: 'Buttons must be a list',
    });
  });
});
