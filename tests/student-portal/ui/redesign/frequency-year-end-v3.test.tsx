// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FrequencySummaryV2, FrequencyYearSummaryV2 } from '../../../../shared/attendance-contracts/frequency-v2';
import type { StudentFrequencyClientV2 } from '../../../../src/features/student-portal/frequency/client-v2';
import { FrequencyPageV3 } from '../../../../src/features/student-portal/redesign/frequency-page-v3';

/*
 * The school year's countdown after its last school day (review A18, 13/11/2026): a refresh brings
 * nothing new until the next year's calendar, so the card says only the day it ended.
 */
const empty = (month: string): FrequencySummaryV2 => ({
  contractVersion: 2,
  state: 'ready',
  month,
  absences: null,
  justified: null,
  denominator: null,
  percentage: null,
  coverage: 'unavailable',
  observedAt: null,
  receivedAt: null,
  marks: [],
  conflicts: 0,
  days: [],
});
const clientOf = (today: string): StudentFrequencyClientV2 => ({
  readYear: vi.fn(
    async (): Promise<FrequencyYearSummaryV2> => ({
      contractVersion: 2,
      state: 'ready',
      academicYear: 2026,
      today,
      year: { lessons: 100, absences: 0 },
      lastReadAt: `${today}T10:10:00Z`,
      months: Array.from({ length: Number(today.slice(5, 7)) }, (_, index) => empty(`2026-${String(index + 1).padStart(2, '0')}`)),
      schoolYear: { schoolDays: 200, remaining: 0, firstDay: '2026-02-23', lastDay: '2026-12-15' },
    }),
  ),
});

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('says only the day the school year ended, without asking for a refresh', async () => {
  vi.setSystemTime(new Date('2026-12-20T12:00:00-03:00'));
  render(<FrequencyPageV3 client={clientOf('2026-12-20')} />);
  expect(await screen.findByText('O ano letivo terminou em 15/12.')).toBeTruthy();
  expect(screen.queryByText('Atualize a página para ver.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Atualizar página' })).toBeNull();
  expect(screen.queryByText(/dias? letivos? de 200/u)).toBeNull();
});

it('still counts down on the last school day', async () => {
  vi.setSystemTime(new Date('2026-12-15T12:00:00-03:00'));
  render(<FrequencyPageV3 client={clientOf('2026-12-15')} />);
  expect(await screen.findByText(/O ano letivo termina em 15\/12\/2026/u)).toBeTruthy();
  expect(screen.getByRole('timer')).toBeTruthy();
  expect(screen.queryByText(/O ano letivo terminou/u)).toBeNull();
});
