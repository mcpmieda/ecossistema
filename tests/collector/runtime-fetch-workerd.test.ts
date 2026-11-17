// @vitest-environment node
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

it('reads the person in the directory from real Workerd, with the server identity and native fetch', async () => {
  const tenant = '11111111-1111-4111-8111-111111111111',
    client = '22222222-2222-4222-8222-222222222222',
    graphClient = '66666666-6666-4666-8666-666666666666';
  const actor = '33333333-3333-4333-8333-333333333333',
    group = '44444444-4444-4444-8444-444444444444';
  const now = Date.now();
  const pair = await webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64',
  );
  const credential = JSON.stringify({
    privateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    certificateThumbprint: 'synthetic-thumbprint-value',
    keyId: '77777777-7777-4777-8777-777777777777',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const bundled = await build({
    stdin: {
      contents: `
    import {createCollectorRuntimeV1} from './server/collector/runtime-v1';
    import {readCollectorDirectoryV1} from './server/collector/directory-v1';
    export default {async fetch(){
      const env={OFFICIAL_ORIGIN:'https://admin.escolaieda.com',TENANT_ID:'${tenant}',WEB_CLIENT_ID:'${client}',
        GRAPH_CLIENT_ID:'${graphClient}',GRAPH_CREDENTIAL_A:${JSON.stringify(credential)},
        GROUP_ADMIN_ID:'${group}',COLLECTOR_ENABLED:'true',COLLECTOR_DB:{connectionString:'synthetic-only'},
        SESSION_SECRET:'s'.repeat(43)};
      // No injected Graph: the production dependency signs its assertion and calls native fetch.
      const runtime=await createCollectorRuntimeV1(env,{database:async()=>({query:async()=>[{ready:true}],
        close:async()=>{}})});
      if(!runtime)return new Response('runtime unavailable',{status:503});
      try {
        const binding={tenantId:'${tenant}',clientId:'${client}',actorId:'${actor}',
          grantId:'55555555-5555-4555-8555-555555555555',generation:1,version:0,originAuthenticatedAt:${now}-60000};
        const evidence=await readCollectorDirectoryV1({binding,expectedTenantId:'${tenant}',expectedClientId:'${client}',
          adminGroupId:'${group}',dependencies:runtime.directory});
        return Response.json({actorId:evidence.actorId,window:evidence.directoryValidUntil-evidence.directoryCheckedAt});
      }finally{await runtime.close();}
    }};
  `,
      resolveDir: process.cwd(),
      sourcefile: 'collector-directory-harness.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
  });
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const outgoing: string[] = [];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'collector-directory-proof',
      modules: true,
      script: bundled.outputFiles[0]!.text,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      outboundService: async (request) => {
        const url = new URL(request.url);
        outgoing.push(`${request.method} ${url.host}${url.pathname}`);
        if (url.pathname.endsWith('/token')) {
          const body = new URLSearchParams(await request.text());
          // The server's own identity, never a credential of the person.
          expect(body.get('grant_type')).toBe('client_credentials');
          expect(body.get('client_id')).toBe(graphClient);
          expect(body.get('scope')).toBe('https://graph.microsoft.com/.default');
          return Response.json({ access_token: 'SYNTHETIC_SERVER_TOKEN', expires_in: 3600 });
        }
        expect(request.headers.get('Authorization')).toBe('Bearer SYNTHETIC_SERVER_TOKEN');
        if (url.pathname === `/v1.0/users/${actor}`)
          return Response.json({
            id: actor,
            accountEnabled: true,
            signInSessionsValidFromDateTime: new Date(now - 3600_000).toISOString(),
          });
        if (url.pathname === `/v1.0/users/${actor}/checkMemberGroups`) {
          expect(await request.json()).toEqual({ groupIds: [group] });
          return Response.json({ value: [group] });
        }
        throw new Error('Unexpected synthetic outbound request');
      },
    }),
  );
  try {
    const reply = await runtime.dispatchFetch('http://localhost/');
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ actorId: actor, window: 300_000 });
    expect(outgoing).toEqual([
      `POST login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      `GET graph.microsoft.com/v1.0/users/${actor}`,
      `POST graph.microsoft.com/v1.0/users/${actor}/checkMemberGroups`,
    ]);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
