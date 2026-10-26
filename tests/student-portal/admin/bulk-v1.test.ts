import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BulkAdminV1 } from '../../../server/student-portal/admin/bulk-v1';
import { QrServiceV1 } from '../../../server/student-portal/auth/qr-service-v1';
import { PortalAdminApiV1 } from '../../../server/student-portal/admin/api-v1';
import { PortalCryptoV1 } from '../../../server/student-portal/crypto/crypto-v1';
import type { StudentPortalPostgresSqlV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import {
  bulkExecuteCommandV1,
  bulkPreviewQueryV1,
} from '../../../shared/student-portal-contracts/bulk-v1';
import { adminCommandV1, adminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { installResetSchemaFixtureV1 } from '../year-reset/schema-fixture';
import { ACADEMIC_FIXTURE_SQL_V1 } from '../academic/academic-fixture-v1';

const context = {
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  requestId: '33333333-3333-4333-8333-333333333333',
  authenticatedAt: new Date().toISOString(),
  capability: 'platform.settings.write' as const,
};
const query = {
  contractVersion: 1,
  operation: 'bulk-preview',
  action: 'block',
  scope: { kind: 'class', academicYear: 2026, classId: 910001 },
  page: { limit: 100 },
} as const;
type Preview = Awaited<ReturnType<BulkAdminV1['preview']>>;
function command(preview: Preview, index = 0) {
  return {
    contractVersion: 1,
    operation: 'bulk-execute',
    action: preview.action,
    proof: preview.proof,
    accountId: preview.items[index]!.accountId,
    expectedVersion: preview.items[index]!.version,
    idempotencyKey: crypto.randomUUID(),
    confirmed: true,
  };
}

describe('bulk administration #1102 with fictitious disposable data', () => {
  let pg: PGlite;
  let sql: StudentPortalPostgresSqlV1;
  let service: BulkAdminV1;
  let timeOffset = 0;
  let rejectAudit = false;
  const cryptography = new PortalCryptoV1(
    new Map([[1, new Uint8Array(32).fill(7)]]),
    new Map([[1, new Uint8Array(32).fill(8)]]),
  );
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync('migrations/gradebook-simplified/0001_current_schema.sql', 'utf8'));
    await installResetSchemaFixtureV1(pg);
    await pg.exec(ACADEMIC_FIXTURE_SQL_V1);
    await pg.exec(`INSERT INTO gradebook.aluno(id,ano,nome) SELECT n,2026,'SYNTHETIC BULK '||n FROM generate_series(920001,920149) n;
      INSERT INTO gradebook.vinculo(ano,turma_id,numero,aluno_id) SELECT 2026,910001,n-920000+2,n FROM generate_series(920001,920149) n;
      SELECT * FROM student_portal.synchronize_profiles_v1(true);`);
    const run = async <R extends Record<string, unknown>>(
      target: Pick<PGlite, 'query'>,
      statement: string,
      parameters: readonly unknown[] = [],
    ) => {
      if (rejectAudit && statement.includes('INSERT INTO student_portal.audit_event'))
        throw new Error('synthetic-audit-unavailable');
      const rows = (await target.query<R>(statement, [...parameters])).rows;
      if (timeOffset && statement === 'SELECT statement_timestamp() AS now')
        return [{ now: new Date(Date.now() + timeOffset) }] as unknown as R[];
      return rows;
    };
    sql = {
      unsafe: (statement, parameters) => run(pg, statement, parameters),
      begin: (operation) =>
        pg.transaction((tx) =>
          operation({ unsafe: (statement, parameters) => run(tx, statement, parameters) }),
        ),
    };
    service = new BulkAdminV1(
      sql,
      'synthetic-bulk-key-'.repeat(4),
      new QrServiceV1(sql, cryptography, 1),
    );
  }, 30_000);
  beforeEach(async () => {
    timeOffset = 0;
    rejectAudit = false;
    await pg.exec(`TRUNCATE student_portal.audit_event,student_portal.operation_receipt;
      UPDATE student_portal.account SET blocked=false,version=0;
      UPDATE gradebook.vinculo SET turma_id=910001;`);
  });
  afterAll(async () => {
    await pg?.close();
  });

  it('rejects a school-wide bulk preview at the public contract', () => {
    const school = { ...query, scope: { kind: 'school', academicYear: 2026 } };
    expect(bulkPreviewQueryV1.safeParse(school).success).toBe(false);
    expect(adminQueryV1.safeParse(school).success).toBe(false);
  });

  it('counts all 151 accounts in the selected class and paginates the complete class', async () => {
    const first = await service.preview(context, query);
    expect(first.totalCount).toBe(151);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.preview(context, {
      ...query,
      page: { ...query.page, cursor: first.nextCursor },
    });
    expect(second.totalCount).toBe(151);
    expect(second.items).toHaveLength(51);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.accountId)).size).toBe(151);
    expect(second.expiresAt).toBe(first.expiresAt);
    const empty = await service.preview(context, {
      ...query,
      scope: { kind: 'class', academicYear: 2026, classId: 910002 },
    });
    expect(empty.totalCount).toBe(0);
    expect(empty.items).toEqual([]);
  });

  it('marks accounts that the individual operation cannot execute without weakening its guard', async () => {
    const first = await service.preview(context, { ...query, action: 'qr-regenerate' });
    const id = first.items[0]!.accountId;
    await pg.query("UPDATE student_portal.account SET auth_state='pending-activation' WHERE id=$1", [id]);
    const qr = await service.preview(context, { ...query, action: 'qr-regenerate' });
    expect(qr.items.find((item) => item.accountId === id)?.ineligibility).toBe('recovery-unavailable');
    const reset = await service.preview(context, { ...query, action: 'password-reset' });
    expect(reset.items.find((item) => item.accountId === id)?.ineligibility).toBe('recovery-unavailable');
    await pg.query('UPDATE student_portal.account SET blocked=true WHERE id=$1', [id]);
    const block = await service.preview(context, query);
    expect(block.items.find((item) => item.accountId === id)?.ineligibility).toBe('already-blocked');
  });

  it('binds cursors to the actor, action, scope, limit and revision', async () => {
    const first = await service.preview(context, query);
    const next = { ...query, page: { ...query.page, cursor: first.nextCursor } };
    await expect(
      service.preview({ ...context, actorId: crypto.randomUUID() }, next),
    ).rejects.toThrow('invalid-request');
    await expect(service.preview(context, { ...next, action: 'password-reset' })).rejects.toThrow(
      'invalid-request',
    );
    await expect(
      service.preview(context, {
        ...next,
        scope: { kind: 'class', academicYear: 2026, classId: 910002 },
      }),
    ).rejects.toThrow('invalid-request');
    await expect(
      service.preview(context, { ...next, page: { ...next.page, limit: 99 } }),
    ).rejects.toThrow('invalid-request');
    await pg.query('UPDATE student_portal.account SET version=1 WHERE id=$1', [
      first.items[0]!.accountId,
    ]);
    await expect(service.preview(context, next)).rejects.toThrow('version-conflict');
  });

  it('requires write capability even for destructive previews', async () => {
    await expect(
      service.preview({ ...context, capability: 'platform.settings.read' }, query),
    ).rejects.toThrow('forbidden');
  });

  it('integrates with the existing strict administrative API and rejects read-only execution', async () => {
    const api = new PortalAdminApiV1(sql, {
      tenantId: context.tenantId,
      cursorSecret: 'synthetic-bulk-key-'.repeat(4),
      cryptoPort: cryptography,
      qrKeyVersion: 1,
      pepperVersion: 1,
    });
    expect(adminQueryV1.safeParse(query).success).toBe(true);
    expect(adminQueryV1.safeParse({ ...query, from: new Date().toISOString() }).success).toBe(
      false,
    );
    expect(
      await api.query({ ...context, capability: 'platform.settings.read' }, query),
    ).toMatchObject({ state: 'forbidden' });
    const result = await api.query(context, query);
    expect(result.state).toBe('bulk-preview');
    if (result.state !== 'bulk-preview') throw new Error('synthetic-preview-required');
    const input = command(result);
    expect(adminCommandV1.safeParse(input).success).toBe(true);
    expect(
      await api.command({ ...context, capability: 'platform.settings.read' }, input),
    ).toMatchObject({ state: 'forbidden' });
    expect(await api.command(context, input)).toMatchObject({ state: 'committed', version: 1 });
  });

  it('replays an unknown response after preview expiry without repeating the mutation', async () => {
    const preview = await service.preview(context, query);
    const input = command(preview);
    const result = await service.execute(context, input);
    timeOffset = 6 * 60_000;
    expect(await service.execute(context, input)).toEqual(result);
    expect(
      (await pg.query<{ version: number }>('SELECT version FROM student_portal.account WHERE id=$1', [input.accountId]))
        .rows[0]!.version,
    ).toBe(1);
    expect(
      (
        await pg.query(
          "SELECT * FROM student_portal.audit_event WHERE kind='blocked' AND result='success'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('rejects new work after preview expiry and records its denial', async () => {
    const preview = await service.preview(context, query);
    timeOffset = 6 * 60_000;
    await expect(service.execute(context, command(preview))).rejects.toThrow('preview-conflict');
    expect((await pg.query('SELECT result FROM student_portal.audit_event')).rows).toEqual([
      { result: 'denied' },
    ]);
  });

  it('does not create a second intention after both receipt and proof expire', async () => {
    const preview = await service.preview(context, query);
    const input = command(preview);
    await service.execute(context, input);
    timeOffset = 25 * 3_600_000;
    await expect(service.execute(context, input)).rejects.toThrow('preview-conflict');
    expect(
      (await pg.query<{ version: number }>('SELECT version FROM student_portal.account WHERE id=$1', [input.accountId]))
        .rows[0]!.version,
    ).toBe(1);
  });

  it('rejects a class move after a class preview within the individual mutation transaction', async () => {
    const preview = await service.preview(context, query);
    const input = command(preview);
    await pg.query(
      'UPDATE gradebook.vinculo SET turma_id=910002 WHERE aluno_id=(SELECT gradebook_student_id FROM student_portal.account WHERE id=$1)',
      [input.accountId],
    );
    await expect(service.execute(context, input)).rejects.toThrow('conflict');
    expect(
      (
        await pg.query('SELECT blocked,version FROM student_portal.account WHERE id=$1', [
          input.accountId,
        ])
      ).rows,
    ).toEqual([{ blocked: false, version: 0 }]);
  });

  it('rejects a changed account version without replacing the preview CAS', async () => {
    const preview = await service.preview(context, query);
    const input = command(preview);
    await pg.query('UPDATE student_portal.account SET version=1 WHERE id=$1', [input.accountId]);
    await expect(service.execute(context, input)).rejects.toThrow('version-conflict');
  });

  it('binds proofs to the actor, action and exact account/version', async () => {
    const preview = await service.preview(context, query);
    const input = command(preview);
    await expect(
      service.execute({ ...context, actorId: crypto.randomUUID() }, input),
    ).rejects.toThrow('forbidden');
    await expect(service.execute(context, { ...input, action: 'account-reset' })).rejects.toThrow(
      'forbidden',
    );
    await expect(
      service.execute(context, { ...input, accountId: crypto.randomUUID() }),
    ).rejects.toThrow('forbidden');
    await expect(service.execute(context, { ...input, expectedVersion: 99 })).rejects.toThrow(
      'forbidden',
    );
    await expect(
      service.execute(context, { ...input, proof: input.proof.slice(0, -3) + 'AAA' }),
    ).rejects.toThrow('forbidden');
  });

  it('fails explicitly if denial audit cannot be saved', async () => {
    const preview = await service.preview(context, query);
    rejectAudit = true;
    await expect(
      service.execute(context, { ...command(preview), expectedVersion: 99 }),
    ).rejects.toThrow('audit-unavailable');
  });

  it('never returns credentials from the individual service', async () => {
    const preview = await service.preview(context, { ...query, action: 'qr-regenerate' });
    const own = new BulkAdminV1(sql, 'synthetic-bulk-key-'.repeat(4), {
      command: async () => ({
        operationId: crypto.randomUUID(),
        version: 1,
        qr: 'SYNTHETIC SECRET MUST NOT LEAVE',
      }),
    });
    const result = await own.execute(context, command(preview));
    expect(Object.keys(result).sort()).toEqual([
      'contractVersion',
      'operationId',
      'requestId',
      'state',
      'version',
    ]);
  });

  it('processes only requested items; stopping a batch does not undo committed items', async () => {
    const preview = await service.preview(context, query);
    await service.execute(context, command(preview));
    expect(
      (
        await pg.query(
          'SELECT count(*)::integer AS count FROM student_portal.account WHERE blocked',
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });

  it('strictly rejects unconfirmed or oversized requests and excess page limits', async () => {
    const preview = await service.preview(context, query);
    expect(bulkExecuteCommandV1.safeParse({ ...command(preview), confirmed: false }).success).toBe(
      false,
    );
    expect(bulkPreviewQueryV1.safeParse({ ...query, page: { limit: 101 } }).success).toBe(false);
    await expect(
      service.execute(context, { ...command(preview), unused: 'x'.repeat(65_536) }),
    ).rejects.toThrow('invalid-request');
  });
});
