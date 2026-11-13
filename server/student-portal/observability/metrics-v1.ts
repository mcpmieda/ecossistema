import { z } from 'zod';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';

const count = z.number().int().nonnegative().safe();
export const portalMetricV1 = z.object({
  event: z.literal('student-portal-operation-v1'),
  operation: z.enum(['auth', 'self', 'admin-query', 'admin-command', 'cleanup', 'publication', 'live', 'live-drain']),
  outcome: z.enum(['ok', 'denied', 'unavailable']),
  elapsedMs: count, queries: count, rows: count, lockTimeouts: count, statementTimeouts: count,
}).strict();
export type PortalMetricV1 = z.infer<typeof portalMetricV1>;

export const portalAuthBurstMetricV1 = z.object({
  event: z.literal('student-portal-auth-burst-v1'),
  outcome: z.enum([
    'allowed',
    'global-limited',
    'subject-limited',
    'invalid-subject',
    'unavailable',
  ]),
}).strict();
export type PortalAuthBurstMetricV1 = z.infer<typeof portalAuthBurstMetricV1>;

/** The security check's answer from Cloudflare: a fixed list of its codes, never the token or secret. */
export const PORTAL_RISK_CODES_V1 = ['missing-input-secret', 'invalid-input-secret', 'missing-input-response',
  'invalid-input-response', 'bad-request', 'timeout-or-duplicate', 'internal-error', 'other'] as const;
export const portalRiskVerifyMetricV1 = z.object({
  event: z.literal('student-portal-risk-verify-v1'),
  outcome: z.enum(['passed', 'rejected', 'unavailable']),
  status: z.number().int().min(0).max(599),
  code: z.enum(PORTAL_RISK_CODES_V1).nullable(),
}).strict();
export type PortalRiskVerifyMetricV1 = z.infer<typeof portalRiskVerifyMetricV1>;
export function emitPortalRiskVerifyMetricV1(
  metric: PortalRiskVerifyMetricV1,
  sink: (value: PortalRiskVerifyMetricV1) => void = console.info,
): void {
  const parsed = portalRiskVerifyMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter the auth outcome. */ }
}

export const portalOperationBurstMetricV1 = z.object({
  event: z.literal('student-portal-operation-burst-v1'),
  operation: z.enum(['auth-entry', 'session-entry', 'session', 'read-entry', 'read', 'status-entry', 'status',
    'live-entry', 'live', 'photo-entry', 'photo', 'logout-entry', 'logout', 'activation',
    'frequency-entry', 'schedule-entry', 'incidents-entry',
    'admin-read', 'admin-import', 'admin-write', 'admin-export', 'admin-live', 'admin-revoke']),
  outcome: z.enum(['allowed', 'limited', 'unavailable']),
  elapsedMs: count,
}).strict();

export function emitPortalOperationBurstMetricV1(metric: unknown,
  sink: (value: z.infer<typeof portalOperationBurstMetricV1>) => void = console.info): void {
  const parsed = portalOperationBurstMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry never changes access or a committed outcome. */ }
}

export const portalDbLifecycleMetricV1 = z.object({
  event: z.literal('student-portal-db-lifecycle-v1'),
  operation: portalMetricV1.shape.operation,
  outcome: portalMetricV1.shape.outcome,
  openRoleMs: count,
  applicationMs: count,
  attempts: z.number().int().min(1).max(2),
}).strict();
export type PortalDbLifecycleMetricV1 = z.infer<typeof portalDbLifecycleMetricV1>;

export const portalLiveCloseMetricV1 = z.object({
  event: z.literal('student-portal-live-close-v1'),
  callback: z.enum(['close', 'error']),
  codeClass: z.enum([
    'normal', 'going-away', 'auth-expired', 'no-status', 'abnormal', 'tls-reserved',
    'other-sendable', 'other-invalid', 'not-applicable',
  ]),
  readyState: z.union([z.number().int().min(0).max(3), z.literal('unknown')]),
}).strict();
export type PortalLiveCloseMetricV1 = z.infer<typeof portalLiveCloseMetricV1>;

export const portalEdgeResultMetricV1 = z.object({
  event: z.literal('student-portal-edge-result-v1'),
  family: z.enum(['document', 'asset', 'icon-probe', 'health', 'diagnostic', 'api', 'other']),
  result: z.enum([
    'origin-rejected', 'method-rejected', 'binding-missing', 'asset-miss', 'document-miss',
    'route-miss', 'upstream-error', 'forwarded', 'served', 'redirected',
  ]),
  status: z.number().int().min(100).max(599),
}).strict();
export type PortalEdgeResultMetricV1 = z.infer<typeof portalEdgeResultMetricV1>;

const authResultBaseV1 = {
  event: z.literal('student-portal-auth-result-v1'),
  step: z.enum(['challenge', 'activate', 'login']),
};
export const portalAuthResultMetricV1 = z.union([
  z.object({ ...authResultBaseV1, outcome: z.literal('required'), next: z.enum(['pin', 'password', 'risk']) }).strict(),
  z.object({
    ...authResultBaseV1,
    outcome: z.enum(['issued', 'denied', 'blocked', 'access-closed', 'invalid-request', 'unavailable']),
  }).strict(),
]);
export type PortalAuthResultMetricV1 = z.infer<typeof portalAuthResultMetricV1>;

/** Capture numeric aggregates only, never SQL, parameters, IDs, URLs or driver error messages. */
export function measurePortalSqlV1(sql: StudentPortalPostgresSqlV1) {
  const started = Date.now();
  const counters = { queries: 0, rows: 0, lockTimeouts: 0, statementTimeouts: 0 };
  const wrap = (tx: StudentPortalPostgresQueryV1): StudentPortalPostgresQueryV1 => ({
    unsafe: async <R extends Record<string, unknown>>(query: string, parameters?: readonly unknown[]) => {
      counters.queries++;
      try {
        const rows = await tx.unsafe<R>(query, parameters);
        counters.rows += rows.length;
        return rows;
      } catch (error) {
        // SQLSTATE is a bounded classifier. No other error property leaves this function.
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
        if (code === '55P03') counters.lockTimeouts++;
        if (code === '57014') counters.statementTimeouts++;
        throw error;
      }
    },
  });
  return {
    sql: { ...wrap(sql), begin: <T>(op: (tx: StudentPortalPostgresQueryV1) => Promise<T>) => sql.begin((tx) => op(wrap(tx))) } satisfies StudentPortalPostgresSqlV1,
    snapshot: (operation: PortalMetricV1['operation'], outcome: PortalMetricV1['outcome']): PortalMetricV1 =>
      portalMetricV1.parse({ event: 'student-portal-operation-v1', operation, outcome, elapsedMs: Math.max(0, Date.now() - started), ...counters }),
  };
}

/** Logging failure cannot turn a committed command into an apparent retryable database failure. */
export function emitPortalMetricV1(metric: PortalMetricV1, sink: (value: PortalMetricV1) => void = console.info): void {
  const parsed = portalMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry is outside the commit outcome. */ }
}

export function emitPortalAuthBurstMetricV1(
  metric: PortalAuthBurstMetricV1,
  sink: (value: PortalAuthBurstMetricV1) => void = console.info,
): void {
  const parsed = portalAuthBurstMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter auth outcome. */ }
}

export function emitPortalDbLifecycleMetricV1(
  metric: PortalDbLifecycleMetricV1,
  sink: (value: PortalDbLifecycleMetricV1) => void = console.info,
): void {
  const parsed = portalDbLifecycleMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter DB outcome. */ }
}

export function emitPortalLiveCloseMetricV1(
  metric: PortalLiveCloseMetricV1,
  sink: (value: PortalLiveCloseMetricV1) => void = console.info,
): void {
  const parsed = portalLiveCloseMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter the socket lifecycle. */ }
}

export function emitPortalEdgeResultMetricV1(
  metric: PortalEdgeResultMetricV1,
  sink: (value: PortalEdgeResultMetricV1) => void = console.info,
): void {
  const parsed = portalEdgeResultMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter the edge response. */ }
}

export function emitPortalAuthResultMetricV1(
  metric: PortalAuthResultMetricV1,
  sink: (value: PortalAuthResultMetricV1) => void = console.info,
): void {
  const parsed = portalAuthResultMetricV1.safeParse(metric);
  if (!parsed.success) return;
  try { sink(parsed.data); } catch { /* Telemetry must never alter the auth outcome. */ }
}
