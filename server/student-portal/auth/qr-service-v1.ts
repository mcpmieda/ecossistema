import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensureCanonicalPinV1 } from '../birth-year/canonical-pin-v1';
import {
  adminCommandV1,
  type AdminCommandV1,
} from '../../../shared/student-portal-contracts/admin-v1';
import { qrUrlV1 } from '../../../shared/student-portal-contracts/auth-v1';
import {
  PORTAL_ORIGIN_V1,
  scopeV1,
  instantV1,
  type ScopeV1,
} from '../../../shared/student-portal-contracts/core-v1';
import type {
  AccountRecordV1,
  CredentialRecordV1,
  CryptoPortV1,
  PortalTransactionV1,
} from '../../../shared/student-portal-contracts/ports-v1';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import {
  accountScopeV1,
  authAuditV1,
  authNowV1,
  authTransactionV1,
  revokeChallengesV1,
} from './transaction-v1';

const operations = [
  'qr-issue',
  'qr-reprint',
  'qr-regenerate',
  'password-reset',
  'account-reset',
  'block',
] as const;
type Operation = (typeof operations)[number];
type QrCommandV1 = Extract<AdminCommandV1, { operation: Operation }>;
export type BulkGuardV1 = { expectedScope: ScopeV1; proofExpiresAt: string; proofDigest: string };
const bulkGuardV1 = z
  .object({
    expectedScope: scopeV1,
    proofExpiresAt: instantV1,
    proofDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type QrResultV1 = { operationId: string; version: number; qr?: string };

const kinds = {
  'qr-issue': 'qr-issued',
  'qr-reprint': 'qr-reprinted',
  'qr-regenerate': 'qr-regenerated',
  'password-reset': 'password-reset',
  'account-reset': 'account-reset',
  block: 'blocked',
} as const;

function qrCommandV1(input: unknown): QrCommandV1 {
  const command = adminCommandV1.parse(input);
  if (!('accountId' in command) || !operations.includes(command.operation as Operation))
    throw new Error('student-portal-qr-command-invalid');
  return command as QrCommandV1;
}

function commandDigestV1(command: QrCommandV1, accountId: string) {
  return createHash('sha256')
    .update(JSON.stringify({ ...command, accountId }))
    .digest('hex');
}

function activeCredentialV1(credential: CredentialRecordV1 | null) {
  return credential?.state === 'active' ? credential : null;
}

function requiresRecoveryProofV1(operation: Operation, account: AccountRecordV1) {
  return (
    operation === 'password-reset' ||
    operation === 'account-reset' ||
    (operation.startsWith('qr-') && account.state !== 'active')
  );
}

async function assertRecoveryReadyV1(
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  account: AccountRecordV1,
  operation: Operation,
) {
  if (!requiresRecoveryProofV1(operation, account)) return;
  const birth = await store.readBirth(account.id);
  const pin = await tx.unsafe(
    `SELECT (pin_verifier IS NOT NULL AND pin_version=$2) AS ready
    FROM student_portal.password_credential WHERE account_id=$1::uuid`,
    [account.id, account.pinVersion],
  );
  if (!birth?.year || birth.confirmation !== 'confirmed' || pin[0]?.ready !== true)
    throw new Error('student-portal-qr-recovery-conflict');
}

function assertCredentialOperationV1(
  operation: Operation,
  credential: CredentialRecordV1 | null,
  active: CredentialRecordV1 | null,
) {
  if (operation === 'qr-reprint' && !active) throw new Error('student-portal-qr-unavailable');
  if (operation === 'qr-issue' && credential && !active)
    throw new Error('student-portal-qr-regeneration-required');
}

function operationFlagsV1(
  command: QrCommandV1,
  account: AccountRecordV1,
  active: CredentialRecordV1 | null,
) {
  const operation = command.operation;
  const newQr =
    (operation === 'qr-issue' && !active) ||
    operation === 'qr-regenerate' ||
    operation === 'account-reset';
  const resetPassword = operation === 'password-reset' || operation === 'account-reset';
  const blockChanged = operation === 'block' && command.blocked !== account.blocked;
  const securityChanged = operation === 'qr-regenerate' || resetPassword || blockChanged;
  return { newQr, resetPassword, securityChanged };
}

/** What a repeated request is checked against: the same command, by the same actor, now. */
type ReplayRequestV1 = {
  command: QrCommandV1;
  operation: Operation;
  account: AccountRecordV1;
  receiptActor: string;
  digest: string;
  now: Date;
  url: (credentialId: string, keyVersion: number) => Promise<string>;
  receiptOnly?: boolean;
};

async function replayReceiptV1(
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  { command, operation, account, receiptActor, digest, now, url, receiptOnly = false }: ReplayRequestV1,
): Promise<QrResultV1 | null> {
  const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
  if (!receipt) return null;
  if (Date.parse(receipt.expiresAt) <= now.getTime()) {
    await tx.unsafe(
      'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
      [command.idempotencyKey, receiptActor],
    );
    return null;
  }
  if (receipt.requestDigest !== digest) throw new Error('student-portal-qr-idempotency-conflict');
  if (receiptOnly || !operation.startsWith('qr-'))
    return { operationId: receipt.operationId, version: receipt.version };

  // Never replay a card after a later rotation/reset/closure changed its account.
  if (account.version !== receipt.version) throw new Error('student-portal-qr-version-conflict');
  const credential = await store.readCredentials(account.id);
  if (credential?.state !== 'active') throw new Error('student-portal-qr-unavailable');
  return {
    operationId: receipt.operationId,
    version: receipt.version,
    qr: await url(credential.credentialId, credential.keyVersion),
  };
}

/** The card an operation hands out: a new credential when it issues one, else the active one. */
type QrIssueV1 = {
  url: (credentialId: string, keyVersion: number) => Promise<string>;
  keyVersion: number;
  accountId: string;
  operation: Operation;
  active: CredentialRecordV1 | null;
  newQr: boolean;
  now: Date;
};

async function qrForOperationV1(
  tx: StudentPortalPostgresQueryV1,
  cryptoPort: CryptoPortV1,
  { url, keyVersion, accountId, operation, active, newQr, now }: QrIssueV1,
) {
  if (newQr) {
    const credentialId = cryptoPort.randomToken(32);
    const qr = await url(credentialId, keyVersion); // Missing signing key rolls back before issuance.
    await tx.unsafe(
      `UPDATE student_portal.qr_credential SET state='revoked',revoked_at=$2::timestamptz
      WHERE account_id=$1::uuid AND state='active'`,
      [accountId, now.toISOString()],
    );
    await tx.unsafe(
      `INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
      VALUES ($1,$2::uuid,$3,'active')`,
      [credentialId, accountId, keyVersion],
    );
    return qr;
  }
  if (operation.startsWith('qr-') && active) return url(active.credentialId, active.keyVersion);
  return undefined;
}

async function clearPasswordV1(
  tx: StudentPortalPostgresQueryV1,
  accountId: string,
  resetPassword: boolean,
) {
  if (!resetPassword) return;
  await tx.unsafe(
    'UPDATE student_portal.password_credential SET password_verifier=NULL,updated_at=statement_timestamp() WHERE account_id=$1::uuid',
    [accountId],
  );
}

function nextAccountStateV1(operation: Operation, account: AccountRecordV1) {
  if (operation === 'account-reset') return 'pending-activation' as const;
  if (operation === 'password-reset') return 'reset-required' as const;
  return account.state;
}

function nextAccountV1(
  command: QrCommandV1,
  account: AccountRecordV1,
  changed: boolean,
  securityChanged: boolean,
): AccountRecordV1 {
  return {
    ...account,
    version: account.version + (changed ? 1 : 0),
    securityVersion: account.securityVersion + (securityChanged ? 1 : 0),
    state: nextAccountStateV1(command.operation, account),
    blocked: command.operation === 'block' ? command.blocked : account.blocked,
  };
}

function auditKindV1(command: QrCommandV1) {
  if (command.operation === 'block' && !command.blocked) return 'unblocked' as const;
  return kinds[command.operation];
}

async function applySecurityChangeV1(
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  account: AccountRecordV1,
  next: AccountRecordV1,
  changed: boolean,
  securityChanged: boolean,
  now: Date,
) {
  if (changed && !(await store.compareAndSetAccount(next, account.version)))
    throw new Error('student-portal-qr-version-conflict');
  if (!securityChanged) return;
  await store.revokeSessions(accountScopeV1(account.id), now.toISOString());
  await revokeChallengesV1(tx, account.id, now);
}

async function saveReceiptV1(
  store: PortalTransactionV1,
  command: QrCommandV1,
  receiptActor: string,
  digest: string,
  version: number,
  now: Date,
) {
  const operationId = crypto.randomUUID();
  await store.saveIdempotency({
    key: command.idempotencyKey,
    actorId: receiptActor,
    requestDigest: digest,
    operationId,
    version,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  return operationId;
}

/** Private primitive: #713 supplies trusted admin authorization and transport; no public route. */

/** A bulk operation acts only while its preview proof lasts, and only on a student still in the
 * previewed scope (one current binding, in the previewed class). */
async function checkBulkGuardV1(
  tx: Parameters<Parameters<typeof authTransactionV1>[1]>[0],
  guard: z.infer<typeof bulkGuardV1>,
  studentId: number,
  accountId: string,
  now: Date,
) {
  if (Date.parse(guard.proofExpiresAt) <= now.getTime())
    throw new Error('student-portal-bulk-preview-conflict');
  const scope = guard.expectedScope;
  if (scope.kind === 'account' && scope.accountId.toLowerCase() !== accountId)
    throw new Error('student-portal-bulk-scope-forbidden');
  const rows = await tx.unsafe(
    `SELECT class_id FROM student_portal.academic_binding_v1
          WHERE academic_year=2026 AND student_id=$1 AND status IS DISTINCT FROM 6 ORDER BY class_id LIMIT 2`,
    [studentId],
  );
  if (
    rows.length !== 1 ||
    (scope.kind === 'class' && Number(rows[0]!.class_id) !== scope.classId)
  )
    throw new Error('student-portal-bulk-scope-conflict');
}

export class QrServiceV1 {
  constructor(
    private readonly sql: StudentPortalPostgresSqlV1,
    private readonly cryptoPort: CryptoPortV1,
    private readonly keyVersion: number,
    private readonly pepperVersion = 1,
  ) {
    z.number().int().positive().max(999999).parse(keyVersion);
  }

  private async url(credentialId: string, keyVersion: number): Promise<string> {
    const signature = await this.cryptoPort.signQr(credentialId, keyVersion);
    return qrUrlV1.parse(
      `${PORTAL_ORIGIN_V1}/access#v1.${credentialId}.${keyVersion}.${signature}`,
    );
  }

  async command(actorId: string, input: unknown, inputGuard?: BulkGuardV1) {
    const actor = z.uuid().parse(actorId).toLowerCase();
    const command = qrCommandV1(input);
    const operation = command.operation;
    const accountId = command.accountId.toLowerCase();
    const guard = inputGuard === undefined ? undefined : bulkGuardV1.parse(inputGuard);
    const digest = guard
      ? createHash('sha256').update(JSON.stringify({ command, accountId, guard })).digest('hex')
      : commandDigestV1(command, accountId);
    const receiptActor = `${operation}:${actor}`;

    return authTransactionV1(this.sql, async (tx, store) => {
      await store.lockAccounts([accountId]);
      const now = await authNowV1(tx);
      const account = await store.findAccount(accountId);
      if (!account || (!guard && (!account.link || account.closedAt !== null)))
        throw new Error('student-portal-qr-forbidden');

      const replay = await replayReceiptV1(tx, store, {
        command,
        operation,
        account,
        receiptActor,
        digest,
        now,
        url: (credentialId, version) => this.url(credentialId, version),
        receiptOnly: guard !== undefined,
      });
      if (replay) return replay;
      if (!account.link || account.closedAt !== null)
        throw new Error('student-portal-qr-forbidden');
      if (guard) await checkBulkGuardV1(tx, guard, account.link.studentId, accountId, now);

      if (account.version !== command.expectedVersion)
        throw new Error('student-portal-qr-version-conflict');
      const credential = await store.readCredentials(accountId);
      const active = activeCredentialV1(credential);
      if (operation === 'qr-issue' && account.state !== 'active')
        await ensureCanonicalPinV1(tx, this.cryptoPort, this.pepperVersion, account.id, account.pinVersion);
      await assertRecoveryReadyV1(tx, store, account, operation);
      assertCredentialOperationV1(operation, credential, active);

      const { newQr, resetPassword, securityChanged } = operationFlagsV1(command, account, active);
      const qr = await qrForOperationV1(tx, this.cryptoPort, {
        url: (credentialId, version) => this.url(credentialId, version),
        keyVersion: this.keyVersion,
        accountId,
        operation,
        active,
        newQr,
        now,
      });
      await clearPasswordV1(tx, accountId, resetPassword);

      const changed = newQr || securityChanged;
      const next = nextAccountV1(command, account, changed, securityChanged);
      await applySecurityChangeV1(tx, store, account, next, changed, securityChanged, now);
      await authAuditV1(store, next, auditKindV1(command), now, command.idempotencyKey, { actorId: actor });
      const operationId = await saveReceiptV1(
        store,
        command,
        receiptActor,
        digest,
        next.version,
        now,
      );

      // Account reset's public result is only a receipt; QR access uses a separate reprint command.
      return {
        operationId,
        version: next.version,
        ...(!guard && operation.startsWith('qr-') ? { qr } : {}),
      };
    });
  }
}
