// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PostBodiesLoader,
  type PostBodiesLoaderApi,
  usePostBodies,
} from '@/hooks/cms/usePostBodies';
import type { LoadedBodies } from '@/hooks/cms/postBodyState';

/**
 * Phase 9B editor loading safety: the shared loader must never turn a failure
 * into a body, and a superseded request must never touch editor state.
 */

let api: PostBodiesLoaderApi | null = null;

function loader(): PostBodiesLoaderApi {
  if (!api) throw new Error('usePostBodies was not rendered');
  return api;
}

function Harness({ fetcher }: { fetcher: PostBodiesLoader }) {
  api = usePostBodies(fetcher);
  const status = api.failure ? `error:${api.failure.error}` : 'ok';
  return createElement('div', null, `${api.loadingId ?? 'idle'}|${status}`);
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(fetcher: PostBodiesLoader) {
  act(() => {
    root.render(createElement(Harness, { fetcher }));
  });
}

describe('usePostBodies', () => {
  it('returns the bodies of the requested post', async () => {
    const fetcher = vi.fn(async (id: number) => ({
      success: true,
      data: { id, body_en: '# en', body_it: '# it' },
    }));
    render(fetcher);

    let loaded: LoadedBodies | null = null;
    await act(async () => {
      loaded = await loader().load(7);
    });

    expect(loaded).toEqual({ en: '# en', it: '# it' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(7);
    expect(text(container)).toBe('idle|ok');
  });

  it('never yields a body when the action fails', async () => {
    const fetcher = vi.fn(async () => ({
      success: false,
      error: 'Object not found',
    }));
    render(fetcher);

    let loaded: LoadedBodies | null = { en: 'stale', it: 'stale' };
    await act(async () => {
      loaded = await loader().load(7);
    });

    expect(loaded).toBeNull();
    expect(text(container)).toBe('idle|error:Object not found');
  });

  it('rejects a response for a different post id', async () => {
    const fetcher = vi.fn(async () => ({
      success: true,
      data: { id: 999, body_en: '# en', body_it: '# it' },
    }));
    render(fetcher);

    let loaded: LoadedBodies | null = null;
    await act(async () => {
      loaded = await loader().load(7);
    });

    expect(loaded).toBeNull();
    expect(text(container)).toContain('Unexpected markdown response');
  });

  it('rejects a response whose bodies are not strings', async () => {
    const fetcher = vi.fn(async () => ({
      success: true,
      data: { id: 7, body_en: null, body_it: '# it' },
    }));
    render(fetcher);

    let loaded: LoadedBodies | null = null;
    await act(async () => {
      loaded = await loader().load(7);
    });

    expect(loaded).toBeNull();
    expect(text(container)).toContain('Unexpected markdown response');
  });

  it('turns a thrown error into a failure, not a body', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network exploded');
    });
    render(fetcher);

    let loaded: LoadedBodies | null = null;
    await act(async () => {
      loaded = await loader().load(7);
    });

    expect(loaded).toBeNull();
    expect(text(container)).toContain('error:network exploded');
  });

  it('ignores a superseded request so a slow post cannot overwrite a newer one', async () => {
    const first = Promise.withResolvers<unknown>();
    const fetcher = vi.fn(async (id: number) => {
      if (id === 1) return (await first.promise) as never;
      return { success: true, data: { id, body_en: '# second en', body_it: '# second it' } };
    });
    render(fetcher);

    let firstResult: LoadedBodies | null = { en: 'pending', it: 'pending' };
    let secondResult: LoadedBodies | null = null;

    await act(async () => {
      // Start post 1 but do not await it.
      void loader().load(1).then((value) => {
        firstResult = value;
      });
    });
    await act(async () => {
      secondResult = await loader().load(2);
    });

    expect(secondResult).toEqual({ en: '# second en', it: '# second it' });
    expect(text(container)).toBe('idle|ok');

    await act(async () => {
      first.resolve({
        success: true,
        data: { id: 1, body_en: '# first en', body_it: '# first it' },
      });
      await Promise.resolve();
    });

    // The stale response neither resolves a body nor disturbs the state.
    expect(firstResult).toBeNull();
    expect(text(container)).toBe('idle|ok');
  });

  it('permits a retry after a failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'boom' })
      .mockResolvedValueOnce({
        success: true,
        data: { id: 7, body_en: '# en', body_it: '# it' },
      });
    render(fetcher);

    await act(async () => {
      await loader().load(7);
    });
    expect(text(container)).toContain('error:boom');

    let retried: LoadedBodies | null = null;
    await act(async () => {
      retried = await loader().load(7);
    });

    expect(retried).toEqual({ en: '# en', it: '# it' });
    expect(text(container)).toBe('idle|ok');
  });
});
