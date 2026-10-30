import { readFileSync } from 'node:fs';

/** Empty disposable databases only. All people and devices below are synthetic. */
export function frequencySyntheticSetupSqlV2(): string[] {
  const validity = readFileSync('migrations/attendance/0002_runtime_bridges_v2.sql', 'utf8').match(
    /CREATE FUNCTION gradebook\.reconciliation_evidence_valid_v2[\s\S]*?\$\$;/u,
  )?.[0];
  if (!validity) throw new Error('frequency-central-validity-function-missing');
  return [
    readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'),
    `CREATE ROLE gradebook_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
   CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE student_portal_app;
   CREATE TABLE gradebook.student_identity(id uuid PRIMARY KEY);
   ALTER TABLE gradebook.aluno ADD COLUMN student_uid uuid REFERENCES gradebook.student_identity(id);
   CREATE VIEW gradebook.student_presentation_v1 WITH(security_invoker=true) AS SELECT id AS student_id,ano AS academic_year,nome AS name FROM gradebook.aluno;
   CREATE SCHEMA student_portal;
   CREATE TABLE student_portal.frequency_test_coordination(year smallint PRIMARY KEY,counter bigint DEFAULT 0);
   CREATE FUNCTION student_portal.ensure_year_coordination_v1(smallint) RETURNS void LANGUAGE sql AS $$ INSERT INTO student_portal.frequency_test_coordination(year) VALUES($1) ON CONFLICT DO NOTHING $$;
   CREATE TABLE gradebook.student_reconciliation_scope_v1(academic_year smallint PRIMARY KEY,revision bigint);
   CREATE TABLE gradebook.student_report_class_v1(id uuid PRIMARY KEY,academic_year smallint,label text,class_key text,shift_key text,gradebook_class_id integer,review_required boolean DEFAULT false,version bigint DEFAULT 1);
   CREATE TABLE gradebook.student_source_record_v1(id uuid PRIMARY KEY,academic_year smallint,review_required boolean DEFAULT false);
   CREATE TABLE gradebook.student_source_observation_v1(id uuid PRIMARY KEY,academic_year smallint,source_id uuid,report_class_id uuid,name_key text,inep_key text,birth_date date,filiation1_key text,enrolled_at date,transferred_at date);
   CREATE TABLE gradebook.student_source_link_v1(source_id uuid,academic_year smallint,student_uid uuid,review_required boolean DEFAULT false);
   CREATE SCHEMA collector_auth;
   CREATE TABLE collector_auth.frequency_test_device(device_id uuid PRIMARY KEY,tenant_id uuid,actor_id uuid,generation bigint DEFAULT 1,key_thumbprint text DEFAULT 'synthetic-key',revoked_at timestamptz,grant_state text DEFAULT 'active');
   CREATE VIEW collector_auth.device_public_v2 WITH(security_invoker=true) AS SELECT device_id,tenant_id,actor_id,generation,revoked_at,grant_state FROM collector_auth.frequency_test_device;
   CREATE FUNCTION collector_auth.lock_active_device_v2(uuid,uuid,uuid,bigint,text) RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE r record;BEGIN SELECT * INTO r FROM collector_auth.frequency_test_device WHERE device_id=$1 FOR UPDATE;RETURN r.tenant_id=$2 AND r.actor_id=$3 AND r.generation=$4 AND r.key_thumbprint=$5 AND r.revoked_at IS NULL AND r.grant_state='active';END $$;
   CREATE FUNCTION collector_auth.revoke_device_admin_v2(uuid,uuid,uuid) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN UPDATE collector_auth.frequency_test_device SET revoked_at=clock_timestamp() WHERE device_id=$1 AND tenant_id=$2;RETURN FOUND;END $$;
   GRANT USAGE ON SCHEMA gradebook,student_portal,collector_auth TO gradebook_app;
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA gradebook,student_portal,collector_auth TO gradebook_app;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA student_portal,collector_auth TO gradebook_app;`,
    readFileSync('migrations/attendance/0001_frequency_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0005_operations_trail_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0006_receipt_retention_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0007_superseded_evidence_pruning_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0009_traceable_evidence_pruning_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0010_class_schedule_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0014_incidents_v2.sql', 'utf8'),
    readFileSync('migrations/attendance/0015_student_report_v2.sql', 'utf8'),
    `${validity} REVOKE ALL ON FUNCTION gradebook.reconciliation_evidence_valid_v2(smallint,uuid,integer,jsonb,jsonb) FROM PUBLIC; GRANT EXECUTE ON FUNCTION gradebook.reconciliation_evidence_valid_v2(smallint,uuid,integer,jsonb,jsonb) TO gradebook_app;`,
    `CREATE FUNCTION attendance.record_reset_write_v2(smallint) RETURNS text LANGUAGE sql AS $$ UPDATE student_portal.frequency_test_coordination SET counter=counter+1 WHERE year=$1 RETURNING 'frequency:'||counter::text $$;
   REVOKE ALL ON FUNCTION attendance.record_reset_write_v2(smallint) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION attendance.record_reset_write_v2(smallint) TO gradebook_app;`,
  ];
}
export const FREQUENCY_SYNTHETIC_SEED_SQL_V2 = `
TRUNCATE attendance.school_state_v2,attendance.device_status_v2,attendance.class_state_v2,attendance.batch_v2,attendance.source_row_v2,attendance.coverage_v2,attendance.source_mark_v2,attendance.occurrence_v2,attendance.origin_v2,attendance.conflict_v2,attendance.correction_v2,attendance.receipt_v2,attendance.retired_request_v2,attendance.failure_v2,attendance.pruned_origin_v2,attendance.prune_run_v2,attendance.schedule_state_v2,attendance.schedule_version_v2,attendance.incident_ack_v2,attendance.incident_state_v2,attendance.incident_v2,attendance.incident_version_v2,attendance.student_report_state_v2;
TRUNCATE gradebook.student_source_link_v1,gradebook.student_source_observation_v1,gradebook.student_source_record_v1,gradebook.student_report_class_v1,gradebook.student_reconciliation_scope_v1;
DELETE FROM gradebook.vinculo;DELETE FROM gradebook.aluno;DELETE FROM gradebook.turma;DELETE FROM gradebook.ano_letivo;DELETE FROM gradebook.student_identity;
TRUNCATE collector_auth.frequency_test_device,student_portal.frequency_test_coordination;
INSERT INTO gradebook.ano_letivo VALUES(2026,60000,3);
INSERT INTO gradebook.student_identity VALUES('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
INSERT INTO gradebook.aluno(id,ano,nome,student_uid) VALUES(1,2026,'ALUNA SINTETICA UM','10000000-0000-4000-8000-000000000001'),(2,2026,'ALUNO SINTETICO DOIS','10000000-0000-4000-8000-000000000002');
INSERT INTO gradebook.turma(id,ano,codigo,nome,etapa,turno) VALUES(101,2026,'6A','TURMA SINTETICA A',6,'M'),(102,2026,'6B','TURMA SINTETICA B',6,'M');
INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) VALUES(2026,101,1,1),(2026,101,2,2);
INSERT INTO gradebook.student_reconciliation_scope_v1 VALUES(2026,1);
INSERT INTO gradebook.student_report_class_v1(id,academic_year,label,class_key,shift_key,gradebook_class_id) VALUES('40000000-0000-4000-8000-000000000001',2026,'6A','6A','MATUTINO',101),('40000000-0000-4000-8000-000000000002',2026,'6B','6B','MATUTINO',102);
INSERT INTO gradebook.student_source_record_v1(id,academic_year) VALUES('50000000-0000-4000-8000-000000000001',2026),('50000000-0000-4000-8000-000000000002',2026);
INSERT INTO gradebook.student_source_observation_v1(id,academic_year,source_id,report_class_id,name_key,birth_date,enrolled_at) VALUES
('60000000-0000-4000-8000-000000000001',2026,'50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','ALUNA SINTETICA UM','2014-01-01','2026-01-01'),
('60000000-0000-4000-8000-000000000002',2026,'50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','ALUNO SINTETICO DOIS','2014-02-01','2026-01-01');
INSERT INTO gradebook.student_source_link_v1(source_id,academic_year,student_uid) VALUES('50000000-0000-4000-8000-000000000001',2026,'10000000-0000-4000-8000-000000000001'),('50000000-0000-4000-8000-000000000002',2026,'10000000-0000-4000-8000-000000000002');
INSERT INTO collector_auth.frequency_test_device(device_id,tenant_id,actor_id) VALUES('30000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001'),('30000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001');`;
