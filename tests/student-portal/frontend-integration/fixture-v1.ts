import { openSyntheticSchoolV1 } from '../academic/open-school-fixture-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { ACADEMIC_FIXTURE_SQL_V1 } from '../academic/academic-fixture-v1';
import { installShiftReadViewFixtureV1 } from '../year-reset/schema-fixture';

/** New synthetic namespace on each run; lives only in the disposable cluster. */
export async function installIntegrationFixtureV1(sql: ReturnType<typeof postgres>) {
  await installShiftReadViewFixtureV1({
    exec: (query) => sql.unsafe(query, [], { prepare: false }),
  });
  await openSyntheticSchoolV1(sql as unknown as StudentPortalPostgresSqlV1);
  // Scoped V2 is the only publisher; the fixture is activated below, as in production.
  const migration = await sql.unsafe(
    "SELECT to_regclass('student_portal.publication_control_v2') IS NOT NULL AS installed",
  );
  if (migration[0]!.installed !== true) {
    for (const file of ['0008_atomic_publication_v2.sql', '0009_publication_cutover_guard_v2.sql'])
      await sql.unsafe(readFileSync('migrations/student-portal/' + file, 'utf8'), [], {
        prepare: false,
      });
  }
  const live = await sql.unsafe(
    "SELECT to_regclass('student_portal.live_event_outbox_v1') IS NOT NULL AS installed",
  );
  if (!live[0]!.installed)
    await sql.unsafe(
      readFileSync('migrations/student-portal/0011_live_event_outbox_v1.sql', 'utf8'),
      [],
      { prepare: false },
    );
  for (const [table, column, file] of [
    ['audit_event', 'actor_name', '0016_audit_entities_v1.sql'],
    ['live_event_outbox_v1', 'security_relevant', '0017_security_event_priority_v1.sql'],
  ]) {
    const found = await sql.unsafe(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='student_portal' AND table_name=$1 AND column_name=$2",
      [table!, column!],
    );
    if (!found.length)
      await sql.unsafe(readFileSync('migrations/student-portal/' + file, 'utf8'), [], {
        prepare: false,
      });
  }
  // A deterministic free range avoids colliding with runtime fixtures or a prior local QA run.
  const rows = await sql.unsafe(`SELECT GREATEST(
    (SELECT COALESCE(max(id),0) FROM gradebook.turma),
    (SELECT COALESCE(max(id),0) FROM gradebook.aluno),
    (SELECT COALESCE(max(id),0) FROM gradebook.professor),
    (SELECT COALESCE(max(id),0) FROM gradebook.disciplina),
    (SELECT COALESCE(max(id),0) FROM gradebook.oferta),
    (SELECT COALESCE(max(id),0) FROM gradebook.instrumento))::text AS max_id`);
  const base = Math.ceil(Math.max(10_000_000, Number(rows[0]!.max_id)) / 1000) * 1000 + 1000;
  if (!Number.isSafeInteger(base) || base + 500 > 2_147_483_647)
    throw new Error('Disposable fixture namespace exhausted');
  const classId = base + 1;
  const prefix = 'SYNTHETIC P757 ' + base;
  await sql.begin((tx) =>
    tx.unsafe(
      ACADEMIC_FIXTURE_SQL_V1.replaceAll('910002', String(base + 2))
        .replaceAll('910001', String(base + 1))
        .replaceAll('910000', String(base))
        .replaceAll("'S710'", "'I757-" + base + "'")
        .replaceAll("'S712'", "'E757-" + base + "'")
        .replaceAll('SYNTHETIC ACADEMIC CLASS', prefix + ' CLASS')
        .replaceAll('SYNTHETIC NEXT CLASS', prefix + ' EMPTY')
        .replaceAll('SYNTHETIC ACADEMIC ONE', prefix + ' ONE')
        .replaceAll('SYNTHETIC PRIVATE TEACHER', prefix + ' TEACHER')
        .replaceAll("'MATEMATICA'", "'" + prefix + " MATH'")
        .replaceAll("'PORTUGUES'", "'" + prefix + " LANGUAGE'")
        .replaceAll('SYNTHETIC ACADEMIC OTHER', prefix + ' OTHER'),
    ),
  );
  // Like a real import: the recorded change prepares the edition an administrator can release.
  await sql.unsafe(
    "SELECT * FROM student_portal.record_gradebook_change_v1(gen_random_uuid(),2026::smallint,'marks',true,ARRAY[$1::integer,$2::integer],statement_timestamp())",
    [base + 1, base + 2],
  );
  await sql.unsafe('SELECT student_portal.activate_scoped_publication_v2()');
  return {
    classId,
    emptyClassId: base + 2,
    studentId: base + 1,
    otherStudentId: base + 2,
    prefix,
    scope: { kind: 'class', academicYear: 2026, classId } as const,
  };
}
