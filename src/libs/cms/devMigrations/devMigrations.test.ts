import { describe, expect, it } from 'vitest';
import { runDevCheck } from '@/libs/cms/devMigrations/devCheck';

describe('devCheck history semantics (ledger-shaped stub)', () => {
  it('fails on missing ledger instead of passing silently', async () => {
    const queryJson = async (sql: string): Promise<unknown[]> => {
      if (sql.includes('cms_migration_audit')) {
        throw new Error(
          'relation dev_staging.cms_migration_audit does not exist'
        );
      }
      return [];
    };
    const report = await runDevCheck({
      repoRoot: '/nonexistent-repo-root-for-test',
      queryJson,
    });
    expect(report.ok).toBe(false);
    expect(
      report.findings.some((f: { status: string }) => f.status === 'FAIL')
    ).toBe(true);
  });
});
