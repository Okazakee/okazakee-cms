import { describe, expect, it } from 'vitest';
import {
  BODY_DUAL_WRITE_FLAG,
  POINTER_COLUMNS_FLAG,
  resolveBodyDualWrite,
} from '@/libs/cms/bodyDualWrite';

/**
 * The gate is the only thing standing between production and the dev content
 * bucket, so every combination is pinned here.
 */
describe('body dual-write feature gate', () => {
  it('is disabled by default and records the dev clone', () => {
    expect(
      resolveBodyDualWrite({
        enabled: false,
        appEnv: 'development',
        schema: 'dev_staging',
      })
    ).toEqual({ mode: 'disabled', devClone: true, pointerColumns: true });

    expect(
      resolveBodyDualWrite({
        enabled: false,
        appEnv: 'production',
        schema: 'public',
      })
    ).toEqual({ mode: 'disabled', devClone: false, pointerColumns: false });
  });

  it('enables only for the dev clone and names the dev content bucket', () => {
    expect(
      resolveBodyDualWrite({
        enabled: true,
        appEnv: 'development',
        schema: 'dev_staging',
      })
    ).toEqual({ mode: 'enabled', bucket: 'website-content-dev' });

    expect(
      resolveBodyDualWrite({
        enabled: true,
        appEnv: 'staging',
        schema: 'dev_staging',
      })
    ).toEqual({ mode: 'enabled', bucket: 'website-content-dev' });
  });

  it('enables the production bucket for production+public', () => {
    expect(
      resolveBodyDualWrite({
        enabled: true,
        appEnv: 'production',
        schema: 'public',
      })
    ).toEqual({ mode: 'enabled', bucket: 'website-content' });
  });

  it('never crosses buckets between environments', () => {
    expect(
      resolveBodyDualWrite({ enabled: true, appEnv: 'production', schema: 'public' })
    ).toEqual({ mode: 'enabled', bucket: 'website-content' });
    expect(
      resolveBodyDualWrite({ enabled: true, appEnv: 'development', schema: 'dev_staging' })
    ).toEqual({ mode: 'enabled', bucket: 'website-content-dev' });
    expect(
      resolveBodyDualWrite({ enabled: true, appEnv: 'production', schema: 'dev_staging' }).mode
    ).toBe('invalid');
    expect(
      resolveBodyDualWrite({ enabled: true, appEnv: 'development', schema: 'public' }).mode
    ).toBe('invalid');
  });

  it('rejects an enabled flag outside dev_staging', () => {
    for (const schema of ['public', '', 'qa_staging']) {
      const decision = resolveBodyDualWrite({
        enabled: true,
        appEnv: 'development',
        schema,
      });
      expect(decision.mode).toBe('invalid');
      if (decision.mode === 'invalid') {
        expect(decision.error).toContain('refusing to resolve a content bucket');
      }
    }
  });

  it('rejects production even when the schema looks like the dev clone', () => {
    const decision = resolveBodyDualWrite({
      enabled: true,
      appEnv: 'production',
      schema: 'dev_staging',
    });
    expect(decision.mode).toBe('invalid');
  });

  it('exposes the flag names used by the environment', () => {
    expect(BODY_DUAL_WRITE_FLAG).toBe('CMS_BODY_DUAL_WRITE_ENABLED');
    expect(POINTER_COLUMNS_FLAG).toBe('CMS_BODY_POINTER_COLUMNS');
  });

  it('declares pointer columns only in the two valid pairings', () => {
    expect(
      resolveBodyDualWrite({ enabled: false, appEnv: 'development', schema: 'dev_staging' })
    ).toMatchObject({ mode: 'disabled', devClone: true, pointerColumns: true });
    expect(
      resolveBodyDualWrite({ enabled: false, appEnv: 'production', schema: 'public' })
    ).toMatchObject({ mode: 'disabled', devClone: false, pointerColumns: false });
    expect(
      resolveBodyDualWrite({
        enabled: false,
        appEnv: 'production',
        schema: 'public',
        pointerColumns: true,
      })
    ).toMatchObject({ mode: 'disabled', devClone: false, pointerColumns: true });
    // A declared capability in a mismatched environment fails closed.
    expect(
      resolveBodyDualWrite({
        enabled: false,
        appEnv: 'development',
        schema: 'public',
        pointerColumns: true,
      }).mode
    ).toBe('invalid');
    expect(
      resolveBodyDualWrite({
        enabled: false,
        appEnv: 'production',
        schema: 'dev_staging',
        pointerColumns: true,
      }).mode
    ).toBe('invalid');
  });
});
