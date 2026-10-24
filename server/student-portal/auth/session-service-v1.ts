import { withAuditSqlV1 } from '../observability/audit-context-v1';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { adminCommandV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { opaqueV1, scopeV1, versionV1, type ScopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { sessionResponseV1 } from '../../../shared/student-portal-contracts/auth-v1';
import type { CryptoPortV1, PortalTransactionV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresQueryV1, StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { accessEndV1, sessionExpiryV1 } from '../policies/calendar-v1';
import { readPortalSnapshotV2 } from './read-snapshot-v2';
import { accessContextV1, accountScopeV1, authAuditV1, authInstantV1, authNowV1, authTransactionV1, accountTransactionV1, type AccessContextV1 } from './transaction-v1';

/** The query's one parameter: the account or the class; the whole school has none. */
function scopeParametersV1(scope: { kind: string; accountId?: unknown; classId?: unknown }) {
  if (scope.kind === 'account') return [scope.accountId];
  return scope.kind === 'class' ? [scope.classId] : [];
}

/** Only internal callers see the token. HTTP emits it exclusively as Set-Cookie after commit. */
export async function createSessionV1(store: PortalTransactionV1, context: AccessContextV1,
  cryptoPort: CryptoPortV1, persistent: boolean, requestId: string) {
  const expiresAt = sessionExpiryV1(context.policy.enforcedValue, context.now, persistent);
  if (!expiresAt) throw new Error('student-portal-session-unavailable');
  const token = cryptoPort.randomToken(32);
  await store.saveSession({ id: crypto.randomUUID(), accountId: context.account.id,
    tokenHash: await cryptoPort.hashOpaqueToken(token), securityVersion: context.account.securityVersion,
    expiresAt, revokedAt: null, persistent });
  return { token, body: sessionResponseV1.parse({ contractVersion: 1, requestId, state: 'authenticated', expiresAt, persistent }) };
}

export class SessionServiceV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1, private readonly cryptoPort: CryptoPortV1,
    clientIp?: string | null, private readonly snapshotReads = false,
    private readonly onVerifiedAccount?: (accountId: string) => Promise<void>) {
    // Read-only snapshots cannot append audit events. In particular, their SET TRANSACTION
    // must precede the audit wrapper's set_config SELECT, which would start a snapshot too early.
    if (clientIp !== undefined && !snapshotReads) this.sql = withAuditSqlV1(sql, clientIp);
  }

  private async revocationScope(tx: StudentPortalPostgresQueryV1, input: ScopeV1) {
    const scope = scopeV1.parse(input);
    let predicate: 'a.id=$1::uuid' | 'true' | `a.id IN (
      SELECT a2.id FROM student_portal.account a2 JOIN student_portal.academic_binding_v1 b
        ON b.student_id=a2.gradebook_student_id AND b.academic_year=a2.academic_year
      WHERE b.class_id=$1 AND b.status IS DISTINCT FROM 6)`;
    if (scope.kind === 'account') {
      predicate = 'a.id=$1::uuid';
    } else if (scope.kind === 'school') {
      predicate = 'true';
    } else {
      predicate = `a.id IN (
      SELECT a2.id FROM student_portal.account a2 JOIN student_portal.academic_binding_v1 b
        ON b.student_id=a2.gradebook_student_id AND b.academic_year=a2.academic_year
      WHERE b.class_id=$1 AND b.status IS DISTINCT FROM 6)`;
    }
    const rows = await tx.unsafe(`SELECT a.id,a.version::text FROM student_portal.account a
      WHERE a.academic_year=2026 AND ${predicate} ORDER BY a.id`,
    scopeParametersV1(scope));
    const accounts = rows.map((row) => ({ id: z.uuid().parse(row.id), version: versionV1.parse(Number(row.version)) }));
    if (scope.kind === 'account') return { accounts, version: accounts[0]?.version ?? 0 };
    const revision = await tx.unsafe(`SELECT (r.academic_counter+r.portal_link_counter+
      COALESCE((SELECT sum(version) FROM student_portal.account WHERE academic_year=2026),0))::text AS version
      FROM student_portal.academic_revision r WHERE r.academic_year=2026`);
    if (revision.length !== 1) throw new Error('student-portal-session-scope-unavailable');
    return { accounts, version: versionV1.parse(Number(revision[0]!.version)) };
  }

  /** This administrative read may be nested in the V1 facade's already-started transaction. */
  async readRevocationScope(scope: ScopeV1) {
    return authTransactionV1(this.sql, async (tx) => {
      const snapshot = await this.revocationScope(tx, scope);
      return { version: snapshot.version, count: snapshot.accounts.length };
    });
  }

  async revoke(actorId: string, input: unknown) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const command = adminCommandV1.parse(input);
    if (command.operation !== 'sessions-revoke') throw new Error('student-portal-session-command-invalid');
    const scope = command.scope.kind === 'account' ? { ...command.scope, accountId: command.scope.accountId.toLowerCase() } : command.scope;
    const digest = createHash('sha256').update(JSON.stringify({ ...command, scope })).digest('hex');
    const receiptActor = `sessions-revoke:${actor}`;
    return authTransactionV1(this.sql, async (tx, store) => {
      const now = await authNowV1(tx);
      const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
      if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
        if (receipt.requestDigest !== digest) throw new Error('student-portal-session-idempotency-conflict');
        return { operationId: receipt.operationId, version: receipt.version };
      }
      if (receipt) await tx.unsafe('DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2', [command.idempotencyKey, receiptActor]);
      const snapshot = await this.revocationScope(tx, scope);
      if (snapshot.version !== command.expectedVersion) throw new Error('student-portal-session-version-conflict');
      await store.lockAccounts(snapshot.accounts.map((account) => account.id));
      for (const item of snapshot.accounts) {
        const account = await store.findAccount(item.id);
        if (!account || account.version !== item.version) throw new Error('student-portal-session-version-conflict');
        const changed = await store.revokeSessions(accountScopeV1(item.id), now.toISOString(), command.sessionId);
        if (changed === 0) continue;
        const next = { ...account, version: account.version + 1 };
        if (!await store.compareAndSetAccount(next, account.version)) throw new Error('student-portal-session-version-conflict');
        await authAuditV1(store, next, 'session-revoked', now, command.idempotencyKey, { actorId: actor });
      }
      const version = (await this.revocationScope(tx, scope)).version;
      const operationId = crypto.randomUUID();
      await store.saveIdempotency({ key: command.idempotencyKey, actorId: receiptActor, requestDigest: digest,
        operationId, version, expiresAt: new Date(now.getTime() + 86_400_000).toISOString() });
      return { operationId, version };
    });
  }

  /** In snapshot mode the consumer must be read-only; its authorization and data cannot tear. */
  private async withSession<T>(token: string, includeClosed: boolean, expectedAccountId: string | undefined,
    operation: (context: AccessContextV1, tx: StudentPortalPostgresQueryV1,
      session: { id: string; expiresAt: string; persistent: boolean }) => Promise<T>):
    Promise<{ state: 'ready'; value: T } | { state: 'access-closed' } | null> {
    if (!opaqueV1.safeParse(token).success) return null;
    const hash = await this.cryptoPort.hashOpaqueToken(token);
    const transact = this.snapshotReads ? readPortalSnapshotV2 : accountTransactionV1;
    return transact(this.sql, async (tx, store) => {
      // A read-only repeatable snapshot cannot see a different session on a second lookup.
      // Commands still locate first, lock the account, then reread and lock the session below.
      const located = await tx.unsafe(this.snapshotReads
        ? 'SELECT account_id,id,security_version::text,expires_at,revoked_at,persistent,created_at FROM student_portal.session WHERE token_hash=$1'
        : 'SELECT account_id FROM student_portal.session WHERE token_hash=$1', [hash]);
      if (located.length !== 1) return null;
      const accountId = z.uuid().parse(located[0]!.account_id);
      if (expectedAccountId !== undefined && accountId !== expectedAccountId.toLowerCase()) return null;
      if (!this.snapshotReads) await store.lockAccounts([accountId]);
      const context = await accessContextV1(this.sql, tx, store, accountId, includeClosed);
      if (!context || context.account.state !== 'active') return null;
      const row = this.snapshotReads ? located[0] : (await tx.unsafe(`SELECT id,security_version::text,expires_at,revoked_at,persistent,created_at
        FROM student_portal.session WHERE token_hash=$1 AND account_id=$2::uuid FOR UPDATE`, [hash, accountId]))[0];
      if (!row || row.revoked_at !== null || Number(row.security_version) !== context.account.securityVersion) return null;
      const persistent = z.boolean().parse(row.persistent);
      const ttl = persistent ? context.policy.enforcedValue.risk.persistentSeconds : context.policy.enforcedValue.risk.shortSeconds;
      const tokenEnd = Math.min(authInstantV1(row.expires_at).getTime(), authInstantV1(row.created_at).getTime() + ttl * 1000);
      if (tokenEnd <= context.now.getTime()) return null;
      await this.onVerifiedAccount?.(context.account.id);
      if (!context.accessOpen) return { state: 'access-closed' };
      const end = Math.min(tokenEnd, accessEndV1(context.policy.enforcedValue, context.now));
      if (end <= context.now.getTime()) return null;
      return { state: 'ready', value: await operation(context, tx, { id: z.uuid().parse(row.id), expiresAt: new Date(end).toISOString(), persistent }) };
    });
  }

  async withAuthorized<T>(token: string, operation: (context: AccessContextV1, tx: StudentPortalPostgresQueryV1,
    session: { id: string; expiresAt: string; persistent: boolean }) => Promise<T>): Promise<T | null> {
    const result = await this.withSession(token, false, undefined, operation);
    return result?.state === 'ready' ? result.value : null;
  }

  async read(token: string, requestId: string, expectedAccountId?: string, includeClosed = false,
    onAuthorized?: (context: AccessContextV1, tx: StudentPortalPostgresQueryV1,
      session: { id: string; expiresAt: string; persistent: boolean }) => void | Promise<void>) {
    const result = await this.withSession(token, includeClosed, expectedAccountId, async (context, tx, session) => {
      await onAuthorized?.(context, tx, session);
      return sessionResponseV1.parse({
        contractVersion: 1, requestId, state: 'authenticated', expiresAt: session.expiresAt, persistent: session.persistent,
      });
    });
    if (result?.state === 'access-closed') return { contractVersion: 1 as const, requestId, state: 'access-closed' as const };
    return result?.state === 'ready' ? result.value : null;
  }

  async logout(token: string, requestId: string, onVerifiedAccount?: (accountId: string) => Promise<void>): Promise<void> {
    if (!opaqueV1.safeParse(token).success) return;
    const hash = await this.cryptoPort.hashOpaqueToken(token);
    await accountTransactionV1(this.sql, async (tx, store) => {
      const rows = await tx.unsafe('SELECT id,account_id FROM student_portal.session WHERE token_hash=$1 AND revoked_at IS NULL', [hash]);
      if (rows.length !== 1) return;
      const accountId = z.uuid().parse(rows[0]!.account_id);
      await store.lockAccounts([accountId]);
      const account = await store.findAccount(accountId);
      if (!account) return;
      await onVerifiedAccount?.(account.id);
      const now = await authNowV1(tx);
      await store.revokeSessions(accountScopeV1(accountId), now.toISOString(), z.uuid().parse(rows[0]!.id));
      await authAuditV1(store, account, 'session-revoked', now, requestId);
    });
  }
}
