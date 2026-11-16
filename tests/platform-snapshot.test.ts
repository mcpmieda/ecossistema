// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { buildPlatformSnapshot } from '../server/platform/snapshot';
import { coreModules } from '../server/platform/manifest';

describe('platform snapshot', () => {
  it('builds the production snapshot from the native modules only', () => {
    const snapshot = buildPlatformSnapshot(
      { correlationId: 'snapshot-correlation', generatedAt: '2026-08-24T18:00:00Z' },
      PLATFORM_CAPABILITIES,
    );

    expect(snapshot).toEqual({
      version: '1.0.0',
      releaseState: 'production',
      generatedAt: '2026-08-24T18:00:00Z',
      correlationId: 'snapshot-correlation',
      coreModules,
    });
    // The SharePoint registers (modules, settings, audit, migrations) are no longer read (#1473, #1490).
    for (const retired of ['foundation', 'operational', 'registeredModules', 'configurations', 'recentAudit', 'migrations'])
      expect(snapshot).not.toHaveProperty(retired);
  });

  it('keeps only the modules whose capabilities were granted', () => {
    const snapshot = buildPlatformSnapshot({ correlationId: 'snapshot-limited' }, ['platform.snapshot.read']);
    expect(snapshot.coreModules).toEqual([]);
    const settings = buildPlatformSnapshot({ correlationId: 'snapshot-settings' }, ['platform.snapshot.read', 'platform.settings.read']);
    expect(settings.coreModules.map((module) => module.route)).toEqual(['painel-do-aluno', 'configuracoes']);
  });
});
