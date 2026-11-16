// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AcademicStudentReaderPostgresV1,
  academicToSelfV1,
} from '../../../server/student-portal/academic/academic-reader-v1';
import { applyPublishedVisibilityV1 } from '../../../server/student-portal/policies/calendar-v1';
import { initialPolicyDefaultsV1 } from '../../../server/student-portal/policies/defaults-v1';
import { selfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import { SYNTHETIC_SELF_V1 } from '../../../shared/student-portal-contracts/fixtures-v1';
import {
  PARALLEL_ACCOUNT_848,
  PARALLEL_VERSION_848,
  parallelFixture848,
} from '../../gradebook/performance/parallel-visibility-fixture-848';

function project(options: Parameters<typeof parallelFixture848>[0] = {}) {
  const fixture = parallelFixture848(options);
  const unsafe = vi.fn(async () => {
    throw new Error('unexpected-query');
  });
  const reader = new AcademicStudentReaderPostgresV1({ unsafe });
  const before = structuredClone(fixture.portalSource);
  const projected = reader.projectPreparedSourceV2(
    fixture.link,
    PARALLEL_VERSION_848,
    fixture.portalSource,
  );
  if (!projected) throw new Error('expected-projection');
  expect(fixture.portalSource).toEqual(before);
  expect(unsafe).not.toHaveBeenCalled();
  const self = selfResponseV1.parse({
    ...SYNTHETIC_SELF_V1,
    ...academicToSelfV1(projected.student, PARALLEL_ACCOUNT_848),
  });
  return { fixture, reader, unsafe, projected, self };
}

describe('Portal PARA from the approved edition', () => {
  it.each([1, 2, 3] as const)(
    'shows the numeric exception but hides unrecorded dispensed PARA in trimester %s',
    (term) => {
      for (const parallel of [null, 0, 5000]) {
        const { self } = project({
          term,
          parallel,
          qualitative: (term === 3 ? 24000 : 18000) - 4000,
        });
        const period = self.subjects[0]!.periods.find((value) => value.period === `T${term}`)!;
        const item = period.partials?.find(
          (value) => value.assessmentId === 8480000 + term * 100 + 3,
        );
        expect(Boolean(item)).toBe(parallel !== null);
        expect(period.partials).toHaveLength(parallel === null ? 3 : 4);
        if (parallel !== null) {
          expect(item!.mark).toMatchObject({ kind: 'score', value: parallel / 1000 });
          expect(item).not.toHaveProperty('notDone');
        }
        expect(period.final).toMatchObject({ kind: 'score', value: [25, 26, 35][term - 1] });
      }
    },
  );

  it.each([null, 0, 3000, 5000])(
    'preserves the eligible PARA state without converting zero or absence (%s)',
    (parallel) => {
      const { projected, self } = project({ parallel });
      const partial = self.subjects[0]!.periods.find(
        (period) => period.period === 'T2',
      )!.partials!.find((item) => item.assessmentId === 8480203)!;
      expect(partial).toBeDefined();
      expect(partial.mark).toMatchObject(
        parallel === null ? { kind: 'absent' } : { kind: 'score', value: parallel / 1000 },
      );
      expect(partial.notDone).toBe(parallel === null ? true : undefined);
      expect(projected.student.subjects[0]!.officialAnnual).toMatchObject({
        kind: 'score',
        valueMilli: 86000,
      });
    },
  );

  it('does not invent not-done for an unobserved cell or a missing definition', () => {
    const { self } = project({ observed: false });
    const partial = self.subjects[0]!.periods.find(
      (period) => period.period === 'T2',
    )!.partials!.find((item) => item.assessmentId === 8480203)!;
    expect(partial.mark.kind).toBe('absent');
    expect(partial).not.toHaveProperty('notDone');
    const unconfigured = project({ includeParallel: false }).self;
    expect(
      unconfigured.subjects[0]!.periods.flatMap((period) => period.partials ?? []).some(
        (item) => item.assessmentId === 8480203,
      ),
    ).toBe(false);
  });

  it('uses the supplied older edition, not a newer recorded PARA, and rejects the wrong revision', () => {
    const older = project({ qualitative: 14000, parallel: null });
    const newer = parallelFixture848({ qualitative: 14000, parallel: 5000 });
    const newRevision = `${'8'.repeat(32)}:2`;
    const newerSource = { ...newer.portalSource, data_version: newRevision };
    expect(
      older.reader.projectPreparedSourceV2(older.fixture.link, PARALLEL_VERSION_848, newerSource),
    ).toBeNull();
    const updated = older.reader.projectPreparedSourceV2(newer.link, newRevision, newerSource)!;
    expect(
      updated.student.subjects[0]!.periods[1]!.partials!.some(
        (item) => item.assessmentId === 8480203,
      ),
    ).toBe(true);
    expect(
      older.projected.student.subjects[0]!.periods[1]!.partials!.some(
        (item) => item.assessmentId === 8480203,
      ),
    ).toBe(false);
    expect(older.unsafe).not.toHaveBeenCalled();
  });

  it('keeps publication, partial visibility and calendar gates independent of PARA eligibility', () => {
    const { self } = project({ parallel: 0 });
    const defaults = initialPolicyDefaultsV1();
    const policy = {
      ...defaults,
      accessEnabled: true,
      showPartials: true,
      autoUpdate: false,
      allowedPeriods: ['T2' as const],
      calendar: {
        ...defaults.calendar,
        yearStartsAt: '2026-01-01T00:00:00Z',
        t1EndsAt: '2026-04-01T00:00:00Z',
        t2StartsAt: '2026-04-02T00:00:00Z',
        t2EndsAt: '2026-08-01T00:00:00Z',
        t3StartsAt: '2026-08-02T00:00:00Z',
        t3EndsAt: '2026-11-01T00:00:00Z',
        recoveriesStartAt: '2026-11-02T00:00:00Z',
        yearEndsAt: '2026-12-31T23:59:59Z',
        disclosure: { mode: 'single' as const, at: null, periods: ['T2' as const] },
      },
    };
    const now = new Date('2026-09-18T00:00:00Z');
    const visible = applyPublishedVisibilityV1(self, policy, now, false);
    expect(visible.subjects[0]!.periods).toHaveLength(1);
    expect(
      visible.subjects[0]!.periods[0]!.partials!.some((item) => item.assessmentId === 8480203),
    ).toBe(true);
    const hidden = applyPublishedVisibilityV1(self, { ...policy, showPartials: false }, now, false);
    expect(hidden.subjects[0]!.periods[0]).not.toHaveProperty('partials');
    expect(hidden.subjects[0]!.periods[0]!.final).toEqual(visible.subjects[0]!.periods[0]!.final);
    expect(
      applyPublishedVisibilityV1(self, { ...policy, allowedPeriods: [] }, now, false).subjects,
    ).toEqual([]);
    expect(
      applyPublishedVisibilityV1(self, policy, new Date('2026-03-01T00:00:00Z'), false).subjects,
    ).toEqual([]);
    expect(
      applyPublishedVisibilityV1(self, { ...policy, accessEnabled: false }, now, false).subjects,
    ).toEqual([]);
    expect(visible.profile.result).toBe('in-progress');
    expect(visible.subjects[0]).not.toHaveProperty('officialOutcome');
  });
});
