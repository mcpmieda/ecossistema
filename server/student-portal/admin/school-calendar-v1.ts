import { z } from 'zod';
import { adminCommandV1, type AdminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { schoolCalendarDaysV1, type SchoolCalendarV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { adminDigestV1 } from './common-v1';

/*
 * Calendário escolar (owner decision 22/10/2026): one calendar for the whole school, marked in the
 * ADM. Written whole with the version read (two admins never overwrite each other), never with more
 * than 200 school days (the contract refuses it), and audited as a settings change.
 */
export async function readSchoolCalendarV1(tx: StudentPortalPostgresQueryV1): Promise<SchoolCalendarV1 | null> {
  const rows = await tx.unsafe(
    'SELECT days_json,version FROM student_portal.school_calendar_v1 WHERE academic_year=2026',
  );
  if (!rows.length) return null;
  const row = rows[0]!;
  const raw = typeof row.days_json === 'string' ? JSON.parse(row.days_json) : row.days_json;
  return {
    academicYear: 2026,
    version: z.coerce.number().int().positive().parse(row.version),
    days: schoolCalendarDaysV1.parse(raw),
  };
}

export async function setSchoolCalendarV1(
  sql: StudentPortalPostgresSqlV1,
  actorId: string,
  input: Extract<AdminCommandV1, { operation: 'school-calendar-set' }>,
) {
  const actor = z.uuid().parse(actorId).toLowerCase();
  const command = adminCommandV1.parse(input);
  if (command.operation !== 'school-calendar-set')
    throw new Error('student-portal-school-calendar-invalid-request');
  return authTransactionV1(sql, async (tx, store) => {
    const now = await authNowV1(tx);
    const digest = adminDigestV1(command);
    const receiptActor = `school-calendar:${actor}`;
    const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
    if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
      if (receipt.requestDigest !== digest)
        throw new Error('student-portal-school-calendar-idempotency-conflict');
      return { operationId: receipt.operationId, version: receipt.version };
    }
    if (receipt)
      await tx.unsafe(
        'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
        [command.idempotencyKey, receiptActor],
      );
    const current = await tx.unsafe(
      'SELECT version FROM student_portal.school_calendar_v1 WHERE academic_year=2026 FOR UPDATE',
    );
    const version = current.length ? Number(current[0]!.version) : 0;
    if (version !== command.expectedVersion)
      throw new Error('student-portal-school-calendar-version-conflict');
    const days = [...command.days].sort((left, right) => left.date.localeCompare(right.date));
    const next = version + 1;
    await tx.unsafe(
      `INSERT INTO student_portal.school_calendar_v1(academic_year,days_json,version,updated_at,updated_by)
       VALUES(2026,$1::text::jsonb,$2,statement_timestamp(),$3::uuid)
       ON CONFLICT(academic_year) DO UPDATE SET days_json=EXCLUDED.days_json,version=EXCLUDED.version,
         updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by`,
      [JSON.stringify(days), next, actor],
    );
    const operationId = crypto.randomUUID();
    await store.appendAudit({
      eventId: crypto.randomUUID(),
      at: now.toISOString(),
      actorId: actor,
      accountId: null,
      scope: { kind: 'school', academicYear: 2026 },
      kind: 'settings-changed',
      result: 'success',
      requestId: command.idempotencyKey,
      version: next,
      maskedIp: null,
    });
    await store.saveIdempotency({
      key: command.idempotencyKey,
      actorId: receiptActor,
      requestDigest: digest,
      operationId,
      version: next,
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    });
    return { operationId, version: next };
  });
}
