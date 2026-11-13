import { expect, it, vi } from 'vitest';
import { scopedSelfV2 } from '../../../server/student-portal/publication/scoped-self-v2';
import { PERIODS_V1 } from '../../../server/student-portal/publication/state-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { PARALLEL_ACCOUNT_848, PARALLEL_VERSION_848, parallelFixture848 } from '../../gradebook/performance/parallel-visibility-fixture-848';

const NEWER_848 = `${'8'.repeat(32)}:2`;

/** Low edition: every term at 14 (T3 14/40, in recovery). High edition: every term at 30. `swap` puts the high one first. */
function sources848(swap: boolean) {
  const fixture = parallelFixture848();
  const edition = (value: number, am: number) => ({ ...fixture.portalSource, offers: fixture.portalSource.offers.map((offer) => ({
    ...offer,
    instruments: offer.instruments.map((item) => ({ ...item, value: item.slot === 3 ? null : item.slot === 11 ? 10000 : value })),
    closure: { am1: am, am2: am, am3: am, rec1: null, rec2: null, rec3: null, nc: 0, rr: 0, annual: am * 3 },
  })) });
  const low = edition(2000, 14000);
  const high = edition(10000, 30000);
  return { link: fixture.link, older: swap ? high : low, newer: swap ? low : high };
}

async function selfA2(revisions: Partial<Record<(typeof PERIODS_V1)[number], 'older' | 'newer'>>, swap = false) {
  const { link, older, newer } = sources848(swap);
  const rows = PERIODS_V1.map((period, index) => {
    const which = revisions[period];
    const revision = which === 'newer' ? NEWER_848 : which === 'older' ? PARALLEL_VERSION_848 : null;
    return {
      period, mask: 1 << index, decision_version: 1, approved_revision: revision, target_revision: revision,
      payload_json: which === 'newer' ? newer : which === 'older' ? older : null, edition_class_id: 848001,
      edition_revision: which === 'newer' ? '2' : '1', available_mask: 63, latest_revision: '2',
    };
  });
  const defaults = initialPolicyDefaultsV1();
  const value = settingsValueV1.parse({ ...defaults,
    accessEnabled: true, showPartials: true, showFinalResult: false, showTermClosing: false, termClosingConclusive: true, autoUpdate: false,
    allowedPeriods: [...PERIODS_V1], calendar: { ...defaults.calendar,
      yearStartsAt: '2026-01-01T00:00:00Z', t1EndsAt: '2026-04-01T00:00:00Z',
      t2StartsAt: '2026-04-02T00:00:00Z', t2EndsAt: '2026-07-01T00:00:00Z',
      t3StartsAt: '2026-07-02T00:00:00Z', t3EndsAt: '2026-08-31T00:00:00Z',
      recoveriesStartAt: '2026-09-01T00:00:00Z', finalDisclosureAt: '2026-09-17T00:00:00Z',
      yearEndsAt: '2026-12-31T23:59:59Z',
      disclosure: { mode: 'single', at: null, periods: [...PERIODS_V1] },
    },
  });
  const context = {
    account: { id: PARALLEL_ACCOUNT_848, link },
    policy: { enforcedValue: value, classId: 848001, policyVersion: SYNTHETIC_SELF_V1.revisions.policyVersion, settings: { value } },
    profile: { ...SYNTHETIC_SELF_V1.profile, accountId: PARALLEL_ACCOUNT_848, link,
      name: 'ESTUDANTE SINTETICO', classLabel: 'TURMA SINTETICA', academicState: 'regular', result: 'in-progress' },
    now: new Date('2026-09-18T00:00:00Z'),
  } as unknown as Parameters<typeof scopedSelfV2>[1];
  const tx = { unsafe: vi.fn(async () => { throw new Error('unexpected-query'); }) } as unknown as StudentPortalPostgresQueryV1;
  return scopedSelfV2(tx, context, '84800000-0000-4000-8000-0000000000a2', {
    scoped: async () => structuredClone(rows) as never,
    latest: async () => null as never,
    studentKey: async () => 'synthetic-student-key' as never,
  });
}

const t3Of = (self: Awaited<ReturnType<typeof selfA2>>) =>
  self.subjects[0]!.periods.find((period) => period.period === 'T3')!.final;

it('A2: keeps EM RECUPERAÇÃO from the shown T3 edition when T1 is republished on a newer revision', async () => {
  const baseline = await selfA2({ T1: 'older', T2: 'older', T3: 'older' });
  expect(t3Of(baseline)).toMatchObject({ value: 14, maximum: 40, meetsMinimum: false });
  expect(baseline.profile.annualSituation).toBe('in-recovery');
  expect(baseline.subjects[0]!.annualSituation).toBe('recovery-pending');

  const republished = await selfA2({ T1: 'newer', T2: 'older', T3: 'older' });
  expect(t3Of(republished)).toMatchObject({ value: 14, maximum: 40, meetsMinimum: false });
  expect(republished.profile.annualSituation).toBe('in-recovery');
  expect(republished.subjects[0]!.annualSituation).toBe('recovery-pending');
});

it('A2: never shows EM RECUPERAÇÃO beside a published T3 above the minimum', async () => {
  const self = await selfA2({ T1: 'newer', T2: 'older', T3: 'older' }, true);
  expect(t3Of(self)).toMatchObject({ value: 30, maximum: 40, meetsMinimum: true });
  expect(self.profile.annualSituation).not.toBe('in-recovery');
  expect(self.subjects[0]!.annualSituation).not.toBe('recovery-pending');
});
