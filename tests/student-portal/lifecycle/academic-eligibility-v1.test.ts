// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AcademicEligibilityReaderPostgresV1 } from '../../../server/student-portal/integration/lifecycle/academic-eligibility-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';

let pg: PGlite;
let reader: AcademicEligibilityReaderPostgresV1;
const link = { academicYear: 2026 as const, studentId: 900001 };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(`
    INSERT INTO gradebook.ano_letivo (ano,minimo_aprovacao,max_componentes_conselho) VALUES (2026,60000,2);
    INSERT INTO gradebook.turma (id,ano,codigo,nome,etapa,turno)
      VALUES (900001,2026,'S1','TURMA SINTETICA UM',6,'TESTE'),
             (900002,2026,'S2','TURMA SINTETICA DOIS',6,'TESTE');
    INSERT INTO gradebook.aluno (id,ano,nome)
      VALUES (900001,2026,'PESSOA SINTETICA'),(900002,2026,'PESSOA SINTETICA');
    INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id)
      VALUES (2026,900001,1,900001);
  `);
  const sql: StudentPortalPostgresQueryV1 = {
    async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
      return (await pg.query<R>(query, [...parameters])).rows;
    },
  };
  reader = new AcademicEligibilityReaderPostgresV1(sql);
}, 30_000);

beforeEach(async () => {
  await pg.exec('DELETE FROM gradebook.vinculo; INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id) VALUES (2026,900001,1,900001)');
});

afterAll(async () => { await pg?.close(); });

describe('fresh eligibility from the private academic views', () => {
  it.each([null, 1, 2, 7])('allows supported current status %s', async (status) => {
    await pg.query('UPDATE gradebook.vinculo SET situacao=$1,turma_relacionada_id=$2 WHERE aluno_id=900001', [status, status === 7 ? 900002 : null]);
    expect(await reader.readCurrent(link)).toMatchObject({ state: 'eligible', classId: 900001 });
  });

  it.each([3, 4, 5])('observes exit %s without waiting for profile/publication jobs', async (status) => {
    await pg.query('UPDATE gradebook.vinculo SET situacao=$1,turma_relacionada_id=$2 WHERE aluno_id=900001', [status, status === 7 ? 900002 : null]);
    expect(await reader.readCurrent(link)).toMatchObject({ state: 'exit', classId: 900001 });
  });

  it('never substitutes a new ID with the same name', async () => {
    expect(await reader.readCurrent({ ...link, studentId: 900002 })).toMatchObject({ state: 'unresolved', classId: null });
    expect(await reader.readCurrent({ ...link, studentId: 999999 })).toMatchObject({ state: 'unresolved', classId: null });
  });

  it('excludes historical FOI PARA, resolves the new class and rejects ambiguous current links', async () => {
    await pg.exec(`UPDATE gradebook.vinculo SET situacao=6,turma_relacionada_id=900002 WHERE aluno_id=900001;
      INSERT INTO gradebook.vinculo (ano,turma_id,numero,aluno_id,situacao,turma_relacionada_id) VALUES (2026,900002,1,900001,7,900001);`);
    expect(await reader.readCurrent(link)).toMatchObject({ state: 'eligible', classId: 900002 });
    await expect(pg.exec('UPDATE gradebook.vinculo SET situacao=NULL,turma_relacionada_id=NULL WHERE aluno_id=900001')).rejects.toThrow('vinculo_um_corrente_por_aluno_uidx');
    await pg.exec('UPDATE gradebook.vinculo SET situacao=6,turma_relacionada_id=CASE WHEN turma_id=900001 THEN 900002 ELSE 900001 END WHERE aluno_id=900001');
    expect(await reader.readCurrent(link)).toMatchObject({ state: 'unresolved', classId: null });
  });

  it('reads using only the granted Portal role and fails closed if coordination is missing', async () => {
    await pg.exec('SET ROLE student_portal_app');
    try { expect(await reader.readCurrent(link)).toMatchObject({ state: 'eligible' }); }
    finally { await pg.exec('RESET ROLE'); }
    await pg.exec('DELETE FROM student_portal.academic_revision WHERE academic_year=2026');
    await expect(reader.readCurrent(link)).rejects.toThrow('student-portal-academic-revision-unavailable');
  });
});
