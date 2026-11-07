import type { CurrentGradebookRecoveryQueryV1 } from '../gradebook/recovery/current-gradebook-schema-v1.ts';
import { GRADEBOOK_CURRENT_TABLES_V1 } from '../gradebook/recovery/current-gradebook-schema-v1.ts';

/** Exact Gradebook catalog after the existing foundation and the cross-module identity migration. */
const STUDENT_IDENTITY_GRADEBOOK_CATALOG_V1 = {
  tables: 31, columns: 254, constraints: 227, indexes: 73,
  foreignKeys: 53, sequences: 13, functions: 6, triggers: 5,
} as const;

/** Owner-side recovery/postflight assertion, not a runtime endpoint or permission grant. */
export async function assertStudentIdentitySchemaV1(sql: CurrentGradebookRecoveryQueryV1): Promise<void> {
  const rows = Array.from(await sql.unsafe(`SELECT
    (SELECT count(*) FROM pg_tables WHERE schemaname='gradebook')::integer AS tables,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='gradebook')::integer AS columns,
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='gradebook' AND c.contype<>'n')::integer AS constraints,
    (SELECT count(*) FROM pg_indexes WHERE schemaname='gradebook')::integer AS indexes,
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='gradebook' AND c.contype='f')::integer AS "foreignKeys",
    (SELECT count(*) FROM pg_sequences WHERE schemaname='gradebook')::integer AS sequences,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='gradebook')::integer AS functions,
    (SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname='gradebook' AND NOT t.tgisinternal)::integer AS triggers`));
  if (rows.length !== 1) throw new Error('student-identity-catalog-missing');
  for (const [key, expected] of Object.entries(STUDENT_IDENTITY_GRADEBOOK_CATALOG_V1)) {
    if (rows[0]![key] !== expected) throw new Error(`student-identity-catalog-${key}-mismatch`);
  }
  const names = Array.from(await sql.unsafe("SELECT tablename FROM pg_tables WHERE schemaname='gradebook' ORDER BY tablename"));
  const expectedNames = new Set<string>([...GRADEBOOK_CURRENT_TABLES_V1, 'student_identity']);
  if (names.length !== expectedNames.size
    || names.some(row => typeof row.tablename !== 'string' || !expectedNames.has(row.tablename))) {
    throw new Error('student-identity-table-set-mismatch');
  }
  const checks = Array.from(await sql.unsafe(`SELECT
    NOT EXISTS (SELECT 1 FROM gradebook.aluno WHERE student_uid IS NULL) AS students_complete,
    NOT EXISTS (SELECT 1 FROM student_portal.account WHERE student_uid IS NULL) AS accounts_complete,
    NOT EXISTS (SELECT 1 FROM student_portal.account a JOIN gradebook.aluno s
      ON s.id=a.gradebook_student_id AND s.ano=a.academic_year WHERE a.student_uid<>s.student_uid) AS links_match,
    (SELECT relrowsecurity FROM pg_class WHERE oid='gradebook.student_identity'::regclass) AS private_registry,
    NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('gradebook.aluno'::regclass,'aluno_student_uid_fk_v1','gradebook.student_identity'::regclass,
          ARRAY['student_uid']::text[],ARRAY['id']::text[]),
        ('student_portal.account'::regclass,'account_student_uid_fk_v1','gradebook.student_identity'::regclass,
          ARRAY['student_uid']::text[],ARRAY['id']::text[]),
        ('student_portal.account'::regclass,'account_academic_identity_fk_v1','gradebook.aluno'::regclass,
          ARRAY['gradebook_student_id','academic_year','student_uid']::text[],ARRAY['id','ano','student_uid']::text[])
      ) AS required(relation_id,constraint_name,target_id,keys,target_keys)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid=required.relation_id AND c.conname=required.constraint_name
          AND c.contype='f' AND c.convalidated AND c.confrelid=required.target_id
          AND c.confupdtype='r' AND c.confdeltype='r' AND NOT c.condeferrable
          AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,position)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.position)=required.keys
          AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum,position)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.position)=required.target_keys
      )
    ) AS validated,
    NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('gradebook.aluno'::regclass,'aluno_00_student_uid_input_v1','gradebook.guard_student_uid_input_v1()',7,false),
        ('gradebook.aluno'::regclass,'aluno_student_uid_v1','gradebook.assign_student_uid_v1()',23,true),
        ('student_portal.account'::regclass,'account_00_student_uid_input_v1','student_portal.guard_student_uid_input_v1()',7,false),
        ('student_portal.account'::regclass,'account_student_uid_v1','student_portal.assign_student_uid_v1()',23,true)
      ) AS required(relation_id,trigger_name,function_name,trigger_type,security_definer)
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=required.relation_id AND t.tgname=required.trigger_name
          AND t.tgfoid=to_regprocedure(required.function_name) AND t.tgtype=required.trigger_type
          AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgqual IS NULL
          AND p.prosecdef=required.security_definer AND p.proconfig @> ARRAY['search_path=pg_catalog'])
    ) AS identity_triggers_enforced,
    NOT EXISTS (SELECT 1 FROM information_schema.table_privileges WHERE table_schema='gradebook'
      AND table_name='student_identity' AND grantee IN ('PUBLIC','anon','authenticated')) AS no_public_acl,
    NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('gradebook_app','student_portal_app','anon','authenticated')
      AND (has_table_privilege(r.oid,'gradebook.student_identity','INSERT')
        OR has_table_privilege(r.oid,'gradebook.student_identity','UPDATE')
        OR has_table_privilege(r.oid,'gradebook.student_identity','DELETE')
        OR has_table_privilege(r.oid,'gradebook.student_identity','TRUNCATE')
        OR has_function_privilege(r.oid,'gradebook.assign_student_uid_v1()','EXECUTE')
        OR has_function_privilege(r.oid,'student_portal.assign_student_uid_v1()','EXECUTE')
        OR has_function_privilege(r.oid,'gradebook.guard_student_uid_input_v1()','EXECUTE')
        OR has_function_privilege(r.oid,'student_portal.guard_student_uid_input_v1()','EXECUTE'))) AS no_runtime_identity_writes`));
  if (checks.length !== 1 || Object.values(checks[0]!).some(value => value !== true)) {
    throw new Error('student-identity-postflight-invariant-failed');
  }
}
