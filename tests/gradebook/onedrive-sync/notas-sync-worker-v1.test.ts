// @vitest-environment node
import { describe, expect, it } from 'vitest';
import worker, {
  handleNotificationV1,
  sameSecretV1,
  type NotasSyncEnvV1,
} from '../../../workers/notas-onedrive-sync/index';

const env: NotasSyncEnvV1 = {
  TENANT_ID: '00000000-0000-4000-8000-000000000001',
  GRAPH_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
  NOTAS_SITE_ID: 'synthetic-site',
  NOTAS_FOLDER_PATH: 'PASTA SINTÉTICA',
  NOTAS_SYNC_CLIENT_STATE: 'synthetic-client-state',
  NOTAS_SYNC_PROBE_TOKEN: 'synthetic-probe-token',
};
const origin = 'https://notas-onedrive-sync.example.test';
const call = (request: Request) => worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env);

describe('Notas OneDrive sync Worker', () => {
  it('answers the Graph validation handshake with the token as plain text', async () => {
    const response = await handleNotificationV1(
      new Request(`${origin}/graph/notificacoes?validationToken=abc%20123`, { method: 'POST' }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(await response.text()).toBe('abc 123');
  });

  it('acknowledges notifications with 202, whatever their client state', async () => {
    for (const clientState of ['synthetic-client-state', 'forged']) {
      const response = await call(new Request(`${origin}/graph/notificacoes`, {
        method: 'POST', body: JSON.stringify({ value: [{ clientState, subscriptionId: 's' }] }),
      }));
      expect(response.status).toBe(202);
    }
  });

  it('refuses the probe without the bearer token', async () => {
    for (const authorization of [undefined, 'Bearer wrong', 'synthetic-probe-token']) {
      const headers = authorization ? { Authorization: authorization } : undefined;
      const response = await call(new Request(`${origin}/sonda`, { method: 'POST', headers }));
      expect(response.status).toBe(401);
    }
  });

  it('serves nothing else', async () => {
    expect((await call(new Request(`${origin}/`))).status).toBe(404);
    expect((await call(new Request(`${origin}/sonda`))).status).toBe(404);
  });

  it('compares secrets without accepting an empty expected value', () => {
    expect(sameSecretV1('a', 'a')).toBe(true);
    expect(sameSecretV1('a', 'b')).toBe(false);
    expect(sameSecretV1('ab', 'a')).toBe(false);
    expect(sameSecretV1('', '')).toBe(false);
  });
});
