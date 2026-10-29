import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from 'prettier';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const identityStateSchema = z.object({
  shared_student_identity_1114: z.object({
    issue: z.literal(1114),
    pull_request: z.literal(1115),
    canonical_key: z.literal('studentUid'),
    migration: z.literal('0018_shared_student_identity_v1.sql'),
    status: z.literal('applied-and-postflight-verified'),
    production_migration_applied: z.literal(true),
    production_migration_version: z.literal(20260922212633),
    evidence: z.literal('docs/student-identity/POSTFLIGHT_1114.md'),
  }),
});
const projectionStateSchema = z.object({
  legacy_projection_removal_0019: z.object({
    pull_request: z.literal(1122),
    migration: z.literal('0019_remove_legacy_projection_v1.sql'),
    status: z.literal('applied-and-technical-postflight-verified'),
    production_migration_applied: z.literal(true),
    production_migration_version: z.literal(20260923164053),
    validated_source_head: z.literal('f01a410a8dd3e58ff1ee664ba3ee2e5b424aa20c'),
    evidence: z.literal('docs/student-portal/POSTFLIGHT_0019.md'),
    authenticated_grade_display_after_migration: z.literal('confirmed-by-owner-2026-09-23'),
  }),
});

/** Reuses the installed formatter's public YAML config loader, not substring matching or a custom parser. */
async function readYamlDocument(path: string) {
  const document: unknown = await resolveConfig(path, { config: path, useCache: false });
  return document;
}

const migrationFiles = (directory: string) =>
  readdirSync(join(root, directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));

const reconciliationCandidates = {
  gradebook: ['0015_student_reconciliation_v1.sql', '0016_reconciliation_year_reset_v1.sql'],
  portal: ['0025_reconciliation_credentials_v1.sql'],
} as const;
/** Retention of unreachable publication editions (owner request of 14/10/2026), not yet applied. */
const retentionCandidate = '0026_publication_source_retention_v1.sql';
/** Política Frequência (owner request of 20/10/2026), applied as 20261020115021 (POSTFLIGHT_0027). */
const frequencyCandidate = '0027_frequency_policy_v1.sql';
/** Política Horário (owner decision of 22/10/2026). */
const scheduleCandidate = '0028_schedule_policy_v1.sql';
/** Calendário escolar (owner decision of 22/10/2026). */
const calendarCandidate = '0029_school_calendar_v1.sql';
/** Horário das aulas (owner decision of 23/10/2026). */
const bellsCandidate = '0030_school_bells_v1.sql';
/** A parada in the bells (owner decision of 23/10/2026). */
const paradaCandidate = '0031_school_bells_parada_v1.sql';
/** Política Ocorrências (owner decision of 29/10/2026). */
const incidentCandidate = '0032_incident_policy_v1.sql';

describe('current canonical project state', () => {
  it('preserves the latest applied Gradebook migration separately from draft candidates', () => {
    const state = source('docs/gradebook/PROJECT_STATE.yaml');
    const latest = migrationFiles('migrations/gradebook-simplified')
      .filter((file) => !new Set<string>(reconciliationCandidates.gradebook).has(file))
      .at(-1);
    expect(latest).toBe('0014_function_execute_hardening_v1.sql');
    expect(state).toContain(`latest_gradebook_migration_file: ${latest}`);
    expect(state).toContain('latest_gradebook_migration_status: applied-and-postflight-verified');
    expect(state).toContain('latest_gradebook_migration_production_version: 20261005151011');
    expect(state).toContain(
      'latest_gradebook_applied_migration_file: 0014_function_execute_hardening_v1.sql',
    );
    expect(state).toContain(
      'latest_gradebook_applied_migration_production_version: 20261005151011',
    );
    expect(state).toContain(
      'previous_gradebook_applied_migration_production_version: 20260920162250',
    );
    const evidence = source('docs/gradebook/POSTFLIGHT_0014.md');
    expect(evidence).toContain('20261005151011');
    expect(evidence).toContain('28490011a920f36aad3543d928af6999733c99e2d65532b53b3f27283712d19d');
  });

  it('parses the applied projection removal and preserves earlier migration evidence', async () => {
    const gradebookState = await readYamlDocument(join(root, 'docs/gradebook/PROJECT_STATE.yaml'));
    const portalState = await readYamlDocument(
      join(root, 'docs/student-portal/PROJECT_STATE.yaml'),
    );
    const latest = migrationFiles('migrations/student-portal')
      .filter(
        (file) =>
          !new Set<string>([...reconciliationCandidates.portal, retentionCandidate, frequencyCandidate, scheduleCandidate, calendarCandidate, bellsCandidate, paradaCandidate, incidentCandidate]).has(file),
      )
      .at(-1);
    expect(latest).toBe('0024_seal_count_cache_v1.sql');
    expect(gradebookState).toMatchObject({
      storage: { total_table_count: 31, student_identity_table_count: 1 },
      repository_snapshot: {
        student_portal_latest_migration_in_tree: latest,
        student_portal_candidate_migrations_status: 'none-pending',
      },
      student_portal_integration: {
        schema_migration_file: latest,
        schema_migration_production_version: 20261001201546,
        schema_migration_production_evidence: 'docs/student-portal/POSTFLIGHT_0024.md',
        schema_table_count: 28,
      },
    });
    expect(portalState).toMatchObject({
      student_portal_latest_migration_in_tree: latest,
      student_portal_schema_latest_migration: latest,
      student_portal_schema_production_version: 20261001201546,
      student_portal_schema_production_evidence: 'docs/student-portal/POSTFLIGHT_0024.md',
      student_portal_schema_table_count: 28,
      seal_count_cache_0024: {
        issue: 1221,
        pull_request: 1222,
        production_migration_applied: true,
        production_migration_version: 20261001201546,
        evidence: 'docs/student-portal/POSTFLIGHT_0024.md',
      },
      audit_detail_0023: {
        status: 'migration-applied-runtime-deploy-pending',
        production_migration_applied: true,
        production_migration_version: 20260929071319,
        evidence: 'docs/student-portal/POSTFLIGHT_0023.md',
        deploy_order: 'migration-before-compatible-worker',
      },
      shift_policy_0022: {
        status: 'migration-applied-runtime-deploy-pending',
        production_migration_applied: true,
        production_migration_version: 20260928092734,
        production_deploy_verified: false,
        evidence: 'docs/student-portal/POSTFLIGHT_0022.md',
        deploy_order: 'migration-before-compatible-worker',
        contract: 'docs/student-portal/SHIFT_POLICY_V1.md',
      },
      recovery_1101: {
        production_migrations_applied: true,
        production_migration_versions: [20260922150000, 20260922150001],
      },
    });
    const auditEvidence = source('docs/student-portal/POSTFLIGHT_0023.md');
    expect(auditEvidence).toContain('20260929071319');
    expect(auditEvidence).toContain('b3ddacf8a38848968dd64d4a8349765dcd870178');
    const shiftEvidence = source('docs/student-portal/POSTFLIGHT_0022.md');
    expect(shiftEvidence).toContain('20260928092734');
    expect(shiftEvidence).toContain('4f380b4942c6b5f48f88fd80f70d8c6acf43779a');
    for (const state of [gradebookState, portalState]) {
      const identity = identityStateSchema.parse(state).shared_student_identity_1114;
      expect(identity.production_migration_applied).toBe(true);
      const evidence = source(identity.evidence);
      expect(evidence).toContain(String(identity.production_migration_version));
      expect(evidence).toContain('0e4c1f1298c6f69e5acf12f4ebe0464ea0ea97ab');
      const projection = projectionStateSchema.parse(state).legacy_projection_removal_0019;
      const projectionEvidence = source(projection.evidence);
      expect(projectionEvidence).toContain(String(projection.production_migration_version));
      expect(projectionEvidence).toContain('54aef301d949cbe5da5de07977580722491563ad');
      expect(projectionEvidence).toContain(projection.validated_source_head);
    }
  });

  it('accounts for every unapplied reconciliation candidate and its documented dependency order', () => {
    expect(
      migrationFiles('migrations/gradebook-simplified').filter(
        (file) => Number(file.slice(0, 4)) > 14,
      ),
    ).toEqual(reconciliationCandidates.gradebook);
    expect(
      migrationFiles('migrations/student-portal').filter((file) => Number(file.slice(0, 4)) === 25),
    ).toEqual(reconciliationCandidates.portal);
    expect(
      migrationFiles('migrations/student-portal').filter((file) => Number(file.slice(0, 4)) > 25),
    ).toEqual([retentionCandidate, frequencyCandidate, scheduleCandidate, calendarCandidate, bellsCandidate, paradaCandidate, incidentCandidate]);
    const contract = source('docs/student-identity/RECONCILIATION_V1.md');
    const order = [
      'gradebook-simplified/0015_student_reconciliation_v1.sql',
      'student-portal/0025_reconciliation_credentials_v1.sql',
      'gradebook-simplified/0016_reconciliation_year_reset_v1.sql',
    ];
    const positions = order.map((file) => contract.indexOf(file));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(contract).toContain('não altera a baseline de `PROJECT_STATE.yaml`');
    expect(contract).toContain('A execução em produção depende de autorização posterior.');
  });

  it('rejects malformed YAML and an identity block nested under an unrelated key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'identity-project-state-'));
    const file = join(directory, 'state.yaml');
    try {
      writeFileSync(file, 'invalid: [\n');
      await expect(readYamlDocument(file)).rejects.toThrow();
      writeFileSync(
        file,
        `unrelated:\n  shared_student_identity_1114:\n    issue: 1114\n    pull_request: 1115\n    canonical_key: studentUid\n    migration: 0018_shared_student_identity_v1.sql\n    status: applied-and-postflight-verified\n    production_migration_applied: true\n    production_migration_version: 20260922212633\n    evidence: docs/student-identity/POSTFLIGHT_1114.md\n`,
      );
      expect(identityStateSchema.safeParse(await readYamlDocument(file)).success).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps historical checkpoint 668 explicitly non-authoritative and retains its pending pilot', async () => {
    const state = await readYamlDocument(join(root, 'docs/gradebook/PROJECT_STATE.yaml'));
    expect(state).toMatchObject({
      repository_snapshot: { historical_checkpoint_668_is_runtime_authority: false },
      historical_checkpoint_668: {
        history: { obsolete_execution_queues: [185, 192, 593] },
        final_phases: expect.arrayContaining([
          expect.objectContaining({
            phase: 'FINAL-3',
            status:
              'relational-v3-integrated-migrated-deployed-smoke-and-local-contention-green-joint-visual-validation-and-pilot-pending',
          }),
        ]),
      },
    });
  });

  it('points current entry documents to the consolidated maintenance queue', () => {
    for (const path of [
      'docs/gradebook/README.md',
      'docs/gradebook/COMECE_AQUI.md',
      'docs/gradebook/ISSUE_MAP.md',
    ]) {
      const document = source(path);
      expect(document).toContain('#970');
      expect(document).not.toContain('A fila ativa é [Portal do Aluno Parte2 #742]');
    }
  });
});
