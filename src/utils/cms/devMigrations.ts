#!/usr/bin/env node
/**
 * Dev-only migration CLI entry (read-only).
 *
 *   bun run db:dev:check [--scope dev_staging]
 *
 * Requires the logged-in project-local Supabase CLI
 * (`supabase login` + `supabase link --project-ref <ref>` once in this
 * repo). Check is read-only: ledger + source hashes + dev_staging effect
 * proof. Unknown actions are rejected; no apply path exists.
 * Verified-existing history is never replayed; `db push` / global repair
 * are never invoked.
 */
import { runDevCheck } from '@/libs/cms/devMigrations/devCheck';

const argv = process.argv.slice(2);
const command = argv[0];
const repoRoot = process.cwd();

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usage(): void {
  console.log(
    [
      'usage:',
      '  bun run db:dev:check [--scope dev_staging]',
      '',
      'auth/link (once per machine):',
      '  supabase login',
      '  supabase link --project-ref <ref>',
    ].join('\n')
  );
}

if (command === 'check') {
  const scope = flag('--scope') ?? 'dev_staging';
  const report = await runDevCheck({ repoRoot, selectedScope: scope });
  for (const f of report.findings) {
    console.log(`${f.status.padEnd(6)} ${f.id} :: ${f.detail.slice(0, 280)}`);
  }
  console.log(
    `dev check: ${report.pass} pass / ${report.fail} fail / ${report.info} info`
  );
  if (!report.ok) {
    console.log(
      'scope note: shared-auth/global objects (auth.users, global history, public schema) are NOT certified here.'
    );
  }
  process.exit(report.ok ? 0 : 1);
} else {
  usage();
  process.exit(2);
}
