import { describe, expect, it } from 'vitest';
import type { PlatformSnapshotContract } from '../shared/platform-contract';
import { STUDENT_PORTAL_MODULE } from '../shared/platform-contract';
import { buildSearchItems, filterSearchItems, normalizeSearch } from '../src/platform/search-model';

const snapshot = {
  version: '1.0.0',
  releaseState: 'production',
  generatedAt: '2026-08-24T19:00:00.000Z',
  correlationId: 'corr-search-test',
  foundation: {
    status: 'ok',
    sharePointListCount: 12,
    expectedPlatformListsPresent: true,
    missingPlatformLists: [],
  },
  operational: {
    status: 'nominal',
    recentAuditFailureCount: 0,
    healthContractsConfigured: 0,
    healthContractsMissing: 0,
    lastAuditAt: '2026-08-24T18:44:00.000Z',
    recoveryStatus: 'not-verified',
    recoveryVerifiedAt: '',
    recoveryEvidenceRef: '',
    recoveryScope: 'sharepoint-disposable-record-backup-restore-roundtrip',
  },
  coreModules: [
    {
      id: 'platform.settings',
      name: 'Configurações',
      description: 'Governança dos parâmetros da plataforma.',
      route: 'configuracoes',
      state: 'ready',
      requiredRole: 'ADMINISTRADOR',
      capabilities: ['platform.settings.read'],
    },
    {
      id: 'platform.operations',
      name: 'Saúde',
      description: 'Disponibilidade e trilha de auditoria.',
      route: 'operacao',
      state: 'ready',
      requiredRole: 'ADMINISTRADOR',
      capabilities: ['platform.health.read'],
    },
  ],
  registeredModules: [],
  configurations: [
    {
      id: 'config-1',
      key: 'PLATAFORMA.NAVEGACAO',
      scope: 'GLOBAL',
      version: '3',
      active: true,
      effectiveFrom: '',
      effectiveUntil: '',
      updatedAt: '2026-08-24T18:00:00.000Z',
    },
  ],
  recentAudit: [
    {
      id: 'audit-1',
      eventId: 'evt-1',
      occurredAt: '2026-08-24T18:44:00.000Z',
      module: 'Centro',
      action: 'SEGREDO_NAO_INDEXAR',
      entityType: 'SESSION',
      correlationId: 'corr-audit',
      result: 'OK',
    },
  ],
  migrations: [
    {
      id: 'migration-1',
      version: '0.2.0',
      module: 'SEGREDO_MIGRACAO_NAO_INDEXAR',
      appliedAt: '2026-08-24T17:00:00.000Z',
      result: 'OK',
    },
  ],
} satisfies PlatformSnapshotContract;

describe('platform search model', () => {
  it('indexes the independent Conciliação area while preserving Alunos in the legacy Panel', () => {
    const items = buildSearchItems({
      ...snapshot,
      coreModules: [...snapshot.coreModules, STUDENT_PORTAL_MODULE],
    });
    expect(items.find((item) => item.id === 'students:reconciliation')).toMatchObject({
      label: 'Conciliação',
      category: 'Área',
      href: '#/painel-do-aluno?area=reconciliation',
    });
    expect(filterSearchItems(items, 'conciliação pendências')[0]?.id).toBe(
      'students:reconciliation',
    );
    expect(items.find((item) => item.id === 'student-portal:accounts')).toMatchObject({
      label: 'Alunos',
      category: 'Seção',
      href: '#/painel-do-aluno?area=accounts',
    });
  });
  it('normalizes accents and case for Portuguese search', () => {
    expect(normalizeSearch('Configurações')).toBe('configuracoes');
    expect(normalizeSearch('AUDITORIA')).toBe('auditoria');
  });

  it('indexes core areas, all gradebook entry points and configuration metadata', () => {
    const items = buildSearchItems(snapshot);

    expect(items.map((item) => item.id)).toEqual([
      'core:platform.settings',
      'core:platform.operations',
      'core:content.notes',
      'notes:importacao',
      'notes:performance',
      'notes:bulletins',
      'notes:council',
      'notes:audit',
      'notes:settings',
      'health:audit',
      'config:config-1',
    ]);
    expect(items.some((item) => item.id === 'notes:operational')).toBe(false);
    expect(items.some((item) => item.href.includes('area=operational'))).toBe(false);
    expect(filterSearchItems(items, 'Centrais')).toEqual([]);
    expect(filterSearchItems(items, 'SEGREDO_NAO_INDEXAR')).toEqual([]);
    expect(filterSearchItems(items, 'SEGREDO_MIGRACAO_NAO_INDEXAR')).toEqual([]);
  });

  it('finds accent-insensitive matches and routes core areas correctly', () => {
    const items = buildSearchItems(snapshot);

    expect(filterSearchItems(items, 'configuracoes')[0]?.href).toBe('#/configuracoes');
    expect(filterSearchItems(items, 'rastreabilidade')[0]?.href).toBe('#/operacao?area=audit');
    expect(filterSearchItems(items, 'importar planilha')[0]?.href).toBe('#/banco-de-notas');
    expect(filterSearchItems(items, 'conselho classe')[0]?.id).toBe('notes:council');
    expect(filterSearchItems(items, 'desempenho resultado')[0]?.id).toBe('notes:performance');
    expect(filterSearchItems(items, 'relatórios recuperação')).toEqual([]);
    expect(items.some((item) => item.href.includes('area=reports'))).toBe(false);
    expect(filterSearchItems(items, 'resetar ano letivo')[0]?.id).toBe('notes:settings');
  });

  it('enforces the result limit', () => {
    const items = buildSearchItems(snapshot);
    expect(filterSearchItems(items, '', 2)).toHaveLength(2);
    expect(filterSearchItems(items, '', 0)).toHaveLength(0);
  });
});
