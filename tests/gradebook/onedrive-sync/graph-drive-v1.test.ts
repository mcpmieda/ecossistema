// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  driveWorkbookFromItemV1,
  graphCreateDriveSubscriptionV1,
  graphDownloadWorkbookV1,
  graphDriveDeltaV1,
  graphFolderWorkbooksV1,
  WorkbookTooLargeError,
  type GraphAppEnvV1,
} from '../../../server/gradebook/onedrive-sync/graph-drive-v1';

async function syntheticCredentialV1(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const base64 = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))).toString('base64');
  return JSON.stringify({
    privateKeyPkcs8: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    certificateThumbprint: 'synthetic-thumbprint-value', keyId: crypto.randomUUID(), createdAt: '2026-01-01T00:00:00.000Z',
  });
}

async function syntheticEnvV1(): Promise<GraphAppEnvV1> {
  return {
    TENANT_ID: '00000000-0000-4000-8000-000000000001',
    GRAPH_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
    GRAPH_CREDENTIAL_A: await syntheticCredentialV1(),
  };
}

/** Token endpoint plus a router of Graph URLs to synthetic answers. */
function graphMockV1(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const route = Object.keys(routes).find((key) => url.includes(key));
    return route ? routes[route]!() : new Response(null, { status: 404 });
  });
  return { calls, dependencies: { fetch, sleep: async () => undefined } };
}

const workbookItem = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, size: 1000, lastModifiedDateTime: '2026-11-13T10:00:00Z', eTag: `"${id}"`,
  file: { hashes: { quickXorHash: `hash-${id}` } }, parentReference: { id: 'folder-1' }, ...extra,
});

describe('Graph drive access for the Notas sync', () => {
  it('keeps workbook files and deletions, and drops folders and other files', () => {
    expect(driveWorkbookFromItemV1(workbookItem('a', 'Planilha sintética.xlsb'))?.quickXorHash).toBe('hash-a');
    expect(driveWorkbookFromItemV1(workbookItem('b', 'outra.XLSX'))).not.toBeNull();
    expect(driveWorkbookFromItemV1(workbookItem('c', 'nota.pdf'))).toBeNull();
    expect(driveWorkbookFromItemV1({ id: 'd', name: 'pasta', folder: {} })).toBeNull();
    expect(driveWorkbookFromItemV1({ id: 'e', deleted: {}, parentReference: { id: 'folder-1' } })).toMatchObject({
      id: 'e', deleted: true, parentId: 'folder-1',
    });
  });

  it('lists every page of the folder', async () => {
    const graph = graphMockV1({
      'skiptoken=2': () => Response.json({ value: [workbookItem('b', 'b.xlsb')] }),
      '/children': () => Response.json({
        value: [workbookItem('a', 'a.xlsb'), { id: 'x', name: 'sub', folder: {} }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/d/items/folder-1/children?$skiptoken=2',
      }),
    });
    const files = await graphFolderWorkbooksV1(await syntheticEnvV1(), 'd', 'folder-1', graph.dependencies);
    expect(files.map((file) => file.id)).toEqual(['a', 'b']);
  });

  it('follows delta pages to the next deltaLink', async () => {
    const graph = graphMockV1({
      'token=page2': () => Response.json({
        value: [{ id: 'gone', deleted: {}, parentReference: { id: 'folder-1' } }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/d/root/delta?token=next',
      }),
      '/root/delta': () => Response.json({
        value: [workbookItem('a', 'a.xlsb')],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/d/root/delta?token=page2',
      }),
    });
    const result = await graphDriveDeltaV1(await syntheticEnvV1(), 'd', null, graph.dependencies);
    expect(result.changes.map((item) => [item.id, item.deleted])).toEqual([['a', false], ['gone', true]]);
    expect(result.deltaLink).toBe('https://graph.microsoft.com/v1.0/drives/d/root/delta?token=next');
  });

  it('downloads the bytes and refuses files over the limit', async () => {
    const env = await syntheticEnvV1();
    const small = graphMockV1({ '/content': () => new Response(new Uint8Array([1, 2, 3])) });
    expect(new Uint8Array(await graphDownloadWorkbookV1(env, 'd', 'a', 10, small.dependencies))).toEqual(new Uint8Array([1, 2, 3]));
    const big = graphMockV1({
      '/content': () => new Response(new Uint8Array(20), { headers: { 'Content-Length': '20' } }),
    });
    await expect(graphDownloadWorkbookV1(env, 'd', 'a', 10, big.dependencies)).rejects.toBeInstanceOf(WorkbookTooLargeError);
  });

  it('subscribes to the drive root with the client state', async () => {
    const graph = graphMockV1({
      '/subscriptions': () => Response.json({ id: 'sub-1', expirationDateTime: '2026-11-13T11:00:00Z' }, { status: 201 }),
    });
    const created = await graphCreateDriveSubscriptionV1(await syntheticEnvV1(), {
      driveId: 'd', notificationUrl: 'https://sync.example.test/graph/notificacoes', clientState: 'synthetic-state',
      expiresAt: new Date('2026-11-13T11:00:00Z'), dependencies: graph.dependencies,
    });
    expect(created.id).toBe('sub-1');
    const body = JSON.parse(String(graph.dependencies.fetch.mock.calls.at(-1)![1]!.body));
    expect(body).toMatchObject({ changeType: 'updated', resource: '/drives/d/root', clientState: 'synthetic-state' });
  });
});
