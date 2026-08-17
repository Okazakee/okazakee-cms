import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  getLoginRateIdentifiers,
  normalizeLoginRateIdentifier,
} from '@/libs/cms/loginRateLimit';

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

describe('getLoginRateIdentifiers', () => {
  it('keeps the IP and email buckets distinct', () => {
    const { ipHash, emailHash } = getLoginRateIdentifiers(
      '1.2.3.4',
      'user@example.com'
    );
    expect(ipHash).not.toBe(emailHash);
  });

  it('same email from different IPs shares the email bucket', () => {
    const a = getLoginRateIdentifiers('1.2.3.4', 'user@example.com');
    const b = getLoginRateIdentifiers('5.6.7.8', 'user@example.com');
    expect(a.emailHash).toBe(b.emailHash);
    expect(a.ipHash).not.toBe(b.ipHash);
  });

  it('multiple emails from the same IP share the IP bucket', () => {
    const a = getLoginRateIdentifiers('1.2.3.4', 'a@example.com');
    const b = getLoginRateIdentifiers('1.2.3.4', 'b@example.com');
    expect(a.ipHash).toBe(b.ipHash);
    expect(a.emailHash).not.toBe(b.emailHash);
  });

  it('normalizes email case and whitespace for the email bucket', () => {
    const a = getLoginRateIdentifiers('1.2.3.4', 'User@Example.com');
    const b = getLoginRateIdentifiers('1.2.3.4', '  user@example.com ');
    expect(a.emailHash).toBe(b.emailHash);
  });

  it('never includes raw values in the hashes', () => {
    const { ipHash, emailHash } = getLoginRateIdentifiers(
      '203.0.113.7',
      'secret@example.com'
    );
    expect(ipHash).not.toContain('203.0.113.7');
    expect(emailHash).not.toContain('secret@example.com');
  });
});
