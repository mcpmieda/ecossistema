// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const fullAccess = PLATFORM_CAPABILITIES;

describe('platform snapshot parsing', () => {
  it('builds the production snapshot without exposing protected or legacy authorization values', () => {
    const snapshot = buildPlatformSnapshot(
      {
        lists: [{ id: 'modules-list', displayName: 'PLATAFORMA_MODULOS' }],
        moduleItems: [
          {
            id: 'module-1',
            fields: {
              Chave: 'plataforma-base',
              Nome: 'Plataforma Base',
              RotaBase: '/',
              Versao: '1.0.0',
              Status: 'instalado',
              Ordem: 0,
              RolesJson: '["LEGACY_ROLE_MUST_NOT_LEAK"]',
              HealthEndpoint: '/api/health',
            },
          },
        ],
        correlationId: 'snapshot-correlation',
        generatedAt: '2026-08-24T18:00:00Z',
      },
      fullAccess,
    );
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.version).toBe('1.0.0');
    expect(snapshot.releaseState).toBe('production');
    expect(snapshot.foundation).toEqual({
      status: 'ok',
      sharePointListCount: 1,
      expectedPlatformListsPresent: true,
      missingPlatformLists: [],
    });
    expect(snapshot.operational).toEqual({ status: 'nominal', healthContractsConfigured: 1, healthContractsMissing: 0 });
    expect(snapshot.registeredModules[0]).toMatchObject({
      key: 'plataforma-base',
      name: 'Plataforma Base',
      status: 'installed',
      contractVersion: 1,
      requiredCapabilities: ['platform.snapshot.read'],
      integrationState: 'ready',
      integrationIssues: [],
      available: true,
    });
    // The SharePoint settings, audit and migration registers were retired (owner decision, #1473).
    expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(['configurations']));
    expect(snapshot).not.toHaveProperty('recentAudit');
    expect(snapshot).not.toHaveProperty('migrations');
    expect(serialized).not.toContain('LEGACY_ROLE_MUST_NOT_LEAK');
    expect(serialized).not.toContain('RolesJson');
    expect(serialized).not.toContain('recovery');
  });

  it('reports degradation instead of returning a false healthy status', () => {
    const snapshot = buildPlatformSnapshot(
      {
        lists: [{ id: 'other-list', displayName: 'OUTRA_LISTA' }],
        moduleItems: [
          {
            id: 'module-1',
            fields: { Chave: 'plataforma-base', Nome: 'Plataforma Base', RotaBase: '/', Versao: '1.0.0', Status: 'VALIDACAO' },
          },
        ],
        correlationId: 'snapshot-degraded',
        generatedAt: '2026-08-24T19:05:00Z',
      },
      fullAccess,
    );

    expect(snapshot.foundation.status).toBe('degraded');
    expect(snapshot.foundation.expectedPlatformListsPresent).toBe(false);
    expect(snapshot.foundation.missingPlatformLists).toEqual(['PLATAFORMA_MODULOS']);
    expect(snapshot.operational).toEqual({ status: 'attention', healthContractsConfigured: 0, healthContractsMissing: 1 });
  });

  it('removes module-specific data when the corresponding capabilities are absent', () => {
    const snapshot = buildPlatformSnapshot(
      {
        lists: [{ id: 'modules-list', displayName: 'PLATAFORMA_MODULOS' }],
        moduleItems: [{ id: 'module-secret', fields: { Nome: 'Sistema restrito' } }],
        correlationId: 'snapshot-limited',
        generatedAt: '2026-08-24T20:00:00Z',
      },
      ['platform.snapshot.read'],
    );

    expect(snapshot.coreModules.map((module) => module.route)).toEqual([]);
    expect(snapshot.operational).toBeNull();
    expect(snapshot.registeredModules).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('Sistema restrito');
  });
});
