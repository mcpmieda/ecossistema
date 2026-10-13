import type { LiveDrainContextV1 } from './live-v1';
import type { z } from 'zod';
import type { AdminReadQueryV2, AdminReadResponseV2 } from './admin-read-v2';
import type { AdminCommandV1, AdminQueryV1, AdminResponseV1, auditEventV1, trustedAdminContextV1 } from './admin-v1';
import type { AcademicLinkV1, ScopeV1, RevisionsV1, FailureV1, accountStateV1, eligibilityStateV1 } from './core-v1';
import type { EffectiveSettingsV1 } from './policy-v1';
import type { SelfResponseV1 } from './self-v1';

// Internal ports are not HTTP DTOs. #703 owns the shared BN implementation contract.
export interface ClockPortV1 { now(): Date }
export interface VerifierV1 { algorithm: string; parameters: Readonly<Record<string, number>>; salt: string; pepperVersion: number; digest: string }
export interface CryptoPortV1 {
  randomToken(bytes: number): string;
  hashOpaqueToken(token: string): Promise<string>;
  deriveVerifier(secret: string, pepperVersion: number): Promise<VerifierV1>;
  verifySecret(secret: string, verifier: VerifierV1): Promise<boolean>;
  signQr(credentialId: string, keyVersion: number): Promise<string>;
  verifyQr(credentialId: string, keyVersion: number, signature: string): Promise<boolean>;
}
export interface AccountRecordV1 {
  id: string; link: AcademicLinkV1 | null; state: z.infer<typeof accountStateV1>;
  eligibility: z.infer<typeof eligibilityStateV1>; blocked: boolean;
  version: number; securityVersion: number; pinVersion: number; closedAt: string | null;
}
export interface SessionRecordV1 {
  id: string; accountId: string; tokenHash: string; securityVersion: number;
  expiresAt: string; revokedAt: string | null; persistent: boolean;
}
export interface ChallengeRecordV1 {
  tokenHash: string; accountId: string; securityVersion: number; pinVersion: number;
  expiresAt: string; consumedAt: string | null;
}
export interface RevisionEventV1 {
  eventId: string; academicYear: 2026; studentIds: readonly number[]; dataVersion: string;
  cause: 'relation' | 'marks' | 'council' | 'academic-policy'; occurredAt: string;
}
export interface PublicationJobV1 {
  id: string; accountId: string; target: RevisionsV1; state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number; nextAttemptAt: string; leaseUntil: string | null;
}
export interface CredentialRecordV1 {
  accountId: string; credentialId: string; keyVersion: number; state: 'active' | 'revoked';
  pin: VerifierV1 | null; password: VerifierV1 | null; pinVersion: number;
}
export interface BirthRecordV1 { accountId: string; year: string | null; confirmation: 'confirmed' | 'unconfirmed-test' | null; version: number }
export interface AttemptRecordV1 { accountId: string; failures: number; windowStartedAt: string; blockedUntil: string | null; version: number }
export interface IdempotencyRecordV1 { key: string; actorId: string; requestDigest: string; operationId: string; version: number; expiresAt: string }
export interface PortalTransactionV1 {
  /** Shared consumers never change academic/link revisions; writers retain the exclusive default. */
  lockAcademicYear(year: 2026, mode?: 'exclusive' | 'shared'): Promise<void>;
  lockAccounts(accountIdsSorted: readonly string[]): Promise<void>;
  findAccount(id: string): Promise<AccountRecordV1 | null>;
  findByLink(link: AcademicLinkV1): Promise<AccountRecordV1 | null>;
  insertAccount(record: AccountRecordV1): Promise<'created' | 'existing'>;
  compareAndSetAccount(record: AccountRecordV1, expectedVersion: number): Promise<boolean>;
  saveSession(record: SessionRecordV1): Promise<void>;
  revokeSessions(scope: ScopeV1, revokedAt: string, sessionId?: string): Promise<number>;
  consumeChallenge(hash: string, securityVersion: number, pinVersion: number, now: string): Promise<boolean>;
  saveChallenge(record: ChallengeRecordV1): Promise<void>;
  readCredentials(accountId: string): Promise<CredentialRecordV1 | null>;
  saveCredentials(record: CredentialRecordV1): Promise<void>;
  readBirth(accountId: string): Promise<BirthRecordV1 | null>;
  readAttempts(accountId: string): Promise<AttemptRecordV1 | null>;
  saveAttempts(record: AttemptRecordV1): Promise<void>;
  readIdempotency(key: string, actorId: string): Promise<IdempotencyRecordV1 | null>;
  saveIdempotency(record: IdempotencyRecordV1): Promise<void>;
  appendAudit(event: z.infer<typeof auditEventV1>): Promise<void>;
  compareAndSetSettings(settings: EffectiveSettingsV1, expectedVersion: number): Promise<boolean>;
  closeAcademicLinks(year: 2026, expectedCount: number, closedAt: string): Promise<number>;
  appendRevision(event: RevisionEventV1): Promise<void>;
  enqueuePublication(job: PublicationJobV1): Promise<'created' | 'existing'>;
}
export interface PersistencePortV1 {
  transaction<T>(operation: (tx: PortalTransactionV1) => Promise<T>): Promise<T>;
  findSessionByHash(hash: string): Promise<SessionRecordV1 | null>;
}
export interface EffectivePolicyPortV1 { read(scope: ScopeV1): Promise<EffectiveSettingsV1> }
export interface AcademicEligibilityPortV1 {
  readCurrent(link: AcademicLinkV1): Promise<{ state: z.infer<typeof eligibilityStateV1>; classId: number | null; dataVersion: string }>;
}
export interface AcademicStudentReaderPortV1 {
  readOfficial(link: AcademicLinkV1, expectedDataVersion: string): Promise<{
    dataVersion: string; profile: SelfResponseV1['profile']; subjects: SelfResponseV1['subjects'];
  } | null>;
}
export interface YearResetPortalGuardPortV1 {
  countLinkedInTransaction(tx: PortalTransactionV1, year: 2026): Promise<number>;
}
export interface PublishedProjectionPortV1 {
  readAuthorized(accountId: string, expected: RevisionsV1): Promise<SelfResponseV1 | null>;
}
export type TrustedAdminContextV1 = z.infer<typeof trustedAdminContextV1>;
export interface PortalAdminEntrypointV1 {
  query(context: TrustedAdminContextV1, request: AdminQueryV1 | AdminReadQueryV2): Promise<AdminResponseV1 | AdminReadResponseV2 | FailureV1>;
  command(context: TrustedAdminContextV1, request: AdminCommandV1): Promise<AdminResponseV1 | FailureV1>;
}
/** Internal service capability only; never accepted as identity from public HTTP. */
export type AdminOperationV1 = 'read' | 'import' | 'write' | 'export' | 'live' | 'revoke';
export interface ReconciliationCredentialRequestV1 {
  contractVersion: 1; batchId: string; generation: string; expectedScopeRevision: number;
}
export interface ReconciliationCredentialResultV1 {
  state: 'ready' | 'preparing' | 'conflict' | 'expired'; preparedCount: number; remainingCount: number;
}
export interface PortalAdminServiceBindingV1 extends PortalAdminEntrypointV1 {
  prepareReconciliationCredentials?(context: TrustedAdminContextV1, request: ReconciliationCredentialRequestV1): Promise<ReconciliationCredentialResultV1 | FailureV1>;
  limitOperation?(context: TrustedAdminContextV1, operation: AdminOperationV1): Promise<FailureV1 | null>;
  drainLive?(context: LiveDrainContextV1): Promise<boolean>;
  fetch?(request: Request): Promise<Response>;
}
