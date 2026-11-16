// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildMaintenancePlan } from '../../scripts/entra/maintenance-plan';

const MAINTENANCE_CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const MAINTENANCE_SP_ID = '44444444-4444-4444-8444-444444444444';
const WEB_OBJECT_ID = '11111111-1111-4111-8111-111111111111';
const GRAPH_OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const OWNED_BY = '18a4783c-866b-4cc7-a460-3d5e5662c884';
const TOKEN = 'synthetic-maintenance-token-must-not-leak';

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function target(id: string, appId: string, displayName: string, includeCertificateMaterial = true) {
  return {
    id,
    appId,
    displayName,
    keyCredentials: [
      {
        keyId: crypto.randomUUID(),
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        displayName: 'rotation-a',
        startDateTime: '2026-01-01T00:00:00Z',
        endDateTime: '2027-01-01T00:00:00Z',
        customKeyIdentifier: 'synthetic-thumbprint',
        key: includeCertificateMaterial ? 'PUBLIC-CERTIFICATE-MUST-NOT-BE-EMITTED' : null,
      },
    ],
    passwordCredentials: [{ secretText: 'MUST-NOT-LEAK' }],
  };
}

function fetcherFor(
  options: {
    assignments?: Array<{ id: string; appRoleId: string; resourceId: string }>;
    ownedIds?: string[];
  } = {},
) {
  const assignments = options.assignments ?? [
    {
      id: crypto.randomUUID(),
      appRoleId: OWNED_BY,
      resourceId: crypto.randomUUID(),
    },
  ];
  const ownedIds = options.ownedIds ?? [WEB_OBJECT_ID, GRAPH_OBJECT_ID];

  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);

    if (url.includes('/servicePrincipals?')) {
      return json({
        value: [
          {
            id: MAINTENANCE_SP_ID,
            appId: MAINTENANCE_CLIENT_ID,
            displayName: 'Ecossistema Maintenance - GitHub OIDC',
            accountEnabled: true,
            servicePrincipalType: 'Application',
          },
        ],
      });
    }
    if (url.includes(`/servicePrincipals/${MAINTENANCE_SP_ID}/appRoleAssignments`)) {
      return json({ value: assignments });
    }
    if (url.includes(`/servicePrincipals/${MAINTENANCE_SP_ID}/ownedObjects`)) {
      return json({ value: ownedIds.map((id) => ({ id })) });
    }
    if (url.includes(`/applications/${WEB_OBJECT_ID}`)) {
      return json(
        target(WEB_OBJECT_ID, '78185e20-c824-4acc-9ccd-41b9f7509a6f', 'Ecossistema Escolar - Web'),
      );
    }
    if (url.includes(`/applications/${GRAPH_OBJECT_ID}`)) {
      return json(
        target(
          GRAPH_OBJECT_ID,
          '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
          'Ecossistema Escolar - Graph Backend',
        ),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe('Entra Maintenance dry-run', () => {
  it('proves minimal permission, exact ownership and emits only sanitized certificate metadata', async () => {
    const fetcher = fetcherFor();
    const result = await buildMaintenancePlan({
      accessToken: TOKEN,
      maintenanceClientId: MAINTENANCE_CLIENT_ID,
      webApplicationObjectId: WEB_OBJECT_ID,
      graphApplicationObjectId: GRAPH_OBJECT_ID,
      fetcher,
      now: () => new Date('2026-09-19T00:00:00Z'),
    });

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.status).toBe('ready');
    expect(result.identity.applicationPermissions).toEqual(['Application.ReadWrite.OwnedBy']);
    expect(result.identity.ownedApplicationObjectIds).toEqual(
      [WEB_OBJECT_ID, GRAPH_OBJECT_ID].sort(),
    );
    expect(result.targets.web.passwordCredentialCount).toBe(1);
    expect(result.targets.graph.keyCredentials).toHaveLength(1);
    expect(result.targets.web.certificateMaterialReadableCount).toBe(1);
    expect(result.targets.web.allCertificateMaterialReadable).toBe(true);
    expect(result.targets.graph.allCertificateMaterialReadable).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('PUBLIC-CERTIFICATE-MUST-NOT-BE-EMITTED');
    expect(serialized).not.toContain('MUST-NOT-LEAK');
    expect(serialized).not.toContain('secretText');
    expect(serialized).not.toContain('"key"');
  });

  it('reports certificate material readiness without emitting certificate bytes', async () => {
    const fetcher = fetcherFor();
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);

      if (url.includes('/servicePrincipals?')) {
        return json({
          value: [
            {
              id: MAINTENANCE_SP_ID,
              appId: MAINTENANCE_CLIENT_ID,
              displayName: 'Ecossistema Maintenance - GitHub OIDC',
              accountEnabled: true,
              servicePrincipalType: 'Application',
            },
          ],
        });
      }
      if (url.includes(`/servicePrincipals/${MAINTENANCE_SP_ID}/appRoleAssignments`)) {
        return json({
          value: [
            {
              id: crypto.randomUUID(),
              appRoleId: OWNED_BY,
              resourceId: crypto.randomUUID(),
            },
          ],
        });
      }
      if (url.includes(`/servicePrincipals/${MAINTENANCE_SP_ID}/ownedObjects`)) {
        return json({ value: [WEB_OBJECT_ID, GRAPH_OBJECT_ID].map((id) => ({ id })) });
      }
      if (url.includes(`/applications/${WEB_OBJECT_ID}`)) {
        return json(
          target(
            WEB_OBJECT_ID,
            '78185e20-c824-4acc-9ccd-41b9f7509a6f',
            'Ecossistema Escolar - Web',
            false,
          ),
        );
      }
      if (url.includes(`/applications/${GRAPH_OBJECT_ID}`)) {
        return json(
          target(
            GRAPH_OBJECT_ID,
            '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
            'Ecossistema Escolar - Graph Backend',
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await buildMaintenancePlan({
      accessToken: TOKEN,
      maintenanceClientId: MAINTENANCE_CLIENT_ID,
      webApplicationObjectId: WEB_OBJECT_ID,
      graphApplicationObjectId: GRAPH_OBJECT_ID,
      fetcher,
    });

    expect(result.targets.web.certificateMaterialReadableCount).toBe(0);
    expect(result.targets.web.allCertificateMaterialReadable).toBe(false);
    expect(result.targets.graph.certificateMaterialReadableCount).toBe(1);
    expect(result.targets.graph.allCertificateMaterialReadable).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PUBLIC-CERTIFICATE-MUST-NOT-BE-EMITTED');
  });

  it('fails closed if any application permission beyond OwnedBy is granted', async () => {
    const fetcher = fetcherFor({
      assignments: [
        { id: crypto.randomUUID(), appRoleId: OWNED_BY, resourceId: crypto.randomUUID() },
        {
          id: crypto.randomUUID(),
          appRoleId: crypto.randomUUID(),
          resourceId: crypto.randomUUID(),
        },
      ],
    });

    await expect(
      buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: MAINTENANCE_CLIENT_ID,
        webApplicationObjectId: WEB_OBJECT_ID,
        graphApplicationObjectId: GRAPH_OBJECT_ID,
        fetcher,
      }),
    ).rejects.toMatchObject({
      stage: 'maintenance-permission-drift',
    });
  });

  it('fails closed if Maintenance owns any object beyond Web and Graph', async () => {
    const fetcher = fetcherFor({
      ownedIds: [WEB_OBJECT_ID, GRAPH_OBJECT_ID, '55555555-5555-4555-8555-555555555555'],
    });

    await expect(
      buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: MAINTENANCE_CLIENT_ID,
        webApplicationObjectId: WEB_OBJECT_ID,
        graphApplicationObjectId: GRAPH_OBJECT_ID,
        fetcher,
      }),
    ).rejects.toMatchObject({
      stage: 'maintenance-ownership-mismatch',
    });
  });

  it('fails closed if one required target is not owned', async () => {
    const fetcher = fetcherFor({ ownedIds: [WEB_OBJECT_ID] });

    await expect(
      buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: MAINTENANCE_CLIENT_ID,
        webApplicationObjectId: WEB_OBJECT_ID,
        graphApplicationObjectId: GRAPH_OBJECT_ID,
        fetcher,
      }),
    ).rejects.toMatchObject({
      stage: 'maintenance-ownership-mismatch',
    });
  });

  it('never includes provider response bodies in errors', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('provider-secret-MUST-NOT-LEAK', { status: 403 }),
    );

    try {
      await buildMaintenancePlan({
        accessToken: TOKEN,
        maintenanceClientId: MAINTENANCE_CLIENT_ID,
        webApplicationObjectId: WEB_OBJECT_ID,
        graphApplicationObjectId: GRAPH_OBJECT_ID,
        fetcher,
      });
      throw new Error('Expected maintenance plan to fail');
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain('MUST-NOT-LEAK');
    }
  });
});
