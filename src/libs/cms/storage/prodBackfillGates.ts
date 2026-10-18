/**
 * Phase 13 C3/C4 — the production-only gates a mutating run must pass.
 *
 * Two gates live here because BOTH the executor and the rollback need them
 * identically and in the same order:
 *
 *   - the persistent journal destination (a production-specific variable,
 *     deliberately not the DEV one), and
 *   - the signed cache-invalidation destination: an explicitly configured HTTPS
 *     origin allowlist plus the signing secret.
 *
 * Everything else a production `--apply` requires (the environment tuple, the
 * production acknowledgement, the project reference, the manifest digest, a
 * clean manifest, and the live readiness probes) is checked by the CLI in the
 * documented order, using the shared helpers.
 *
 * There is no default origin anywhere in this module: the operator names the
 * approved production origin(s), so the tooling can never invent a hostname and
 * a typo fails closed.
 */
import {
  type BackfillEnvironmentSpec,
  parseRevalidationOrigins,
  validateRevalidationEndpointFor,
} from '@/libs/cms/storage/backfillEnvironment';

/**
 * Colon-separated repository roots the production journal must NOT live under.
 * The command already forbids its own working directory; this lets the operator
 * add the sibling checkout (the public site) so a journal can never be
 * committed by either repository.
 */
export const PROD_FORBIDDEN_ROOTS_ENV = 'CMS_PROD_BACKFILL_FORBIDDEN_ROOTS';

/** The signing secret shared with the public site's revalidation endpoint. */
export const REVALIDATION_SECRET_ENV = 'WEBSITE_REVALIDATION_SECRET';

/** The configured destination URL of the signed revalidation event. */
export const REVALIDATION_URL_ENV = 'WEBSITE_REVALIDATION_URL';

export type ProdMutationGates = {
  journalPath: string;
  /** Normalised, lowercased HTTPS origins the destination may use. */
  allowedOrigins: string[];
  /** The approved destination URL. */
  endpoint: string;
};

export type ProdMutationGateResult =
  | { ok: true; gates: ProdMutationGates }
  | { ok: false; error: string };

/**
 * What a production CLI returns to its caller (the process entry point, or a
 * test): the exit code, the JSON report to print on stdout (null when the run
 * never got that far), and the refusal/failure message for stderr.
 */
export type ProdCliOutcome = {
  exitCode: number;
  report: Record<string, unknown> | null;
  error: string | null;
};

/**
 * The environment-only gates, in order: the journal variable must be present,
 * the allowlist must parse, the destination must be an approved HTTPS origin on
 * the exact route, and the signing secret must be configured.
 *
 * A failure here is a refusal, never a warning: a run that cannot journal is
 * not recoverable, and a pointer switch that cannot invalidate the public cache
 * would leave the site serving the pre-migration render.
 */
export function resolveProdMutationGates(
  spec: BackfillEnvironmentSpec,
  env: Readonly<Record<string, string | undefined>>
): ProdMutationGateResult {
  const journalPath = env[spec.journal.env] ?? '';
  if (!journalPath) {
    return {
      ok: false,
      error: `${spec.journal.env} must be set so the run is recoverable across invocations`,
    };
  }
  const originsVariable =
    spec.revalidation.kind === 'https-allowlist'
      ? spec.revalidation.originsEnv
      : 'CMS_REVALIDATION_ORIGINS';
  const parsed = parseRevalidationOrigins(env[originsVariable] ?? '');
  if (!parsed.ok && spec.revalidation.kind === 'https-allowlist') {
    return { ok: false, error: `${originsVariable}: ${parsed.error}` };
  }
  const origins = parsed.ok ? parsed.origins : [];
  const endpoint = env[REVALIDATION_URL_ENV] ?? '';
  const endpointProblem = validateRevalidationEndpointFor(
    spec,
    endpoint,
    origins
  );
  if (endpointProblem) {
    return {
      ok: false,
      error: `${endpointProblem} (a pointer switch must be able to invalidate the public cache)`,
    };
  }
  if (!env[REVALIDATION_SECRET_ENV]) {
    return {
      ok: false,
      error: `${REVALIDATION_SECRET_ENV} is not configured`,
    };
  }
  return {
    ok: true,
    gates: { journalPath, allowedOrigins: origins, endpoint },
  };
}
