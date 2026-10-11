import { expect } from 'vitest';
import { StudentReconciliationServiceV1 } from '../../../server/student-identity/reconciliation/service-v1';
import type { GradebookPostgresDatabaseV1 } from '../../../server/gradebook/persistence/postgres/postgres-database-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type { ReconciliationCredentialRequestV1 } from '../../../shared/student-portal-contracts/ports-v1';

export type ReconciliationHarnessFixtureV1 = {
  request: ReconciliationCredentialRequestV1;
  assertUnchanged(): Promise<void>;
  activate(): Promise<void>;
};

/** Owner creates synthetic fixtures; all application mutations use the real Gradebook service/role. */
export async function prepareReconciliationHarnessFixtureV1(
  database: GradebookPostgresDatabaseV1,
  owner: StudentPortalPostgresQueryV1,
): Promise<ReconciliationHarnessFixtureV1> {
  const service = new StudentReconciliationServiceV1(
    database,
    '11111111-1111-4111-8111-111111111111',
    'synthetic-harness-cursor-1269'.repeat(3),
  );
  const catalog = await service.execute({
    contractVersion: 1,
    academicYear: 2026,
    operation: 'catalog',
  });
  if (catalog.state !== 'ready' || catalog.operation !== 'catalog')
    throw new Error('synthetic-harness-context');
  const prepared = await service.execute({
    contractVersion: 1,
    academicYear: 2026,
    operation: 'prepare',
    generation: catalog.context.generation,
    expectedRevision: catalog.context.revision,
    idempotencyKey: crypto.randomUUID(),
    normalizationVersion: 1,
    sourceFormat: 'smecel-report-v1',
    date1904: false,
    sourceYear: 2026,
    confirmYear: true,
    sourceGeneratedAt: null,
    rows: Array.from({ length: 5 }, (_, i) => ({
      sourceRow: i + 2,
      name: 'SYNTHETIC WORKER ' + (i + 1),
      birthDate: '2001-02-03',
      filiation1: null,
      inep: null,
      enrollmentHash: 'synthetic-harness-' + i,
      classLabel: '6A 2026 - MATUTINO',
      shift: 'MATUTINO',
      stageLabel: '6º Ano',
      status: 'ATIVO',
      enrolledAt: null,
      transferredAt: null,
    })),
    classLinks: [
      {
        classLabel: '6A 2026 - MATUTINO',
        shift: 'MATUTINO',
        stageLabel: '6º Ano',
        gradebookClassId: 950001,
        confirmRegular: true,
      },
    ],
  });
  if (prepared.state !== 'ready' || prepared.operation !== 'prepare')
    throw new Error('synthetic-harness-prepare');
  expect(prepared.counts.linked).toBe(5);
  const snapshot = async () =>
    JSON.stringify(
      await owner.unsafe(`SELECT a.id,a.version,a.pin_version,a.security_version,
    p.pin_verifier,p.password_verifier,d.birth_year,d.confirmation FROM student_portal.account a
    LEFT JOIN student_portal.password_credential p ON p.account_id=a.id LEFT JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
    WHERE a.gradebook_student_id BETWEEN 950001 AND 950005 ORDER BY a.id`),
    );
  const before = await snapshot();
  return {
    request: {
      contractVersion: 1,
      batchId: prepared.batchId,
      generation: prepared.context.generation,
      expectedScopeRevision: prepared.context.revision,
    },
    assertUnchanged: async () => {
      expect(await snapshot()).toBe(before);
    },
    activate: async () => {
      const result = await service.execute({
        contractVersion: 1,
        academicYear: 2026,
        operation: 'apply',
        batchId: prepared.batchId,
        generation: prepared.context.generation,
        expectedRevision: prepared.context.revision,
        idempotencyKey: crypto.randomUUID(),
        confirmDifferences: true,
      });
      expect(result.state).toBe('committed');
      expect(
        (
          await owner.unsafe(
            'SELECT 1 FROM student_portal.reconciliation_credential_stage_v1 WHERE batch_id=$1::uuid',
            [prepared.batchId],
          )
        ).length,
      ).toBe(0);
    },
  };
}
