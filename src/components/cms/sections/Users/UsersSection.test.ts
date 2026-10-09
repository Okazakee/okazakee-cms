// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CMSUser } from '@/app/actions/cms/getUser';
import { useCmsStore } from '@/store/cmsStore';

const h = vi.hoisted(() => ({ actions: vi.fn() }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: { identity?: string }) =>
    values?.identity ? `${key}: ${values.identity}` : key,
}));
vi.mock('@/app/actions/cms/sections/usersActions', () => ({
  usersActions: h.actions,
  updateUserDisplayName: vi.fn(),
  uploadUserAvatar: vi.fn(),
}));

import UsersSection from './UsersSection';

let root: Root;
let container: HTMLDivElement;
function removeCalls() {
  return h.actions.mock.calls.filter(
    ([operation]) => operation.type === 'REMOVE'
  );
}
async function click(node: Element) {
  await act(async () =>
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCmsStore.setState({
    user: { id: 'admin', role: 'admin', email: 'admin@example.com' } as CMSUser,
  });
  h.actions.mockReset();
  h.actions.mockImplementation(async (operation) =>
    operation.type === 'GET'
      ? {
          success: true,
          data: [
            {
              id: 2,
              email: 'editor@example.com',
              github_username: null,
              role: 'editor',
              invited_at: null,
              created_at: '2026-01-01',
              profile: null,
            },
          ],
        }
      : { success: true }
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(UsersSection)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe('user removal confirmation', () => {
  it('identifies the target and cancels without mutation', async () => {
    await click(container.querySelector('[aria-label="users.removeUser"]')!);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'editor@example.com'
    );
    expect(removeCalls()).toEqual([]);
    const cancel = document.querySelector(
      '[role="dialog"] [aria-label="common.cancel"]'
    )!;
    await click(cancel);
    expect(removeCalls()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('confirms only once and surfaces action errors', async () => {
    h.actions.mockImplementation(async (operation) =>
      operation.type === 'REMOVE'
        ? { success: false, error: 'Deletion denied' }
        : { success: true, data: [] }
    );
    await click(container.querySelector('[aria-label="users.removeUser"]')!);
    const confirm = Array.from(
      document.querySelectorAll('[role="dialog"] button')
    ).find((node) => node.textContent === 'common.delete')!;
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(removeCalls()).toHaveLength(1);
    expect(container.textContent).toContain('Deletion denied');
  });
});
