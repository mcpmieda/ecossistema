import { withAuditSqlV1 } from '../observability/audit-context-v1';
import {
  emitPortalAuthResultMetricV1,
  type PortalAuthResultMetricV1,
} from '../observability/metrics-v1';
import type { AuthBurstGuardV1 } from '../observability/auth-burst-v1';
import { z } from 'zod';
import {
  activateRequestV1,
  challengeRequestV1,
  challengeResponseV1,
  loginRequestV1,
  qrUrlV1,
} from '../../../shared/student-portal-contracts/auth-v1';
import type { FailureV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { AuditDetailV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type {
  AttemptRecordV1,
  CredentialRecordV1,
  CryptoPortV1,
  PortalTransactionV1,
  VerifierV1,
} from '../../../shared/student-portal-contracts/ports-v1';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresSqlV1,
} from '../persistence/postgres-persistence-v1';
import {
  accessContextV1,
  authAuditV1,
  authNowV1,
  accountTransactionV1,
  revokeChallengesV1,
  type AccessContextV1,
} from './transaction-v1';
import { createSessionV1 } from './session-service-v1';
import { accessEndV1 } from '../policies/calendar-v1';
import type { RiskVerifierV1 } from './turnstile-v1';

const denied = (requestId: string): FailureV1 => ({
  contractVersion: 1,
  requestId,
  state: 'unauthenticated',
});
const accessClosed = (requestId: string): FailureV1 => ({
  contractVersion: 1,
  requestId,
  state: 'access-closed',
});
function required(requestId: string, next: 'pin' | 'password' | 'risk') {
  return challengeResponseV1.parse({
    contractVersion: 1,
    requestId,
    state: 'credential-required',
    next,
  });
}
export function parseQrV1(input: string) {
  const url = new URL(qrUrlV1.parse(input));
  const [, credentialId, keyVersion, signature] = url.hash.slice(1).split('.');
  return { credentialId: credentialId!, keyVersion: Number(keyVersion), signature: signature! };
}
async function attempts(
  store: PortalTransactionV1,
  context: AccessContextV1,
): Promise<AttemptRecordV1> {
  const previous = await store.readAttempts(context.account.id);
  if (
    previous &&
    previous.blockedUntil !== null &&
    Date.parse(previous.blockedUntil) > context.now.getTime()
  )
    return previous;
  if (
    !previous ||
    (previous.blockedUntil !== null &&
      Date.parse(previous.blockedUntil) <= context.now.getTime()) ||
    Date.parse(previous.windowStartedAt) +
      context.policy.enforcedValue.risk.failureWindowSeconds * 1000 <=
      context.now.getTime()
  ) {
    return {
      accountId: context.account.id,
      failures: 0,
      windowStartedAt: context.now.toISOString(),
      blockedUntil: null,
      version: previous?.version ?? 0,
    };
  }
  return previous;
}
function blocked(
  attempt: AttemptRecordV1,
  context: AccessContextV1,
  requestId: string,
): FailureV1 | null {
  if (attempt.blockedUntil === null || Date.parse(attempt.blockedUntil) <= context.now.getTime())
    return null;
  return {
    contractVersion: 1,
    requestId,
    state: 'rate-limited',
    retryAfterSeconds: Math.min(
      86400,
      Math.max(1, Math.ceil((Date.parse(attempt.blockedUntil) - context.now.getTime()) / 1000)),
    ),
  };
}
async function failed(
  store: PortalTransactionV1,
  context: AccessContextV1,
  previous: AttemptRecordV1,
  requestId: string,
  kind: 'pin' | 'password',
) {
  const failures = previous.failures + 1;
  const attempt = {
    ...previous,
    failures,
    version: previous.version + 1,
    blockedUntil:
      failures >= context.policy.enforcedValue.risk.blockAfter
        ? new Date(
            context.now.getTime() + context.policy.enforcedValue.risk.blockSeconds * 1000,
          ).toISOString()
        : null,
  };
  await store.saveAttempts(attempt);
  await authAuditV1(
    store,
    context.account,
    'login-failed',
    context.now,
    requestId,
    { actorId: context.account.id, result: 'denied', detail: {
      reason: kind === 'pin' ? 'wrong-pin' : 'wrong-password',
      step: kind,
      failures,
      blockAfter: context.policy.enforcedValue.risk.blockAfter,
      ...(attempt.blockedUntil ? { blockedUntil: attempt.blockedUntil } : {}),
    } },
  );
  // Return, never throw: a failed credential must commit its durable counter.
  return blocked(attempt, context, requestId) ?? denied(requestId);
}
async function clearAttempts(
  store: PortalTransactionV1,
  context: AccessContextV1,
  previous: AttemptRecordV1,
) {
  await store.saveAttempts({
    ...previous,
    failures: 0,
    windowStartedAt: context.now.toISOString(),
    blockedUntil: null,
    version: previous.version + 1,
  });
}
async function auditedDenied(
  store: PortalTransactionV1,
  account: AccessContextV1['account'],
  now: Date,
  requestId: string,
  detail?: AuditDetailV1,
) {
  await authAuditV1(store, account, 'login-failed', now, requestId, { actorId: account.id, result: 'denied', detail });
  return denied(requestId);
}

/** Why an account cannot sign in now, read from the account itself (blocked, left the school). */
function unavailableReasonV1(account: AccessContextV1['account']): AuditDetailV1['reason'] {
  return account.blocked ? 'account-blocked' : 'not-enrolled';
}

/** A refusal while the account is temporarily blocked after wrong attempts. */
async function auditedBlockedV1(
  store: PortalTransactionV1,
  context: AccessContextV1,
  attempt: AttemptRecordV1,
  requestId: string,
  step: NonNullable<AuditDetailV1['step']>,
) {
  await authAuditV1(store, context.account, 'login-failed', context.now, requestId, { actorId: context.account.id, result: 'denied', detail: {
    reason: 'temporarily-blocked',
    step,
    failures: attempt.failures,
    blockAfter: context.policy.enforcedValue.risk.blockAfter,
    ...(attempt.blockedUntil ? { blockedUntil: attempt.blockedUntil } : {}),
  } });
}

function sameVerifier(left: VerifierV1, right: VerifierV1): boolean {
  const parameters = (value: VerifierV1) =>
    Object.entries(value.parameters).sort(([a], [b]) => a.localeCompare(b));
  return left.algorithm === right.algorithm
    && left.salt === right.salt
    && left.pepperVersion === right.pepperVersion
    && left.digest === right.digest
    && JSON.stringify(parameters(left)) === JSON.stringify(parameters(right));
}

type QrIdentityV1 = ReturnType<typeof parseQrV1>;
type CredentialProofV1 = { accountId: string; verifier: VerifierV1; valid: boolean };

async function activeQrAccountIdV1(
  sql: StudentPortalPostgresQueryV1,
  qr: QrIdentityV1,
): Promise<string | null> {
  const rows = await sql.unsafe(
    "SELECT account_id FROM student_portal.qr_credential WHERE credential_id=$1 AND key_version=$2 AND state='active'",
    [qr.credentialId, qr.keyVersion],
  );
  return rows.length === 1 ? z.uuid().parse(rows[0]!.account_id) : null;
}

async function lockedCredentialV1(store: PortalTransactionV1, accountId: string) {
  await store.lockAccounts([accountId]);
  const account = await store.findAccount(accountId);
  if (!account) return null;
  return { account, credential: await store.readCredentials(accountId) };
}

type QrAuthStateV1 =
  | { result: FailureV1 }
  | {
      accountId: string;
      context: AccessContextV1;
      credential: CredentialRecordV1;
      attempt: AttemptRecordV1;
    };

async function qrAuthStateV1(
  sql: StudentPortalPostgresSqlV1,
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  qr: QrIdentityV1,
  requestId: string,
  step: NonNullable<AuditDetailV1['step']>,
): Promise<QrAuthStateV1> {
  const accountId = await activeQrAccountIdV1(tx, qr);
  if (!accountId) return { result: denied(requestId) };
  const locked = await lockedCredentialV1(store, accountId);
  if (!locked) return { result: denied(requestId) };
  const { account, credential } = locked;
  if (
    credential?.state !== 'active' ||
    credential.credentialId !== qr.credentialId ||
    credential.keyVersion !== qr.keyVersion
  )
    return {
      result: await auditedDenied(store, account, await authNowV1(tx), requestId, { reason: 'card-replaced', step }),
    };
  const context = await accessContextV1(sql, tx, store, accountId, true);
  if (!context)
    return {
      result: await auditedDenied(store, account, await authNowV1(tx), requestId, {
        reason: unavailableReasonV1(account),
        step,
      }),
    };
  if (!context.accessOpen) {
    await authAuditV1(store, account, 'login-failed', context.now, requestId, { actorId: account.id, result: 'denied', detail: {
      reason: 'access-closed',
      step,
    } });
    return { result: accessClosed(requestId) };
  }
  return { accountId, context, credential, attempt: await attempts(store, context) };
}

async function credentialProofV1(
  sql: StudentPortalPostgresSqlV1,
  cryptoPort: CryptoPortV1,
  qr: QrIdentityV1,
  secret: string,
  kind: 'pin' | 'password',
  requestId: string,
  riskPassed: boolean,
): Promise<CredentialProofV1 | null> {
  const snapshot = await accountTransactionV1(sql, async (tx, store) => {
    const accountId = await activeQrAccountIdV1(tx, qr);
    if (!accountId) return null;
    const locked = await lockedCredentialV1(store, accountId);
    if (!locked) return null;
    const { account, credential } = locked;
    const stateAllowed =
      kind === 'password'
        ? account.state === 'active'
        : account.state === 'pending-activation' || account.state === 'reset-required';
    if (
      !stateAllowed ||
      credential?.state !== 'active' ||
      credential.credentialId !== qr.credentialId ||
      credential.keyVersion !== qr.keyVersion
    )
      return null;
    const context = await accessContextV1(sql, tx, store, accountId);
    if (!context) return null;
    const attempt = await attempts(store, context);
    if (blocked(attempt, context, requestId)) return null;
    if (attempt.failures >= context.policy.enforcedValue.risk.challengeAfter && !riskPassed)
      return null;
    const verifier = kind === 'pin' ? credential.pin : credential.password;
    return verifier ? { accountId, verifier } : null;
  });
  if (!snapshot) return null;
  return {
    ...snapshot,
    valid: await cryptoPort.verifySecret(secret, snapshot.verifier),
  };
}

type ActivationStateV1 = {
  accountId: string;
  context: AccessContextV1;
  credential: CredentialRecordV1;
  attempt: AttemptRecordV1;
};

async function activationStateV1(
  sql: StudentPortalPostgresSqlV1,
  tx: StudentPortalPostgresQueryV1,
  store: PortalTransactionV1,
  hash: string,
  requestId: string,
): Promise<ActivationStateV1 | FailureV1> {
  const rows = await tx.unsafe(
    `SELECT account_id,
    (consumed_at IS NULL AND expires_at>statement_timestamp()) AS usable,
    (expires_at<=statement_timestamp()) AS expired
    FROM student_portal.auth_challenge WHERE token_hash=$1`,
    [hash],
  );
  if (rows.length !== 1) return denied(requestId);
  const accountId = z.uuid().parse(rows[0]!.account_id);
  const locked = await lockedCredentialV1(store, accountId);
  if (!locked) return denied(requestId);
  const { account, credential } = locked;
  const context = await accessContextV1(sql, tx, store, accountId);
  const birth = await store.readBirth(accountId);
  if (!context)
    return auditedDenied(store, account, await authNowV1(tx), requestId, {
      reason: account.blocked ? 'account-blocked' : 'retry-needed',
      step: 'create',
    });
  const createDenied = (reason: NonNullable<AuditDetailV1['reason']>) =>
    auditedDenied(store, context.account, context.now, requestId, { reason, step: 'create' });
  // Only a proven deadline is reported as expired; a consumed proof is a retry.
  if (rows[0]!.usable !== true)
    return createDenied(rows[0]!.expired === true ? 'password-window-expired' : 'retry-needed');
  if (context.account.state === 'active') return createDenied('already-active');
  if (
    credential?.state !== 'active' ||
    !credential.pin ||
    credential.pinVersion !== context.account.pinVersion ||
    !birth?.year ||
    birth.confirmation !== 'confirmed'
  )
    return createDenied('retry-needed');
  const attempt = await attempts(store, context);
  const limited = blocked(attempt, context, requestId);
  if (limited) {
    await auditedBlockedV1(store, context, attempt, requestId, 'create');
    return limited;
  }
  const valid = await tx.unsafe(
    `SELECT token_hash FROM student_portal.auth_challenge WHERE token_hash=$1
    AND account_id=$2::uuid AND security_version=$3 AND pin_version=$4
    AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
    [hash, accountId, context.account.securityVersion, context.account.pinVersion],
  );
  if (valid.length !== 1) return createDenied('retry-needed');
  return { accountId, context, credential, attempt };
}

type AuthStepV1 = PortalAuthResultMetricV1['step'];

/** Terminal outcome of one public call; refusal reasons stay in the audit detail only (#1207). */
function authResultV1(step: AuthStepV1, result: unknown): PortalAuthResultMetricV1 {
  const event = 'student-portal-auth-result-v1' as const;
  const value = (result ?? {}) as { state?: unknown; next?: unknown; body?: { state?: unknown } };
  if (value.body?.state === 'authenticated' || value.state === 'password-creation')
    return { event, step, outcome: 'issued' };
  if (value.state === 'credential-required')
    return { event, step, outcome: 'required', next: value.next as 'pin' | 'password' | 'risk' };
  if (value.state === 'unauthenticated') return { event, step, outcome: 'denied' };
  if (value.state === 'rate-limited') return { event, step, outcome: 'blocked' };
  if (value.state === 'access-closed') return { event, step, outcome: 'access-closed' };
  if (value.state === 'invalid-request') return { event, step, outcome: 'invalid-request' };
  return { event, step, outcome: 'unavailable' };
}

async function withAuthResultV1<Request, Result>(
  step: AuthStepV1,
  parse: () => Request,
  run: (request: Request) => Promise<Result>,
): Promise<Result> {
  let request: Request;
  try {
    request = parse();
  } catch (error) {
    emitPortalAuthResultMetricV1({ event: 'student-portal-auth-result-v1', step, outcome: 'invalid-request' });
    throw error;
  }
  let result: Result;
  try {
    result = await run(request);
  } catch (error) {
    emitPortalAuthResultMetricV1({ event: 'student-portal-auth-result-v1', step, outcome: 'unavailable' });
    throw error;
  }
  emitPortalAuthResultMetricV1(authResultV1(step, result));
  return result;
}

export class AuthServiceV1 {
  constructor(
    private readonly sql: StudentPortalPostgresSqlV1,
    private readonly cryptoPort: CryptoPortV1,
    private readonly pepperVersion: number,
    private readonly risk: RiskVerifierV1,
    clientIp?: string | null,
    private readonly burst?: AuthBurstGuardV1,
    /** Coarse device family of the request, kept with sign-in events for support. */
    private readonly device?: AuditDetailV1['device'],
  ) {
    if (clientIp !== undefined) this.sql = withAuditSqlV1(sql, clientIp);
    z.number().int().positive().safe().parse(pepperVersion);
  }

  private async qrAccount(qr: string) {
    const payload = parseQrV1(qr);
    if (
      !(await this.cryptoPort.verifyQr(payload.credentialId, payload.keyVersion, payload.signature))
    )
      return null;
    return payload;
  }

  async challenge(input: unknown, requestId: string) {
    return withAuthResultV1(
      'challenge',
      () => challengeRequestV1.parse(input),
      (request) => this.challengeRequest(request, requestId),
    );
  }

  private async challengeRequest(request: z.infer<typeof challengeRequestV1>, requestId: string) {
    const qr = await this.qrAccount(request.qr);
    if (!qr) return denied(requestId);
    if (this.burst && !(await this.burst(request.qr)))
      return {
        contractVersion: 1 as const,
        requestId,
        state: 'rate-limited' as const,
        retryAfterSeconds: 60,
      };
    // Remote verification finishes before acquiring any database lock.
    const riskPassed =
      request.riskToken === undefined ? false : await this.risk.verify(request.riskToken);
    const pinProof = request.pin === undefined
      ? null
      : await credentialProofV1(
          this.sql,
          this.cryptoPort,
          qr,
          request.pin,
          'pin',
          requestId,
          riskPassed,
        );
    const step = request.pin === undefined ? 'card' : 'pin';
    const device = this.device ? { device: this.device } : {};
    return accountTransactionV1(this.sql, async (tx, store) => {
      const locked = await qrAuthStateV1(this.sql, tx, store, qr, requestId, step);
      if ('result' in locked) return locked.result;
      const { accountId, context, credential, attempt } = locked;
      const limited = blocked(attempt, context, requestId);
      if (limited) {
        await auditedBlockedV1(store, context, attempt, requestId, step);
        return limited;
      }
      if (context.account.state === 'active') {
        if (attempt.failures >= context.policy.enforcedValue.risk.challengeAfter && !riskPassed)
          return required(requestId, 'risk');
        return required(requestId, 'password');
      }
      const birth = await store.readBirth(accountId);
      if (
        !birth?.year ||
        birth.confirmation !== 'confirmed' ||
        !credential.pin ||
        credential.pinVersion !== context.account.pinVersion
      )
        return auditedDenied(store, context.account, context.now, requestId, {
          reason: 'first-access-not-ready',
          step,
          ...device,
        });
      if (attempt.failures >= context.policy.enforcedValue.risk.challengeAfter && !riskPassed)
        return required(requestId, 'risk');
      if (request.pin === undefined) return required(requestId, 'pin');
      if (
        !pinProof ||
        pinProof.accountId !== accountId ||
        !sameVerifier(pinProof.verifier, credential.pin)
      )
        return auditedDenied(store, context.account, context.now, requestId, { reason: 'retry-needed', step, ...device });
      if (!pinProof.valid) return failed(store, context, attempt, requestId, 'pin');
      context.now = await authNowV1(tx);
      const token = this.cryptoPort.randomToken(32);
      const expiresAt = new Date(
        Math.min(
          context.now.getTime() + context.policy.enforcedValue.risk.challengeTtlSeconds * 1000,
          accessEndV1(context.policy.enforcedValue, context.now),
        ),
      ).toISOString();
      if (Date.parse(expiresAt) <= context.now.getTime())
        return auditedDenied(store, context.account, context.now, requestId, {
          reason: 'password-window-expired',
          step,
          ...device,
        });
      // A retry of the same PIN request replaces its earlier proof; only the latest response can activate.
      await revokeChallengesV1(tx, accountId, context.now);
      await store.saveChallenge({
        tokenHash: await this.cryptoPort.hashOpaqueToken(token),
        accountId,
        securityVersion: context.account.securityVersion,
        pinVersion: context.account.pinVersion,
        expiresAt,
        consumedAt: null,
      });
      return challengeResponseV1.parse({
        contractVersion: 1,
        requestId,
        state: 'password-creation',
        challenge: token,
        expiresAt,
      });
    });
  }

  async activate(input: unknown, requestId: string) {
    return withAuthResultV1(
      'activate',
      () => activateRequestV1.parse(input),
      (request) => this.activateRequest(request, requestId),
    );
  }

  private async activateRequest(request: z.infer<typeof activateRequestV1>, requestId: string) {
    if (this.burst && !(await this.burst(request.challenge)))
      return {
        contractVersion: 1 as const,
        requestId,
        state: 'rate-limited' as const,
        retryAfterSeconds: 60,
      };
    const hash = await this.cryptoPort.hashOpaqueToken(request.challenge);
    const preflight = await accountTransactionV1(
      this.sql,
      (tx, store) => activationStateV1(this.sql, tx, store, hash, requestId),
    );
    if ('contractVersion' in preflight) return preflight;

    const password = await this.cryptoPort.deriveVerifier(request.password, this.pepperVersion);

    return accountTransactionV1(this.sql, async (tx, store) => {
      const current = await activationStateV1(this.sql, tx, store, hash, requestId);
      if ('contractVersion' in current) return current;
      if (current.accountId !== preflight.accountId) return denied(requestId);
      current.context.now = await authNowV1(tx);
      if (
        !(await store.consumeChallenge(
          hash,
          current.context.account.securityVersion,
          current.context.account.pinVersion,
          current.context.now.toISOString(),
        ))
      )
        return auditedDenied(store, current.context.account, current.context.now, requestId, {
          reason: 'retry-needed',
          step: 'create',
        });
      const expectedVersion = current.context.account.version;
      current.context.account = {
        ...current.context.account,
        state: 'active',
        version: expectedVersion + 1,
      };
      if (!(await store.compareAndSetAccount(current.context.account, expectedVersion)))
        throw new Error('student-portal-auth-conflict');
      await store.saveCredentials({ ...current.credential, password });
      await revokeChallengesV1(tx, current.accountId, current.context.now);
      await clearAttempts(store, current.context, current.attempt);
      await authAuditV1(
        store,
        current.context.account,
        'activated',
        current.context.now,
        requestId,
        { actorId: current.context.account.id, result: 'success', detail: { keepConnected: request.keepConnected, ...(this.device ? { device: this.device } : {}) } },
      );
      return createSessionV1(
        store,
        current.context,
        this.cryptoPort,
        request.keepConnected,
        requestId,
      );
    });
  }

  async login(input: unknown, requestId: string) {
    return withAuthResultV1(
      'login',
      () => loginRequestV1.parse(input),
      (request) => this.loginRequest(request, requestId),
    );
  }

  private async loginRequest(request: z.infer<typeof loginRequestV1>, requestId: string) {
    const qr = await this.qrAccount(request.qr);
    if (!qr) return denied(requestId);
    if (this.burst && !(await this.burst(request.qr)))
      return {
        contractVersion: 1 as const,
        requestId,
        state: 'rate-limited' as const,
        retryAfterSeconds: 60,
      };
    const riskPassed =
      request.riskToken === undefined ? false : await this.risk.verify(request.riskToken);
    const passwordProof = await credentialProofV1(
      this.sql,
      this.cryptoPort,
      qr,
      request.password,
      'password',
      requestId,
      riskPassed,
    );
    const device = this.device ? { device: this.device } : {};
    return accountTransactionV1(this.sql, async (tx, store) => {
      const locked = await qrAuthStateV1(this.sql, tx, store, qr, requestId, 'password');
      if ('result' in locked) return locked.result;
      const { accountId, context, credential, attempt } = locked;
      const passwordDenied = (reason: NonNullable<AuditDetailV1['reason']>) =>
        auditedDenied(store, context.account, context.now, requestId, { reason, step: 'password', ...device });
      if (context.account.state !== 'active' || !credential.password)
        return passwordDenied('first-access-pending');
      const limited = blocked(attempt, context, requestId);
      if (limited) {
        await auditedBlockedV1(store, context, attempt, requestId, 'password');
        return limited;
      }
      if (attempt.failures >= context.policy.enforcedValue.risk.challengeAfter && !riskPassed)
        return passwordDenied('verification-required');
      if (
        !passwordProof ||
        passwordProof.accountId !== accountId ||
        !sameVerifier(passwordProof.verifier, credential.password)
      )
        return passwordDenied('retry-needed');
      if (!passwordProof.valid) return failed(store, context, attempt, requestId, 'password');
      context.now = await authNowV1(tx);
      await clearAttempts(store, context, attempt);
      await authAuditV1(store, context.account, 'login', context.now, requestId, { actorId: context.account.id, result: 'success', detail: {
        keepConnected: request.keepConnected,
        ...device,
      } });
      return createSessionV1(store, context, this.cryptoPort, request.keepConnected, requestId);
    });
  }
}
