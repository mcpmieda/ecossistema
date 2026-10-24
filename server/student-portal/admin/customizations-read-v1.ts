import { z } from 'zod';
import { customizationsResponseV1 } from '../../../shared/student-portal-contracts/customizations-v1';
import { completeStoredPolicyValueV1, settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { versionV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { AdminReadQueryV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import type { StudentPortalPostgresQueryV1 } from '../persistence/postgres-persistence-v1';
import { PARENT_RELEASE_KEYS_V1, SCHOOL_RELEASE_KEYS_V1, releaseSelectionSqlV1 } from '../publication/release-selection-v1';
import { scopedKeyV2 } from '../publication/scoped-source-v2';
import type { AdminCursorV1 } from './cursor-v1';
import { ACCOUNT_JOIN_V1 } from './queries-v1';

/** Source-code aliases only. Values from a request always use bound parameters. */
const source = (alias: string) => `CASE WHEN ${alias}.scope_key IS NULL THEN NULL
  WHEN ${alias}.scope_kind='school' THEN jsonb_build_object('kind','school','academicYear',2026)
  WHEN ${alias}.scope_kind='class' THEN jsonb_build_object('kind','class','academicYear',2026,'classId',${alias}.class_id)
  WHEN ${alias}.scope_kind='shift' THEN jsonb_build_object('kind','shift','academicYear',2026,'shift',split_part(${alias}.scope_key,':',3))
  ELSE jsonb_build_object('kind','account','academicYear',2026,'accountId',${alias}.account_id::text) END`;
const normalizedOption = (alias: string) => `CASE WHEN ${alias}.field_key='calendar'
  THEN ${alias}.value_json||jsonb_build_object('t2StartsAt',COALESCE(${alias}.value_json->'t2StartsAt','null'::jsonb),
    't3StartsAt',COALESCE(${alias}.value_json->'t3StartsAt','null'::jsonb)) ELSE ${alias}.value_json END`;

/** Two read statements in the dispatcher's repeatable-read transaction, independent of
 * population size. Filter actual differences BEFORE pagination; do not load each student's
 * publication endpoint, infer origin from legacy snapshots, or query marks here. */
export async function readCustomizationsV1(tx: StudentPortalPostgresQueryV1, query: AdminReadQueryV2,
  actor: string, requestId: string, now: Date, cursor: AdminCursorV1) {
  if (query.operation !== 'customizations-read') throw new Error('student-portal-cursor-invalid-request');
  const after = await cursor.read(query, actor, now);
  if (after?.at) throw new Error('student-portal-cursor-invalid-request');
  const metadata = await tx.unsafe(`SELECT c.version::text,c.enabled,h.generation,h.revision::text,
    (SELECT jsonb_object_agg(field_key,value_json) FROM student_portal.setting WHERE scope_key='school:2026') AS defaults,
    (SELECT min(version)::text FROM student_portal.setting WHERE scope_key='school:2026') AS epoch,
    (SELECT count(DISTINCT version)::integer FROM student_portal.setting WHERE scope_key='school:2026') AS epochs
    FROM student_portal.publication_control_v2 c
    JOIN student_portal.publication_source_head_v2 h USING(academic_year)
    JOIN student_portal.academic_revision r ON r.academic_year=h.academic_year
      AND r.academic_generation=h.generation AND r.academic_counter=h.revision
    WHERE c.academic_year=2026`);
  if (metadata.length !== 1 || metadata[0]!.enabled !== true || metadata[0]!.epochs !== 1)
    throw new Error('student-portal-preparation-unavailable');
  const meta = metadata[0]!;
  // Tolerates a school snapshot stored before migration 0020 (#1132): missing optional fields read as defaults.
  const schoolDefaults = settingsValueV1.parse(completeStoredPolicyValueV1(meta.defaults));
  const publicationVersion = versionV1.parse(Number(meta.version));
  const epoch = versionV1.parse(Number(meta.epoch));
  const generation = z.string().regex(/^[a-f0-9]{32}$/u).parse(meta.generation);
  const headRevision = z.string().regex(/^[1-9]\d{0,19}$/u).parse(meta.revision);
  const args: unknown[] = [generation, headRevision, epoch, publicationVersion];
  const bind = (value: unknown) => { args.push(value); return `$${args.length}`; };
  const defaults = bind(JSON.stringify(schoolDefaults));
  const targetKey = query.scope.kind === 'school' ? null : scopedKeyV2(query.scope);
  const contextKey = bind(targetKey);
  const contextOwner = query.scope.kind === 'school' ? '' : `UNION SELECT ${contextKey}::text,
    ${bind(query.scope.kind)}::text,${bind(query.scope.kind === 'class' ? query.scope.classId : null)}::integer,
    ${bind(query.scope.kind === 'account' ? query.scope.accountId : null)}::uuid`;
  const where = ['s.resolved', "(s.value IS NOT NULL OR s.blocked OR jsonb_array_length(s.publications)>0)"];
  if (query.scope.kind === 'class') where.push(`s.class_id=${bind(query.scope.classId)}`);
  if (query.scope.kind === 'account') where.push(`s.scope_key=${contextKey}`);
  if (query.nameSearch !== undefined)
    where.push(`position(lower(${bind(query.nameSearch)}) in lower(s.label||' '||s.class_label))>0`);
  if (after) where.push(`s.scope_key COLLATE "C">${bind(after.id)} COLLATE "C"`);
  const limit = bind(query.page.limit + 1);
  // Turnos (28/09/2026): an account's own choice, then its shift, then its class, then the school;
  // for a class, its shift wins over the class's own choice.
  const auto = `CASE WHEN t.scope_kind='account'
    THEN COALESCE(oa.value_json,sha.value_json,ca.value_json,sa.value_json,'false'::jsonb)
    ELSE COALESCE(sha.value_json,oa.value_json,sa.value_json,'false'::jsonb) END='true'::jsonb`;
  const approved = (alias: string, school = false) => `CASE
    WHEN ${alias}.target_revision IS NULL OR split_part(${alias}.target_revision,':',1)<>$1 THEN NULL
    ELSE $1||':'||GREATEST(split_part(${alias}.target_revision,':',2)::numeric,
      ${school ? '0' : 'COALESCE(automatic.revision,0)'},
      CASE WHEN ${school ? "COALESCE(sa.value_json,'false'::jsonb)='true'::jsonb" : auto}
        THEN $2::numeric ELSE 0 END)::text END`;
  const choice = (alias: string, revision: string) => `jsonb_build_object('source',${source(alias)},'revision',${revision},'version',${alias}.version)`;
  const rows = await tx.unsafe(`WITH own_settings AS (
    SELECT st.*,${normalizedOption('st')} AS normalized FROM student_portal.setting st
    WHERE st.academic_year=2026 AND st.source_scope_json=CASE st.scope_kind
      WHEN 'school' THEN jsonb_build_object('kind','school','academicYear',2026)
      WHEN 'class' THEN jsonb_build_object('kind','class','academicYear',2026,'classId',st.class_id)
      WHEN 'shift' THEN jsonb_build_object('kind','shift','academicYear',2026,'shift',split_part(st.scope_key,':',3))
      ELSE jsonb_build_object('kind','account','academicYear',2026,'accountId',st.account_id::text) END
  ), class_shifts AS (
    SELECT class_id,shift FROM student_portal.academic_class_v1 WHERE academic_year=2026 AND shift IS NOT NULL
  ), accounts AS (
    SELECT a.id,a.gradebook_student_id,a.auth_state,a.version,a.blocked,a.closed_at,a.updated_at,
      s.name,b.class_id,b.class_name ${ACCOUNT_JOIN_V1} WHERE a.academic_year=2026
  ), classes AS (
    SELECT class_id,min(class_name) AS name FROM student_portal.academic_binding_v1
    WHERE academic_year=2026 AND status IS DISTINCT FROM 6 GROUP BY class_id
  ), owners AS (
    SELECT DISTINCT scope_key,scope_kind,class_id,account_id FROM own_settings WHERE scope_kind IN('class','shift','account')
    UNION SELECT scope_key,scope_kind,class_id,account_id FROM student_portal.publication_release_v2 r
      WHERE academic_year=2026 AND scope_kind IN('class','account')
        AND version>COALESCE((to_jsonb(r)->>'inherit_version')::bigint,0)
    UNION SELECT 'account:2026:'||id::text,'account',NULL::integer,id FROM accounts WHERE blocked
    ${contextOwner}
  ), targets AS (
    SELECT o.scope_key,o.scope_kind,o.account_id,
      CASE WHEN o.scope_kind='class' THEN o.class_id WHEN o.scope_kind='shift' THEN NULL ELSE a.class_id END AS class_id,
      CASE WHEN o.scope_kind='shift' THEN split_part(o.scope_key,':',3) ELSE cs.shift END AS shift,
      CASE WHEN o.scope_kind='class' THEN COALESCE(c.name,'Turma '||o.class_id::text)
        WHEN o.scope_kind='shift' THEN 'Turno '||initcap(lower(split_part(o.scope_key,':',3)))
        ELSE COALESCE(a.name,'Aluno sem vínculo atual') END AS label,
      COALESCE(CASE WHEN o.scope_kind='class' THEN c.name WHEN o.scope_kind='shift' THEN NULL ELSE a.class_name END,'') AS class_label,
      a.gradebook_student_id,a.auth_state,a.version AS account_version,COALESCE(a.blocked,false) AS blocked,a.updated_at,
      (o.scope_kind IN ('class','shift') OR (a.id IS NOT NULL AND a.closed_at IS NULL AND a.class_id IS NOT NULL)) AS resolved
    FROM owners o LEFT JOIN accounts a ON a.id=o.account_id LEFT JOIN classes c ON c.class_id=o.class_id
    LEFT JOIN class_shifts cs ON cs.class_id=CASE WHEN o.scope_kind='class' THEN o.class_id ELSE a.class_id END
  ), option_differences AS (
    SELECT t.scope_key,o.field_key,o.normalized AS value,base.inherited,
      baseline.school,o.updated_at
    FROM targets t JOIN own_settings o ON o.scope_key=t.scope_key
    LEFT JOIN own_settings school ON school.scope_key='school:2026' AND school.field_key=o.field_key
    LEFT JOIN own_settings parent ON t.scope_kind='account' AND parent.scope_key='class:2026:'||t.class_id::text
      AND parent.field_key=o.field_key
    LEFT JOIN own_settings shift_parent ON t.scope_kind IN ('account','class') AND shift_parent.scope_key='shift:2026:'||t.shift
      AND shift_parent.field_key=o.field_key
    CROSS JOIN LATERAL (SELECT COALESCE(school.normalized,${defaults}::jsonb->o.field_key) AS school) baseline
    CROSS JOIN LATERAL (SELECT COALESCE(shift_parent.normalized,parent.normalized,baseline.school) AS inherited) base
    WHERE (t.scope_kind<>'class' OR shift_parent.scope_key IS NULL)
      AND CASE WHEN o.field_key='allowedPeriods' THEN
      NOT (o.normalized @> base.inherited AND o.normalized <@ base.inherited)
      ELSE o.normalized IS DISTINCT FROM base.inherited END
  ), publication_context AS (
    SELECT t.scope_key,p.period,p.position,actual.released_at,
      jsonb_build_object('period',p.period,'current',${choice('actual', 'revisions.current_revision')},
        'inherited',${choice('parent', 'revisions.parent_revision')},'school',${choice('school', 'revisions.school_revision')},
        'customized',COALESCE(actual.scope_key=t.scope_key AND revisions.current_revision IS DISTINCT FROM revisions.parent_revision,false),
        'ownVersion',CASE WHEN actual.scope_key=t.scope_key THEN actual.version END) AS item,
      COALESCE(actual.scope_key=t.scope_key AND revisions.current_revision IS DISTINCT FROM revisions.parent_revision,false) AS customized
    FROM targets t CROSS JOIN (VALUES('T1',1),('T2',2),('T3',3),('REC1',4),('REC2',5),('REC3',6)) p(period,position)
    LEFT JOIN LATERAL (${releaseSelectionSqlV1()}) actual ON true
    LEFT JOIN LATERAL (${releaseSelectionSqlV1(PARENT_RELEASE_KEYS_V1)}) parent ON true
    LEFT JOIN LATERAL (${releaseSelectionSqlV1(SCHOOL_RELEASE_KEYS_V1)}) school ON true
    LEFT JOIN own_settings oa ON oa.scope_key=t.scope_key AND oa.field_key='autoUpdate'
    LEFT JOIN own_settings ca ON t.scope_kind='account' AND ca.scope_key='class:2026:'||t.class_id::text AND ca.field_key='autoUpdate'
    LEFT JOIN own_settings sha ON t.scope_kind IN ('account','class') AND sha.scope_key='shift:2026:'||t.shift AND sha.field_key='autoUpdate'
    LEFT JOIN own_settings sa ON sa.scope_key='school:2026' AND sa.field_key='autoUpdate'
    LEFT JOIN student_portal.publication_auto_approval_v2 automatic ON automatic.academic_year=2026
      AND automatic.student_id=t.gradebook_student_id AND automatic.class_id=t.class_id AND automatic.generation=$1
    CROSS JOIN LATERAL (SELECT ${approved('actual')} AS current_revision,${approved('parent')} AS parent_revision,
      ${approved('school', true)} AS school_revision) revisions
    WHERE t.resolved AND t.scope_kind<>'shift'
  ), serialized AS (
    SELECT t.*,opts.value,opts.inherited,opts.school,
      COALESCE(pubs.publications,'[]'::jsonb) AS publications,COALESCE(pubs.context,'[]'::jsonb) AS context,
      GREATEST(opts.updated_at,pubs.updated_at,CASE WHEN t.blocked THEN t.updated_at END) AS modified
    FROM targets t LEFT JOIN LATERAL (
      SELECT jsonb_object_agg(d.field_key,d.value) AS value,jsonb_object_agg(d.field_key,d.inherited) AS inherited,
        jsonb_object_agg(d.field_key,d.school) AS school,max(d.updated_at) AS updated_at
      FROM option_differences d WHERE d.scope_key=t.scope_key
    ) opts ON true LEFT JOIN LATERAL (
      SELECT jsonb_agg(d.item ORDER BY d.position) FILTER(WHERE d.customized) AS publications,
        jsonb_agg(d.item ORDER BY d.position) AS context,max(d.released_at) FILTER(WHERE d.customized) AS updated_at
      FROM publication_context d WHERE d.scope_key=t.scope_key
    ) pubs ON true
  ), page AS (SELECT s.* FROM serialized s WHERE ${where.join(' AND ')} ORDER BY s.scope_key COLLATE "C" LIMIT ${limit})
  SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',s.scope_key,'scope',CASE WHEN s.scope_kind='class' THEN jsonb_build_object('kind','class','academicYear',2026,'classId',s.class_id)
      WHEN s.scope_kind='shift' THEN jsonb_build_object('kind','shift','academicYear',2026,'shift',s.shift)
      ELSE jsonb_build_object('kind','account','academicYear',2026,'accountId',s.account_id::text) END,
    'label',s.label,'classLabel',s.class_label,'classId',s.class_id,'accountState',s.auth_state,
    'accountVersion',s.account_version,'settingsVersion',$3::bigint+COALESCE(s.account_version,0),'publicationVersion',$4::bigint,
    'value',s.value,'inheritedValue',s.inherited,'schoolValue',s.school,'blocked',s.blocked,'publications',s.publications,
    'updatedAt',to_char(s.modified AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.scope_key COLLATE "C") FROM page s),'[]'::jsonb) AS items,
    (SELECT jsonb_build_object('resolved',s.resolved,'publications',s.context) FROM serialized s WHERE s.scope_key=${contextKey}) AS context`, args);
  if (rows.length !== 1 || !Array.isArray(rows[0]!.items)) throw new Error('student-portal-admin-unavailable');
  const result = rows[0]!;
  const items = result.items as Record<string, unknown>[];
  const selected = items.slice(0, query.page.limit);
  return customizationsResponseV1.parse({
    contractVersion: 2, state: 'customizations-read', requestId, observedAt: now.toISOString(), scope: query.scope,
    publicationVersion, items: selected,
    nextCursor: items.length > query.page.limit ? await cursor.next(query, actor, now, String(selected.at(-1)!.id)) : null,
    context: targetKey ? { ...((result.context ?? { resolved: false, publications: [] }) as Record<string, unknown>), scope: query.scope } : null,
  });
}
