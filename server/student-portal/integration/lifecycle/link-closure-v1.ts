import { z } from 'zod';
import { adminCommandV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import {
  StudentPortalPostgresPersistenceV1,
  type StudentPortalPostgresQueryV1,
  type StudentPortalPostgresSqlV1,
} from '../../persistence/postgres-persistence-v1';

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function snapshot(sql: StudentPortalPostgresQueryV1) {
  await sql.unsafe('SELECT pg_advisory_xact_lock_shared(613,0)');
  await sql.unsafe('SELECT pg_advisory_xact_lock(613,2026)');
  const revisions = await sql.unsafe(`SELECT academic_generation,academic_counter::text,
    portal_link_generation,portal_link_counter::text FROM student_portal.academic_revision WHERE academic_year=2026 FOR UPDATE`);
  if (revisions.length !== 1) throw new Error('student-portal-academic-revision-unavailable');
  const accounts =
    await sql.unsafe(`SELECT id,gradebook_student_id,version::text,security_version::text
    FROM student_portal.account WHERE academic_year=2026 AND closed_at IS NULL AND gradebook_student_id IS NOT NULL
    ORDER BY id FOR UPDATE`);
  const version = z.coerce
    .number()
    .int()
    .safe()
    .nonnegative()
    .parse(revisions[0]!.portal_link_counter);
  return {
    version,
    count: accounts.length,
    digest: await digest(JSON.stringify({ revisions, accounts })),
  };
}

/** Private primitive for the authenticated administrative module; never a public reset route. */
export class LinkClosureServiceV1 {
  constructor(private readonly sql: StudentPortalPostgresSqlV1) {}

  async preview(actorId: string) {
    z.uuid().parse(actorId);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const tokenDigest = await digest(token);
    return this.sql.begin(async (tx) => {
      const scope = await snapshot(tx);
      const rows = await tx.unsafe(
        `INSERT INTO student_portal.link_close_preview
        (token_digest,actor_id,scope_digest,version,expected_count,expires_at)
        VALUES ($1,$2::uuid,$3,$4,$5,statement_timestamp()+interval '5 minutes') RETURNING expires_at`,
        [tokenDigest, actorId, scope.digest, scope.version, scope.count],
      );
      const expires = rows[0]?.expires_at;
      const expiresAt = expires instanceof Date ? expires.toISOString() : z.string().parse(expires);
      return { count: scope.count, version: scope.version, previewToken: token, expiresAt };
    });
  }

  async execute(actorId: string, input: unknown) {
    z.uuid().parse(actorId);
    const command = adminCommandV1.parse(input);
    if (command.operation !== 'links-close') throw new Error('student-portal-link-command-invalid');
    const tokenDigest = await digest(command.previewToken);
    return this.sql.begin(async (tx) => {
      const scope = await snapshot(tx);
      const proof = await tx.unsafe(
        `UPDATE student_portal.link_close_preview SET consumed_at=statement_timestamp()
        WHERE token_digest=$1 AND actor_id=$2::uuid AND scope_digest=$3 AND version=$4 AND expected_count=$5
          AND consumed_at IS NULL AND expires_at>statement_timestamp()
        RETURNING consumed_at`,
        [tokenDigest, actorId, scope.digest, command.expectedVersion, command.expectedCount],
      );
      if (
        scope.version !== command.expectedVersion ||
        scope.count !== command.expectedCount ||
        proof.length !== 1
      ) {
        // Throw to roll back consumption as well as any subsequent work.
        throw new Error('student-portal-link-preview-conflict');
      }
      const now = proof[0]!.consumed_at;
      const closedAt = now instanceof Date ? now.toISOString() : z.string().parse(now);
      const persistence = new StudentPortalPostgresPersistenceV1({
        unsafe: (query, parameters) => tx.unsafe(query, parameters),
        begin: (operation) => operation(tx),
      });
      await persistence.transaction(async (store) => {
        await store.closeAcademicLinks(2026, scope.count, closedAt);
        await store.appendAudit({
          eventId: crypto.randomUUID(),
          at: closedAt,
          actorId,
          accountId: null,
          scope: { kind: 'school', academicYear: 2026 },
          kind: 'links-closed',
          result: 'success',
          requestId: command.idempotencyKey,
          version: scope.version + (scope.count > 0 ? 1 : 0),
          maskedIp: null,
        });
      });
      return { closed: scope.count, version: scope.version + (scope.count > 0 ? 1 : 0) };
    });
  }
}
