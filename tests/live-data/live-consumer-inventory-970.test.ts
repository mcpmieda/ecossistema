// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const consumers = [
  ['src/features/gradebook/performance/use-performance-analytics-v6.ts', "domains: ['gradebook']"],
  ['src/features/gradebook/performance/use-relational-performance-v2.ts', "domains: ['gradebook']"],
  ['src/features/gradebook/council/use-relational-council-v3.ts', "domains: ['gradebook']"],
  ['src/features/gradebook/bulletins/relational-bulletin-page-v2.tsx', "domains: ['gradebook']"],
  ['src/features/gradebook/audit-workspace/relational-current-audit-page-v2.tsx', "domains: ['gradebook']"],
  ['src/features/gradebook/settings/assessment-names-v1.tsx', "domains: ['gradebook']"],
  ['src/features/student-portal-admin/accounts/accounts-read-v1.ts', "domains: ['portal', 'gradebook']"],
  ['src/features/student-portal-admin/settings/student-settings-v1.tsx', "domains: ['portal', 'gradebook']"],
  ['src/features/student-portal-admin/publication/student-publication-v1.tsx', "domains: ['portal', 'gradebook']"],
] as const;

describe('BN-21 current live consumer inventory', () => {
  it('keeps the nine direct refresh owners wired to authorized re-read invalidation', () => {
    expect(consumers).toHaveLength(9);
    for (const [path, domains] of consumers) {
      const value = source(path);
      expect(value, path).toContain('useLiveRefreshV1');
      expect(value, path).toContain(domains);
    }
  });

  it('keeps canonical birth and the QR account collection on the shared authorized refresh chain', () => {
    const birth = source('src/features/student-portal-admin/birth-year/student-birth-years-v1.tsx');
    const accounts = source('src/features/student-portal-admin/accounts/student-accounts-v1.tsx');
    expect(birth).toContain('useContinuousReadV1(load,');
    expect(accounts).toContain('useContinuousReadV1(');
    expect(accounts).toContain('<QrBatchToolsV1');
    expect(source('src/features/student-portal-admin/shared/continuous-read-v1.tsx')).toContain(
      'useOperationalReadV1(load, onAuthorizationLost, active, eventDriven)',
    );
    expect(source('src/features/student-portal-admin/overview/operations-values-v1.ts')).toContain(
      'useAccountsReadV1(guarded, active, eventDriven)',
    );
    expect(birth).not.toContain('LIVE_HEAVY_READ_INTERVAL_V1');
    expect(accounts).not.toContain('LIVE_HEAVY_READ_INTERVAL_V1');
  });

  it('does not silently turn the heavy analytics cadence into a universal rule', () => {
    const heavy = source('src/features/gradebook/performance/use-performance-analytics-v6.ts');
    expect(heavy).toContain('LIVE_HEAVY_READ_INTERVAL_V1');
    expect(heavy).toContain('intervalMs: LIVE_HEAVY_READ_INTERVAL_V1');

    // Desempenho's Notas reads the whole class at once and joined the heavy cadence by the
    // owner's decision of 08/10/2026; every other consumer keeps the interactive one.
    const notes = source('src/features/gradebook/performance/use-relational-performance-v2.ts');
    expect(notes).toContain('intervalMs: LIVE_HEAVY_READ_INTERVAL_V1');

    for (const [path] of consumers) {
      if (path.endsWith('use-performance-analytics-v6.ts')) continue;
      if (path.endsWith('use-relational-performance-v2.ts')) continue;
      expect(source(path), path).not.toContain('LIVE_HEAVY_READ_INTERVAL_V1');
    }
  });

  it('preserves the package-level CAS, draft and fallback regression owners', () => {
    const regressionOwners = [
      'tests/live-data/draft-and-cadence-839.test.tsx',
      'tests/live-data/live-refresh-scope-839.test.tsx',
      'tests/live-data/administrative-live-resilience-839.test.tsx',
      'tests/live-data/read-resilience-839.test.ts',
      'tests/student-portal/persistence/live-outbox-v1.test.ts',
    ] as const;

    for (const path of regressionOwners) {
      expect(source(path).length, path).toBeGreaterThan(0);
    }

    expect(source('tests/live-data/draft-and-cadence-839.test.tsx')).toContain('expectedVersion');
    expect(source('tests/student-portal/persistence/live-outbox-v1.test.ts')).toContain(
      'live_event_outbox_v1',
    );
  });
});
