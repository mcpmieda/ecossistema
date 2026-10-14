import { readFileSync } from 'node:fs';

/** Used only in empty, disposable test databases, never as a migration. */
export function attendanceSyntheticSetupSqlV1(): string[] {
  return [
    readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'),
    `CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE student_portal_app;
    CREATE TABLE gradebook.student_identity (id uuid PRIMARY KEY);
    ALTER TABLE gradebook.aluno ADD COLUMN student_uid uuid REFERENCES gradebook.student_identity(id);
    GRANT USAGE ON SCHEMA gradebook TO gradebook_app;
    GRANT SELECT,UPDATE ON gradebook.aluno,gradebook.turma,gradebook.vinculo TO gradebook_app;
    GRANT SELECT ON gradebook.student_identity TO gradebook_app;
    INSERT INTO gradebook.ano_letivo VALUES (2026,60000,3),(2027,60000,3);
    INSERT INTO gradebook.student_identity VALUES
      ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
    INSERT INTO gradebook.aluno(id,ano,nome,student_uid) VALUES
      (1,2026,'ALUNA SINTÉTICA UM','10000000-0000-4000-8000-000000000001'),
      (2,2026,'ALUNO SINTÉTICO DOIS','10000000-0000-4000-8000-000000000002');
    INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES
      (101,2026,'6A','TURMA SINTETICA A',6,'M'),(102,2026,'6B','TURMA SINTETICA B',6,'M'),
      (201,2027,'6A','TURMA SINTETICA OUTRO ANO',6,'M');
    INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES (2026,101,1,1),(2026,101,2,2);`,
    readFileSync('docs/attendance/schema-v1.sql', 'utf8'),
  ];
}

export const ATTENDANCE_SYNTHETIC_RESET_SQL_V1 = `
  TRUNCATE attendance.scope,attendance.configuration,attendance.calendar,attendance.enrollment,
    attendance.batch,attendance.source_record,attendance.coverage,attendance.mark,attendance.decision,attendance.receipt;
  UPDATE gradebook.aluno SET nome=CASE id WHEN 1 THEN 'ALUNA SINTÉTICA UM' ELSE 'ALUNO SINTÉTICO DOIS' END;
  UPDATE gradebook.vinculo SET turma_id=101,situacao=NULL,turma_relacionada_id=NULL WHERE ano=2026;`;
