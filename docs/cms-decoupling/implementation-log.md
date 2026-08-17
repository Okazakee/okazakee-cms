# CMS Decoupling — Implementation Log

Running log per the orchestration instructions. Updated every phase.

## Model constraint (ABSOLUTE MODEL REQUIREMENT)

The task mandates DeepSeek V4 Flash for every role. The harness exposes no
per-subagent model override on `task`/`hub`, so subagent model cannot be
guaranteed. Per the instruction "if the harness cannot guarantee DeepSeek V4
Flash for a particular delegated call, do not make that delegated call", **no
subagents are spawned**. All orchestration, analysis, implementation, review
and verification are performed by the primary DeepSeek V4 Flash route. Tool
calls are parallelized instead.

## Sources of truth

- Plan: `/home/okazakee/Desktop/okazakee-cms-decoupling-plan.md` (4027 lines, read in full)
- Current checkout: `beta` @ `f448986` (`chore: remove graphify leftovers`)
- Audited commit per plan: `master` `551c552` — `git diff master beta` is empty, tree identical
- Behavior matrix: `docs/cms-decoupling/behavior-matrix.md`

## Phase log

### Phase 0 — Freeze the behavioral contract (2026-08-17)

- Read the full 4027-line plan.
- Full audit of current repo (all CMS routes, actions, components, hooks,
  stores, i18n, proxy, supabase clients, getData, next.config, env docs, git).
- Baseline: `bun run lint` clean (139 files); `bunx tsc --noEmit` exit 0.
- All 25 plan items verified against source. Classification in behavior-matrix.md §10.
- Key CONFIRMED BUGS (reproduce before copying): privacy write path never
  reaches the `privacy_policy` column; hero image stored/returned URL mismatch;
  `usersActions(GET)` editor-accessible; avatar + blog/portfolio `.webp`
  hardcoded extension with PNG fallback; `post` global cache tag; missing
  `author:<id>` invalidation; no `serverActions.bodySizeLimit` vs 10 MB
  validators; 5 duplicated elevated Supabase clients; invite URLs → monolith.
- Git: no tags exist. No `.github/` workflows. No docs/ dir before this phase.

### Phase 1 — Migration safety net (2026-08-17)

- Added `vitest` (dev dep), `vitest.config.ts` (`@/` alias, node env).
- Extracted pure validation helpers from `fileHelpers.ts` into
  `src/utils/cms/validation.ts` (exact move, re-exported; zero behavior change)
  so they are unit-testable without server deps.
- Tests: `src/utils/cms/validation.test.ts` (sanitizeFilename, image/PDF
  validation, storage path extraction, URL/date validation) and
  `src/app/actions/cms/utils/auth.test.ts` (getSafeCmsNext, GitHub username,
  provider, display name, avatar, allowlist matching). 43 tests, all passing.
  Two initial test expectations were corrected to match ACTUAL behavior
  (sanitizeFilename strips `@`/`?` without hyphen; PDF MIME alone passes
  validatePdfFile regardless of extension) — characterization, not fix, per
  Phase 1 scope.
- `.github/workflows/ci.yml`: bun 1.3.7, `bun install --frozen-lockfile`,
  lint, tsc, test, build (placeholder env for build).
- `package.json`: added `"test": "vitest run"`.
- Gates verified locally: lint 143 files clean, tsc exit 0, 43/43 tests,
  production build green (~10s).

### Phase 2 — Make the monolith easier to split (in progress)
