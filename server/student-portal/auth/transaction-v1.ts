import { z } from 'zod';
import type { AccountRecordV1, PortalTransactionV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { AuditDetailV1, auditEventV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { StudentPortalPostgresPersistenceV1, type StudentPortalPostgresQueryV1, type StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { AcademicEligibilityReaderPostgresV1 } from '../integration/lifecycle/academic-eligibility-v1';
import { PolicyServiceV1 } from '../policies/policy-service-v1';
import { sessionExpiryV1 } from '../policies/calendar-v1';

export const accountScopeV1 = (accountId: string) => ({ kind: 'account', academicYear: 2026, accountId } as const);
export function authTransactionV1<T>(sql: StudentPortalPostgresSqlV1,
  operation: (tx: StudentPortalPostgresQueryV1, store: PortalTransactionV1) => Promise<T>,
  yearMode: 'exclusive' | 'shared' = 'exclusive'): Promise<T> {
  return sql.begin((tx) => new StudentPortalPostgresPersistenceV1({ unsafe: (query, parameters) => tx.unsafe(query, parameters),
    begin: (callback) => callback(tx) }).transaction(async (store) => {
    await store.lockAcademicYear(2026, yearMode);
    return operation(tx, store);
  }));
}
/** Account-local work shares the academic snapshot barrier; account/credential/job locks still serialize mutations. */
export function accountTransactionV1<T>(sql: StudentPortalPostgresSqlV1,
  operation: (tx: StudentPortalPostgresQueryV1, store: PortalTransactionV1) => Promise<T>): Promise<T> {
  return authTransactionV1(sql, operation, 'shared');
}
export function authInstantV1(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(z.string().parse(value));
  if (!Number.isFinite(date.getTime())) throw new Error('student-portal-auth-clock-unavailable');
  return date;
}
export async function authNowV1(tx: StudentPortalPostgresQueryV1): Promise<Date> {
  return authInstantV1((await tx.unsafe('SELECT statement_timestamp() AS now'))[0]?.now);
}
/** Caller holds the common year lock and this account lock until the response data commits. */
export async function accessContextV1(sql: StudentPortalPostgresSqlV1, tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1, accountId: string, includeClosed = false) {
  const account = await store.findAccount(accountId);
  if (!account?.link || account.closedAt !== null || account.blocked || account.eligibility !== 'eligible') return null;
  const eligibility = await new AcademicEligibilityReaderPostgresV1(tx).readInTransaction(tx, account.link);
  if (eligibility.state !== 'eligible') return null;
  const policy = await new PolicyServiceV1(sql).readSnapshotInTransaction(tx, accountScopeV1(accountId));
  const now = await authNowV1(tx);
  const accessOpen = sessionExpiryV1(policy.enforcedValue, now, false) !== null;
  if (!accessOpen && !includeClosed) return null;
  return { account, policy, eligibility, now, accessOpen };
}
export type AccessContextV1 = NonNullable<Awaited<ReturnType<typeof accessContextV1>>>;
/** Who acted (the student by default), how it ended and its detail. */
type AuditOptionsV1 = { actorId?: string; result?: 'success' | 'denied'; detail?: AuditDetailV1 };
export async function authAuditV1(store: PortalTransactionV1, account: AccountRecordV1,
  kind: z.infer<typeof auditEventV1>['kind'], now: Date, requestId: string,
  { actorId = account.id, result = 'success', detail }: AuditOptionsV1 = {}) {
  await store.appendAudit({ eventId: crypto.randomUUID(), at: now.toISOString(), actorId, accountId: account.id,
    scope: accountScopeV1(account.id), kind, result, requestId, version: account.version, maskedIp: null,
    ...(detail && Object.keys(detail).length ? { detail } : {}) });
}
export async function revokeChallengesV1(tx: StudentPortalPostgresQueryV1, accountId: string, now: Date) {
  await tx.unsafe('UPDATE student_portal.auth_challenge SET consumed_at=$2::timestamptz WHERE account_id=$1::uuid AND consumed_at IS NULL',
    [accountId, now.toISOString()]);
}
