// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ScheduleWeekV3 as SchedulePageV3,
  type ScheduleClassV3,
} from '../../../../src/features/student-portal/redesign/schedule-page-v3';
import { officialBells2026V1 } from '../../../../shared/student-portal-contracts/school-bells-v1';

/*
 * The redesigned Horário page (owner decisions 22–23/10/2026), fed with grids shaped like
 * /api/student/schedule: subjects as the Smecel names them, a free position absent, the times of
 * the class's shift marked in the ADM.
 */
const grid = (label = 'TURMA', bells: ScheduleClassV3['bells'] = null): ScheduleClassV3 => ({
  label,
  observedAt: '2026-10-22T10:12:00Z',
  bells,
  lessons: [
    { weekday: 1, slot: 1, subject: 'ARTE' },
    { weekday: 1, slot: 2, subject: 'INFORMATICA/COMPUTACAO' },
    { weekday: 4, slot: 1, subject: 'REDACAO' },
    { weekday: 4, slot: 3, subject: 'GEOGRAFIA' },
  ],
});
/** A full morning: five lessons Monday, Wednesday and Friday; six Tuesday and Thursday. */
const morning = (): ScheduleClassV3 => ({
  label: '6º ANO A - MATUTINO',
  observedAt: '2026-10-22T10:12:00Z',
  bells: officialBells2026V1().matutino,
  lessons: [1, 2, 3, 4, 5].flatMap((weekday) =>
    Array.from({ length: weekday === 2 || weekday === 4 ? 6 : 5 }, (_, index) => ({
      weekday,
      slot: index + 1,
      subject: `MATERIA ${weekday}.${index + 1}`,
    })),
  ),
});
const phoneList = () => screen.getAllByRole('list')[0]!;
const rows = (list = phoneList()) =>
  within(list)
    .getAllByRole('listitem')
    .map((row) => row.textContent);
const at = (when: string) => vi.setSystemTime(new Date(`${when}-03:00`));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  at('2026-10-22T12:00:00'); // A Thursday, after the morning's lessons.
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
  // Positions up to the day's last lesson; the 2nd is free on Thursday.
  expect(rows()).toEqual(['1ª1ª aula: REDACAO', '2ª2ª aula: sem aula', '3ª3ª aula: GEOGRAFIA']);
  const free = within(phoneList()).getAllByRole('listitem')[1]!;
  expect(free.className).toContain('is-free');
  expect(free.querySelector('.pa3-schedule-subject')!.textContent).toBe('2ª aula: sem aula');
});

it("shows each day's own lessons only: no empty 6th on a day without one (owner request 23/10/2026)", () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Segunda-feira' }));
  expect(screen.getByRole('heading', { name: 'Segunda-feira' })).toBeTruthy();
  // Monday ends at its 2nd lesson, even though Thursday has a 3rd.
  expect(rows()).toEqual(['1ª1ª aula: ARTE', '2ª2ª aula: INFORMATICA/COMPUTACAO']);
});

it('shows each lesson with its time and the break in its place, different on each day', () => {
  render(<SchedulePageV3 classes={[morning()]} />);
  // Thursday: six lessons, the break after the 4th.
  expect(rows()).toEqual([
    '1ª1ª aula: MATERIA 4.107:00 – 07:45',
    '2ª2ª aula: MATERIA 4.207:45 – 08:30',
    '3ª3ª aula: MATERIA 4.308:30 – 09:15',
    '4ª4ª aula: MATERIA 4.409:15 – 10:00',
    'Intervalo10:00 – 10:15',
    '5ª5ª aula: MATERIA 4.510:15 – 11:00',
    '6ª6ª aula: MATERIA 4.611:00 – 11:45',
  ]);
  // Monday: five lessons, the break after the 3rd.
  fireEvent.click(screen.getByRole('button', { name: 'Segunda-feira' }));
  expect(rows()).toEqual([
    '1ª1ª aula: MATERIA 1.107:00 – 07:55',
    '2ª2ª aula: MATERIA 1.207:55 – 08:50',
    '3ª3ª aula: MATERIA 1.308:50 – 09:45',
    'Intervalo09:45 – 10:00',
    '4ª4ª aula: MATERIA 1.410:00 – 10:55',
    '5ª5ª aula: MATERIA 1.510:55 – 11:45',
  ]);
  // On a computer each day is its own column, with the same rows.
  const week = screen.getByRole('group', { name: 'Horário da semana' });
  expect(within(week).getAllByRole('list')).toHaveLength(5);
  expect(rows(within(week).getByRole('list', { name: 'Aulas de sexta-feira' }))[0]).toBe('1ª1ª aula: MATERIA 5.107:45 – 08:30');
});

it('says the lesson going on now and counts to the break, the next lesson and the end', () => {
  at('2026-10-22T09:05:00');
  render(<SchedulePageV3 classes={[morning()]} />);
  expect(screen.getByText('Agora: 3ª aula · MATERIA 4.3')).toBeTruthy();
  expect(screen.getByText('até 09:15')).toBeTruthy();
  expect(screen.getByText('Próxima aula em')).toBeTruthy();
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Próxima aula em 10 minutos');
  expect(screen.getByText('Depois: 4ª aula · MATERIA 4.4 · 09:15')).toBeTruthy();
  // The row of the lesson going on is marked.
  expect(within(phoneList()).getAllByRole('listitem')[2]!.getAttribute('aria-current')).toBe('time');

  act(() => {
    at('2026-10-22T09:50:00');
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText('Agora: 4ª aula · MATERIA 4.4')).toBeTruthy();
  expect(screen.getByText('Intervalo em')).toBeTruthy();
  expect(screen.getByText('Depois: 5ª aula · MATERIA 4.5 · 10:15')).toBeTruthy();

  act(() => {
    at('2026-10-22T10:05:00');
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText('Agora: Intervalo')).toBeTruthy();
  expect(screen.getByText('Volta em')).toBeTruthy();

  act(() => {
    at('2026-10-22T11:30:00');
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText('Saída em')).toBeTruthy();

  // After the last lesson, nothing.
  act(() => {
    at('2026-10-22T11:50:00');
    vi.advanceTimersByTime(1000);
  });
  expect(screen.queryByRole('timer')).toBeNull();
});

it('before the first lesson, says when the day starts', () => {
  at('2026-10-23T07:00:00'); // Friday starts at 07:45.
  render(<SchedulePageV3 classes={[morning()]} />);
  expect(screen.getByText('Hoje as aulas começam às 07:45')).toBeTruthy();
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Começa em 45 minutos');
  expect(screen.getByText('Primeira: 1ª aula · MATERIA 5.1')).toBeTruthy();
});

it('on a day without school says why, from the ADM calendar, and shows no lesson going on', () => {
  at('2026-10-12T09:00:00'); // Monday, a holiday.
  const daysOff = [
    { date: '2026-10-12', kind: 'feriado' as const, note: 'Nossa Senhora Aparecida' },
    { date: '2026-10-14', kind: 'feriado' as const, note: 'Antecipação do dia 28' },
  ];
  render(<SchedulePageV3 classes={[morning()]} daysOff={daysOff} />);
  expect(screen.getAllByText('Sem aula hoje')[0]).toBeTruthy();
  expect(screen.getAllByText('Feriado · Nossa Senhora Aparecida')[0]).toBeTruthy();
  expect(screen.queryByRole('timer')).toBeNull();
  // Wednesday of the same week says so too, on its chip and in its place.
  const wednesday = screen.getByRole('button', { name: 'Quarta-feira, sem aula' });
  fireEvent.click(wednesday);
  expect(screen.getAllByText('Sem aula em 14/10')[0]).toBeTruthy();
  expect(screen.getAllByText('Feriado · Antecipação do dia 28')[0]).toBeTruthy();
});

it('on a weekend opens on Monday, with no day marked as today', () => {
  at('2026-10-24T12:00:00'); // Saturday.
  render(<SchedulePageV3 classes={[grid()]} />);
  expect(screen.getByRole('button', { name: 'Segunda-feira' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByText('hoje')).toBeNull();
});

it("marks today's column in the week", () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  const week = screen.getByRole('group', { name: 'Horário da semana' });
  const columns = [...week.querySelectorAll('.pa3-schedule-column')];
  expect(columns.map((column) => column.classList.contains('is-today'))).toEqual([false, false, false, true, false]);
});

it('names each class only when the student has two (regular and integral)', () => {
  const { rerender } = render(<SchedulePageV3 classes={[grid('6A')]} />);
  expect(screen.queryByText('6A')).toBeNull();
  rerender(<SchedulePageV3 classes={[grid('6A'), grid('INTEGRAL')]} />);
  expect(screen.getByText('6A')).toBeTruthy();
  expect(screen.getByText('INTEGRAL')).toBeTruthy();
});

it('says when it was read, without "Conforme o Smecel" (owner request 23/10/2026)', () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  expect(screen.getByText(/^Atualizado em/u)).toBeTruthy();
  expect(screen.queryByText(/Smecel/u)).toBeNull();
});

it('says so when the grid was never read', () => {
  render(<SchedulePageV3 classes={[]} />);
  expect(screen.getByText('O horário da turma ainda não foi lido do Smecel.')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});
