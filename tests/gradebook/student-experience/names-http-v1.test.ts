// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleAssessmentNamesRequestV1 } from '../../../server/gradebook/http/assessment-names-routes-v1';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';
const transaction = vi.fn(async () => {
  throw new Error('synthetic-db-offline');
});
const env = {
  ...testEnv,
  RUNTIME_ENVIRONMENT: 'local',
  GRADEBOOK_STORAGE_PROVIDER: 'postgres',
  GRADEBOOK_DATABASE: {
    transaction,
    prepare: () => {
      throw new Error('outside-transaction');
    },
    exec: () => {
      throw new Error('outside-transaction');
    },
  },
} as unknown as RuntimeEnv;
async function request(
  role: 'ADMINISTRADOR' | 'PROFESSOR' | null,
  body = JSON.stringify({ contractVersion: 1, operation: 'read', year: 2026 }),
  origin = testEnv.OFFICIAL_ORIGIN,
  method = 'POST',
) {
  const headers = new Headers({ Origin: origin, 'Content-Type': 'application/json' });
  if (role)
    headers.set(
      'Cookie',
      `${SESSION_COOKIE}=${await seal({ oid: '11111111-1111-4111-8111-111111111111', name: 'Synthetic', username: 'synthetic@example.test', roles: [role], exp: Math.floor(Date.now() / 1000) + 600 }, testEnv.SESSION_SECRET, 'admin-session')}`,
    );
  return new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/assessment-names`, {
    method,
    headers,
    ...(method === 'POST' ? { body } : {}),
  });
}
describe('assessment names HTTP security', () => {
  it('requires admin, keeps private responses no-store and returns opaque database failure', async () => {
    transaction.mockClear();
    for (const [role, status] of [
      [null, 401],
      ['PROFESSOR', 403],
      ['ADMINISTRADOR', 503],
    ] as const) {
      const res = await handleAssessmentNamesRequestV1(await request(role), env);
      expect(res?.status).toBe(status);
      expect(res?.headers.get('Cache-Control')).toContain('no-store');
      expect(await res?.text()).not.toContain('synthetic-db-offline');
    }
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('rejects provider/gate, hostile origin, method and oversized body before touching storage', async () => {
    transaction.mockClear();
    expect(
      (
        await handleAssessmentNamesRequestV1(await request('ADMINISTRADOR'), {
          ...env,
          RUNTIME_ENVIRONMENT: 'production',
          GRADEBOOK_PRODUCTION_ENABLED: 'false',
        })
      )?.status,
    ).toBe(503);
    expect(
      (
        await handleAssessmentNamesRequestV1(await request('ADMINISTRADOR'), {
          ...env,
          GRADEBOOK_STORAGE_PROVIDER: 'd1',
        })
      )?.status,
    ).toBe(503);
    await expect(
      handleAssessmentNamesRequestV1(
        await request('ADMINISTRADOR', '{}', 'https://evil.example'),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      handleAssessmentNamesRequestV1(
        await request('ADMINISTRADOR', '{}', testEnv.OFFICIAL_ORIGIN, 'GET'),
        env,
      ),
    ).rejects.toMatchObject({ status: 405 });
    expect(
      (await handleAssessmentNamesRequestV1(await request('ADMINISTRADOR', 'x'.repeat(9000)), env))
        ?.status,
    ).toBe(413);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('refuses unknown contract keys and illegal year before any database read', async () => {
    transaction.mockClear();
    for (const body of [
      {
        contractVersion: 1,
        operation: 'save',
        year: 2026,
        expectedVersion: 0,
        names: { '1:3': 'x' },
      },
      { contractVersion: 1, operation: 'read', year: -1 },
    ])
      expect(
        (
          await handleAssessmentNamesRequestV1(
            await request('ADMINISTRADOR', JSON.stringify(body)),
            env,
          )
        )?.status,
      ).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});
