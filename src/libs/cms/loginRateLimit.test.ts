import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeLoginRateIdentifier } from '@/libs/cms/loginRateLimit';

describe('normalizeLoginRateIdentifier', () => {
  it('produces a stable sha256 hash', () => {
    const raw = 'login:1.2.3.4:user@example.com';
    expect(normalizeLoginRateIdentifier(raw)).toBe(
      createHash('sha256').update(raw).digest('hex')
    );
  });

  it('never includes the raw email', () => {
    const out = normalizeLoginRateIdentifier('login:1.2.3.4:user@example.com');
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('1.2.3.4');
  });

  it('is deterministic', () => {
    const raw = 'login:8.8.8.8:a@b.com';
    expect(normalizeLoginRateIdentifier(raw)).toBe(
      normalizeLoginRateIdentifier(raw)
    );
  });
});
