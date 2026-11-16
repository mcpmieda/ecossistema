import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPortalFrontendHarnessV1, localPortalDatabaseV1 } from './harness-v1';
const target = localPortalDatabaseV1(process.env.PORTAL_TEST_DATABASE_URL ?? 'http://invalid');
let harness: Awaited<ReturnType<typeof createPortalFrontendHarnessV1>>;
beforeAll(async () => {
  harness = await createPortalFrontendHarnessV1(target);
});
afterAll(async () => {
  await harness?.dispose();
});
it('passes a synthetic absent session through Pages and the restricted PostgreSQL composition', async () => {
  const response = await harness.fetch('https://aluno.escolaieda.com/api/student/me', {
    headers: { cookie: `__Host-student_portal_session=${'a'.repeat(43)}` },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ contractVersion: 1, state: 'unauthenticated' });
});
