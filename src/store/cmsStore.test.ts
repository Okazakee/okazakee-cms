import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCmsStore } from '@/store/cmsStore';

const resetStore = () => {
  useCmsStore.setState({
    publishQueue: {},
    sectionCallbacks: {},
    isPublishingAll: false,
    error: null,
    warning: null,
    sidePanelSections: [],
  });
};

const registerDirty = (key: string) => {
  useCmsStore.getState().registerPublishState(key, {
    isDirty: true,
    changeCount: 1,
    lastModified: 1,
  });
};

describe('cmsStore section callbacks', () => {
  beforeEach(resetStore);

  it('registers and unregisters per-section callbacks', () => {
    const publish = vi.fn(async () => {});
    const revert = vi.fn();
    const store = useCmsStore.getState();

    store.registerSectionCallbacks('blog', { publish, revert });
    expect(useCmsStore.getState().sectionCallbacks.blog?.publish).toBe(publish);

    useCmsStore.getState().unregisterSectionCallbacks('blog');
    expect(useCmsStore.getState().sectionCallbacks.blog).toBeUndefined();
  });
});

describe('cmsStore publishAll', () => {
  beforeEach(resetStore);

  it('publishes every dirty section sequentially and returns no failures', async () => {
    const order: string[] = [];
    useCmsStore.getState().registerSectionCallbacks('blog', {
      publish: async () => {
        order.push('blog');
      },
      revert: () => {},
    });
    useCmsStore.getState().registerSectionCallbacks('hero', {
      publish: async () => {
        order.push('hero');
      },
      revert: () => {},
    });
    useCmsStore.getState().setSidePanelSections(['hero', 'blog']);
    registerDirty('blog');
    registerDirty('hero');

    const failures = await useCmsStore.getState().publishAll();

    expect(failures).toEqual([]);
    expect(order).toEqual(['hero', 'blog']);
    expect(useCmsStore.getState().isPublishingAll).toBe(false);
  });

  it('skips clean sections and keys without a handler', async () => {
    const publish = vi.fn(async () => {});
    useCmsStore.getState().registerSectionCallbacks('hero', {
      publish,
      revert: () => {},
    });
    registerDirty('hero');
    // Dirty but no registered callback.
    registerDirty('orphan');

    const failures = await useCmsStore.getState().publishAll();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({
      key: 'orphan',
      error: 'No publish handler registered for "orphan"',
    });
  });

  it('continues after a section throws and reports every failure', async () => {
    const order: string[] = [];
    useCmsStore.getState().registerSectionCallbacks('blog', {
      publish: async () => {
        order.push('blog');
        throw new Error('blog exploded');
      },
      revert: () => {},
    });
    useCmsStore.getState().registerSectionCallbacks('hero', {
      publish: async () => {
        order.push('hero');
      },
      revert: () => {},
    });
    useCmsStore.getState().setSidePanelSections(['blog', 'hero']);
    registerDirty('blog');
    registerDirty('hero');

    const failures = await useCmsStore.getState().publishAll();

    expect(order).toEqual(['blog', 'hero']);
    expect(failures).toEqual([{ key: 'blog', error: 'blog exploded' }]);
    expect(useCmsStore.getState().error).toContain('blog: blog exploded');
  });

  it('locks against concurrent publishAll calls and releases the lock', async () => {
    let resolvePublish: (() => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePublish = resolve;
        })
    );
    useCmsStore.getState().registerSectionCallbacks('blog', {
      publish,
      revert: () => {},
    });
    registerDirty('blog');

    const first = useCmsStore.getState().publishAll();
    const second = await useCmsStore.getState().publishAll();

    expect(second).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(useCmsStore.getState().isPublishingAll).toBe(true);

    resolvePublish?.();
    await first;
    expect(useCmsStore.getState().isPublishingAll).toBe(false);
  });

  it('aggregates returned section failures and continues publishing', async () => {
    const later = vi.fn(async () => {});
    useCmsStore.getState().registerSectionCallbacks('hero', {
      publish: async () => {
        useCmsStore.getState().setError('Hero upload failed');
      },
      revert: vi.fn(),
    });
    useCmsStore
      .getState()
      .registerSectionCallbacks('blog', { publish: later, revert: vi.fn() });
    registerDirty('hero');
    registerDirty('blog');
    expect(await useCmsStore.getState().publishAll()).toEqual([
      { key: 'hero', error: 'Hero upload failed' },
    ]);
    expect(later).toHaveBeenCalledOnce();
    expect(useCmsStore.getState().error).toContain('Hero upload failed');
  });

  it('does not convert propagation warnings into publish failures', async () => {
    useCmsStore.getState().registerSectionCallbacks('privacy-policy', {
      publish: async () => {
        useCmsStore.getState().setWarning('Revalidation failed');
      },
      revert: vi.fn(),
    });
    registerDirty('privacy-policy');
    expect(await useCmsStore.getState().publishAll()).toEqual([]);
    expect(useCmsStore.getState().error).toBeNull();
    expect(useCmsStore.getState().warning).toBe('Revalidation failed');
  });

  it('releases the lock even when a callback throws synchronously', async () => {
    useCmsStore.getState().registerSectionCallbacks('blog', {
      publish: () => {
        throw new Error('sync boom');
      },
      revert: () => {},
    });
    registerDirty('blog');

    const failures = await useCmsStore.getState().publishAll();

    expect(failures).toEqual([{ key: 'blog', error: 'sync boom' }]);
    expect(useCmsStore.getState().isPublishingAll).toBe(false);
  });
});
