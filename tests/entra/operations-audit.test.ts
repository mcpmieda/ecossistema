// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  auditEntraOperations,
  EntraOperationsAuditError,
} from '../../scripts/entra/operations-audit';

const WEB_OBJECT = '11111111-1111-4111-8111-111111111111';
const GRAPH_OBJECT = '22222222-2222-4222-8222-222222222222';
const WEB_APP_ID = '78185e20-c824-4acc-9ccd-41b9f7509a6f';
const GRAPH_APP_ID = '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c';
const OPS_APP_ID = '8d0378b4-832c-4703-8449-5ff2072589a5';
const APPLICATION_READ_ALL = '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30';
const SITES_SELECTED = '883ea226-0bf2-4a8f-9f9d-92c9162a727d';
const TOKEN = 'synthetic-token-that-must-never-appear-in-output';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Entra operations read-only audit', () => {
  it('reads only the two exact applications and sanitizes credential metadata', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      expect(init?.method).toBe('GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      if (url.includes(`/applications/${WEB_OBJECT}`)) {
        return json({
          id: WEB_OBJECT,
          appId: WEB_APP_ID,
          displayName: 'Ecossistema Escolar - Web',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: ['https://admin.escolaieda.com/auth/callback'] },
          keyCredentials: [
            {
              keyId: '55555555-5555-4555-8555-555555555555',
              type: 'AsymmetricX509Cert',
              usage: 'Verify',
              displayName: 'rotation-a',
              startDateTime: '2026-01-01T00:00:00Z',
              endDateTime: '2027-01-01T00:00:00Z',
              customKeyIdentifier: 'synthetic-thumbprint',
              key: 'MUST_NOT_LEAK',
            },
          ],
          passwordCredentials: [
            {
              keyId: '66666666-6666-4666-8666-666666666666',
              displayName: 'legacy-secret',
              startDateTime: '2026-01-01T00:00:00Z',
              endDateTime: '2026-12-31T00:00:00Z',
              secretText: 'MUST_NOT_LEAK',
              hint: 'abc',
            },
          ],
          requiredResourceAccess: [
            {
              resourceAppId: '00000003-0000-0000-c000-000000000000',
              resourceAccess: [{ id: '77777777-7777-4777-8777-777777777777', type: 'Role' }],
            },
          ],
        });
      }
      if (url.includes(`/applications/${GRAPH_OBJECT}`)) {
        return json({
          id: GRAPH_OBJECT,
          appId: GRAPH_APP_ID,
          displayName: 'Ecossistema Escolar - Graph Backend',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          keyCredentials: [
            {
              keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              type: 'AsymmetricX509Cert',
              usage: 'Verify',
              displayName: 'rotation-a',
              startDateTime: '2026-01-01T00:00:00Z',
              endDateTime: '2027-12-31T00:00:00Z',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(WEB_APP_ID))) {
        return json({
          value: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              appId: WEB_APP_ID,
              displayName: 'Synthetic Web SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(GRAPH_APP_ID))) {
        return json({
          value: [
            {
              id: '99999999-9999-4999-8999-999999999999',
              appId: GRAPH_APP_ID,
              displayName: 'Synthetic Graph SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(OPS_APP_ID))) {
        return json({
          value: [
            {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              appId: OPS_APP_ID,
              displayName: 'Ecossistema Operations - GitHub OIDC',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (
        url.includes('/servicePrincipals/88888888-8888-4888-8888-888888888888/appRoleAssignments')
      ) {
        return json({
          value: [
            {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              appRoleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              createdDateTime: '2026-01-01T00:00:00Z',
            },
          ],
        });
      }
      if (
        url.includes('/servicePrincipals/99999999-9999-4999-8999-999999999999/appRoleAssignments')
      ) {
        return json({ value: [] });
      }
      if (
        url.includes('/servicePrincipals/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/appRoleAssignments')
      ) {
        return json({
          value: [
            {
              id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
              appRoleId: APPLICATION_READ_ALL,
              resourceId: '00000003-0000-0000-c000-000000000000',
              createdDateTime: '2026-09-19T00:00:00Z',
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await auditEntraOperations({
      accessToken: TOKEN,
      webApplicationObjectId: WEB_OBJECT,
      graphApplicationObjectId: GRAPH_OBJECT,
      operationsClientId: OPS_APP_ID,
      fetcher,
      now: () => new Date('2026-09-19T00:00:00Z'),
    });

    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(result.generatedAt).toBe('2026-09-19T00:00:00.000Z');
    expect(result.applications.web.servicePrincipal?.accountEnabled).toBe(true);
    expect(result.applications.web.redirectUris.web).toEqual([
      'https://admin.escolaieda.com/auth/callback',
    ]);
    expect(result.applications.web.requiredResourceAccess[0]?.resourceAccess[0]?.type).toBe('Role');
    expect(result.applications.web.servicePrincipal?.appRoleAssignments).toHaveLength(1);
    expect(result.operationsIdentity).toMatchObject({
      appId: OPS_APP_ID,
      displayName: 'Ecossistema Operations - GitHub OIDC',
      accountEnabled: true,
    });
    expect(result.drift.status).toBe('warning');
    expect(result.drift.findings).toContainEqual({
      application: 'web',
      severity: 'warning',
      code: 'password-credential-present',
    });
    expect(result.sharePoint).toEqual({
      enabled: false,
      status: 'disabled',
      isolationProbe: 'not-run',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('MUST_NOT_LEAK');
    expect(serialized).not.toContain('"hint"');
    expect(serialized).not.toContain('"key"');
    expect(serialized).not.toContain('"secretText"');
  });

  it('proves Sites.Selected read access while denying an unselected site', async () => {
    const selectedSite =
      'eduieda.sharepoint.com,d8cb46fa-e401-40a9-9f81-876d59e8cbb0,89a47a04-34fa-4877-8a3c-00d35d246c56';
    const isolationSite =
      'eduieda.sharepoint.com,bc1489eb-2358-475f-a3b6-674e42eb7e53,f3e8239e-3ed7-4eb1-8774-e14743bc0d45';

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes(`/applications/${WEB_OBJECT}`)) {
        return json({
          id: WEB_OBJECT,
          appId: WEB_APP_ID,
          displayName: 'Ecossistema Escolar - Web',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: ['https://admin.escolaieda.com/auth/callback'] },
          keyCredentials: [
            {
              keyId: '11111111-aaaa-4111-8111-111111111111',
              type: 'AsymmetricX509Cert',
              usage: 'Verify',
              endDateTime: '2027-12-31T00:00:00Z',
            },
          ],
        });
      }
      if (url.includes(`/applications/${GRAPH_OBJECT}`)) {
        return json({
          id: GRAPH_OBJECT,
          appId: GRAPH_APP_ID,
          displayName: 'Ecossistema Escolar - Graph Backend',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          keyCredentials: [
            {
              keyId: '22222222-aaaa-4222-8222-222222222222',
              type: 'AsymmetricX509Cert',
              usage: 'Verify',
              endDateTime: '2027-12-31T00:00:00Z',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(WEB_APP_ID))) {
        return json({
          value: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              appId: WEB_APP_ID,
              displayName: 'Web SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(GRAPH_APP_ID))) {
        return json({
          value: [
            {
              id: '99999999-9999-4999-8999-999999999999',
              appId: GRAPH_APP_ID,
              displayName: 'Graph SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(OPS_APP_ID))) {
        return json({
          value: [
            {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              appId: OPS_APP_ID,
              displayName: 'Ecossistema Operations - GitHub OIDC',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (
        url.includes('/servicePrincipals/88888888-8888-4888-8888-888888888888/appRoleAssignments')
      )
        return json({ value: [] });
      if (
        url.includes('/servicePrincipals/99999999-9999-4999-8999-999999999999/appRoleAssignments')
      )
        return json({ value: [] });
      if (
        url.includes('/servicePrincipals/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/appRoleAssignments')
      )
        return json({
          value: [
            {
              id: crypto.randomUUID(),
              appRoleId: APPLICATION_READ_ALL,
              resourceId: crypto.randomUUID(),
            },
            { id: crypto.randomUUID(), appRoleId: SITES_SELECTED, resourceId: crypto.randomUUID() },
          ],
        });
      if (url.includes(encodeURIComponent(selectedSite)) && url.includes('/lists?'))
        return json({ value: [{ id: 'list-a' }, { id: 'list-b' }] });
      if (url.includes(encodeURIComponent(selectedSite)))
        return json({
          id: selectedSite,
          displayName: 'Selected Site',
          webUrl: 'https://example.invalid/sites/selected',
        });
      if (url.includes(encodeURIComponent(isolationSite)))
        return new Response(null, { status: 403 });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await auditEntraOperations({
      accessToken: TOKEN,
      webApplicationObjectId: WEB_OBJECT,
      graphApplicationObjectId: GRAPH_OBJECT,
      operationsClientId: OPS_APP_ID,
      sharePointAuditEnabled: true,
      fetcher,
      now: () => new Date('2026-09-19T00:00:00Z'),
    });

    expect(fetcher).toHaveBeenCalledTimes(11);
    expect(result.drift.status).toBe('ok');
    expect(result.sharePoint).toEqual({
      enabled: true,
      status: 'ok',
      siteId: selectedSite,
      displayName: 'Selected Site',
      webUrl: 'https://example.invalid/sites/selected',
      visibleListCount: 2,
      isolationProbe: 'denied',
    });
  });

  it('fails closed if the Operations identity can read an unselected SharePoint site', async () => {
    const selectedSite =
      'eduieda.sharepoint.com,d8cb46fa-e401-40a9-9f81-876d59e8cbb0,89a47a04-34fa-4877-8a3c-00d35d246c56';
    const isolationSite =
      'eduieda.sharepoint.com,bc1489eb-2358-475f-a3b6-674e42eb7e53,f3e8239e-3ed7-4eb1-8774-e14743bc0d45';

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes(`/applications/${WEB_OBJECT}`)) {
        return json({
          id: WEB_OBJECT,
          appId: WEB_APP_ID,
          displayName: 'Ecossistema Escolar - Web',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: ['https://admin.escolaieda.com/auth/callback'] },
          keyCredentials: [{ keyId: crypto.randomUUID(), endDateTime: '2027-12-31T00:00:00Z' }],
        });
      }
      if (url.includes(`/applications/${GRAPH_OBJECT}`)) {
        return json({
          id: GRAPH_OBJECT,
          appId: GRAPH_APP_ID,
          displayName: 'Ecossistema Escolar - Graph Backend',
          signInAudience: 'AzureADMyOrg',
          web: { redirectUris: [] },
          spa: { redirectUris: [] },
          publicClient: { redirectUris: [] },
          keyCredentials: [{ keyId: crypto.randomUUID(), endDateTime: '2027-12-31T00:00:00Z' }],
        });
      }
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(WEB_APP_ID)))
        return json({
          value: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              appId: WEB_APP_ID,
              displayName: 'Web SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(GRAPH_APP_ID)))
        return json({
          value: [
            {
              id: '99999999-9999-4999-8999-999999999999',
              appId: GRAPH_APP_ID,
              displayName: 'Graph SP',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      if (url.includes('servicePrincipals') && url.includes(encodeURIComponent(OPS_APP_ID)))
        return json({
          value: [
            {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              appId: OPS_APP_ID,
              displayName: 'Ecossistema Operations - GitHub OIDC',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      if (
        url.includes('/servicePrincipals/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/appRoleAssignments')
      )
        return json({
          value: [
            {
              id: crypto.randomUUID(),
              appRoleId: APPLICATION_READ_ALL,
              resourceId: crypto.randomUUID(),
            },
            { id: crypto.randomUUID(), appRoleId: SITES_SELECTED, resourceId: crypto.randomUUID() },
          ],
        });
      if (url.includes('/appRoleAssignments')) return json({ value: [] });
      if (url.includes(encodeURIComponent(selectedSite)) && url.includes('/lists?'))
        return json({ value: [] });
      if (url.includes(encodeURIComponent(selectedSite)))
        return json({
          id: selectedSite,
          displayName: 'Selected Site',
          webUrl: 'https://example.invalid/sites/selected',
        });
      if (url.includes(encodeURIComponent(isolationSite))) return json({ id: isolationSite });
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      auditEntraOperations({
        accessToken: TOKEN,
        webApplicationObjectId: WEB_OBJECT,
        graphApplicationObjectId: GRAPH_OBJECT,
        operationsClientId: OPS_APP_ID,
        sharePointAuditEnabled: true,
        fetcher,
        now: () => new Date('2026-09-19T00:00:00Z'),
      }),
    ).rejects.toMatchObject({
      name: 'EntraOperationsAuditError',
      stage: 'sharepoint-broad-access-detected',
    });
  });

  it('fails closed with a sanitized error instead of provider response content', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('provider-secret-body-MUST_NOT_LEAK', { status: 403 }),
    );

    await expect(
      auditEntraOperations({
        accessToken: TOKEN,
        webApplicationObjectId: WEB_OBJECT,
        graphApplicationObjectId: GRAPH_OBJECT,
        operationsClientId: OPS_APP_ID,
        fetcher,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EntraOperationsAuditError>>({
        name: 'EntraOperationsAuditError',
        status: 403,
      }),
    );

    try {
      await auditEntraOperations({
        accessToken: TOKEN,
        webApplicationObjectId: WEB_OBJECT,
        graphApplicationObjectId: GRAPH_OBJECT,
        operationsClientId: OPS_APP_ID,
        fetcher,
      });
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain('MUST_NOT_LEAK');
    }
  });

  it('rejects invalid or duplicate object IDs before any network request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      auditEntraOperations({
        accessToken: TOKEN,
        webApplicationObjectId: 'not-a-uuid',
        graphApplicationObjectId: GRAPH_OBJECT,
        operationsClientId: OPS_APP_ID,
        fetcher,
      }),
    ).rejects.toBeInstanceOf(EntraOperationsAuditError);
    await expect(
      auditEntraOperations({
        accessToken: TOKEN,
        webApplicationObjectId: WEB_OBJECT,
        graphApplicationObjectId: WEB_OBJECT,
        operationsClientId: OPS_APP_ID,
        fetcher,
      }),
    ).rejects.toBeInstanceOf(EntraOperationsAuditError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
