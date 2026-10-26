import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEV_RBAC_ALLOWLIST_ACL_QUERY,
  DEV_RBAC_ROLE_CONSTRAINTS_QUERY,
  DEV_RBAC_RPC_COPIES_QUERY,
  DEV_RBAC_TRIGGERS_QUERY,
  LEDGER_ROWS_QUERY,
  loadRegistry,
  runDevCheck,
  type CheckFinding,
} from '@/libs/cms/devMigrations/devCheck';

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

const REGISTRY_PATH = 'src/libs/cms/devMigrations/registry.json';

const DEV_ROLE_CONSTRAINT_ROW = {
  constraint_name: 'cms_allowed_users_role_check',
  contype: 'c',
  definition:
    "CHECK (role = ANY (ARRAY['editor'::text, 'admin'::text, 'superadmin'::text]))",
};

const DEV_GUARD_TRIGGER_ROW = {
  trigger_name: 'cms_allowed_users_guard_superadmin',
  enabled: 'O',
  trigger_type: 27,
  function_schema: 'dev_staging',
  function_name: 'cms_allowed_users_guard_superadmin',
};

const DEV_ALLOWLIST_ACL_ROW = {
  table_name: 'cms_allowed_users',
  acl_raw: '{postgres=arwdDxt/postgres,service_role=arwdDxt/postgres}',
};

/**
 * Runs the real history stage (registry + source bytes) and answers the four
 * RBAC catalog reads from deterministic fixtures; every other catalog read is
 * empty. Only the RBAC-* findings are returned, so the assertions stay focused
 * on the contract added by the superadmin migration.
 */
async function rbacFindings(overrides?: {
  constraints?: unknown[];
  triggers?: unknown[];
  rpcCopies?: unknown[];
  allowlistAcl?: unknown[];
}): Promise<CheckFinding[]> {
  const repoRoot = process.cwd();
  const registry = await loadRegistry(repoRoot, REGISTRY_PATH);
  const ledgerRows = await Promise.all(
    registry.map(async (entry) => ({
      version: entry.version,
      name: entry.name,
      source_file: entry.sourceFile,
      source_sha256: createHash('sha256')
        .update(await readFile(path.join(repoRoot, entry.sourceFile)))
        .digest('hex'),
      execution_mode: 'applied',
      recorded_at: null,
    }))
  );
  const queryJson = async (sql: string): Promise<unknown[]> => {
    if (sql === LEDGER_ROWS_QUERY) return ledgerRows;
    if (sql === DEV_RBAC_ROLE_CONSTRAINTS_QUERY) {
      return overrides?.constraints ?? [DEV_ROLE_CONSTRAINT_ROW];
    }
    if (sql === DEV_RBAC_TRIGGERS_QUERY) {
      return overrides?.triggers ?? [DEV_GUARD_TRIGGER_ROW];
    }
    if (sql === DEV_RBAC_RPC_COPIES_QUERY) return overrides?.rpcCopies ?? [];
    if (sql === DEV_RBAC_ALLOWLIST_ACL_QUERY) {
      return overrides?.allowlistAcl ?? [DEV_ALLOWLIST_ACL_ROW];
    }
    return [];
  };
  const report = await runDevCheck({ repoRoot, queryJson });
  return report.findings.filter((f) => f.id.startsWith('RBAC-'));
}

describe('dev RBAC mirror contract', () => {
  it('certifies role CHECK, dev-bound guard trigger, no RPC copies, closed grants', async () => {
    const findings = await rbacFindings();
    expect(findings.map((f) => f.id).sort()).toEqual([
      'RBAC-dev-allowlist-grants',
      'RBAC-dev-guard-trigger',
      'RBAC-dev-role-constraint',
      'RBAC-dev-rpc-copies',
      'RBAC-scope',
    ]);
    expect(findings.filter((f) => f.status === 'FAIL')).toEqual([]);
    expect(findings.find((f) => f.id === 'RBAC-scope')?.status).toBe('INFO');
    expect(findings.find((f) => f.id === 'RBAC-scope')?.detail).toContain(
      'NOT certified'
    );
  });

  it('fails when the dev role CHECK still rejects superadmin', async () => {
    const findings = await rbacFindings({
      constraints: [
        {
          ...DEV_ROLE_CONSTRAINT_ROW,
          definition:
            "CHECK (role = ANY (ARRAY['editor'::text, 'admin'::text]))",
        },
      ],
    });
    const roleFinding = findings.find(
      (f) => f.id === 'RBAC-dev-role-constraint'
    );
    expect(roleFinding?.status).toBe('FAIL');
    expect(roleFinding?.detail).toContain('superadmin');
  });

  it('fails when a second role CHECK narrows the vocabulary', async () => {
    const findings = await rbacFindings({
      constraints: [
        DEV_ROLE_CONSTRAINT_ROW,
        {
          constraint_name: 'cms_allowed_users_role_editor_only',
          contype: 'c',
          definition: "CHECK (role = 'editor'::text)",
        },
      ],
    });
    const roleFinding = findings.find(
      (f) => f.id === 'RBAC-dev-role-constraint'
    );
    expect(roleFinding?.status).toBe('FAIL');
    expect(roleFinding?.detail).toContain('cms_allowed_users_role_editor_only');
  });

  it('fails when the dev role CHECK is missing entirely', async () => {
    const findings = await rbacFindings({ constraints: [] });
    const roleFinding = findings.find(
      (f) => f.id === 'RBAC-dev-role-constraint'
    );
    expect(roleFinding?.status).toBe('FAIL');
    expect(roleFinding?.detail).toContain('ABSENT');
  });

  it('fails when the guard trigger binds the public function', async () => {
    const findings = await rbacFindings({
      triggers: [{ ...DEV_GUARD_TRIGGER_ROW, function_schema: 'public' }],
    });
    const guardFinding = findings.find(
      (f) => f.id === 'RBAC-dev-guard-trigger'
    );
    expect(guardFinding?.status).toBe('FAIL');
    expect(guardFinding?.detail).toContain(
      'public.cms_allowed_users_guard_superadmin'
    );
  });

  it('fails when the guard trigger is disabled or absent', async () => {
    const disabled = await rbacFindings({
      triggers: [{ ...DEV_GUARD_TRIGGER_ROW, enabled: 'D' }],
    });
    expect(
      disabled.find((f) => f.id === 'RBAC-dev-guard-trigger')?.detail
    ).toContain('tgenabled got=D');
    const absent = await rbacFindings({ triggers: [] });
    expect(absent.find((f) => f.id === 'RBAC-dev-guard-trigger')?.status).toBe(
      'FAIL'
    );
  });

  it('fails when dev_staging grows a public-reading RPC copy', async () => {
    const findings = await rbacFindings({
      rpcCopies: [{ name: 'is_admin_user', acl_raw: '{postgres=X/postgres}' }],
    });
    const copyFinding = findings.find((f) => f.id === 'RBAC-dev-rpc-copies');
    expect(copyFinding?.status).toBe('FAIL');
    expect(copyFinding?.detail).toContain('is_admin_user');
  });

  it('fails when anon or authenticated regains allowlist table grants', async () => {
    const findings = await rbacFindings({
      allowlistAcl: [
        {
          table_name: 'cms_allowed_users',
          acl_raw: '{anon=r/postgres,authenticated=r/postgres}',
        },
      ],
    });
    const aclFinding = findings.find(
      (f) => f.id === 'RBAC-dev-allowlist-grants'
    );
    expect(aclFinding?.status).toBe('FAIL');
    expect(aclFinding?.detail).toContain('anon holds r');
    expect(aclFinding?.detail).toContain('authenticated holds r');
  });

  it('fails when the allowlist table row is unreadable', async () => {
    const findings = await rbacFindings({ allowlistAcl: [] });
    const aclFinding = findings.find(
      (f) => f.id === 'RBAC-dev-allowlist-grants'
    );
    expect(aclFinding?.status).toBe('FAIL');
    expect(aclFinding?.detail).toContain('ABSENT');
  });
});
