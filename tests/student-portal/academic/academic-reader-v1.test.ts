import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AcademicStudentReaderPostgresV1 } from '../../../server/student-portal/academic/academic-reader-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { ACADEMIC_FIXTURE_SQL_V1 } from './academic-fixture-v1';

let pg: PGlite;
let reader: AcademicStudentReaderPostgresV1;
let sql: StudentPortalPostgresQueryV1;
let count = 0;
let revision: string;
const link = { academicYear: 2026, studentId: 910001 } as const;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
  await installResetSchemaFixtureV1(pg);
  await pg.exec(ACADEMIC_FIXTURE_SQL_V1);
  sql = { async unsafe<R extends Record<string, unknown>>(query: string, parameters: readonly unknown[] = []) {
    count += 1;
    return (await pg.query<R>(query, [...parameters])).rows;
  } };
  reader = new AcademicStudentReaderPostgresV1(sql);
  revision = String((await pg.query<{ revision: string }>("SELECT academic_generation||':'||academic_counter::text AS revision FROM student_portal.academic_revision WHERE academic_year=2026")).rows[0]!.revision);
}, 30_000);
beforeEach(async () => {
  await pg.exec('BEGIN');
  count = 0;
});
// Rollback restores every synthetic case, including deleted instruments and link movements.
import { afterEach } from 'vitest';
afterEach(async () => { await pg.exec('ROLLBACK'); });
afterAll(async () => { await pg?.close(); });

describe('official academic snapshot and self allowlist', () => {
  it('classifies official and partial values from the same revision without rounding or changing AM/U', async () => {
    for (const [minimum, am1, expected] of [[60000,17999,false],[60000,18000,true],[75000,22499,false],[75000,22500,true]] as const) {
      await pg.query('UPDATE gradebook.ano_letivo SET minimo_aprovacao=$1 WHERE ano=2026', [minimum]);
      await pg.query('UPDATE gradebook.fechamento SET am1_fonte=$1 WHERE oferta_id=910001', [am1]);
      await pg.query("SELECT * FROM student_portal.record_gradebook_change_v1($1::uuid,2026::smallint,'academic-policy',true,ARRAY[910001],statement_timestamp())", [crypto.randomUUID()]);
      const current = (await pg.query<{ revision: string }>("SELECT academic_generation||':'||academic_counter::text AS revision FROM student_portal.academic_revision WHERE academic_year=2026")).rows[0]!.revision;
      count = 0;
      const result = await reader.readOfficialInTransaction(sql, link, current);
      expect(count).toBe(1);
      expect(result!.subjects[1]!.periods[0]!.final).toEqual({ kind: 'score', valueMilli: am1, maximumMilli: 30000, meetsMinimum: expected });
      expect(result!.subjects[1]!.officialAnnual).toEqual({ kind: 'score', valueMilli: 99000, maximumMilli: null, meetsMinimum: null });
      expect(result!.subjects[1]!.periods[1]!.final).toEqual({ kind: 'absent' });
      expect(result!.subjects[1]!.periods[2]!.final).toMatchObject({ valueMilli: 0, meetsMinimum: false });
      expect(await reader.readOfficial(link, revision)).toBeNull();
      for (const [value, classified] of [[5062,false],[5063,true]] as const) {
        if (minimum !== 75000) continue;
        await pg.query('UPDATE gradebook.nota SET valor=$1 WHERE aluno_id=910001 AND instrumento_id=(SELECT id FROM gradebook.instrumento WHERE oferta_id=910001 AND trimestre=1 AND slot=1)', [value]);
        await pg.query("SELECT * FROM student_portal.record_gradebook_change_v1($1::uuid,2026::smallint,'marks',true,ARRAY[910001],statement_timestamp())", [crypto.randomUUID()]);
        const partialRevision = (await pg.query<{ revision: string }>("SELECT academic_generation||':'||academic_counter::text AS revision FROM student_portal.academic_revision WHERE academic_year=2026")).rows[0]!.revision;
        const self = await reader.readOfficial(link, partialRevision);
        const partial = self!.subjects[1]!.periods[0]!.partials![0]!.mark;
        expect(partial).toEqual({ kind: 'score', value: value / 1000, maximum: 6.75, meetsMinimum: classified });
      }
    }
  });

  it('reads one snapshot in one query and preserves official AM/U, zero and absent values', async () => {
    const result = await reader.readOfficialInTransaction(sql, link, revision);
    expect(count).toBe(1);
    expect(result?.subjects.map((subject) => subject.label)).toEqual(['PORTUGUES', 'MATEMATICA']);
    expect(result?.subjects.map((subject) => subject.order)).toEqual([0, 1]);
    const math = result!.subjects[1]!;
    expect(math.periods[0]!.final).toMatchObject({ kind: 'score', valueMilli: 25000, maximumMilli: 30000 });
    expect(math.periods[1]!.final).toEqual({ kind: 'absent' });
    expect(math.periods[2]!.final).toMatchObject({ kind: 'score', valueMilli: 0 });
    expect(math.officialAnnual).toMatchObject({ kind: 'score', valueMilli: 99000, maximumMilli: null });
    expect(math.periods[0]!.partials![0]!.mark).toMatchObject({ kind: 'score', valueMilli: 0 });
    expect(math.periods.filter((period) => period.period.startsWith('REC')).map((period) => period.final.kind)).toEqual(['recovery-pending', 'recovery-pending', 'recovery-pending']);
  });

  it('projects only allowed self fields and does not expose internal annual or third-party facts', async () => {
    const result = await reader.readOfficial(link, revision);
    expect(count).toBe(1);
    expect(result?.profile).toMatchObject({ name: 'SYNTHETIC ACADEMIC ONE', classLabel: 'SYNTHETIC ACADEMIC CLASS', result: 'in-progress' });
    expect(result?.subjects[1]!.periods[0]!.final).toMatchObject({ value: 25, maximum: 30 });
    expect(JSON.stringify(result)).not.toMatch(/officialAnnual|classId|offerId|source|formula|weight|teacher|PRIVATE TEACHER|ACADEMIC OTHER|99000/);
  });

  it('preserves NC and RR in applicable recovery and gives RR precedence over a council approval', async () => {
    await pg.exec(`UPDATE gradebook.fechamento SET rec_nc_mask=1,rec_rr_mask=2,rec3=0 WHERE oferta_id=910001;
      INSERT INTO gradebook.conselho_decisao(aluno_id,decisao,justificativa,registrado_por) VALUES (910001,1,'SYNTHETIC ONLY','11111111-1111-4111-8111-111111111111');`);
    const result = await reader.readOfficialInTransaction(sql, link, revision);
    expect(result!.subjects[1]!.periods.slice(3).map((period) => period.final)).toEqual([
      { kind: 'nc' }, { kind: 'rr' }, { kind: 'score', valueMilli: 0, maximumMilli: 40000, meetsMinimum: false },
    ]);
    expect(result!.profile.result).toBe('failed');
    // R/R is exactly REPROVADO and overrides the Council approval.
    expect(result!.profile.annualSituation).toBe('failed-repeat');
  });

  it('ignores an old Council decision while the student does not go to the Council', async () => {
    // Recovery still pending: the student is not at the Council, so the decision does not show.
    await pg.exec("INSERT INTO gradebook.conselho_decisao(aluno_id,decisao,justificativa,registrado_por) VALUES (910001,2,'SYNTHETIC ONLY','11111111-1111-4111-8111-111111111111')");
    const pending = await reader.readOfficial(link, revision);
    expect(pending?.profile.result).not.toBe('failed');
    expect(pending?.profile.annualSituation).not.toBe('failed-by-council');
  });

  it('applies formal attendance decision only to regular/7 and keeps assisted without global outcome', async () => {
    // Zero in every applicable recovery: the student fails and goes to the Council.
    await pg.exec('UPDATE gradebook.fechamento SET rec1=0,rec2=0,rec3=0 WHERE aluno_id=910001');
    await pg.exec("INSERT INTO gradebook.conselho_decisao(aluno_id,decisao,justificativa,registrado_por) VALUES (910001,3,'SYNTHETIC ONLY','11111111-1111-4111-8111-111111111111')");
    expect((await reader.readOfficial(link, revision))?.profile).toMatchObject({ result: 'failed-attendance', annualSituation: 'failed-by-absence' });
    await pg.exec('UPDATE gradebook.vinculo SET situacao=7,turma_relacionada_id=910002 WHERE aluno_id=910001');
    expect((await reader.readOfficial(link, revision))?.profile.result).toBe('failed-attendance');
    await pg.exec('UPDATE gradebook.vinculo SET situacao=2,turma_relacionada_id=NULL WHERE aluno_id=910001');
    const assisted = await reader.readOfficial(link, revision);
    expect(assisted?.profile).toMatchObject({ result: 'not-applicable', academicState: 'assisted' });
    expect(assisted?.profile).not.toHaveProperty('annualSituation');
    expect(assisted?.subjects.some((subject) => subject.annualSituation !== undefined)).toBe(false);
    await pg.exec('UPDATE gradebook.vinculo SET situacao=1 WHERE aluno_id=910001');
    expect((await reader.readOfficial(link, revision))?.profile).toMatchObject({ result: 'approved', academicState: 'special', annualSituation: 'approved-special' });
  });

  it('uses instrument-wide activity evidence without returning another student mark or inventing a maximum', async () => {
    await pg.exec(`INSERT INTO gradebook.instrumento(id,oferta_id,trimestre,slot,maximo,descricao) VALUES
      (919001,910001,1,12,NULL,'2'),(919002,910001,1,13,NULL,'3');
      INSERT INTO gradebook.nota(instrumento_id,aluno_id,valor) VALUES (919001,910002,17001);`);
    const result = await reader.readOfficialInTransaction(sql, link, revision);
    const partials = result!.subjects[1]!.periods[0]!.partials!;
    expect(partials.find((item) => item.assessmentId === 919001)?.mark).toEqual({ kind: 'absent' });
    expect(partials.some((item) => item.assessmentId === 919002)).toBe(false);
    expect(JSON.stringify(result)).not.toContain('17001');
    await pg.exec('INSERT INTO gradebook.nota(instrumento_id,aluno_id,valor) VALUES (919001,910001,0)');
    const updated = await reader.readOfficialInTransaction(sql, link, revision);
    expect(updated!.subjects[1]!.periods[0]!.partials!.find((item) => item.assessmentId === 919001)?.mark)
      .toEqual({ kind: 'score', valueMilli: 0, maximumMilli: null, meetsMinimum: null });
  });

  it('omits nonapplicable recovery even when a source value exists', async () => {
    await pg.exec(`UPDATE gradebook.nota n SET valor=i.maximo FROM gradebook.instrumento i WHERE n.instrumento_id=i.id AND n.aluno_id=910001;
      UPDATE gradebook.fechamento SET rec1=1000;`);
    const result = await reader.readOfficial(link, revision);
    expect(result!.subjects.every((subject) => subject.periods.length === 3)).toBe(true);
    expect(result!.profile.result).toBe('approved');
  });

  it('fails closed for stale revisions, wrong year/id and current exit or historical-only bindings', async () => {
    expect(await reader.readOfficial(link, `${'a'.repeat(32)}:999`)).toBeNull();
    expect(await reader.readOfficial({ ...link, studentId: 919999 }, revision)).toBeNull();
    await expect(reader.readOfficial({ academicYear: 2025, studentId: 910001 } as unknown as typeof link, revision)).rejects.toThrow();
    for (const status of [3, 4, 5, 6]) {
      await pg.exec(`UPDATE gradebook.vinculo SET situacao=${status},turma_relacionada_id=${status === 6 ? '910002' : 'NULL'} WHERE aluno_id=910001`);
      expect(await reader.readOfficial(link, revision)).toBeNull();
    }
  });

  it('uses the current class after a move and rejects ambiguous bindings', async () => {
    await pg.exec(`UPDATE gradebook.vinculo SET turma_id=910002 WHERE aluno_id=910001`);
    expect(await reader.readOfficial(link, revision)).toMatchObject({ profile: { classLabel: 'SYNTHETIC NEXT CLASS' }, subjects: [] });
    // Only this disposable rollback transaction simulates a corrupted pre-constraint snapshot.
    await pg.exec('DROP INDEX gradebook.vinculo_um_corrente_por_aluno_uidx; INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,910001,3,910001)');
    expect(await reader.readOfficial(link, revision)).toBeNull();
  });

  it('rejects a second offer for the same subject instead of merging identities or truncating', async () => {
    await pg.exec(`INSERT INTO gradebook.professor(id,ano,nome) VALUES (919999,2026,'SYNTHETIC OTHER TEACHER');
      INSERT INTO gradebook.oferta(id,ano,turma_id,professor_id,disciplina_id) VALUES (919999,2026,910001,919999,910001);`);
    await expect(reader.readOfficial(link, revision)).rejects.toThrow();
  });

  it('preserves all thirteen legitimate partials, including parallel recovery and ten qualitative activities', async () => {
    await pg.exec(`INSERT INTO gradebook.instrumento(id,oferta_id,trimestre,slot,maximo,descricao)
      SELECT 920000+s,910001,1,s,1000,'SYNTHETIC EXTRA '||s FROM generate_series(12,20) s;
      INSERT INTO gradebook.instrumento(id,oferta_id,trimestre,slot,maximo,descricao) VALUES (920003,910001,1,3,13500,'SYNTHETIC PARALLEL');`);
    const result = await reader.readOfficial(link, revision);
    const partials = result?.subjects.find((subject) => subject.subjectId === 910001)?.periods[0]?.partials;
    expect(partials).toHaveLength(13);
    expect(new Set(partials?.map((partial) => partial.assessmentId)).size).toBe(13);
    expect(partials?.find((partial) => partial.assessmentId === 920003)?.label).toBe('SYNTHETIC PARALLEL');
    for (let slot = 12; slot <= 20; slot++)
      expect(partials?.some((partial) => partial.assessmentId === 920000 + slot)).toBe(true);
    expect(count).toBe(1);
  });

  it('does not fabricate a term engine result when required assessment maximums are unavailable', async () => {
    await pg.exec('UPDATE gradebook.instrumento SET maximo=NULL WHERE oferta_id=910001 AND trimestre=2 AND slot=1');
    await expect(reader.readOfficial(link, revision)).rejects.toThrow('AV1 and AV2 must exist with positive maximums');
  });
});
