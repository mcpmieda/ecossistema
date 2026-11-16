import { readFileSync } from 'node:fs';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import type { ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { ScopedPublicationServiceV2 } from '../../../server/student-portal/publication/scoped-publication-service-v2';
import { PortalAdminApiV1 } from '../../../server/student-portal/admin/api-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import {
  installAdminReadFixtureV2,
  READ_ACTOR_V2,
  READ_TENANT_V2,
  READ_SCHOOL_V2,
  readAccountIdV2,
} from './read-fixture-v2';

export const CUSTOM_ACCOUNT_V1 = {
  kind: 'account',
  academicYear: 2026,
  accountId: readAccountIdV2(1),
} as const;
export const CUSTOM_CURSOR_SECRET_V1 = 'synthetic-customization-827-cursor-secret-'.repeat(3);
export async function installCustomizationFixtureV1(
  database: { exec(sql: string): Promise<unknown> },
  sql: StudentPortalPostgresSqlV1,
) {
  await installAdminReadFixtureV2(database, sql);
  await database.exec(`INSERT INTO gradebook.professor(id,ano,nome) VALUES(827001,2026,'SYNTHETIC TEACHER');
    INSERT INTO gradebook.disciplina(id,ano,nome) VALUES(827001,2026,'MATEMATICA');
    INSERT INTO gradebook.oferta(id,ano,turma_id,professor_id,disciplina_id) VALUES(827001,2026,746001,827001,827001);
    INSERT INTO gradebook.fechamento(oferta_id,aluno_id,am1_fonte,am2_fonte,am3_fonte)
      SELECT 827001,746000+n,8000,9000,10000 FROM generate_series(1,106) n;`);
  for (const name of ['0008_atomic_publication_v2.sql', '0013_publication_inheritance_v1.sql'])
    await database.exec(readFileSync('migrations/student-portal/' + name, 'utf8'));
  await sql.unsafe('UPDATE student_portal.publication_control_v2 SET enabled=true');
}
export async function resetCustomizationFixtureV1(sql: StudentPortalPostgresSqlV1) {
  await sql.unsafe('DELETE FROM student_portal.publication_release_v2');
  await sql.unsafe('DELETE FROM student_portal.publication_auto_approval_v2');
  await sql.unsafe('DELETE FROM student_portal.publication');
  await sql.unsafe('DELETE FROM student_portal.audit_event');
  await sql.unsafe('DELETE FROM student_portal.operation_receipt');
  await sql.unsafe("DELETE FROM student_portal.setting WHERE scope_kind<>'school'");
  await sql.unsafe('UPDATE student_portal.account SET blocked=false');
  await sql.unsafe(
    "UPDATE student_portal.setting SET value_json='false'::jsonb WHERE field_key='autoUpdate'",
  );
  await sql.unsafe('UPDATE student_portal.publication_control_v2 SET enabled=true,version=1');
  await sql.unsafe('UPDATE gradebook.vinculo SET turma_id=746001 WHERE aluno_id=746001');
}
export function customizationApiV1(sql: StudentPortalPostgresSqlV1) {
  return new PortalAdminApiV1(sql, {
    tenantId: READ_TENANT_V2,
    cursorSecret: CUSTOM_CURSOR_SECRET_V1,
    scopedPublication: true,
    cryptoPort: new PortalCryptoV1(
      new Map([[1, new Uint8Array(32).fill(7)]]),
      new Map([[1, new Uint8Array(32).fill(8)]]),
    ),
    qrKeyVersion: 1,
    pepperVersion: 1,
  });
}
export async function releaseCustomizationV1(
  sql: StudentPortalPostgresSqlV1,
  scope: ScopeV1 = READ_SCHOOL_V2,
  period: 'T1' | 'T2' | 'T3' = 'T1',
  operation: 'publish' | 'unpublish' = 'publish',
) {
  const service = new ScopedPublicationServiceV2(sql);
  const current = await service.read(scope);
  return service.command(READ_ACTOR_V2, {
    contractVersion: 1,
    operation,
    scope,
    period,
    expectedVersion: current.version,
    idempotencyKey: crypto.randomUUID(),
    ...(operation === 'publish' ? { targetDataVersion: current.dataVersion } : { confirmed: true }),
  });
}
