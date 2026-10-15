import { z } from 'zod';
import type {
  GradebookPostgresDatabaseV1,
  GradebookPostgresFailureDiagnosticV1,
  GradebookPostgresTransactionV1,
} from '../gradebook/persistence/postgres/postgres-database-v1';

export type FrequencyFailureOriginV2 = 'collector' | 'admin' | 'device-report';
export type FrequencyFailureV2 = {
  origin: FrequencyFailureOriginV2;
  operation: string;
  code: string;
  detail?: string;
  deviceId?: string | null;
  classId?: number | null;
};

/** Seven-day trail. A repeat within ten minutes only increments its counter. */
export const FREQUENCY_FAILURE_RETENTION_DAYS_V2 = 7;
const OPERATION = /^[a-z-]{1,40}$/u;
const CODE = /^[A-Za-z_-]{1,60}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

function clean(failure: FrequencyFailureV2): Required<FrequencyFailureV2> {
  return {
    origin: failure.origin,
    operation: OPERATION.test(failure.operation) ? failure.operation : 'unknown',
    code: CODE.test(failure.code) ? failure.code : 'unavailable',
    detail: (failure.detail ?? '').slice(0, 200),
    deviceId: failure.deviceId ?? null,
    classId: failure.classId ?? null,
  };
}

/**
 * Error detail without values: SQLSTATE/constraint, schema paths or the error
 * class. Messages are never stored because they can repeat names or marks.
 */
export function frequencyFailureDetailV2(
  error: unknown,
  diagnostic?: GradebookPostgresFailureDiagnosticV1 | null,
): string {
  if (error instanceof z.ZodError) {
    const issues = new Set(error.issues.map((issue) => issue.path.join('.') + ':' + issue.code));
    return ('invalid:' + [...issues].join(',')).slice(0, 200);
  }
  const value = (error ?? {}) as { code?: unknown; constraint_name?: unknown };
  if (typeof value.code === 'string' && SQLSTATE.test(value.code)) {
    const parts = [`sqlstate:${value.code}`];
    if (typeof value.constraint_name === 'string' && IDENTIFIER.test(value.constraint_name))
      parts.push(value.constraint_name);
    if (diagnostic?.sqlState === value.code) parts.push(diagnostic.operation.toLowerCase());
    if (diagnostic?.sqlState === value.code && diagnostic.relation) parts.push(diagnostic.relation);
    return parts.join(' ').slice(0, 200);
  }
  return error instanceof Error ? error.name.slice(0, 60) : 'unknown';
}

export async function insertFrequencyFailureV2(
  tx: GradebookPostgresTransactionV1,
  failure: FrequencyFailureV2,
): Promise<void> {
  const value = clean(failure);
  const fingerprint = JSON.stringify([
    value.origin,
    value.operation,
    value.code,
    value.detail,
    value.deviceId,
    value.classId,
  ]);
  const repeated = await tx.executeNative<Record<string, unknown>>(
    `UPDATE attendance.failure_v2 SET last_at=clock_timestamp(),occurrences=occurrences+1
    WHERE fingerprint=$1 AND last_at>clock_timestamp()-interval '10 minutes' RETURNING id`,
    [fingerprint],
  );
  if (!repeated.rows.length)
    await tx.executeNative(
      `INSERT INTO attendance.failure_v2(origin,operation,code,detail,device_id,class_id,fingerprint)
      VALUES($1,$2,$3,$4,$5::uuid,$6,$7)`,
      [
        value.origin,
        value.operation,
        value.code,
        value.detail,
        value.deviceId,
        value.classId,
        fingerprint,
      ],
    );
  await tx.executeNative(
    `DELETE FROM attendance.failure_v2 WHERE last_at<clock_timestamp()-make_interval(days=>$1)`,
    [FREQUENCY_FAILURE_RETENTION_DAYS_V2],
  );
}

/** Own transaction: the failed operation has already rolled back. Never throws. */
export async function recordFrequencyFailureV2(
  database: GradebookPostgresDatabaseV1,
  failure: FrequencyFailureV2,
): Promise<void> {
  const value = clean(failure);
  console.error(
    JSON.stringify({
      message: 'frequency_failed',
      origin: value.origin,
      operation: value.operation,
      code: value.code,
      detail: value.detail,
      deviceId: value.deviceId,
      classId: value.classId,
    }),
  );
  try {
    await database.transaction((tx) => insertFrequencyFailureV2(tx, value));
  } catch {
    console.error(JSON.stringify({ message: 'frequency_failure_log_unavailable' }));
  }
}
