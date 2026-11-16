// @vitest-environment node
import { expect, it } from 'vitest';
import { portalAdminRpcV1 } from '../../../server/student-portal/composition/admin-v1';
import { readContextV2, READ_CLASS_V2, READ_TENANT_V2 } from './read-fixture-v2';
const env = {
  PORTAL_ENVIRONMENT: 'production',
  PORTAL_ORIGIN: 'https://aluno.escolaieda.com',
  PORTAL_ADMIN_TENANT_ID: READ_TENANT_V2,
  PORTAL_SERVING_ENABLED: 'false',
};
const input = { contractVersion: 2, operation: 'accounts-read', scope: READ_CLASS_V2, page: {} };
it('recognizes V2 at the actual RPC boundary while preserving the serving, tenant and write guards', async () => {
  expect((await portalAdminRpcV1(env, 'query', readContextV2(), input)).state).toBe('unavailable');
  expect(
    (await portalAdminRpcV1(env, 'query', readContextV2(), { ...input, role: 'ADMINISTRADOR' }))
      .state,
  ).toBe('invalid-request');
  expect(
    (
      await portalAdminRpcV1(
        { ...env, PORTAL_ENVIRONMENT: 'preview' },
        'query',
        readContextV2(),
        input,
      )
    ).state,
  ).toBe('forbidden');
  expect(
    (
      await portalAdminRpcV1(
        env,
        'query',
        { ...readContextV2(), tenantId: crypto.randomUUID() },
        input,
      )
    ).state,
  ).toBe('forbidden');
  expect((await portalAdminRpcV1(env, 'command', readContextV2(), input)).state).toBe('forbidden');
  expect(
    (
      await portalAdminRpcV1(
        env,
        'command',
        { ...readContextV2(), capability: 'platform.settings.write' },
        input,
      )
    ).state,
  ).toBe('invalid-request');
});
