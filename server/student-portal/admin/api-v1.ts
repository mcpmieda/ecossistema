import { readSchoolCalendarV1, setSchoolCalendarV1 } from './school-calendar-v1';
import { withAuditSqlV1 } from '../observability/audit-context-v1';
import { z } from 'zod';
import { adminReadQueryV2, type AdminReadResponseV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import { readAdminV2 } from './queries-v2';
import { saveSealCacheV1, type SealCacheWriteV1 } from './seal-cache-v1';
import { adminCommandV1, adminQueryV1, adminResponseV1, trustedAdminContextV1, type AdminQueryV1, type AdminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type { FailureV1, PolicyScopeV1, ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { CryptoPortV1, PortalAdminEntrypointV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { QrServiceV1 } from '../auth/qr-service-v1';
import { SessionServiceV1 } from '../auth/session-service-v1';
import { PolicyServiceV1 } from '../policies/policy-service-v1';
import { PublicationServiceV1 } from '../publication/publication-service-v1';
import { ScopedPublicationServiceV2 } from '../publication/scoped-publication-service-v2';
import { inheritPublicationV1 } from '../publication/publication-inheritance-v1';
import { LinkClosureServiceV1 } from '../integration/lifecycle/link-closure-v1';
import { authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { AdminCursorV1 } from './cursor-v1';
import { adminFailureStateV1, boundSqlV1 } from './common-v1';
import { readAccountListV1, readAdminHealthV1, readAuditV1 } from './queries-v1';
import { closeLinksIdempotentlyV1, qrBatchV1 } from './batches-v1';
import { readPopulationV1, startPopulationV1 } from './population-v1';
import { BulkAdminV1 } from './bulk-v1';

export { trustedAdminContextV1 } from '../../../shared/student-portal-contracts/admin-v1';
export type AdminApiOptionsV1 = { tenantId: string; cryptoPort: CryptoPortV1; qrKeyVersion: number; pepperVersion: number;
  cursorSecret: string; scopedPublication?: boolean };

/** Only the dedicated server-to-server ADM binding may invoke this facade. Shape validation is not authentication. */

/** A shift is a policy level only: the query contract allows it for settings reads alone. */
function plainScopeV1(scope: PolicyScopeV1): ScopeV1 {
  if (scope.kind === 'shift') throw new Error('student-portal-admin-scope-invalid');
  return scope;
}

export class PortalAdminApiV1 implements PortalAdminEntrypointV1 {
  private readonly cursor: AdminCursorV1;
  constructor(private readonly sql: StudentPortalPostgresSqlV1, private readonly options: AdminApiOptionsV1) {
    z.uuid().parse(options.tenantId);
    z.number().int().positive().max(999999).parse(options.qrKeyVersion);
    z.number().int().positive().safe().parse(options.pepperVersion);
    this.cursor = new AdminCursorV1(options.cursorSecret);
  }
  private context(input: unknown, write: boolean) {
    const parsed = trustedAdminContextV1.safeParse(input);
    if (!parsed.success) return null;
    const value = parsed.data;
    const age = Date.now() - Date.parse(value.authenticatedAt);
    if (value.tenantId.toLowerCase() !== this.options.tenantId.toLowerCase() || age < 0 || age > 300_000
      || (write && value.capability !== 'platform.settings.write')) return null;
    return { ...value, actorId: value.actorId.toLowerCase() };
  }
  private failure(requestId: string, state: FailureV1['state']): FailureV1 { return { contractVersion: 1, requestId, state }; }
  async query(inputContext: unknown, input: unknown): Promise<AdminResponseV1 | AdminReadResponseV2 | FailureV1> {
    if (input === null || typeof input !== 'object' || !('contractVersion' in input) || input.contractVersion !== 2)
      return this.queryV1(inputContext, input);
    const context = this.context(inputContext, false);
    if (!context) return this.failure(crypto.randomUUID(), 'forbidden');
    const parsed = adminReadQueryV2.safeParse(input);
    if (!parsed.success) return this.failure(context.requestId, 'invalid-request');
    try {
      const pendingSealWrites: SealCacheWriteV1[] = [];
      const response = await this.sql.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        return readAdminV2(tx, parsed.data, context.actorId, context.requestId, await authNowV1(tx), this.cursor, pendingSealWrites);
      });
      if (pendingSealWrites.length) await saveSealCacheV1(this.sql, pendingSealWrites);
      return response;
    } catch (error) { return this.failure(context.requestId, adminFailureStateV1(error)); }
  }
  private async queryV1(inputContext: unknown, input: unknown): Promise<AdminResponseV1 | FailureV1> {
    const context = this.context(inputContext, false);
    if (!context) return this.failure(crypto.randomUUID(), 'forbidden');
    const parsed = adminQueryV1.safeParse(input);
    if (!parsed.success) return this.failure(context.requestId, 'invalid-request');
    const query = parsed.data;
    if (['audit-detail', 'links-preview', 'bulk-preview'].includes(query.operation) && context.capability !== 'platform.settings.write')
      return this.failure(context.requestId, 'forbidden');
    if (!this.queryFieldsAllowed(query)) return this.failure(context.requestId, 'invalid-request');
    try {
      const base = { contractVersion: 1, requestId: context.requestId, state: query.operation };
      if (query.operation === 'bulk-preview')
        return await new BulkAdminV1(this.sql, this.options.cursorSecret,
          new QrServiceV1(this.sql, this.options.cryptoPort, this.options.qrKeyVersion, this.options.pepperVersion)).preview(context, query);
      if (this.options.scopedPublication && query.operation === 'publication')
        return adminResponseV1.parse({ ...base, items: (await new ScopedPublicationServiceV2(this.sql).read(plainScopeV1(query.scope))).items });
      if (this.options.scopedPublication && query.operation === 'settings')
        return adminResponseV1.parse({ ...base, settings: await new PolicyServiceV1(this.sql).read(query.scope) });
      if (query.operation === 'health') return await this.sql.begin(async (tx) => adminResponseV1.parse({
        ...base, ...await readAdminHealthV1(tx, query),
      }));
      const yearMode = query.operation === 'publication' || query.operation === 'settings' ? 'shared' : 'exclusive';
      return await authTransactionV1(withAuditSqlV1(this.sql, context.clientIp ?? null, context), async (tx) => {
        const sql = boundSqlV1(tx);
        const now = await authNowV1(tx);
        switch (query.operation) {
          case 'accounts': case 'birth-years':
            return adminResponseV1.parse({ ...base, ...await readAccountListV1(tx, query, context.actorId, now, this.cursor) });
          case 'sessions': {
            const version = (await new SessionServiceV1(sql, this.options.cryptoPort).readRevocationScope(plainScopeV1(query.scope))).version;
            return adminResponseV1.parse({ ...base, version, ...await readAccountListV1(tx, query, context.actorId, now, this.cursor) });
          }
          case 'settings': return adminResponseV1.parse({ ...base, settings: await new PolicyServiceV1(sql).read(query.scope) });
          case 'publication': return adminResponseV1.parse({ ...base, items: (await new PublicationServiceV1(sql).read(plainScopeV1(query.scope))).items });
          case 'audit': case 'audit-detail': return adminResponseV1.parse({ ...base, ...await readAuditV1(tx, query, context.actorId, now, this.cursor) });
          case 'links-preview':
            if (query.scope.kind !== 'school') throw new Error('student-portal-preview-forbidden');
            return adminResponseV1.parse({ ...base, ...await new LinkClosureServiceV1(sql).preview(context.actorId) });
          case 'school-calendar':
            if (query.scope.kind !== 'school') throw new Error('student-portal-school-calendar-forbidden');
            return adminResponseV1.parse({ ...base, state: 'school-calendar', calendar: await readSchoolCalendarV1(tx) });
          case 'population':
            if (query.scope.kind !== 'school') throw new Error('student-portal-population-forbidden');
            return adminResponseV1.parse({ ...base, ...await readPopulationV1(tx) });
          default: throw new Error('student-portal-query-invalid-request');
        }
      }, yearMode);
    } catch (error) { return this.failure(context.requestId, adminFailureStateV1(error)); }
  }
  private queryFieldsAllowed(query: AdminQueryV1) {
    if (query.operation === 'bulk-preview') return true;
    const accountList = ['accounts', 'birth-years', 'sessions'].includes(query.operation);
    const audit = ['audit', 'audit-detail'].includes(query.operation);
    if (!accountList && [query.accountState, query.blocked, query.nameSearch].some((value) => value !== undefined)) return false;
    if (!audit && [query.from, query.until, query.event, query.result, query.eventId].some((value) => value !== undefined)) return false;
    if (query.operation === 'audit' && query.eventId !== undefined) return false;
    return !query.page.cursor || (accountList || query.operation === 'audit');
  }
  async command(inputContext: unknown, input: unknown): Promise<AdminResponseV1 | FailureV1> {
    const context = this.context(inputContext, true);
    if (!context) return this.failure(crypto.randomUUID(), 'forbidden');
    const parsed = adminCommandV1.safeParse(input);
    if (!parsed.success) return this.failure(context.requestId, 'invalid-request');
    const command = parsed.data;
    const base = { contractVersion: 1, requestId: context.requestId };
    const committed = (result: { operationId: string; version: number }) => adminResponseV1.parse({ ...base, state: 'committed', ...result });
    const sql = withAuditSqlV1(this.sql, context.clientIp ?? null, context);
    try {
      switch (command.operation) {
        case 'bulk-execute':
          return await new BulkAdminV1(sql, this.options.cursorSecret,
            new QrServiceV1(sql, this.options.cryptoPort, this.options.qrKeyVersion, this.options.pepperVersion)).execute(context, command);
        case 'publication-inherit':
          if (!this.options.scopedPublication) throw new Error('student-portal-scoped-publication-unavailable');
          return committed(await inheritPublicationV1(sql, context.actorId, command));
        case 'qr-issue': case 'qr-reprint': case 'qr-regenerate': case 'password-reset': case 'account-reset': case 'block': {
          const result = await new QrServiceV1(sql, this.options.cryptoPort, this.options.qrKeyVersion, this.options.pepperVersion).command(context.actorId, command);
          return command.operation.startsWith('qr-') ? adminResponseV1.parse({ ...base, state: 'qr', version: result.version,
            cards: [{ accountId: command.accountId.toLowerCase(), mode: 'qr-only', qr: result.qr }] }) : committed(result);
        }
        case 'qr-batch': return adminResponseV1.parse({ ...base, state: 'qr', ...await qrBatchV1(sql, this.options.cryptoPort, this.options.qrKeyVersion, context.actorId, command, this.options.pepperVersion) });
        case 'sessions-revoke': return committed(await new SessionServiceV1(sql, this.options.cryptoPort).revoke(context.actorId, command));
        case 'birth-write': case 'birth-batch': return this.failure(context.requestId, 'invalid-request');
        case 'settings-set': case 'settings-inherit': return committed(await new PolicyServiceV1(sql).mutate(context.actorId, command));
        case 'publish': case 'publish-update': case 'unpublish':
          if (!this.options.scopedPublication) throw new Error('student-portal-scoped-publication-unavailable');
          return committed(await new ScopedPublicationServiceV2(sql).command(context.actorId, command));
        case 'links-close': return committed(await closeLinksIdempotentlyV1(sql, context.actorId, command));
        case 'population-start': return committed(await startPopulationV1(sql, context.actorId, command));
        case 'school-calendar-set': return committed(await setSchoolCalendarV1(sql, context.actorId, command));
      }
    } catch (error) { return this.failure(context.requestId, adminFailureStateV1(error)); }
  }
}
