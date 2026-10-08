// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCmsStore } from '@/store/cmsStore';
import { SectionActions } from './SectionActions';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
const publish = vi.fn(async () => {});
const revert = vi.fn();
async function mount(isDirty = true, busy = false) {
  await act(async () =>
    root.render(
      createElement(SectionActions, {
        isDirty,
        busy,
        onPublish: publish,
        onRevert: revert,
      })
    )
  );
}
function button(label: string, modal = false) {
  const scope = modal ? document.querySelector('[role="dialog"]') : container;
  const target = Array.from(scope?.querySelectorAll('button') ?? []).find(
    (node) => node.textContent === label
  );
  if (!target) throw new Error(`Missing button ${label}`);
  return target;
}
async function click(node: Element) {
  await act(async () =>
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  publish.mockReset();
  publish.mockResolvedValue(undefined);
  useCmsStore.setState({ isPublishingAll: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe('publish confirmation', () => {
  it.each(['cancel', 'escape', 'backdrop'])(
    'cancels by %s without writing',
    async (method) => {
      await mount();
      await click(button('publish'));
      expect(publish).not.toHaveBeenCalled();
      if (method === 'cancel') await click(button('common.cancel', true));
      else if (method === 'backdrop')
        await click(
          document.querySelector('[role="dialog"] [aria-hidden="true"]')!
        );
      else
        await act(async () =>
          document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
          )
        );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    }
  );
  it('confirms once even for two synchronous clicks', async () => {
    await mount();
    await click(button('publish'));
    const confirm = button('publish', true);
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it.each(['clean', 'busy', 'all'])(
    'rejects a stale %s confirmation',
    async (state) => {
      await mount();
      await click(button('publish'));
      if (state === 'all')
        await act(async () => useCmsStore.setState({ isPublishingAll: true }));
      else await mount(state !== 'clean', state === 'busy');
      await click(button('publish', true));
      expect(publish).not.toHaveBeenCalled();
    }
  );
  it('surfaces a rejected action rather than suppressing it', async () => {
    publish.mockRejectedValue(new Error('Database unavailable'));
    await mount();
    await click(button('publish'));
    await click(button('publish', true));
    expect(document.body.textContent).toContain('Database unavailable');
  });
});
