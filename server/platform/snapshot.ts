import type { PlatformCapability } from '../../shared/platform-contract';
import type { PlatformSnapshotV2 } from '../../shared/platform-snapshot-v2';
import { coreModules } from './manifest';

/** The native modules this person may open. Nothing is read from Microsoft or the database. */
export function buildPlatformSnapshot(
  source: { correlationId: string; generatedAt?: string },
  capabilities: readonly PlatformCapability[],
): PlatformSnapshotV2 {
  return {
    version: '1.0.0',
    releaseState: 'production',
    generatedAt: source.generatedAt ?? new Date().toISOString(),
    correlationId: source.correlationId,
    coreModules: coreModules.filter((module) =>
      module.capabilities.every((capability) => capabilities.includes(capability)),
    ),
  };
}
