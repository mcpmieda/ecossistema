import type { RuntimeEnv } from '../server/env';

function rotatedCredential(keyId: string, createdAt: string): string {
  return JSON.stringify({
    privateKeyPkcs8: 'x'.repeat(256),
    certificateThumbprint: 'thumbprint-value-12345',
    keyId,
    createdAt,
  });
}

export const testEnv = {
  TENANT_ID: 'f04e0fa3-b8dc-4f77-be3c-7dfda0635188',
  WEB_CLIENT_ID: '78185e20-c824-4acc-9ccd-41b9f7509a6f',
  GRAPH_CLIENT_ID: '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
  GROUP_ADMIN_ID: '6b9be4a5-52a4-4e41-8654-1564f14e5ab5',
  GROUP_PROFESSOR_ID: '96227794-63b1-421c-96f4-cd062fcdf00a',
  GROUP_ALUNO_ID: '8255b76e-dd85-4d04-a360-8ce1baf6ce63',
  GROUP_APOIO_ID: '74386ce1-2db4-4352-8618-7ab4659ab7b6',
  GROUP_VISITANTE_ID: '9b0283b8-8883-4257-8085-3ac60060d489',
  OFFICIAL_ORIGIN: 'https://admin.escolaieda.com',
  WEB_CREDENTIAL_A: rotatedCredential(
    '11111111-1111-4111-8111-111111111111',
    '2026-09-19T15:38:20.000Z',
  ),
  WEB_CREDENTIAL_B: rotatedCredential(
    '22222222-2222-4222-8222-222222222222',
    '2026-08-24T16:02:00.054Z',
  ),
  GRAPH_CREDENTIAL_A: rotatedCredential(
    '33333333-3333-4333-8333-333333333333',
    '2026-08-24T16:01:18.701Z',
  ),
  GRAPH_CREDENTIAL_B: rotatedCredential(
    '44444444-4444-4444-8444-444444444444',
    '2026-09-19T15:43:58.000Z',
  ),
  SESSION_SECRET: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
} satisfies RuntimeEnv;
