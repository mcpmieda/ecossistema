import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { scopedSummaryV2 } from '../../../server/student-portal/publication/scoped-source-v2';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

// Minimal synthetic schema with only the relations the scoped summary reads (A7, A11).
const SCHEMA = `
CREATE SCHEMA student_portal;
CREATE TABLE student_portal.academic_student_v1(academic_year smallint,student_id integer);
CREATE TABLE student_portal.academic_binding_v1(academic_year smallint,student_id integer,class_id integer,status integer);
CREATE TABLE student_portal.account(id uuid,academic_year smallint,gradebook_student_id integer,closed_at timestamptz);
CREATE TABLE student_portal.publication_source_head_v2(academic_year smallint,generation char(32),revision numeric(20,0));
CREATE TABLE student_portal.publication_control_v2(academic_year smallint,enabled boolean,version bigint);
CREATE TABLE student_portal.academic_revision(academic_year smallint,academic_generation char(32),academic_counter numeric(20,0));
CREATE TABLE student_portal.publication_release_v2(scope_key text,scope_kind text,academic_year smallint,period text,
  target_revision text,version bigint,bound_class_id integer);
CREATE TABLE student_portal.publication(account_id uuid,period text,published_revision text);
CREATE TABLE student_portal.publication_auto_approval_v2(academic_year smallint,student_id integer,class_id integer,
  generation char(32),revision numeric(20,0));
CREATE TABLE student_portal.setting(scope_key text,field_key text,value_json jsonb);
CREATE TABLE student_portal.academic_class_v1(academic_year smallint,class_id integer,shift text);
CREATE TABLE student_portal.publication_source_v2(academic_year smallint,student_id integer,generation char(32),
  revision numeric(20,0),class_id integer,payload_json jsonb,period_mask integer);`;

const GENERATION = 'a'.repeat(32);
const account = (student: number) => `a7a11000-0000-4000-8000-${String(student).padStart(12, '0')}`;

/** One subject; `marks` holds the value of the first instrument of each trimester. */
function payload(marks: { t1: number; t2: number; t3: number }) {
  const instruments = ([1, 2, 3] as const).map((term) => ({
    id: 900 + term, term, slot: 1, maximum: term === 3 ? 40000 : 30000, label: null,
    value: term === 1 ? marks.t1 : term === 2 ? marks.t2 : marks.t3, observed: true,
  }));
  return {
    minimum_approval: 60000, assessment_names: {}, name: 'ESTUDANTE SINTETICO',
    offers: [{ offerId: 1, subjectId: 77, label: 'MATEMATICA', instruments,
      closure: { am1: marks.t1, am2: marks.t2, am3: marks.t3, rec1: null, rec2: null, rec3: null, nc: 0, rr: 0, annual: null } }],
  };
}

const pg = new PGlite();
const tx: StudentPortalPostgresQueryV1 = {
  async unsafe<R extends Record<string, unknown>>(query: string, values: unknown[] = []) {
    return (await pg.query<R>(query, [...values])).rows;
  },
} as StudentPortalPostgresQueryV1;

/** Students 1 (class 10) and 2 (class 11); T1, T2 and T3 released only for class 10 at revision 1. */
async function seed(newer: Record<number, ReturnType<typeof payload>>) {
  await pg.exec('DROP SCHEMA IF EXISTS student_portal CASCADE;' + SCHEMA);
  const base = payload({ t1: 20000, t2: 20000, t3: 14000 });
  await pg.query('INSERT INTO student_portal.publication_source_head_v2 VALUES(2026,$1,2)', [GENERATION]);
  await pg.query('INSERT INTO student_portal.academic_revision VALUES(2026,$1,2)', [GENERATION]);
  await pg.exec('INSERT INTO student_portal.publication_control_v2 VALUES(2026,true,5)');
  for (const [student, classId] of [[1, 10], [2, 11]] as const) {
    await pg.query('INSERT INTO student_portal.academic_student_v1 VALUES(2026,$1)', [student]);
    await pg.query('INSERT INTO student_portal.academic_binding_v1 VALUES(2026,$1,$2,1)', [student, classId]);
    await pg.query('INSERT INTO student_portal.account VALUES($1,2026,$2,NULL)', [account(student), student]);
    await pg.query('INSERT INTO student_portal.publication_source_v2 VALUES(2026,$1,$2,1,$3,$4,63)',
      [student, GENERATION, classId, JSON.stringify(base)]);
    const next = newer[student];
    if (next) await pg.query('INSERT INTO student_portal.publication_source_v2 VALUES(2026,$1,$2,2,$3,$4,63)',
      [student, GENERATION, classId, JSON.stringify(next)]);
  }
  for (const [index, period] of ['T1', 'T2', 'T3'].entries())
    await pg.query(`INSERT INTO student_portal.publication_release_v2 VALUES('class:2026:10','class',2026,$1,$2,$3,NULL)`,
      [period, `${GENERATION}:1`, index + 1]);
}

const item = (summary: Awaited<ReturnType<typeof scopedSummaryV2>>, period: string) =>
  summary.items.find((value) => value.period === period)!;

afterAll(async () => { await pg.close(); });

describe('A7: a period published for only some students of the scope', () => {
  beforeEach(async () => { await seed({}); });

  it('reports how many of the school are published and keeps it out of allPublished', async () => {
    const school = await scopedSummaryV2(tx, { kind: 'school', academicYear: 2026 });
    expect(item(school, 'T1')).toMatchObject({ state: 'published', publishedCount: 1, targetCount: 2 });
    expect(school.allPublished.has('T1')).toBe(false);
    expect(item(school, 'REC1')).toMatchObject({ publishedCount: 0, targetCount: 2, publishedRevision: null });
  });

  it('reports a fully published class as all of its students', async () => {
    const own = await scopedSummaryV2(tx, { kind: 'class', academicYear: 2026, classId: 10 });
    expect(item(own, 'T1')).toMatchObject({ state: 'published', publishedCount: 1, targetCount: 1 });
    expect(own.allPublished.has('T1')).toBe(true);
  });
});

describe('A11: "Há notas novas no Banco" only for the period whose marks changed', () => {
  it('a new 3º trimestre mark leaves the published 1º and 2º trimestres unchanged', async () => {
    await seed({ 1: payload({ t1: 20000, t2: 20000, t3: 30000 }) });
    const own = await scopedSummaryV2(tx, { kind: 'class', academicYear: 2026, classId: 10 });
    expect(item(own, 'T1').state).toBe('published');
    expect(item(own, 'T2').state).toBe('published');
    expect(item(own, 'T3').state).toBe('update-pending');
  });

  it('a changed 1º trimestre mark is still an update of the 1º trimestre', async () => {
    await seed({ 1: payload({ t1: 25000, t2: 20000, t3: 14000 }) });
    const own = await scopedSummaryV2(tx, { kind: 'class', academicYear: 2026, classId: 10 });
    expect(item(own, 'T1').state).toBe('update-pending');
    expect(item(own, 'T2').state).toBe('published');
  });

  it('a changed subject list counts for every trimester', async () => {
    const renamed = payload({ t1: 20000, t2: 20000, t3: 14000 });
    renamed.offers[0]!.label = 'MATEMATICA II';
    await seed({ 1: renamed });
    const own = await scopedSummaryV2(tx, { kind: 'class', academicYear: 2026, classId: 10 });
    expect(item(own, 'T1').state).toBe('update-pending');
    expect(item(own, 'T2').state).toBe('update-pending');
  });
});
