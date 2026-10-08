// @vitest-environment happy-dom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SiteSettingsResult } from '@/app/actions/cms/sections/siteSettingsActions';
import cmsEn from '@/i18n/messages/cms.en.json';

const h = vi.hoisted(() => ({
  action:
    vi.fn<
      (operation: {
        type: string;
        variant?: string;
        file?: File;
        vatNumber?: string;
      }) => Promise<SiteSettingsResult>
    >(),
  publish: null as (() => Promise<void>) | null,
}));
vi.mock('@/app/actions/cms/sections/siteSettingsActions', () => ({
  siteSettingsActions: h.action,
}));
vi.mock('@/hooks/cms/useSectionCallbacks', () => ({
  useSectionCallbacks: (_section: string, publish: () => Promise<void>) => {
    h.publish = publish;
  },
}));
vi.mock('@/utils/imageProcessor', () => ({
  processImageToWebP: async (file: File) => ({ success: true, file }),
}));
vi.mock('next/image', () => ({
  default: (props: { src: string; alt: string }) => createElement('img', props),
}));

import { LayoutSection } from '@/components/cms/sections/Layout/LayoutSection';

let root: Root;
let container: HTMLDivElement;
const initial = {
  header_logo_dark: 'https://example.com/dark.png',
  header_logo_light: 'https://example.com/light.png',
  footer_vat_number: '001',
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:staged');
      static revokeObjectURL = vi.fn();
    }
  );
  h.action.mockReset();
  h.action.mockResolvedValue({ success: true, data: initial });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('keeps the failed opposite-theme selection and unsaved VAT after one logo commits', async () => {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ cms: cmsEn }}>
        <LayoutSection />
      </NextIntlClientProvider>
    )
  );
  const vat = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!vat) throw new Error('Missing VAT input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set?.call(vat, '002');
    vat.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const variant of ['dark', 'light']) {
    const input = container.querySelector<HTMLInputElement>(
      `[data-testid="header-logo-${variant}"] input[type="file"]`
    );
    if (!input) throw new Error('Missing logo input');
    await act(async () => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['image'], `${variant}.png`, { type: 'image/png' })],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  expect(h.action).toHaveBeenCalledTimes(1);
  h.action.mockImplementation(async (operation) =>
    operation.variant === 'dark'
      ? {
          success: true,
          data: {
            ...initial,
            header_logo_dark: 'https://example.com/committed.png',
          },
        }
      : { success: false, error: 'light failed' }
  );
  await act(async () => {
    await expect(h.publish?.()).rejects.toThrow('light failed');
  });
  expect(vat.value).toBe('002');
  expect(
    container
      .querySelector('[data-testid="header-logo-dark"] img')
      ?.getAttribute('src')
  ).toBe('https://example.com/committed.png');
  expect(
    container
      .querySelector('[data-testid="header-logo-light"] img')
      ?.getAttribute('src')
  ).toBe('blob:staged');
  expect(container.textContent).toContain('light failed');
  h.action.mockImplementation(async (operation) => ({
    success: true,
    data: {
      ...initial,
      header_logo_dark: 'https://example.com/committed.png',
      header_logo_light: 'https://example.com/new-light.png',
      footer_vat_number: operation.type === 'UPDATE_VAT' ? '002' : '001',
    },
  }));
  h.action.mockClear();
  await act(async () => {
    await h.publish?.();
  });
  expect(
    h.action.mock.calls.map(([operation]) => [
      operation.type,
      operation.variant,
    ])
  ).toEqual([
    ['UPLOAD_LOGO', 'light'],
    ['UPDATE_VAT', undefined],
  ]);
  expect(vat.value).toBe('002');
});

it('stages removal without a write, supports undo, and clears only on Publish', async () => {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={{ cms: cmsEn }}>
        <LayoutSection />
      </NextIntlClientProvider>
    )
  );
  const card = container.querySelector('[data-testid="header-logo-dark"]');
  if (!card) throw new Error('Missing dark card');
  const clickText = async (text: string) => {
    const button = [...card.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === text
    );
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  await clickText(cmsEn.common.removeFile);
  expect(card.querySelector('img')).toBeNull();
  expect(h.action).toHaveBeenCalledTimes(1);
  await clickText(cmsEn.layout.headerLogoUndoRemoval);
  expect(card.querySelector('img')?.getAttribute('src')).toBe(
    initial.header_logo_dark
  );
  await clickText(cmsEn.common.removeFile);
  h.action.mockResolvedValue({
    success: true,
    data: { ...initial, header_logo_dark: null },
  });
  await act(async () => {
    await h.publish?.();
  });
  expect(h.action).toHaveBeenLastCalledWith({
    type: 'CLEAR_LOGO',
    variant: 'dark',
  });
  expect(card.textContent).not.toContain(cmsEn.layout.headerLogoRemovalNote);
});
