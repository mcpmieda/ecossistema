// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../server/env';
import type {
  FrequencyActorV2,
  FrequencyRequestV2,
} from '../../shared/attendance-contracts/frequency-v2';
import { frequencyPayloadHashV2 } from '../../shared/attendance-contracts/frequency-v2';
import {
  handleCollectorFrequencyRequestV2,
  handleFrequencyAdminRequestV2,
} from '../../server/collector/frequency-http-v2';
import {
  CollectorAccessErrorV1,
  type CollectorAccessServiceV1,
} from '../../server/collector/access-service-v1';
import { createApplicationSession, SESSION_COOKIE } from '../../server/auth/session';
import { seal } from '../../server/auth/sealed';
import { testEnv } from '../fixtures';

const mocks = vi.hoisted(() => ({
  execute: vi.fn<(payload: unknown, actor: FrequencyActorV2) => Promise<unknown>>(),
}));
vi.mock('../../server/attendance/service-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/attendance/service-v2')>();
  return { ...actual, createFrequencyServiceV2: () => ({ execute: mocks.execute }) };
});
vi.mock('../../server/gradebook/persistence/postgres/official-gradebook-database-v1', () => ({
  withOfficialGradebookDatabaseV1: async (
    env: RuntimeEnv,
    operation: (execution: RuntimeEnv) => Promise<Response | null>,
  ) => operation({ ...env, GRADEBOOK_DATABASE: { transaction: vi.fn() } }),
}));

const origin = 'https://admin.escolaieda.com';
const id = '11111111-1111-4111-8111-111111111111';
const proof = { deviceId: id, nonce: 'a'.repeat(43), signature: 'b'.repeat(86) };
const deviceActor: FrequencyActorV2 = {
  mode: 'device',
  actorId: id,
  tenantId: testEnv.TENANT_ID,
  deviceId: id,
  deviceGeneration: 1,
  keyThumbprint: 'c'.repeat(43),
};
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const desktop = (body: unknown, headers: Record<string, string> = {}) =>
  post('/api/frequency-collector/frequency', body, headers);
const web = (body: unknown, headers: Record<string, string> = {}) =>
  post('/api/gradebook/frequency/v2', body, { Origin: origin, ...headers });
async function cookie(roles: ('ADMINISTRADOR' | 'PROFESSOR')[]) {
  return (
    SESSION_COOKIE +
    '=' +
    (await seal(
      createApplicationSession({ oid: id, name: 'Synthetic administrator', roles }),
      testEnv.SESSION_SECRET,
    ))
  );
}
const access = () => ({
  authorizeFrequency: vi.fn<CollectorAccessServiceV1['authorizeFrequency']>(
    async () => deviceActor,
  ),
});
beforeEach(() => {
  mocks.execute.mockReset();
  mocks.execute.mockResolvedValue({ contractVersion: 2, state: 'ready' });
});

describe('frequency HTTP authority boundaries', () => {
  it('passes the parsed payload unchanged to proof authorization and only uses its server-derived actor', async () => {
    const broker = access();
    const payload: FrequencyRequestV2 = {
      operation: 'lease',
      academicYear: 2026,
      requestId: id,
      durationSeconds: 60,
    };
    const reply = await handleCollectorFrequencyRequestV2(
      desktop({ proof, payload }),
      testEnv,
      broker,
    );
    expect(reply.status).toBe(200);
    expect(broker.authorizeFrequency).toHaveBeenCalledWith(proof, payload);
    expect(mocks.execute).toHaveBeenCalledWith(payload, deviceActor);
    expect(await frequencyPayloadHashV2(payload)).not.toBe(
      await frequencyPayloadHashV2({ ...payload, durationSeconds: 61 }),
    );
    expect(reply.headers.get('Cache-Control')).toContain('no-store');
  });

  it('does not accept a site cookie or bearer instead of a device proof', async () => {
    const broker = access();
    const headers = {
      Cookie: await cookie(['ADMINISTRADOR']),
      Authorization: 'Bearer SYNTHETIC_PRIVATE_SENTINEL',
    };
    const reply = await handleCollectorFrequencyRequestV2(
      desktop({ payload: { operation: 'status', academicYear: 2026 } }, headers),
      testEnv,
      broker,
    );
    expect(reply.status).toBe(400);
    expect(broker.authorizeFrequency).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await reply.text()).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  });

  it.each(['https://other.invalid', 'null'])(
    'rejects desktop browser origin %s before reading proof',
    async (Origin) => {
      const broker = access();
      const reply = await handleCollectorFrequencyRequestV2(
        desktop({ proof, payload: { operation: 'status', academicYear: 2026 } }, { Origin }),
        testEnv,
        broker,
      );
      expect(reply.status).toBe(403);
      expect(broker.authorizeFrequency).not.toHaveBeenCalled();
    },
  );

  it('rejects forged or differently scoped device identity and keeps private failures out of no-cache errors', async () => {
    const broker = access();
    broker.authorizeFrequency.mockRejectedValue(new CollectorAccessErrorV1('denied'));
    const reply = await handleCollectorFrequencyRequestV2(
      desktop({ proof, payload: { operation: 'status', academicYear: 2026 } }),
      testEnv,
      broker,
    );
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ contractVersion: 2, state: 'not-authorized' });
    expect(mocks.execute).not.toHaveBeenCalled();
    broker.authorizeFrequency.mockRejectedValue(new Error('PRIVATE_REFRESH_SENTINEL'));
    const unavailable = await handleCollectorFrequencyRequestV2(
      desktop({ proof, payload: { operation: 'status', academicYear: 2026 } }),
      testEnv,
      broker,
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Cache-Control')).toContain('no-store');
    expect(unavailable.headers.get('Pragma')).toBe('no-cache');
    expect(await unavailable.text()).not.toContain('PRIVATE_REFRESH_SENTINEL');
  });

  it('uses the verified site role and session actor, denying missing auth and teacher role', async () => {
    const payload = { operation: 'status', academicYear: 2026 };
    expect((await handleFrequencyAdminRequestV2(web(payload), testEnv))?.status).toBe(401);
    expect(
      (
        await handleFrequencyAdminRequestV2(
          web(payload, { Cookie: await cookie(['PROFESSOR']) }),
          testEnv,
        )
      )?.status,
    ).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
    const reply = await handleFrequencyAdminRequestV2(
      web(payload, { Cookie: await cookie(['ADMINISTRADOR']) }),
      testEnv,
    );
    expect(reply?.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(payload, {
      mode: 'admin',
      actorId: id,
      tenantId: testEnv.TENANT_ID,
    });
  });

  it('refuses desktop mutations from a valid web administrator session', async () => {
    const Cookie = await cookie(['ADMINISTRADOR']);
    for (const payload of [
      { operation: 'lease', academicYear: 2026, requestId: id, durationSeconds: 60 },
      {
        operation: 'heartbeat',
        academicYear: 2026,
        requestId: id,
        fencingToken: 1,
        status: 'ready',
        classId: null,
        code: null,
      },
      { operation: 'release', academicYear: 2026, requestId: id, fencingToken: 1, code: null },
      {
        operation: 'collect',
        academicYear: 2026,
        requestId: id,
        fencingToken: 1,
        classId: 1,
        expectedRevision: 0,
        sourceVersion: 'sha256:' + 'a'.repeat(64),
        sourceClassId: '1',
        sourceClassLabel: 'SYNTHETIC CLASS',
        observedAt: '2026-10-14T13:00:00Z',
        rosterComplete: true,
        records: [
          { recordKey: '1', originalName: 'SYNTHETIC STUDENT', originalClass: 'SYNTHETIC CLASS' },
        ],
        coverage: [],
        marks: [],
      },
    ])
      expect((await handleFrequencyAdminRequestV2(web(payload, { Cookie }), testEnv))?.status).toBe(
        403,
      );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('checks web origin and methods even with a valid admin cookie', async () => {
    const Cookie = await cookie(['ADMINISTRADOR']);
    const wrong = await handleFrequencyAdminRequestV2(
      web({ operation: 'status', academicYear: 2026 }, { Cookie, Origin: 'https://other.invalid' }),
      testEnv,
    );
    expect(wrong?.status).toBe(403);
    expect(wrong?.headers.get('Cache-Control')).toContain('no-store');
    expect(
      (
        await handleFrequencyAdminRequestV2(
          new Request(origin + '/api/gradebook/frequency/v2'),
          testEnv,
        )
      )?.status,
    ).toBe(405);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      await handleFrequencyAdminRequestV2(new Request(origin + '/api/unrelated'), testEnv),
    ).toBeNull();
  });
});
