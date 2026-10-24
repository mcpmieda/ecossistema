import { createHash } from 'node:crypto';
import { z } from 'zod';
import { seal, unseal } from '../../auth/sealed';
import {
  BULK_REQUEST_MAX_BYTES_V1,
  bulkActionV1,
  bulkCursorV1,
  bulkExecuteCommandV1,
  bulkExecuteResponseV1,
  bulkPreviewQueryV1,
  bulkPreviewResponseV1,
  bulkProofTokenV1,
  bulkScopeV1,
  type BulkExecuteCommandV1,
} from '../../../shared/student-portal-contracts/bulk-v1';
import { portalIdV1, versionV1 } from '../../../shared/student-portal-contracts/core-v1';
import { trustedAdminContextV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type { TrustedAdminContextV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import type { QrServiceV1 } from '../auth/qr-service-v1';
import { accountScopeV1, authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { accountsScopeVersionV1 } from './common-v1';
import { ACCOUNT_JOIN_V1, ENROLLED_ACCOUNT_SQL_V1 } from './queries-v1';

const TTL = 300_000;
const proofItemV1 = z
  .object({
    accountId: portalIdV1,
    version: versionV1,
    classId: z.number().int().positive().safe(),
  })
  .strict();
const proofV1 = z
  .object({
    v: z.literal(1),
    domain: z.literal('student-portal-bulk-proof-v1'),
    actor: portalIdV1,
    action: bulkActionV1,
    scope: bulkScopeV1,
    scopeVersion: versionV1,
    created: z.number().int().positive(),
    expires: z.number().int().positive(),
    items: z.array(proofItemV1).max(100),
  })
  .strict();
const cursorV1 = z
  .object({
    v: z.literal(1),
    domain: z.literal('student-portal-bulk-cursor-v1'),
    actor: portalIdV1,
    action: bulkActionV1,
    scope: bulkScopeV1,
    scopeVersion: versionV1,
    created: z.number().int().positive(),
    expires: z.number().int().positive(),
    last: portalIdV1,
    limit: z.number().int().min(1).max(100),
  })
  .strict();
const auditKinds = {
  'qr-regenerate': 'qr-regenerated',
  'password-reset': 'password-reset',
  'account-reset': 'account-reset',
  block: 'blocked',
} as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function boundedInput(input: unknown) {
  const body = JSON.stringify(input);
  if (
    typeof body !== 'string' ||
    new TextEncoder().encode(body).byteLength > BULK_REQUEST_MAX_BYTES_V1
  )
    throw new Error('student-portal-bulk-invalid-request');
  return input;
}
function sameScope(a: z.infer<typeof bulkScopeV1>, b: z.infer<typeof bulkScopeV1>) {
  return a.academicYear === b.academicYear && a.classId === b.classId;
}

/** Why a student cannot take the bulk action: already blocked, or no way to recover the account. */
function ineligibilityV1(
  action: string,
  row: Readonly<Record<string, unknown>>,
) {
  if (action === 'block') return row.blocked ? 'already-blocked' : null;
  const recoveryNeeded = action !== 'qr-regenerate' || row.auth_state !== 'active';
  return recoveryNeeded && !row.recovery_ready ? 'recovery-unavailable' : null;
}

/** Administrative primitive. The RPC boundary verifies tenant and capability before invoking it. */
export class BulkAdminV1 {
  private readonly secret: string;
  constructor(
    private readonly sql: StudentPortalPostgresSqlV1,
    secret: string,
    private readonly qr: Pick<QrServiceV1, 'command'>,
  ) {
    if (secret.length < 43) throw new Error('student-portal-bulk-key-unavailable');
    this.secret = `student-portal-bulk-v1:${secret}`;
  }
  private context(input: TrustedAdminContextV1) {
    const context = trustedAdminContextV1.parse(input);
    if (context.capability !== 'platform.settings.write')
      throw new Error('student-portal-bulk-forbidden');
    return { ...context, actorId: context.actorId.toLowerCase() };
  }

  async preview(inputContext: TrustedAdminContextV1, input: unknown) {
    const context = this.context(inputContext);
    const query = bulkPreviewQueryV1.parse(boundedInput(input));
    return this.sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const now = await authNowV1(tx);
      const scopeVersion = await accountsScopeVersionV1(tx);
      let last: string | null = null;
      let created = now.getTime();
      let expires = created + TTL;
      if (query.page.cursor) {
        const parsed = cursorV1.safeParse(await unseal(query.page.cursor, this.secret));
        if (
          !parsed.success ||
          parsed.data.actor !== context.actorId ||
          parsed.data.action !== query.action ||
          !sameScope(parsed.data.scope, query.scope) ||
          parsed.data.limit !== query.page.limit ||
          parsed.data.expires <= now.getTime() ||
          parsed.data.created > now.getTime() ||
          parsed.data.expires - parsed.data.created !== TTL
        )
          throw new Error('student-portal-bulk-invalid-request');
        if (parsed.data.scopeVersion !== scopeVersion)
          throw new Error('student-portal-bulk-version-conflict');
        last = parsed.data.last;
        created = parsed.data.created;
        expires = parsed.data.expires;
      }
      const parameters = [query.scope.classId];
      const filter = `a.academic_year=2026 AND a.closed_at IS NULL AND a.gradebook_student_id IS NOT NULL
        AND b.class_id=$1::integer AND ${ENROLLED_ACCOUNT_SQL_V1}`;
      const count = await tx.unsafe(
        `SELECT count(*)::text AS total ${ACCOUNT_JOIN_V1} WHERE ${filter}`,
        parameters,
      );
      const rows = await tx.unsafe(
        `SELECT a.id,a.version::text,b.class_id,COALESCE(s.name,'') AS name,COALESCE(b.class_name,'') AS class_label,
          a.auth_state,a.blocked,
          COALESCE(d.birth_year IS NOT NULL AND d.confirmation='confirmed'
            AND p.pin_verifier IS NOT NULL AND p.pin_version=a.pin_version,false) AS recovery_ready
        ${ACCOUNT_JOIN_V1}
        LEFT JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
        LEFT JOIN student_portal.password_credential p ON p.account_id=a.id
        WHERE ${filter} AND ($2::uuid IS NULL OR a.id>$2::uuid) ORDER BY a.id LIMIT $3`,
        [...parameters, last, query.page.limit + 1],
      );
      const items = rows.slice(0, query.page.limit).map((row) => ({
        accountId: portalIdV1.parse(row.id),
        version: versionV1.parse(Number(row.version)),
        classId: z.number().int().positive().safe().parse(row.class_id),
        name: row.name,
        classLabel: row.class_label,
        ineligibility: ineligibilityV1(query.action, row),
      }));
      const proof = bulkProofTokenV1.parse(
        await seal(
          proofV1.parse({
            v: 1,
            domain: 'student-portal-bulk-proof-v1',
            actor: context.actorId,
            action: query.action,
            scope: query.scope,
            scopeVersion,
            created,
            expires,
            items: items.map(({ accountId, version, classId }) => ({
              accountId,
              version,
              classId,
            })),
          }),
          this.secret,
        ),
      );
      const nextCursor =
        rows.length > query.page.limit
          ? bulkCursorV1.parse(
              await seal(
                cursorV1.parse({
                  v: 1,
                  domain: 'student-portal-bulk-cursor-v1',
                  actor: context.actorId,
                  action: query.action,
                  scope: query.scope,
                  scopeVersion,
                  created,
                  expires,
                  limit: query.page.limit,
                  last: items.at(-1)!.accountId,
                }),
                this.secret,
              ),
            )
          : null;
      return bulkPreviewResponseV1.parse({
        contractVersion: 1,
        state: 'bulk-preview',
        requestId: context.requestId,
        action: query.action,
        scope: query.scope,
        scopeVersion,
        totalCount: Number(count[0]?.total),
        items,
        proof,
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(expires).toISOString(),
        nextCursor,
      });
    });
  }

  private async recordFailure(
    context: TrustedAdminContextV1,
    command: BulkExecuteCommandV1,
    error: unknown,
  ) {
    try {
      await authTransactionV1(this.sql, async (tx, store) => {
        await store.lockAccounts([command.accountId]);
        const account = await store.findAccount(command.accountId);
        const now = await authNowV1(tx);
        await store.appendAudit({
          eventId: crypto.randomUUID(),
          at: now.toISOString(),
          actorId: context.actorId,
          accountId: account?.id ?? null,
          scope: account ? accountScopeV1(account.id) : { kind: 'school', academicYear: 2026 },
          kind: auditKinds[command.action],
          result:
            error instanceof Error &&
            /-(?:forbidden|conflict|invalid-request)$/u.test(error.message)
              ? 'denied'
              : 'failed',
          requestId: context.requestId,
          version: account?.version ?? 0,
          maskedIp: null,
        });
      });
    } catch {
      throw new Error('student-portal-bulk-audit-unavailable');
    }
  }

  async execute(inputContext: TrustedAdminContextV1, input: unknown) {
    const context = this.context(inputContext);
    const command = bulkExecuteCommandV1.parse(boundedInput(input));
    try {
      const parsed = proofV1.safeParse(await unseal(command.proof, this.secret));
      if (
        !parsed.success ||
        parsed.data.actor !== context.actorId ||
        parsed.data.action !== command.action ||
        parsed.data.expires - parsed.data.created !== TTL
      )
        throw new Error('student-portal-bulk-forbidden');
      const proof = parsed.data;
      const item = proof.items.find(
        (entry) => entry.accountId.toLowerCase() === command.accountId.toLowerCase(),
      );
      if (
        !item ||
        item.version !== command.expectedVersion ||
        proof.scope.classId !== item.classId
      )
        throw new Error('student-portal-bulk-forbidden');
      // Expiry is checked by the mutation after receipt lookup, preserving retries of unknown responses.
      const result = await this.qr.command(
        context.actorId,
        {
          contractVersion: 1,
          operation: command.action,
          accountId: item.accountId,
          expectedVersion: command.expectedVersion,
          idempotencyKey: command.idempotencyKey,
          confirmed: true,
          ...(command.action === 'block' ? { blocked: true } : {}),
        },
        {
          expectedScope: { kind: 'class', academicYear: 2026, classId: item.classId },
          proofExpiresAt: new Date(proof.expires).toISOString(),
          proofDigest: digest(command.proof),
        },
      );
      return bulkExecuteResponseV1.parse({
        contractVersion: 1,
        state: 'committed',
        requestId: context.requestId,
        operationId: result.operationId,
        version: result.version,
      });
    } catch (error) {
      await this.recordFailure(context, command, error);
      throw error;
    }
  }
}
