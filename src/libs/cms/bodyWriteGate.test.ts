import { describe, expect, it } from 'vitest';
import { resolveBodyWrite } from '@/libs/cms/bodyWriteGate';

/**
 * The write gate no longer has an enable flag (Storage is the only body store);
 * what must hold is that only the two sanctioned environment pairings resolve,
 * and that each resolves to its OWN content bucket.
 */
describe('resolveBodyWrite', () => {
  it('resolves the production pairing to the production content bucket', () => {
    expect(
      resolveBodyWrite({ appEnv: 'production', schema: 'public' })
    ).toEqual({ mode: 'enabled', bucket: 'website-content' });
  });

  it('resolves the clone pairing to the dev content bucket', () => {
    expect(
      resolveBodyWrite({ appEnv: 'development', schema: 'dev_staging' })
    ).toEqual({ mode: 'enabled', bucket: 'website-content-dev' });
  });

  it('fails closed on every cross-environment pairing', () => {
    const invalid = [
      { appEnv: 'production', schema: 'dev_staging' },
      { appEnv: 'development', schema: 'public' },
      { appEnv: 'staging', schema: 'public' },
    ];
    for (const env of invalid) {
      const decision = resolveBodyWrite(env);
      expect(decision.mode).toBe('invalid');
      if (decision.mode === 'invalid') {
        expect(decision.error).toMatch(/refusing to resolve a content bucket/);
      }
    }
  });
});
