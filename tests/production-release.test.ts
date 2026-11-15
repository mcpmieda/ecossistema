// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { coreModules } from '../server/platform/manifest';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Centro de Administração production release', () => {
  it('publishes the approved core as production, with no placeholder area', () => {
    const states = new Map(coreModules.map((module) => [module.route, module.state]));

    expect(states.get('operacao')).toBe('ready');
    expect(states.get('configuracoes')).toBe('ready');
    expect(coreModules.every((module) => module.state === 'ready')).toBe(true);

    const snapshot = buildPlatformSnapshot(
      {
        lists: [],
        moduleItems: [],
        correlationId: 'production-release-test',
        generatedAt: '2026-08-25T18:00:00.000Z',
      },
      PLATFORM_CAPABILITIES,
    );

    expect(snapshot.version).toBe('1.0.0');
    expect(snapshot.releaseState).toBe('production');
  });

  it('does not expose release-candidate or developer-only language in the production interface', () => {
    const presentation = [
      source('src/App.tsx'),
      source('src/platform/navigation.tsx'),
      source('src/platform/pages.tsx'),
      source('src/platform/operations-page.tsx'),
      source('src/platform/presentation.tsx'),
    ].join('\n');

    expect(presentation).not.toMatch(
      /Ambiente de validação|Centro em validação controlada|Validação restrita|capabilities administrativas|nesta candidata|ativo em validação|Microsoft Entra ID|HealthEndpoint|read model|\bBFF\b|sidebar-validation-alert/u,
    );
  });
});
