import { expect, it, vi } from 'vitest';
import { AcademicStudentReaderPostgresV1 } from '../../../server/student-portal/academic/academic-reader-v1';
import { scopedSelfV2 } from '../../../server/student-portal/publication/scoped-self-v2';
import { dataVectorV1, PERIODS_V1 } from '../../../server/student-portal/publication/state-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import { settingsValueV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { resolveSimplifiedTermV1, type SimplifiedInstrumentSlotV1 } from '../../../src/gradebook-domain/calculations/simplified/resolve-simplified-academic-engine-v1';
import { PARALLEL_ACCOUNT_848, PARALLEL_VERSION_848, parallelFixture848 } from '../../gradebook/performance/parallel-visibility-fixture-848';

function approvedSource848(kind: 'score' | 'nc' | 'rr' | 'recovery-pending' = 'score', missingSlot?: number) {
  const fixture = parallelFixture848();
  const source = { ...fixture.portalSource, offers: fixture.portalSource.offers.map((offer) => ({
    ...offer,
    instruments: offer.instruments.map((item) => ({ ...item,
      value: item.slot === 3 || (item.term === 1 && item.slot === missingSlot)
        ? null : item.slot === 11 ? 10000 : 2000,
    })),
    closure: { am1: 14000, am2: 14000, am3: 14000,
      rec1: kind === 'score' ? 18000 : null, rec2: 18000, rec3: 24000,
      nc: kind === 'nc' ? 1 : 0, rr: kind === 'rr' ? 1 : 0, annual: 60000 },
  })) };
  const unsafe = vi.fn(async () => { throw new Error('unexpected-current-academic-query'); });
  const reader = new AcademicStudentReaderPostgresV1({ unsafe });
  const original = structuredClone(source);
  const projected = reader.projectPreparedSourceV2(fixture.link, PARALLEL_VERSION_848, source);
  if (!projected) throw new Error('expected-approved-projection');
  expect(source).toEqual(original);
  expect(unsafe).not.toHaveBeenCalled();
  return { source, projected, link: fixture.link };
}

it.each(['score', 'nc', 'rr', 'recovery-pending'] as const)(
  'preserves the approved REC %s without replacing AM/U or resolving current PARA coverage', (kind) => {
    const { source, projected } = approvedSource848(kind);
    const subject = projected.student.subjects[0]!;
    expect(subject.periods.map((period) => period.period)).toEqual(['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3']);
    expect(subject.periods.find((period) => period.period === 'REC1')!.final).toMatchObject({ kind });
    if (kind === 'score') {
      expect(subject.periods.find((period) => period.period === 'REC1')!.final).toMatchObject({ valueMilli: 18000 });
      expect(projected.finalAuthority).toEqual({ global: true, subjectIds: [848001] });
      expect(projected.student.profile.result).toBe('approved');
      expect(subject.officialOutcome).toBe('approved');
    }
    expect(subject.periods.slice(0, 3).map((period) => period.final)).toEqual(
      [1, 2, 3].map((term) => ({ kind: 'score', valueMilli: 14000,
        maximumMilli: term === 3 ? 40000 : 30000, meetsMinimum: false })),
    );
    expect(subject.officialAnnual).toMatchObject({ kind: 'score', valueMilli: 60000 });
    for (const term of [1, 2, 3] as const) {
      const current = resolveSimplifiedTermV1({ term, instruments: source.offers[0]!.instruments
        .filter((item) => item.term === term)
        .map((item) => ({ slot: item.slot as SimplifiedInstrumentSlotV1, maximumMilli: item.maximum, valueMilli: item.value })) });
      expect(current.parallelApplicable).toBe(true);
      expect(current.coverage).toMatchObject({ complete: true, missingSlots: [3] });
      const parallel = subject.periods.find((period) => period.period === `T${term}`)!.partials!
        .find((item) => item.assessmentId === 8480000 + term * 100 + 3)!;
      expect(parallel).toMatchObject({ mark: { kind: 'absent' }, notDone: true });
    }
  },
);

it.each([1, 2, 11])('reads a blank regular slot %s as not done without inventing official authority', (slot) => {
  const { projected } = approvedSource848('score', slot);
  expect(projected.finalAuthority).toEqual({ global: false, subjectIds: [] });
  // BN-DEC-042: the result with the blank slot is final, so its approved recovery is shown.
  expect(projected.student.subjects[0]!.periods.some((period) => period.period.startsWith('REC'))).toBe(true);
  expect(projected.student.subjects[0]!.officialAnnual).toMatchObject({ valueMilli: 60000 });
});

it('keeps the selected older edition and published REC through scopedSelfV2 without a legacy projection', async () => {
  const { source, link } = approvedSource848();
  const newerRevision = `${'8'.repeat(32)}:2`;
  const rows = PERIODS_V1.map((period, index) => ({
    period, mask: 1 << index, decision_version: 1, approved_revision: PARALLEL_VERSION_848,
    target_revision: PARALLEL_VERSION_848, payload_json: source, edition_class_id: 848001,
    edition_revision: '1', available_mask: 63, latest_revision: '2',
  }));
  const queries: string[] = [];
  const tx: StudentPortalPostgresQueryV1 = {
    async unsafe<R extends Record<string, unknown>>(query: string) {
      queries.push(query);
      return structuredClone(rows) as unknown as R[];
    },
  };
  const defaults = initialPolicyDefaultsV1();
  const value = settingsValueV1.parse({ ...defaults,
    accessEnabled: true, showPartials: true, showFinalResult: true, showTermClosing: false, termClosingConclusive: true, autoUpdate: false,
    allowedPeriods: [...PERIODS_V1], calendar: { ...defaults.calendar,
      yearStartsAt: '2026-01-01T00:00:00Z', t1EndsAt: '2026-04-01T00:00:00Z',
      t2StartsAt: '2026-04-02T00:00:00Z', t2EndsAt: '2026-07-01T00:00:00Z',
      t3StartsAt: '2026-07-02T00:00:00Z', t3EndsAt: '2026-08-31T00:00:00Z',
      recoveriesStartAt: '2026-09-01T00:00:00Z', finalDisclosureAt: '2026-09-17T00:00:00Z',
      yearEndsAt: '2026-12-31T23:59:59Z',
      disclosure: { mode: 'single', at: null, periods: [...PERIODS_V1] },
    },
  });
  // This unit starts after authentication; authorization and SQL selection have separate integration gates.
  const context = {
    account: { id: PARALLEL_ACCOUNT_848, link },
    policy: { enforcedValue: value, classId: 848001, policyVersion: SYNTHETIC_SELF_V1.revisions.policyVersion, settings: { value } },
    profile: { ...SYNTHETIC_SELF_V1.profile, accountId: PARALLEL_ACCOUNT_848, link,
      name: 'ESTUDANTE SINTETICO', classLabel: 'TURMA SINTETICA', academicState: 'regular', result: 'in-progress' },
    now: new Date('2026-09-18T00:00:00Z'),
  } as unknown as Parameters<typeof scopedSelfV2>[1];
  const result = await scopedSelfV2(tx, context, '84800000-0000-4000-8000-000000000099');
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('publication_source_v2');
  expect(queries[0]).not.toContain('academic_mark_v1');
  expect(result.revisions.dataVersion).toBe(dataVectorV1(PERIODS_V1.map(() => PARALLEL_VERSION_848)));
  expect(result.revisions.dataVersion).not.toContain(newerRevision);
  expect(result.profile.result).toBe('approved');
  const subject = result.subjects[0]!;
  expect(subject.officialOutcome).toBe('approved');
  expect(subject.periods.map((period) => period.period)).toEqual([...PERIODS_V1]);
  expect(subject.periods.slice(0, 3).map((period) => period.final)).toEqual(
    [1, 2, 3].map((term) => ({ kind: 'score', value: 14, maximum: term === 3 ? 40 : 30, meetsMinimum: false })),
  );
  expect(subject.periods.find((period) => period.period === 'REC1')!.final).toMatchObject({ kind: 'score', value: 18 });
  expect(subject.periods.find((period) => period.period === 'T1')!.partials!
    .find((item) => item.assessmentId === 8480103)).toMatchObject({ mark: { kind: 'absent' }, notDone: true });
});

/** The same student and policy, with only `published` periods released by the school. */
async function selfWith848(published: readonly string[], kind: 'score' | 'recovery-pending', policy: Record<string, unknown> = {}) {
  const fixture = parallelFixture848();
  const source = approvedSource848(kind).source;
  const rows = PERIODS_V1.map((period, index) => {
    const on = published.includes(period);
    return {
      period, mask: 1 << index, decision_version: 1, approved_revision: on ? PARALLEL_VERSION_848 : null,
      target_revision: on ? PARALLEL_VERSION_848 : null, payload_json: on ? source : null, edition_class_id: 848001,
      edition_revision: '1', available_mask: 63, latest_revision: '1',
    };
  });
  const defaults = initialPolicyDefaultsV1();
  const value = settingsValueV1.parse({ ...defaults,
    accessEnabled: true, showPartials: true, showFinalResult: false, showTermClosing: true, termClosingConclusive: true, autoUpdate: false,
    allowedPeriods: [...PERIODS_V1], calendar: { ...defaults.calendar,
      yearStartsAt: '2026-01-01T00:00:00Z', t1EndsAt: '2026-04-01T00:00:00Z',
      t2StartsAt: '2026-04-02T00:00:00Z', t2EndsAt: '2026-07-01T00:00:00Z',
      t3StartsAt: '2026-07-02T00:00:00Z', t3EndsAt: '2026-08-31T00:00:00Z',
      recoveriesStartAt: '2026-09-01T00:00:00Z', finalDisclosureAt: '2026-09-17T00:00:00Z',
      yearEndsAt: '2026-12-31T23:59:59Z',
      disclosure: { mode: 'single', at: null, periods: [...PERIODS_V1] },
    }, ...policy,
  });
  const context = {
    account: { id: PARALLEL_ACCOUNT_848, link: fixture.link },
    policy: { enforcedValue: value, classId: 848001, policyVersion: SYNTHETIC_SELF_V1.revisions.policyVersion, settings: { value } },
    profile: { ...SYNTHETIC_SELF_V1.profile, accountId: PARALLEL_ACCOUNT_848, link: fixture.link,
      name: 'ESTUDANTE SINTETICO', classLabel: 'TURMA SINTETICA', academicState: 'regular', result: 'in-progress' },
    now: new Date('2026-09-18T00:00:00Z'),
  } as unknown as Parameters<typeof scopedSelfV2>[1];
  const tx = { unsafe: async () => { throw new Error('unexpected-query'); } } as unknown as StudentPortalPostgresQueryV1;
  return scopedSelfV2(tx, context, '84800000-0000-4000-8000-000000000098', {
    scoped: async () => structuredClone(rows) as never,
    latest: async () => ({ payload_json: source, class_id: 848001, revision: PARALLEL_VERSION_848 }) as never,
    studentKey: async () => 'synthetic-student-key' as never,
  });
}

it('shows EM RECUPERAÇÃO only while the 3º trimestre it comes from is published', async () => {
  const all = await selfWith848(PERIODS_V1, 'recovery-pending');
  expect(all.profile.annualSituation).toBe('in-recovery');
  expect(all.subjects[0]!.annualSituation).toBe('recovery-pending');
  const withdrawn = await selfWith848(['T1', 'T2'], 'recovery-pending');
  expect(withdrawn.subjects[0]!.periods.map((period) => period.period)).toEqual(['T1', 'T2']);
  expect(withdrawn.profile.annualSituation).toBeUndefined();
  expect(withdrawn.subjects[0]!.annualSituation).toBeUndefined();
});

it('never sends a trimester closing whose marks are not published', async () => {
  const closingsOf = (self: Awaited<ReturnType<typeof selfWith848>>) =>
    self.subjects.flatMap((subject) => (subject.closings ?? []).map((closing) => closing.period));
  const all = await selfWith848(PERIODS_V1, 'recovery-pending');
  expect(closingsOf(all).length).toBeGreaterThan(0);
  const some = await selfWith848(['T1'], 'recovery-pending');
  expect(new Set(closingsOf(some))).toEqual(new Set(['T1']));
  const none = await selfWith848([], 'recovery-pending');
  expect(none.state).toBe('no-publication');
  expect(closingsOf(none)).toEqual([]);
  expect(none.closingSummaries ?? []).toEqual([]);
});
