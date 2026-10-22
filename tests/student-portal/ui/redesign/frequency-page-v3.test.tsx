// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrequencySummaryV2 } from '../../../../shared/attendance-contracts/frequency-v2';
import { FrequencyPageV3 } from '../../../../src/student-portal/redesign-preview/frequency-page-v3';

/*
 * The redesigned Frequência page (PR 1317 preview), fed with summaries shaped like the real API's
 * (withLessonDaysV2): the page counts from `days` and `marks` itself, never from the server's
 * totals, which still include today.
 */
type DayV2 = NonNullable<FrequencySummaryV2['days']>[number];
type MarkInput = { date: string; slot: number; mark: 'X' | 'J'; shift?: string };

const lessonDay = (date: string, lessons = 5, complete = true, shift = 'MATUTINO'): DayV2 => ({
  date,
  shift,
  slots: Array.from({ length: lessons }, (_, index) => index + 1),
  complete,
});
const summary = (month: string, days: DayV2[], marks: MarkInput[] = []): FrequencySummaryV2 => ({
  contractVersion: 2,
  state: 'ready',
  month,
  // As the server: totals over every day sent, today's included (the page must ignore them).
  absences: marks.filter((mark) => mark.mark === 'X').length,
  justified: marks.filter((mark) => mark.mark === 'J').length,
  denominator: days.reduce((total, day) => total + day.slots.length, 0),
  percentage: 100,
  coverage: days.length ? (days.every((day) => day.complete) ? 'reliable' : 'incomplete') : marks.length ? 'incomplete' : 'unavailable',
  observedAt: null,
  receivedAt: null,
  marks: marks.map((mark) => ({ shift: 'MATUTINO', classLabels: ['TURMA'], ...mark })),
  conflicts: 0,
  days,
});
const readerOf = (months: Record<string, FrequencySummaryV2>) => (month: string) => months[month] ?? summary(month, []);

/** A year of `lessons` lessons and `absences` X, spread over February to September (6 a day). */
function yearOf(lessons: number, absences: number) {
  const months: Record<string, FrequencySummaryV2> = {};
  let left = lessons;
  let missing = absences;
  for (let month = 2; month <= 9 && left > 0; month++) {
    const key = `2026-${String(month).padStart(2, '0')}`;
    const days: DayV2[] = [];
    const marks: MarkInput[] = [];
    for (let day = 1; day <= 28 && left > 0; day++) {
      const date = `${key}-${String(day).padStart(2, '0')}`;
      const count = Math.min(6, left);
      left -= count;
      days.push(lessonDay(date, count));
      for (let slot = 1; slot <= count && missing > 0; slot++, missing--) marks.push({ date, slot, mark: 'X' });
    }
    months[key] = summary(key, days, marks);
  }
  expect(left).toBe(0);
  expect(missing).toBe(0);
  return months;
}

const yearBadge = () => document.querySelector('.pa3-year-head strong')?.textContent;
const summaryCard = () => document.querySelector('.pa3-summary')!;
const dayButton = (day: number) => screen.getAllByRole('button').find((button) => button.querySelector('.pa3-day-number')?.textContent === String(day))!;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-21T12:00:00-03:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Frequência page (redesign preview)', () => {
  it('rounds the year DOWN from the exact counts: 74,97% reads 74% and red, never 75%', () => {
    // 903 lessons, 226 absences: 74,972…%. Rounded to one decimal first, it became 75,0.
    render(<FrequencyPageV3 read={readerOf(yearOf(903, 226))} />);
    expect(yearBadge()).toBe('74%');
    expect(summaryCard().className).toContain('pa3-summary--low');
  });

  it('shows exactly 75% as reaching the minimum', () => {
    render(<FrequencyPageV3 read={readerOf(yearOf(100, 25))} />);
    expect(yearBadge()).toBe('75%');
    expect(summaryCard().className).toContain('pa3-summary--good');
  });

  it("never counts today, although the server's totals include it", () => {
    const months = yearOf(100, 25);
    // Today: five lessons, all missed. Counted, the year would fall to 71%.
    months['2026-10'] = summary('2026-10', [lessonDay('2026-10-21')], [1, 2, 3, 4, 5].map((slot) => ({ date: '2026-10-21', slot, mark: 'X' as const })));
    render(<FrequencyPageV3 read={readerOf(months)} />);
    expect(yearBadge()).toBe('75%');
    // Today keeps its colour on the calendar, but the ring counts no day yet.
    expect(dayButton(21).className).toContain('pa3-day--missed');
    expect(document.querySelector('.pa3-guide-ring')?.getAttribute('aria-label')).toMatch(/^Outubro, 0 dias de aula contados/u);
  });

  it('does not let an unfinished reading of today make the whole year unknown', () => {
    const months = yearOf(100, 25);
    months['2026-10'] = summary('2026-10', [lessonDay('2026-10-20'), lessonDay('2026-10-21', 5, false)]);
    render(<FrequencyPageV3 read={readerOf(months)} />);
    expect(yearBadge()).toBe('76%');
  });

  it('shows a past day not read in full as "leitura incompleta", never as a coloured total', () => {
    const months = yearOf(100, 0);
    months['2026-10'] = summary(
      '2026-10',
      [{ date: '2026-10-20', shift: 'MATUTINO', slots: [1, 2], complete: false }],
      [
        { date: '2026-10-20', slot: 1, mark: 'X' },
        { date: '2026-10-20', slot: 2, mark: 'X' },
      ],
    );
    render(<FrequencyPageV3 read={readerOf(months)} />);
    const button = dayButton(20);
    expect(button.className).toContain('pa3-day--pending');
    expect(button.className).not.toContain('pa3-day--missed');
    expect(button.getAttribute('aria-label')).toContain('leitura incompleta');
    // Chosen at first, it explains itself and does not claim "todas as aulas".
    expect(screen.getByText('Leitura incompleta · conta quando o diário for lido')).toBeTruthy();
    expect(screen.getByText('2 faltas registradas até agora.')).toBeTruthy();
    expect(yearBadge()).toBe('em apuração');
  });

  it('never says "sem aula" for today before its first reading', () => {
    const months = yearOf(100, 0);
    months['2026-10'] = summary('2026-10', [lessonDay('2026-10-20')]);
    render(<FrequencyPageV3 read={readerOf(months)} />);
    const label = dayButton(21).getAttribute('aria-label')!;
    expect(label).toContain('nenhuma aula lida até agora');
    expect(label).not.toContain('sem aula');
  });

  it('shows the marks of a day the server sent without its lesson day', () => {
    const months = yearOf(100, 0);
    months['2026-10'] = summary('2026-10', [lessonDay('2026-10-14')], [{ date: '2026-10-15', slot: 3, mark: 'X' }]);
    render(<FrequencyPageV3 read={readerOf(months)} />);
    const button = dayButton(15);
    expect(button.className).toContain('pa3-day--pending');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('1 falta registrada até agora.')).toBeTruthy();
    expect(screen.getByText('3ª aula')).toBeTruthy();
    expect(yearBadge()).toBe('em apuração');
  });

  it('reads every month with the same "today" (one clock per render)', () => {
    const read = vi.fn((month: string, today: string) => {
      void today;
      return summary(month, []);
    });
    render(<FrequencyPageV3 read={read} />);
    expect(new Set(read.mock.calls.map(([, today]) => today))).toEqual(new Set(['2026-10-21']));
  });

  it('stays on December after the school year ends', () => {
    vi.setSystemTime(new Date('2027-01-10T12:00:00-03:00'));
    const read = vi.fn((month: string) => summary(month, []));
    render(<FrequencyPageV3 read={read} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Dezembro de 2026' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Próximo mês' }) as HTMLButtonElement).disabled).toBe(true);
    expect(read.mock.calls.every(([month]) => month >= '2026-02' && month <= '2026-12')).toBe(true);
  });

  it('says the ring in correct Portuguese for one day', () => {
    const months = yearOf(100, 0);
    months['2026-10'] = summary('2026-10', [lessonDay('2026-10-20')]);
    render(<FrequencyPageV3 read={readerOf(months)} />);
    expect(document.querySelector('.pa3-guide-ring')?.getAttribute('aria-label')).toBe(
      'Outubro, 1 dia de aula contado: 1 dia frequentado, 0 faltas totais, 0 faltas parciais, 0 justificadas',
    );
  });
});
