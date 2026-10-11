import { AUDIT_IP_MASK_V1, AUDIT_IP_SOURCE_V1 } from '../observability/audit-context-v1';
import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../../../shared/student-identity/student-identity-v1';
import { ensureCanonicalPinV1 } from '../birth-year/canonical-pin-v1';
import {
  auditEventV1,
  type AdminCommandV1,
} from '../../../shared/student-portal-contracts/admin-v1';
import { PORTAL_ORIGIN_V1 } from '../../../shared/student-portal-contracts/core-v1';
import { qrUrlV1 } from '../../../shared/student-portal-contracts/auth-v1';
import type { CryptoPortV1 } from '../../../shared/student-portal-contracts/ports-v1';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';
import { authNowV1, authTransactionV1 } from '../auth/transaction-v1';
import { LinkClosureServiceV1 } from '../integration/lifecycle/link-closure-v1';
import { accountsScopeVersionV1, adminDigestV1, boundSqlV1 } from './common-v1';
import { ACCOUNT_JOIN_V1, ENROLLED_ACCOUNT_SQL_V1 } from './queries-v1';

type QrBatch = Extract<AdminCommandV1, { operation: 'qr-batch' }>;
export async function qrBatchV1(
  sql: StudentPortalPostgresSqlV1,
  cryptoPort: CryptoPortV1,
  keyVersion: number,
  actor: string,
  input: QrBatch,
  pepperVersion = 1,
) {
  const command = { ...input, accountIds: input.accountIds.map((id) => id.toLowerCase()) };
  if (new Set(command.accountIds).size !== command.accountIds.length)
    throw new Error('student-portal-batch-invalid-request');
  const digest = adminDigestV1(command);
  return authTransactionV1(sql, async (tx, store) => {
    const now = await authNowV1(tx);
    const receiptActor = `qr-batch:${actor}`;
    const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
    const replay = receipt !== null && Date.parse(receipt.expiresAt) > now.getTime();
    if (replay && receipt.requestDigest !== digest)
      throw new Error('student-portal-batch-idempotency-conflict');
    if ((await accountsScopeVersionV1(tx)) !== (replay ? receipt.version : command.expectedVersion))
      throw new Error('student-portal-batch-version-conflict');
    // Same immutable UUID lock order as the persistence port, with one round trip for the whole bounded batch.
    await tx.unsafe(
      `SELECT id FROM student_portal.account
      WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE`,
      [JSON.stringify(command.accountIds)],
    );
    const rows = await tx.unsafe(
      `SELECT a.id,a.closed_at,a.version::text,a.auth_state,a.pin_version,b.class_id,s.name,b.class_name,
      q.credential_id,q.key_version,d.birth_year,d.confirmation,d.source AS birth_source,p.pin_verifier,p.pin_version AS credential_pin_version,
      EXISTS(SELECT 1 FROM student_portal.qr_credential old WHERE old.account_id=a.id) AS had_credential
      ${ACCOUNT_JOIN_V1} LEFT JOIN student_portal.qr_credential q ON q.account_id=a.id AND q.state='active'
      LEFT JOIN student_portal.account_birth_v1 d ON d.account_id=a.id
      LEFT JOIN student_portal.password_credential p ON p.account_id=a.id
      WHERE a.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::text::jsonb)) AND a.academic_year=2026
        AND ${ENROLLED_ACCOUNT_SQL_V1}`,
      [JSON.stringify(command.accountIds)],
    );
    if (
      rows.length !== command.accountIds.length ||
      rows.some((row) => row.closed_at !== null || row.class_id !== command.classId)
    )
      throw new Error('student-portal-batch-forbidden');
    const missingPins = rows.filter((row) => row.auth_state !== 'active' && row.pin_verifier === null &&
      row.birth_year !== null && row.confirmation === 'confirmed' && ['profile','report'].includes(String(row.birth_source)));
    if (missingPins.length > 4) throw new Error('student-portal-batch-recovery-conflict');
    const preparedPins = new Set<string>();
    for (const row of missingPins) if (await ensureCanonicalPinV1(tx, cryptoPort, pepperVersion, String(row.id), Number(row.pin_version)))
      preparedPins.add(String(row.id));
    if (
      rows.some(
        (row) =>
          row.auth_state !== 'active' &&
          (row.birth_year === null ||
            row.confirmation !== 'confirmed' ||
            (!preparedPins.has(String(row.id)) && (row.pin_verifier === null ||
            Number(row.credential_pin_version) !== Number(row.pin_version)))),
      )
    )
      throw new Error('student-portal-batch-recovery-conflict');
    if (rows.some((row) => row.credential_id === null && (row.had_credential || replay)))
      throw new Error('student-portal-batch-regeneration-required');
    const cards = [];
    const created = [];
    const audits = [];
    for (const id of command.accountIds) {
      const row = rows.find((item) => item.id === id)!;
      const isNew = row.credential_id === null;
      const credentialId = isNew ? cryptoPort.randomToken(32) : z.string().parse(row.credential_id);
      const version = isNew ? keyVersion : z.number().int().positive().parse(row.key_version);
      const qr = qrUrlV1.parse(
        `${PORTAL_ORIGIN_V1}/access#v1.${credentialId}.${version}.${await cryptoPort.signQr(credentialId, version)}`,
      );
      cards.push({
        accountId: id,
        mode: command.mode,
        qr,
        ...(command.mode !== 'qr-only' ? { name: z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1).parse(row.name) } : {}),
        ...(command.mode === 'qr-name-class'
          ? { classLabel: z.string().min(1).max(80).parse(row.class_name) }
          : {}),
      });
      if (isNew)
        created.push({ account_id: id, credential_id: credentialId, key_version: version });
      if (!replay)
        audits.push(
          auditEventV1.parse({
            eventId: crypto.randomUUID(),
            at: now.toISOString(),
            actorId: actor,
            accountId: id,
            scope: { kind: 'account', academicYear: 2026, accountId: id },
            kind: isNew ? 'qr-issued' : 'qr-reprinted',
            result: 'success',
            requestId: command.idempotencyKey,
            version: Number(row.version) + (isNew ? 1 : 0),
            maskedIp: null,
          }),
        );
    }
    if (replay) return { cards, version: receipt.version };
    if (receipt)
      await tx.unsafe(
        'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
        [command.idempotencyKey, receiptActor],
      );
    if (created.length) {
      const json = JSON.stringify(created);
      await tx.unsafe(
        `INSERT INTO student_portal.qr_credential(credential_id,account_id,key_version,state)
        SELECT credential_id,account_id,key_version,'active' FROM jsonb_to_recordset($1::text::jsonb)
          AS q(credential_id text,account_id uuid,key_version integer)`,
        [json],
      );
      await tx.unsafe(
        `UPDATE student_portal.account SET version=version+1,updated_at=$2::timestamptz
        WHERE id IN (SELECT account_id FROM jsonb_to_recordset($1::text::jsonb) AS q(account_id uuid))`,
        [json, now.toISOString()],
      );
    }
    await tx.unsafe(
      `INSERT INTO student_portal.audit_event(event_id,occurred_at,actor_id,account_id,scope_json,kind,result,request_id,version,masked_ip,raw_ip,ip_expires_at)
      SELECT event_id,occurred_at,actor_id,account_id,scope_json,kind,'success',request_id,version,${AUDIT_IP_MASK_V1},client_ip,
        CASE WHEN client_ip IS NOT NULL THEN occurred_at+interval '90 days' END
        FROM jsonb_to_recordset($1::text::jsonb) AS e(event_id uuid,occurred_at timestamptz,actor_id uuid,account_id uuid,
          scope_json jsonb,kind text,request_id uuid,version bigint) CROSS JOIN ${AUDIT_IP_SOURCE_V1}`,
      [
        JSON.stringify(
          audits.map((event) => ({
            event_id: event.eventId,
            occurred_at: event.at,
            actor_id: event.actorId,
            account_id: event.accountId,
            scope_json: event.scope,
            kind: event.kind,
            request_id: event.requestId,
            version: event.version,
          })),
        ),
      ],
    );
    const version = await accountsScopeVersionV1(tx);
    await store.saveIdempotency({
      key: command.idempotencyKey,
      actorId: receiptActor,
      requestDigest: digest,
      operationId: crypto.randomUUID(),
      version,
      expiresAt: new Date(now.getTime() + 86400_000).toISOString(),
    });
    return { cards, version };
  });
}

export async function closeLinksIdempotentlyV1(
  sql: StudentPortalPostgresSqlV1,
  actor: string,
  command: Extract<AdminCommandV1, { operation: 'links-close' }>,
) {
  return authTransactionV1(sql, async (tx, store) => {
    const now = await authNowV1(tx);
    const digest = adminDigestV1(command);
    const receiptActor = `links-close:${actor}`;
    const receipt = await store.readIdempotency(command.idempotencyKey, receiptActor);
    if (receipt && Date.parse(receipt.expiresAt) > now.getTime()) {
      if (receipt.requestDigest !== digest)
        throw new Error('student-portal-links-idempotency-conflict');
      return { operationId: receipt.operationId, version: receipt.version };
    }
    if (receipt)
      await tx.unsafe(
        'DELETE FROM student_portal.operation_receipt WHERE idempotency_key=$1 AND actor_id=$2',
        [command.idempotencyKey, receiptActor],
      );
    const result = await new LinkClosureServiceV1(boundSqlV1(tx)).execute(actor, command);
    const operationId = crypto.randomUUID();
    await store.saveIdempotency({
      key: command.idempotencyKey,
      actorId: receiptActor,
      requestDigest: digest,
      operationId,
      version: result.version,
      expiresAt: new Date(now.getTime() + 86400_000).toISOString(),
    });
    return { operationId, version: result.version };
  });
}
