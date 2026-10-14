import { normalizeStudentNameV1, normalizeInepV1, parseCivilDateV1 } from '../../../shared/student-identity/reconciliation-normalization-v1';
import type { ReconciliationSourceEvidenceV1, ReconciliationSourceResolutionV1 } from '../../../shared/student-identity/reconciliation-v1';
import { boolV1, type TxV1 } from './storage-v1';

/** Batched form of the central V1 evidence rules; never creates or decides identity. */
export async function resolveReconciledSourcesV2(tx: TxV1, inputs: ReconciliationSourceEvidenceV1[]): Promise<ReconciliationSourceResolutionV1[]> {
  if(inputs.length>1024)throw new Error('reconciliation-source-batch-too-large');
  if(!inputs.length)return [];
  const normalized=inputs.flatMap((input,ordinal)=>{
    const inep=normalizeInepV1(input.inep??null),birth=parseCivilDateV1(input.birthDate??null,false,'9999-12-31',false);
    return input.academicYear===2026&&input.name.trim()&&input.classLabel.trim()&&input.sourceSnapshotRef.trim()&&input.sourceRecordRef.trim()&&inep.ok&&birth.ok
      ?[{ordinal,name_key:normalizeStudentNameV1(input.name),class_key:normalizeStudentNameV1(input.classLabel),inep_key:inep.key,birth_date:birth.value,
        filiation1_key:input.filiation1?.trim()?normalizeStudentNameV1(input.filiation1):null}]:[];
  });
  if(!normalized.length)return inputs.map(()=>({state:'not_found',decisionVersion:0}));
  const validOrdinals=new Set(normalized.map(input=>input.ordinal));
  const [scope]=await tx.query('SELECT revision::text FROM gradebook.student_reconciliation_scope_v1 WHERE academic_year=$1',[2026]);
  const decisionVersion=Number(scope?.revision??0);
  const rows=normalized.length?await tx.query(`WITH wanted AS (
    SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS w(ordinal integer,name_key text,class_key text,inep_key text,birth_date date,filiation1_key text))
    SELECT w.ordinal,o.id::text,o.source_id::text,l.student_uid::text,r.review_required AS source_review,l.review_required AS link_review
    FROM wanted w JOIN gradebook.student_source_observation_v1 o ON o.academic_year=2026 AND o.name_key=w.name_key
    JOIN gradebook.student_report_class_v1 c ON c.id=o.report_class_id AND c.academic_year=o.academic_year AND c.class_key=w.class_key
    JOIN gradebook.student_source_record_v1 r ON r.id=o.source_id AND r.academic_year=o.academic_year
    LEFT JOIN gradebook.student_source_link_v1 l ON l.source_id=o.source_id AND l.academic_year=o.academic_year
    WHERE (w.inep_key IS NULL OR o.inep_key=w.inep_key) AND (w.birth_date IS NULL OR o.birth_date=w.birth_date)
      AND (w.filiation1_key IS NULL OR o.filiation1_key=w.filiation1_key) ORDER BY w.ordinal,o.id`,[JSON.stringify(normalized)]):[];
  const groups=new Map<number,Record<string,unknown>[]>();
  for(const row of rows){const ordinal=Number(row.ordinal);const group=groups.get(ordinal)??[];group.push(row);groups.set(ordinal,group);}
  return inputs.map((_,ordinal)=>{
    if(!validOrdinals.has(ordinal))return {state:'not_found',decisionVersion:0};
    const group=groups.get(ordinal);if(!group?.length)return {state:'not_found',decisionVersion};
    const uids=new Set(group.map(row=>row.student_uid));
    if(uids.size!==1||uids.has(null)||uids.has(undefined)||group.some(row=>boolV1(row.source_review)||boolV1(row.link_review)))return {state:'ambiguous',decisionVersion};
    return {state:'resolved',studentUid:String(group[0]!.student_uid),sourceIds:[...new Set(group.map(row=>String(row.source_id)))],
      observationIds:group.map(row=>String(row.id)),decisionVersion};
  });
}
