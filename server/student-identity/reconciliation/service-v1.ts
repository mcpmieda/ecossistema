import {
  reconciliationRequestV1,
  type ReconciliationResponseV1,
  type ReconciliationRequestV1,
} from '../../../shared/student-identity/reconciliation-v1';
import type { GradebookPostgresDatabaseV1 } from '../../gradebook/persistence/postgres/postgres-database-v1';
import {
  academicRevisionV1,
  assertContextV1,
  boolV1,
  contextV1,
  digestV1,
  ReconciliationConflictV1,
} from './storage-v1';
import { prepareReportV1, preparedResponseV1 } from './prepare-v1';
import { applyReportV1 } from './apply-v1';
import { catalogV1, detailV1, listV1 } from './queries-v1';
import { decideV1 } from './decisions-v1';

export class StudentReconciliationServiceV1 {
  constructor(
    private readonly database: GradebookPostgresDatabaseV1,
    private readonly actorId: string,
    private readonly cursorSecret: string,
  ) {}
  async execute(input: unknown): Promise<ReconciliationResponseV1> {
    const parsed = reconciliationRequestV1.safeParse(input);
    if (!parsed.success) return { contractVersion: 1, state: 'invalid-request' };
    const request = parsed.data;
    try {
      return await this.database.transaction(async (tx) => {
        const context = await contextV1(tx, request.academicYear, true);
        switch (request.operation) {
          case 'catalog':
            return catalogV1(tx, request.academicYear, context);
          case 'list':
            return listV1(tx, this.actorId, request, context, this.cursorSecret);
          case 'detail':
            return detailV1(tx, request, context);
          case 'prepare':
            return prepareReportV1(tx, this.actorId, request, context);
          case 'apply':
            return applyReportV1(tx, this.actorId, request, context);
          case 'name-source':
          case 'class-link':
          case 'resolve':
          case 'select-observation':
            return decideV1(tx, this.actorId, request, context);
          case 'stage': {
            assertContextV1(context, request);
            const [batch] = await tx.query(
              `SELECT *,expires_at>clock_timestamp() AS usable FROM gradebook.student_report_batch_v1
            WHERE id=$1::uuid AND academic_year=$2 AND actor_id=$3::uuid`,
              [request.batchId, request.academicYear, this.actorId],
            );
            if (
              !batch ||
              batch.generation !== context.generation ||
              Number(batch.base_revision) !== context.revision ||
              batch.base_academic_revision !== (await academicRevisionV1(tx, request.academicYear))
            )
              throw new ReconciliationConflictV1();
            if (!boolV1(batch.usable)) throw new ReconciliationConflictV1('expired');
            if (!['preparing', 'review_required'].includes(String(batch.state)))
              throw new ReconciliationConflictV1();
            return {
              contractVersion: 1,
              state: 'ready',
              operation: 'stage',
              ready: false,
              remaining: 0,
            };
          }
          case 'activate-pending': {
            const activationDigest = await digestV1(request);
            const [receipt] = await tx.query(
              `SELECT id::text,resolution FROM gradebook.student_report_batch_v1 WHERE academic_year=$1 AND generation=$2::uuid AND actor_id=$3::uuid AND idempotency_key=$4::uuid`,
              [request.academicYear, request.generation, this.actorId, request.idempotencyKey],
            );
            if (receipt) {
              const metadata = receipt.resolution as { activationRequestDigest?: string };
              if (metadata?.activationRequestDigest !== activationDigest)
                throw new ReconciliationConflictV1();
              return preparedResponseV1(tx, String(receipt.id), context);
            }
            assertContextV1(context, request);
            const [b] = await tx.query(
              `SELECT *,expires_at>clock_timestamp() AS usable FROM gradebook.student_report_batch_v1 WHERE id=$1::uuid AND academic_year=$2 FOR UPDATE`,
              [request.batchId, request.academicYear],
            );
            if (
              !b ||
              !context.relationAvailable ||
              b.generation !== context.generation ||
              b.state !== 'awaiting_relation'
            )
              throw new ReconciliationConflictV1();
            if (!boolV1(b.usable)) throw new ReconciliationConflictV1('expired');
            const rows = await tx.query(
              `SELECT source_row,name,birth_date::text,filiation1,inep,enrollment_hash,class_label,shift,stage_label,status,enrolled_at::text,transferred_at::text
            FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid ORDER BY source_row`,
              [request.batchId],
            );
            const proposal: Extract<ReconciliationRequestV1, { operation: 'prepare' }> = {
              ...request,
              operation: 'prepare',
              normalizationVersion: 1,
              sourceFormat: 'smecel-report-v1',
              date1904: false,
              sourceYear: request.academicYear,
              confirmYear: true,
              sourceGeneratedAt: b.source_generated_at
                ? new Date(String(b.source_generated_at)).toISOString()
                : null,
              rows: rows.map((r) => ({
                sourceRow: Number(r.source_row),
                name: String(r.name),
                birthDate: String(r.birth_date),
                filiation1: r.filiation1 === null ? null : String(r.filiation1),
                inep: r.inep === null ? null : String(r.inep),
                enrollmentHash: String(r.enrollment_hash),
                classLabel: String(r.class_label),
                shift: String(r.shift),
                stageLabel: String(r.stage_label),
                status: String(r.status),
                enrolledAt: r.enrolled_at === null ? null : String(r.enrolled_at),
                transferredAt: r.transferred_at === null ? null : String(r.transferred_at),
              })),
            };
            // Strip the command-only key before hashing the strict report request.
            const report = reconciliationRequestV1.parse(
              Object.fromEntries(Object.entries(proposal).filter(([k]) => k !== 'batchId')),
            ) as Extract<ReconciliationRequestV1, { operation: 'prepare' }>;
            const response = await prepareReportV1(tx, this.actorId, report, context);
            if (response.state === 'ready' && response.operation === 'prepare') {
              await tx.executeNative(
                `UPDATE gradebook.student_report_batch_v1 SET resolution=$2::text::jsonb WHERE id=$1::uuid`,
                [
                  response.batchId,
                  JSON.stringify({
                    activationSourceId: request.batchId,
                    activationRequestDigest: activationDigest,
                  }),
                ],
              );
              await tx.executeNative(
                `DELETE FROM gradebook.student_report_pending_row_v1 WHERE batch_id=$1::uuid`,
                [request.batchId],
              );
              await tx.executeNative(
                `UPDATE gradebook.student_report_batch_v1 SET state='superseded',class_links='[]' WHERE id=$1::uuid`,
                [request.batchId],
              );
            }
            return response;
          }
        }
      });
    } catch (error) {
      if (error instanceof ReconciliationConflictV1)
        return {
          contractVersion: 1,
          state: error.state,
          reason: error.state === 'conflict' ? 'Dados alterados. Confira novamente.' : undefined,
        };
      throw error;
    }
  }
}
