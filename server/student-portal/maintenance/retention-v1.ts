import { z } from 'zod';
import type { StudentPortalPostgresSqlV1 } from '../persistence/postgres-persistence-v1';

/** Independent, bounded single-statement transactions sent together; repeat until drained.
 * No account, revocation or revision-ledger deletion. */
export async function cleanupPortalV1(sql: StudentPortalPostgresSqlV1, limit = 100) {
  z.number().int().min(1).max(100).parse(limit);
  const statements = {
    rawIp: `WITH expired AS (SELECT event_id FROM student_portal.audit_event
      WHERE raw_ip IS NOT NULL AND (ip_expires_at<=statement_timestamp() OR occurred_at<=statement_timestamp()-interval '90 days')
      ORDER BY ip_expires_at,event_id LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE student_portal.audit_event a SET raw_ip=NULL,ip_expires_at=NULL FROM expired e WHERE a.event_id=e.event_id RETURNING 1`,
    audit: `WITH expired AS (SELECT event_id FROM student_portal.audit_event
      WHERE occurred_at<=statement_timestamp()-interval '12 months' ORDER BY occurred_at,event_id LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.audit_event a USING expired e WHERE a.event_id=e.event_id RETURNING 1`,
    receipts: `WITH expired AS (SELECT idempotency_key,actor_id FROM student_portal.operation_receipt
      WHERE expires_at<=statement_timestamp() ORDER BY expires_at,idempotency_key,actor_id LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.operation_receipt a USING expired e WHERE a.idempotency_key=e.idempotency_key AND a.actor_id=e.actor_id RETURNING 1`,
    challenges: `WITH expired AS (SELECT token_hash FROM student_portal.auth_challenge
      WHERE expires_at<=statement_timestamp() ORDER BY expires_at,token_hash LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.auth_challenge a USING expired e WHERE a.token_hash=e.token_hash RETURNING 1`,
    linkPreviews: `WITH expired AS (SELECT token_digest FROM student_portal.link_close_preview
      WHERE expires_at<=statement_timestamp() ORDER BY expires_at,token_digest LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.link_close_preview a USING expired e WHERE a.token_digest=e.token_digest RETURNING 1`,
    resetPreviews: `WITH expired AS (SELECT token_digest FROM student_portal.year_reset_preview_proof
      WHERE expires_at<=statement_timestamp() ORDER BY expires_at,token_digest LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.year_reset_preview_proof a USING expired e WHERE a.token_digest=e.token_digest RETURNING 1`,
    jobs: `WITH expired AS (SELECT id FROM student_portal.publication_job
      WHERE state IN ('done','failed') AND updated_at<=statement_timestamp()-interval '12 months'
      ORDER BY updated_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
      DELETE FROM student_portal.publication_job a USING expired e WHERE a.id=e.id RETURNING 1`,
  } as const;
  const families = Object.keys(statements) as (keyof typeof statements)[];
  const results = await Promise.allSettled(families.map(async (family) => sql.unsafe(statements[family], [limit])));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return Object.fromEntries(families.map((family, index) =>
    [family, (results[index] as PromiseFulfilledResult<unknown[]>).value.length])) as Record<keyof typeof statements, number>;
}
