// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ScheduleWeekV3 as SchedulePageV3,
  type ScheduleClassV3,
} from '../../../../src/features/student-portal/redesign/schedule-page-v3';

/*
 * The redesigned Horário page (owner decision 22/10/2026), fed with grids shaped like
 * /api/student/schedule: subjects as the Smecel names them, a free position absent.
 */
const grid = (label = 'TURMA'): ScheduleClassV3 => ({
  label,
  observedAt: '2026-10-22T10:12:00Z',
  lessons: [
    { weekday: 1, slot: 1, subject: 'ARTE' },
    { weekday: 1, slot: 2, subject: 'INFORMATICA/COMPUTACAO' },
    { weekday: 4, slot: 1, subject: 'REDACAO' },
    { weekday: 4, slot: 3, subject: 'GEOGRAFIA' },
  ],
});
const dayList = () => screen.getByRole('list');
const rows = () =>
  within(dayList())
    .getAllByRole('listitem')
    .map((row) => row.textContent);
const at = (date: string) => vi.setSystemTime(new Date(`${date}T12:00:00-03:00`));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  at('2026-10-22'); // A Thursday.
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("opens on today's lessons, with a free position as a blank space", () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  expect(
    screen.getByRole('button', { name: 'Quinta-feira (hoje)' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByRole('heading', { name: 'Hoje, quinta-feira' })).toBeTruthy();
  // Positions up to the week's last lesson; the 2nd is free on Thursday.
  expect(rows()).toEqual(['1ª1ª aula: REDACAO', '2ª2ª aula: sem aula', '3ª3ª aula: GEOGRAFIA']);
  const free = within(dayList()).getAllByRole('listitem')[1]!;
  expect(free.className).toContain('is-free');
  expect(free.querySelector('.pa3-schedule-subject')!.textContent).toBe('2ª aula: sem aula');
});

it('shows another day when the reader picks it, and never a teacher or anything else', () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Segunda-feira' }));
  expect(screen.getByRole('heading', { name: 'Segunda-feira' })).toBeTruthy();
  expect(rows()).toEqual([
    '1ª1ª aula: ARTE',
    '2ª2ª aula: INFORMATICA/COMPUTACAO',
    '3ª3ª aula: sem aula',
  ]);
});

it('on a weekend opens on Monday, with no day marked as today', () => {
  at('2026-10-24'); // Saturday.
  render(<SchedulePageV3 classes={[grid()]} />);
  expect(screen.getByRole('button', { name: 'Segunda-feira' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByText('hoje')).toBeNull();
});

it("marks today's column in the week table", () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  const table = screen.getByRole('table');
  const head = within(table).getAllByRole('columnheader');
  expect(head.map((cell) => cell.className)).toEqual(['', '', '', '', 'is-today', '']);
  const firstRow = within(table).getAllByRole('row')[1]!;
  expect(
    within(firstRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['ARTE', 'sem aula', 'sem aula', 'REDACAO', 'sem aula']);
});

it('names each class only when the student has two (regular and integral)', () => {
  const { rerender } = render(<SchedulePageV3 classes={[grid('6A')]} />);
  expect(screen.queryByText('6A')).toBeNull();
  rerender(<SchedulePageV3 classes={[grid('6A'), grid('INTEGRAL')]} />);
  expect(screen.getByText('6A')).toBeTruthy();
  expect(screen.getByText('INTEGRAL')).toBeTruthy();
});

it('says so when the grid was never read', () => {
  render(<SchedulePageV3 classes={[]} />);
  expect(screen.getByText('O horário da turma ainda não foi lido do Smecel.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});
