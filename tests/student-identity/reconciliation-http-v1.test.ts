// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../server/env';
import { handleStudentReconciliationRequestV1 } from '../../server/student-identity/reconciliation/http-v1';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), execute: vi.fn(), stage: vi.fn() }));
vi.mock('../../server/student-portal/admin-client/pages-context-v1', () => ({
  verifiedPagesContextV1: mocks.authenticate,
}));
vi.mock('../../server/student-identity/reconciliation/service-v1', () => ({
  StudentReconciliationServiceV1: class {
    execute = mocks.execute;
  },
}));
const origin = 'https://admin.synthetic.invalid';
const context = {
  actorId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  requestId: crypto.randomUUID(),
  capability: 'platform.settings.write',
  authenticatedAt: new Date().toISOString(),
};
const env = {
  OFFICIAL_ORIGIN: origin,
  TENANT_ID: context.tenantId,
  SESSION_SECRET: 'synthetic-only-'.repeat(5),
  RUNTIME_ENVIRONMENT: 'local',
  GRADEBOOK_STORAGE_PROVIDER: 'postgres',
  GRADEBOOK_DATABASE: {},
  PORTAL_SERVICE: { prepareReconciliationCredentials: mocks.stage },
} as unknown as RuntimeEnv;
const base = { contractVersion: 1, academicYear: 2026 };
const request = (body: unknown) =>
  new Request(origin + '/api/student-reconciliation/v1', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue(context);
  mocks.execute.mockResolvedValue({
    contractVersion: 1,
    state: 'conflict',
    reason: 'Dados alterados. Confira novamente.',
  });
});
it('rejects unauthorized readers before consuming the payload or touching database/Portal', async () => {
  mocks.authenticate.mockResolvedValue('unauthenticated');
  const response = await handleStudentReconciliationRequestV1(
    request({ ...base, operation: 'list' }),
    env,
  );
  expect(response?.status).toBe(401);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.stage).not.toHaveBeenCalled();
  expect(response?.headers.get('Cache-Control')).toContain('no-store');
});
it('checks the write capability again for every mutation and rejects unrecognized/year-crossing data', async () => {
  const mutation = {
    ...base,
    operation: 'name-source',
    generation: crypto.randomUUID(),
    expectedRevision: 0,
    idempotencyKey: crypto.randomUUID(),
    nameSource: 'report',
  };
  mocks.authenticate.mockResolvedValueOnce(context).mockResolvedValueOnce('forbidden');
  expect((await handleStudentReconciliationRequestV1(request(mutation), env))?.status).toBe(403);
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue(context);
  expect(
    (await handleStudentReconciliationRequestV1(request({ ...mutation, academicYear: 2027 }), env))
      ?.status,
  ).toBe(400);
  expect(
    (
      await handleStudentReconciliationRequestV1(
        request({ ...mutation, pinVerifier: 'synthetic-forbidden' }),
        env,
      )
    )?.status,
  ).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it('returns short CAS failures and never echoes or logs database errors', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const conflict = await handleStudentReconciliationRequestV1(
    request({ ...base, operation: 'list' }),
    env,
  );
  expect(conflict?.status).toBe(409);
  expect(await conflict?.json()).toMatchObject({ reason: 'Dados alterados. Confira novamente.' });
  mocks.execute.mockRejectedValue(new Error('synthetic-private-cell'));
  const response = await handleStudentReconciliationRequestV1(
    request({ ...base, operation: 'list' }),
    env,
  );
  expect(response?.status).toBe(503);
  expect(await response?.text()).not.toContain('synthetic-private-cell');
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
it('runs private credential preparation only after the core has accepted CAS and returns no verifiers', async () => {
  const command = {
    ...base,
    operation: 'stage',
    generation: crypto.randomUUID(),
    expectedRevision: 4,
    idempotencyKey: crypto.randomUUID(),
    batchId: crypto.randomUUID(),
  };
  await handleStudentReconciliationRequestV1(request(command), env);
  expect(mocks.stage).not.toHaveBeenCalled();
  mocks.execute.mockResolvedValue({
    contractVersion: 1,
    state: 'ready',
    operation: 'stage',
    ready: false,
    remaining: 0,
  });
  mocks.stage.mockResolvedValue({ state: 'preparing', preparedCount: 4, remainingCount: 2 });
  const response = await handleStudentReconciliationRequestV1(request(command), env);
  expect(mocks.stage).toHaveBeenCalledWith(context, {
    contractVersion: 1,
    batchId: command.batchId,
    generation: command.generation,
    expectedScopeRevision: 4,
  });
  expect(await response?.json()).toEqual({
    contractVersion: 1,
    state: 'ready',
    operation: 'stage',
    ready: false,
    remaining: 2,
  });
});

describe('Excluir aluno lançado por engano (20/11/2026)', () => {
  const studentUid = '20261120-0000-4000-8000-000000000001';
  const accountId = '20261120-0000-4000-8000-000000000002';
  const removal = () => ({
    ...base,
    operation: 'remove-student',
    generation: crypto.randomUUID(),
    expectedRevision: 3,
    idempotencyKey: crypto.randomUUID(),
    studentUid,
    accountId,
  });
  const origin = (patch: Record<string, unknown>) => ({
    contractVersion: 2,
    requestId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    state: 'account-origin',
    accountId,
    version: 7,
    createdAt: '2026-11-20T09:19:22.000Z',
    everAccessed: false,
    classesThisYear: 1,
    closable: false,
    sameName: [],
    ...patch,
  });
  const committed = {
    contractVersion: 1,
    state: 'committed',
    context: {
      generation: crypto.randomUUID(),
      revision: 4,
      nameSource: 'relation',
      relationAvailable: true,
    },
    operationId: crypto.randomUUID(),
  };
  function portal(first: Record<string, unknown>, second: Record<string, unknown>) {
    const query = vi
      .fn()
      .mockResolvedValueOnce(origin(first))
      .mockResolvedValueOnce(origin(second));
    const command = vi.fn().mockResolvedValue({
      contractVersion: 1,
      requestId: crypto.randomUUID(),
      state: 'committed',
      operationId: crypto.randomUUID(),
      version: 9,
    });
    return { query, command, env: { ...env, PORTAL_SERVICE: { query, command } } as RuntimeEnv };
  }

  it('refuses a student whose Portal account was used, before touching the database', async () => {
    const { command, env: portalEnv } = portal({ everAccessed: true }, {});
    const response = await handleStudentReconciliationRequestV1(request(removal()), portalEnv);
    expect(await response?.json()).toMatchObject({ state: 'conflict' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('removes the class place, closes the unused account, then removes the student', async () => {
    mocks.execute.mockResolvedValue(committed);
    const { command, env: portalEnv } = portal(
      {},
      { classesThisYear: 0, closable: true, version: 8 },
    );
    const response = await handleStudentReconciliationRequestV1(request(removal()), portalEnv);
    expect(await response?.json()).toMatchObject({ state: 'committed', accountClosed: true });
    expect(mocks.execute.mock.calls.map((call) => call[1])).toEqual([
      { accountVersion: 7, step: 'class' },
      { step: 'student' },
    ]);
    expect(command.mock.calls[0]![1]).toMatchObject({
      operation: 'account-close',
      accountId,
      expectedVersion: 8,
      confirmed: true,
    });
  });

  it('stops after the class place when the account could not be closed, and says so', async () => {
    mocks.execute.mockResolvedValue(committed);
    const { command, env: portalEnv } = portal({}, { closable: false });
    const response = await handleStudentReconciliationRequestV1(request(removal()), portalEnv);
    expect(await response?.json()).toMatchObject({ state: 'committed', accountClosed: false });
    expect(command).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
