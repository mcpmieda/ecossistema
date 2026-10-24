import { PortalRateLimitErrorV1 } from '../observability/operation-burst-v1';
import { failureV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { withPortalSqlV1 } from '../runtime/database-v1';
import {
  emitPortalDbLifecycleMetricV1,
  emitPortalMetricV1,
  measurePortalSqlV1,
  type PortalDbLifecycleMetricV1,
  type PortalMetricV1,
} from '../observability/metrics-v1';
import type { PortalSqlLifecycleSampleV1 } from '../runtime/database-v1';
import type { PortalCompositionEnvV1 } from './config-v1';

/** Includes connection failures; only the fixed aggregate schema reaches logs. */
export async function portalDatabaseV1<T>(env: PortalCompositionEnvV1, operation: PortalMetricV1['operation'],
  run: (sql: StudentPortalPostgresSqlV1) => Promise<T>): Promise<T> {
  const started = Date.now();
  let measured: ReturnType<typeof measurePortalSqlV1> | undefined;
  let lifecycle: PortalSqlLifecycleSampleV1 | undefined;
  let outcome: PortalMetricV1['outcome'] = 'unavailable';
  try {
    if (!env.PORTAL_DB) throw new Error('student-portal-database-unavailable');
    const result = await withPortalSqlV1(
      env.PORTAL_DB,
      async (sql) => {
        measured = measurePortalSqlV1(sql);
        return run(measured.sql);
      },
      undefined,
      (sample) => {
        lifecycle = sample;
      },
    );
    const failure = failureV1.safeParse(result);
    if (failure.success) outcome = failure.data.state === 'unavailable' ? 'unavailable' : 'denied';
    else outcome = result === null ? 'denied' : 'ok';
    return result;
  } catch (error) {
    if (error instanceof PortalRateLimitErrorV1 && error.state === 'rate-limited') outcome = 'denied';
    throw error;
  } finally {
    const metric = measured?.snapshot(operation, outcome) ?? { event: 'student-portal-operation-v1' as const,
      operation, outcome, elapsedMs: 0, queries: 0, rows: 0, lockTimeouts: 0, statementTimeouts: 0 };
    // The factory's role check succeeds before the instrumented callback starts.
    emitPortalMetricV1({ ...metric, elapsedMs: Math.max(0, Date.now() - started),
      queries: metric.queries + (measured ? 1 : 0), rows: metric.rows + (measured ? 1 : 0) });
    if (lifecycle) {
      const dbMetric: PortalDbLifecycleMetricV1 = {
        event: 'student-portal-db-lifecycle-v1',
        operation,
        outcome,
        openRoleMs: lifecycle.openRoleMs,
        applicationMs: lifecycle.applicationMs,
        attempts: lifecycle.attempts,
      };
      emitPortalDbLifecycleMetricV1(dbMetric);
    }
  }
}
