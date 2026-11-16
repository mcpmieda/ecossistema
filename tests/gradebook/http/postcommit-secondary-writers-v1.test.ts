// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import { createAssessmentNamesRequestHandlerV1 } from '../../../server/gradebook/http/assessment-names-routes-v1';
import { createImportDiagnosticTreatmentRequestHandlerV1 } from '../../../server/gradebook/http/import-diagnostic-treatment-routes-v1';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), authorize: vi.fn(), auth: vi.fn() }));
vi.mock('../../../server/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/auth/session')>()),
  requireAuth: mocks.auth,
}));
vi.mock('../../../server/gradebook/authorization-v1', () => ({
  authorizeGradebookRuntimeV1: mocks.authorize,
}));
vi.mock('../../../server/gradebook/application/settings/assessment-names-v1', () => ({
  createAssessmentNamesServiceV1: () => ({ execute: mocks.execute }),
}));
vi.mock('../../../server/gradebook/application/audit/import-diagnostic-treatment-v1', () => ({
  createImportDiagnosticTreatmentServiceV1: () => ({ execute: mocks.execute }),
}));
const env = {
  OFFICIAL_ORIGIN: 'https://admin.example.test',
  RUNTIME_ENVIRONMENT: 'local',
  GRADEBOOK_STORAGE_PROVIDER: 'postgres',
  GRADEBOOK_DATABASE: {},
} as unknown as RuntimeEnv;
const session = { oid: '12345678-1111-4111-8111-111111111111' };
const request = (path: string, body: unknown) =>
  new Request(`${env.OFFICIAL_ORIGIN}/api/gradebook/${path}`, {
    method: 'POST',
    headers: { Origin: env.OFFICIAL_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(session);
});

it('assessment save notifies only after committed service completion and skips reads, unchanged saves and conflicts', async () => {
  const handler = createAssessmentNamesRequestHandlerV1(),
    notify = vi.fn();
  const save = { contractVersion: 1, operation: 'save', year: 2026, expectedVersion: 2, names: {} };
  let complete!: (value: unknown) => void;
  mocks.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const response = handler(request('assessment-names', save), env, notify);
  await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
  expect(notify).not.toHaveBeenCalled();
  complete({ contractVersion: 1, state: 'ready', year: 2026, version: 3, names: {} });
  expect((await response)?.status).toBe(200);
  expect(notify).toHaveBeenCalledExactlyOnceWith(session);
  notify.mockClear();
  for (const [payload, result] of [
    [
      { contractVersion: 1, operation: 'read', year: 2026 },
      { state: 'ready', version: 3 },
    ],
    [save, { state: 'ready', version: 2 }],
    [save, { state: 'conflict' }],
  ]) {
    mocks.execute.mockResolvedValueOnce(result);
    await handler(request('assessment-names', payload), env, notify);
  }
  expect(notify).not.toHaveBeenCalled();
});

it('audit treatment only notifies a successful committed record, not a history read or rejection', async () => {
  const handler = createImportDiagnosticTreatmentRequestHandlerV1(),
    notify = vi.fn();
  for (const result of [
    { state: 'ready', operation: 'history' },
    { state: 'not-found' },
    { state: 'ready', operation: 'record' },
  ]) {
    mocks.execute.mockResolvedValueOnce(result);
    await handler(request('audit-treatment', {}), env, notify);
  }
  expect(notify).toHaveBeenCalledExactlyOnceWith(session);
});
