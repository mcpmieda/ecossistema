// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { withLessonDaysV2 } from '../../server/attendance/service-v2';
import {
  frequencyCountV2,
  pendingTodayV2,
  type FrequencySummaryV2,
} from '../../shared/attendance-contracts/frequency-v2';

/*
 * The Smecel's FP (18/11/2026): the teacher marks each lesson present (the point) or absent (X)
 * during it, and a lesson not marked yet shows FP. Owner decision 19/11/2026: on the day itself an
 * FP is "a confirmar" (out of the totals, never making the month unknown); once the day is over it
 * is a lesson without absence, as before the FP.
 */
const DAY = '2026-11-19';
const month: FrequencySummaryV2 = {
  contractVersion: 2,
  state: 'ready',
  month: '2026-11',
  absences: null,
  justified: null,
  denominator: null,
  percentage: null,
  coverage: 'incomplete',
  observedAt: null,
  receivedAt: null,
  // Absent in the first lesson; lessons 3 to 6 not marked yet.
  marks: [{ date: DAY, slot: 1, shift: 'MATUTINO', mark: 'X', classLabels: ['6A'] }],
  conflicts: 0,
};
const rows = [
  {
    date: DAY,
    shift: 'MATUTINO',
    slots_json: [1, 2, 3, 4, 5, 6],
    complete: true,
    pending_json: [3, 4, 5, 6],
  },
];

describe('FP "a confirmar" only on its own day', () => {
  it('today: the marked lessons count at once, the FP ones wait', () => {
    const summary = withLessonDaysV2(month, rows, DAY);
    expect(summary).toMatchObject({
      coverage: 'reliable',
      absences: 1,
      denominator: 2,
      percentage: 50,
      days: [{ date: DAY, slots: [1, 2, 3, 4, 5, 6], complete: true, pending: [3, 4, 5, 6] }],
    });
  });

  it('the next day: every FP is a lesson without absence, and none is "a confirmar"', () => {
    const summary = withLessonDaysV2(month, rows, '2026-11-20');
    expect(summary).toMatchObject({
      coverage: 'reliable',
      absences: 1,
      denominator: 6,
      percentage: 83.3,
    });
    expect(summary.days?.[0]).not.toHaveProperty('pending');
  });

  it('the count and the helper agree for the Portal too', () => {
    const days = [
      {
        date: DAY,
        shift: 'MATUTINO',
        slots: [1, 2, 3, 4, 5, 6],
        complete: true,
        pending: [3, 4, 5, 6],
      },
    ];
    expect(pendingTodayV2(days[0]!, DAY)).toEqual([3, 4, 5, 6]);
    expect(pendingTodayV2(days[0]!, '2026-11-20')).toEqual([]);
    expect(frequencyCountV2({ marks: month.marks, conflicts: 0, days }, DAY).lessons).toBe(2);
    expect(frequencyCountV2({ marks: month.marks, conflicts: 0, days }, '2026-11-20').lessons).toBe(
      6,
    );
  });

  it('today not read in full yet counts nothing of it and leaves the month known', () => {
    const count = frequencyCountV2(
      {
        marks: month.marks,
        conflicts: 0,
        days: [{ date: DAY, shift: 'MATUTINO', slots: [1, 2], complete: false }],
      },
      DAY,
    );
    expect(count).toEqual({ lessons: 0, absences: 0, justified: 0, reliable: true });
  });
});
