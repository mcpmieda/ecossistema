// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { graphReadUrlV1 } from '../../scripts/entra/graph-read-url-v1';
import { buildMaintenancePlan } from '../../scripts/entra/maintenance-plan';
import { auditEntraOperations } from '../../scripts/entra/operations-audit';

const OBJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const SITE = encodeURIComponent(`eduieda.sharepoint.com,${OBJECT},${OTHER}`);
const TOKEN = 'synthetic-token-do-not-emit';
const BAD_IDS = [
  '.',
  '..',
  '../applications',
  '%2e%2e',
  '%252e%252e',
  'https://attacker.invalid/secret',
  '//attacker.invalid',
  'x/y',
  'x\\y',
  'id?secret',
  'id#secret',
];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

function assertSafeRead(input: Parameters<typeof fetch>[0], init?: RequestInit): URL {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://graph.microsoft.com');
  expect(init?.method).toBe('GET');
  expect(init?.redirect).toBe('error');
  expect(init?.signal).toBeDefined();
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
  return url;
}

describe('Entra Graph read destination boundary', () => {
  it.each([
    `/applications/${OBJECT}?$select=id%2CappId`,
    '/servicePrincipals?$top=2',
    `/servicePrincipals/${PRINCIPAL}/appRoleAssignments?$top=100`,
    `/servicePrincipals/${PRINCIPAL}/ownedObjects?$select=id`,
    `/sites/${SITE}?$select=id`,
    `/sites/${SITE}/lists?$select=id&$top=20`,
  ])('preserves a permitted read: %s', (path) => {
    const actual = new URL(graphReadUrlV1(path));
    expect(actual.origin).toBe('https://graph.microsoft.com');
    expect(actual.pathname).toBe(`/v1.0${path.split('?')[0]}`);
    expect(actual.searchParams.toString()).toBe(new URLSearchParams(path.split('?')[1]).toString());
  });

  it('preserves the meaning of encoded OData filters', () => {
    const filter = `appId eq '${CLIENT}'`;
    const url = new URL(
      graphReadUrlV1(`/servicePrincipals?$filter=${encodeURIComponent(filter)}&$top=2`),
    );
    expect(url.searchParams.get('$filter')).toBe(filter);
  });

  it.each([
    '',
    'https://attacker.invalid',
    '//attacker.invalid',
    'https://graph.microsoft.com.attacker.invalid/v1.0/servicePrincipals',
    'https://graph.microsoft.com@attacker.invalid/v1.0/servicePrincipals',
    'https://graph.microsoft.com:8443/v1.0/servicePrincipals',
    'http://graph.microsoft.com/v1.0/servicePrincipals',
    '/users',
    '/$batch',
    '/beta/servicePrincipals',
    '/applications',
    '/servicePrincipals/../servicePrincipals',
    '/servicePrincipals/%2e%2e/servicePrincipals',
    '/servicePrincipals#',
    '/servicePrincipals?$top=2#secret',
    '/servicePrincipals\n',
    '/servicePrincipals?x=\\secret',
    `/applications/${OBJECT}/owners`,
    `/sites/${encodeURIComponent(`other.sharepoint.com,${OBJECT},${OTHER}`)}`,
    `/sites/${SITE}/drive`,
    '/servicePrincipals?x=' + 'x'.repeat(8192),
    ...BAD_IDS.map((id) => `/servicePrincipals/${encodeURIComponent(id)}/appRoleAssignments`),
  ])('rejects an unapproved destination without reflecting it: %s', (path) => {
    expect(() => graphReadUrlV1(path)).toThrow('entra-graph-read-url-not-allowed');
  });

  it.each(BAD_IDS)('maintenance never dispatches a path derived from remote id %s', async (id) => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = assertSafeRead(input, init);
      expect(url.pathname).toBe('/v1.0/servicePrincipals');
      return json({
        value: [
          {
            id,
            appId: CLIENT,
            displayName: 'Ecossistema Maintenance - GitHub OIDC',
            accountEnabled: true,
          },
        ],
      });
    });
    await expect(
      buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: CLIENT,
        webApplicationObjectId: OBJECT,
        graphApplicationObjectId: OTHER,
        fetcher,
      }),
    ).rejects.toMatchObject({ stage: 'maintenance-app-role-assignments-transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['operations', 'web', 'graph'] as const)(
    'audit guards the remote %s principal before a derived request',
    async (target) => {
      const webApp = '78185e20-c824-4acc-9ccd-41b9f7509a6f';
      const graphApp = '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c';
      for (const id of BAD_IDS) {
        let rejectedPathReached = false;
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
          const url = assertSafeRead(input, init);
          if (url.pathname.startsWith('/v1.0/applications/')) {
            const isWeb = url.pathname.endsWith(OBJECT);
            return json({
              id: isWeb ? OBJECT : OTHER,
              appId: isWeb ? webApp : graphApp,
              displayName: 'Synthetic application',
            });
          }
          if (url.pathname === '/v1.0/servicePrincipals') {
            const filter = url.searchParams.get('$filter') ?? '';
            const label = filter.includes(CLIENT)
              ? 'operations'
              : filter.includes(webApp)
                ? 'web'
                : 'graph';
            return json({
              value: [
                {
                  id: label === target ? id : PRINCIPAL,
                  appId: CLIENT,
                  displayName: 'Synthetic principal',
                },
              ],
            });
          }
          if (
            url.pathname !== `/v1.0/servicePrincipals/${PRINCIPAL}/appRoleAssignments` &&
            url.pathname !== `/v1.0/servicePrincipals/${PRINCIPAL}/oauth2PermissionGrants`
          ) {
            rejectedPathReached = true;
          }
          return json({ value: [] });
        });
        await expect(
          auditEntraOperations({
            accessToken: TOKEN,
            operationsClientId: CLIENT,
            webApplicationObjectId: OBJECT,
            graphApplicationObjectId: OTHER,
            fetcher,
          }),
        ).rejects.toThrow('entra-graph-read-url-not-allowed');
        expect(rejectedPathReached).toBe(false);
      }
    },
  );

  it('maintenance refuses remote pagination instead of following an arbitrary URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = assertSafeRead(input, init);
      if (url.pathname === '/v1.0/servicePrincipals') {
        return json({
          value: [
            {
              id: PRINCIPAL,
              appId: CLIENT,
              displayName: 'Ecossistema Maintenance - GitHub OIDC',
              accountEnabled: true,
            },
          ],
        });
      }
      expect(url.pathname).toBe(`/v1.0/servicePrincipals/${PRINCIPAL}/appRoleAssignments`);
      return json({ value: [], '@odata.nextLink': 'https://attacker.invalid/secret' });
    });
    await expect(
      buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: CLIENT,
        webApplicationObjectId: OBJECT,
        graphApplicationObjectId: OTHER,
        fetcher,
      }),
    ).rejects.toMatchObject({ stage: 'maintenance-app-role-assignments-capacity' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
