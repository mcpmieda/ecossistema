import { describe, expect, it } from 'vitest';
import { AdminCursorV1 } from '../../../server/student-portal/admin/cursor-v1';
import { adminQueryV1, adminResponseV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { opaqueV1, pageCursorV1 } from '../../../shared/student-portal-contracts/core-v1';
import { seal } from '../../../server/auth/sealed';
import { createHash } from 'node:crypto';

const secret = 'synthetic-cursor-regression-'.repeat(3);
const actor = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-11T12:00:00.000Z');
const query = adminQueryV1.parse({
  contractVersion: 1,
  operation: 'accounts',
  scope: { kind: 'school', academicYear: 2026 },
  page: { limit: 1 },
});
const cursor = new AdminCursorV1(secret);

describe('bounded V1 cursor envelope compatibility', () => {
  it.each([200, 201, 300])(
    'round-trips a %i-character accented name without changing request/response framing',
    async (length) => {
      const name = 'ÁÉÕÇ'.repeat(75).slice(0, length);
      const token = await cursor.next(query, actor, now, id, undefined, name);
      const request = adminQueryV1.parse({ ...query, page: { limit: 1, cursor: token } });
      expect(
        adminResponseV1.safeParse({
          contractVersion: 1,
          requestId: actor,
          state: 'accounts',
          scopeVersion: 0,
          items: [],
          nextCursor: token,
        }).success,
      ).toBe(true);
      expect(await cursor.read(request, actor, now)).toEqual({ id, name });
      await expect(cursor.read(request, id, now)).rejects.toThrow('cursor-invalid');
      await expect(
        cursor.read({ ...request, page: { ...request.page, limit: 2 } }, actor, now),
      ).rejects.toThrow('cursor-invalid');
      await expect(cursor.read(request, actor, new Date(now.getTime() + 300_000))).rejects.toThrow(
        'cursor-invalid',
      );
      await expect(
        cursor.read(
          { ...request, page: { ...request.page, cursor: token.slice(0, -4) + 'AAAA' } },
          actor,
          now,
        ),
      ).rejects.toThrow('cursor-invalid');
    },
  );

  it.each(['漢'.repeat(300), '\u0001'.repeat(300)])(
    'bounds UTF-8 and worst-case JSON escaping before decryption',
    async (name) => {
      const token = await cursor.next(query, actor, now, id, now.toISOString(), name);
      expect(token.length).toBeLessThanOrEqual(4096);
      expect(
        await cursor.read({ ...query, page: { ...query.page, cursor: token } }, actor, now),
      ).toEqual({ id, at: now.toISOString(), name });
      expect(pageCursorV1.safeParse('a'.repeat(4097)).success).toBe(false);
      expect(opaqueV1.safeParse('a'.repeat(513)).success).toBe(false);
      await expect(
        cursor.read({ ...query, page: { ...query.page, cursor: 'a'.repeat(4097) } }, actor, now),
      ).rejects.toThrow('cursor-invalid');
      await expect(
        cursor.next(query, actor, now, id, undefined, 'a'.repeat(301)),
      ).rejects.toThrow();
    },
  );

  it('accepts cursors sealed with the pre-existing V1 payload and key domain', async () => {
    const token = await seal(
      {
        v: 1,
        a: actor,
        q: createHash('sha256')
          .update(JSON.stringify({ ...query, page: { limit: 1 } }))
          .digest('base64url'),
        e: now.getTime() + 300_000,
        k: id,
        n: 'SYNTHETIC LEGACY',
      },
      `student-portal-admin-cursor-v1:${secret}`,
    );
    expect(token.length).toBeLessThanOrEqual(512);
    expect(
      await cursor.read({ ...query, page: { ...query.page, cursor: token } }, actor, now),
    ).toEqual({ id, name: 'SYNTHETIC LEGACY' });
  });
});
