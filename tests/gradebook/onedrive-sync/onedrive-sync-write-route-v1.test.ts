// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RuntimeEnv } from '../../../server/env';
import { handleOneDriveSyncWriteRequestV1, ONEDRIVE_SYNC_WRITE_PATH_V1 } from '../../../server/gradebook/http/onedrive-sync-write-route-v1';

const secret = 's'.repeat(48);
const env = { NOTAS_SYNC_WRITE_TOKEN: secret, GRADEBOOK_DATABASE: {} } as unknown as RuntimeEnv;
const call = (body: unknown, token = secret, path = ONEDRIVE_SYNC_WRITE_PATH_V1) =>
  handleOneDriveSyncWriteRequestV1(new Request(`https://admin.escolaieda.com${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, () => undefined);

describe('Pages route for the OneDrive database half', () => {
  it('answers only its own path', async () => {
    expect(await call({}, secret, '/api/gradebook/other')).toBeNull();
  });

  it('refuses a request without the shared secret', async () => {
    expect((await call({}, 'x'.repeat(48)))!.status).toBe(401);
    const noSecret = await handleOneDriveSyncWriteRequestV1(new Request(`https://admin.escolaieda.com${ONEDRIVE_SYNC_WRITE_PATH_V1}`, {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), { } as RuntimeEnv, () => undefined);
    expect(noSecret!.status).toBe(401);
  });

  it('refuses a body that is not a prepared workbook', async () => {
    expect((await call({ version: 1, input: { name: 'x' }, prepared: { outcome: 'ready' } }))!.status).toBe(400);
  });
});
