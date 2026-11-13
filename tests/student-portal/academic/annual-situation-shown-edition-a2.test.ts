import { expect, it, vi } from 'vitest';
import { scopedSelfV2 } from '../../../server/student-portal/publication/scoped-self-v2';
import { PERIODS_V1 } from '../../../server/student-portal/publication/state-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { PARALLEL_ACCOUNT_848, PARALLEL_VERSION_848, parallelFixture848 } from '../../gradebook/performance/parallel-visibility-fixture-848';

const NEWER_848 = `${'8'.repeat(32)}:2`;
const NEWEST_848 = `${'8'.repeat(32)}:3`;
type PeriodA2 = (typeof PERIODS_V1)[number];
type TermA2 = 1 | 2 | 3;
/** AV1/AV2 per term: 2000 → term at 14 (T3 14/40); 10000 → term at 30. A missing term has no marks. */
type TermsA2 = Partial<Record<TermA2, number>>;
/** `rec1`: REC1 mark already entered in that edition (the student recovered the 1º trimestre). */
type PublishedA2 = { revision: string; terms: TermsA2; rec1?: number; rec2?: number };

const LOW_A2: TermsA2 = { 1: 2000, 2: 2000, 3: 2000 };
const HIGH_A2: TermsA2 = { 1: 10000, 2: 10000, 3: 10000 };

function editionA2({ terms, rec1, rec2 }: Omit<PublishedA2, 'revision'>) {
  const fixture = parallelFixture848();
  const am = (term: TermA2) => {
    const value = terms[term];
    if (value === undefined) return null;
    return value === 2000 ? 14000 : 30000;
  };
  const [am1, am2, am3] = [am(1), am(2), am(3)];
  const annual = am1 !== null && am2 !== null && am3 !== null ? am1 + am2 + am3 : null;
  return { ...fixture.portalSource, offers: fixture.portalSource.offers.map((offer) => ({
    ...offer,
    instruments: offer.instruments.map((item) => {
      const value = terms[item.term as TermA2];
      if (value === undefined || item.slot === 3) return { ...item, value: null };
      return { ...item, value: item.slot === 11 ? 10000 : value };
    }),
    closure: { am1, am2, am3, rec1: rec1 ?? null, rec2: rec2 ?? null, rec3: null, nc: 0, rr: 0, annual },
  })) };
}

async function selfEditionsA2(published: Partial<Record<PeriodA2, PublishedA2>>) {
  const { link } = parallelFixture848();
  const rows = PERIODS_V1.map((period, index) => {
    const edition = published[period];
    const revision = edition?.revision ?? null;
    return {
      period, mask: 1 << index, decision_version: 1, approved_revision: revision, target_revision: revision,
      payload_json: edition ? editionA2(edition) : null, edition_class_id: 848001,
      edition_revision: revision?.split(':')[1] ?? '1', available_mask: 63, latest_revision: '3',
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

/** Low edition: every term at 14 (T3 14/40, in recovery). High edition: every term at 30. `swap` puts the high one first. */
function selfA2(revisions: Partial<Record<PeriodA2, 'older' | 'newer'>>, swap = false) {
  const editions = { older: swap ? HIGH_A2 : LOW_A2, newer: swap ? LOW_A2 : HIGH_A2 };
  const published: Partial<Record<PeriodA2, PublishedA2>> = {};
  for (const [period, which] of Object.entries(revisions) as [PeriodA2, 'older' | 'newer'][])
    published[period] = { revision: which === 'newer' ? NEWER_848 : PARALLEL_VERSION_848, terms: editions[which] };
  return selfEditionsA2(published);
}

const t3Of = (self: Awaited<ReturnType<typeof selfEditionsA2>>) =>
  self.subjects[0]!.periods.find((period) => period.period === 'T3')!.final;
const showsRec1 = (self: Awaited<ReturnType<typeof selfEditionsA2>>) =>
  self.subjects[0]!.periods.some((period) => period.period === 'REC1');

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

it('A2: a REC1 published in May (older revision) does not outrank the T3 published later', async () => {
  // May edition: only the T1 (14/30) and its REC1; read with the T3 published, it still says
  // EM RECUPERAÇÃO. December edition: T1 recovered, T2 30/30 and T3 30/40, nothing left to recover.
  const may: PublishedA2 = { revision: PARALLEL_VERSION_848, terms: { 1: 2000 }, rec1: 25000 };
  const december: PublishedA2 = { revision: NEWEST_848, terms: { 1: 2000, 2: 10000, 3: 10000 }, rec1: 25000 };
  const self = await selfEditionsA2({ T1: may, REC1: may, T2: december, T3: december });
  expect(showsRec1(self)).toBe(true);
  expect(t3Of(self)).toMatchObject({ value: 30, maximum: 40, meetsMinimum: true });
  expect(self.profile.annualSituation).not.toBe('in-recovery');
  expect(self.subjects[0]!.annualSituation).not.toBe('recovery-pending');
});

it('A2 passo 4: a REC1 published on a newer revision keeps EM RECUPERAÇÃO from the shown T3', async () => {
  const t3: PublishedA2 = { revision: PARALLEL_VERSION_848, terms: LOW_A2 };
  // Revision 12: the teacher corrected the T3 to 30/40 (still update-pending) and the REC1 was entered.
  const rec1: PublishedA2 = { revision: NEWER_848, terms: { 1: 2000, 2: 2000, 3: 10000 }, rec1: 25000, rec2: 25000 };
  const self = await selfEditionsA2({ T1: t3, T2: t3, T3: t3, REC1: rec1 });
  expect(showsRec1(self)).toBe(true);
  expect(t3Of(self)).toMatchObject({ value: 14, maximum: 40, meetsMinimum: false });
  expect(self.profile.annualSituation).toBe('in-recovery');
  expect(self.subjects[0]!.annualSituation).toBe('recovery-pending');
});
