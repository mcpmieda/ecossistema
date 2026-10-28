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
/** The now card's title as read, its highlighted part included. */
const nowTitle = () => document.querySelector('.pa3-now-title')?.textContent;
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
  // The official names (owner decision 23/10/2026): REDACAO → REDAÇÃO.
  expect(rows()).toEqual(['1ª aula: REDAÇÃO', '2ª aula: sem aula', '3ª aula: GEOGRAFIA']);
  const free = within(phoneList()).getAllByRole('listitem')[1]!;
  expect(free.className).toContain('is-free');
  expect(free.querySelector('.pa3-schedule-subject')!.textContent).toBe('2ª aula: sem aula');
});

it("shows each day's own lessons only: no empty 6th on a day without one (owner request 23/10/2026)", () => {
  render(<SchedulePageV3 classes={[grid()]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Segunda-feira' }));
  expect(screen.getByRole('heading', { name: 'Segunda-feira' })).toBeTruthy();
  // Monday ends at its 2nd lesson, even though Thursday has a 3rd.
  expect(rows()).toEqual(['1ª aula: ARTE', '2ª aula: COMPUTAÇÃO']);
});

it('shows each lesson with its time and the break in its place, different on each day', () => {
  render(<SchedulePageV3 classes={[morning()]} />);
  // Thursday: the parada, six lessons, the break after the 4th.
  expect(rows()).toEqual([
    'Parada06:45 – 07:00',
    '1ª aula: MATERIA 4.107:00 – 07:45',
    '2ª aula: MATERIA 4.207:45 – 08:30',
    '3ª aula: MATERIA 4.308:30 – 09:15',
    '4ª aula: MATERIA 4.409:15 – 10:00',
    'Intervalo10:00 – 10:15',
    '5ª aula: MATERIA 4.510:15 – 11:00',
    '6ª aula: MATERIA 4.611:00 – 11:45',
  ]);
  // Monday: the parada, five lessons, the break after the 3rd.
  fireEvent.click(screen.getByRole('button', { name: 'Segunda-feira' }));
  expect(rows()).toEqual([
    'Parada06:45 – 07:00',
    '1ª aula: MATERIA 1.107:00 – 07:55',
    '2ª aula: MATERIA 1.207:55 – 08:50',
    '3ª aula: MATERIA 1.308:50 – 09:45',
    'Intervalo09:45 – 10:00',
    '4ª aula: MATERIA 1.410:00 – 10:55',
    '5ª aula: MATERIA 1.510:55 – 11:45',
  ]);
  // On a computer each day is its own column, with the same rows.
  const week = screen.getByRole('group', { name: 'Horário da semana' });
  expect(within(week).getAllByRole('list')).toHaveLength(5);
  expect(rows(within(week).getByRole('list', { name: 'Aulas de sexta-feira' }))[0]).toBe('Parada06:45 – 07:45');
});

it('says the lesson going on now and counts to the break, the next lesson and the end', () => {
  at('2026-10-22T09:05:00');
  render(<SchedulePageV3 classes={[morning()]} />);
  expect(nowTitle()).toBe('Agora: 3ª aula · MATERIA 4.3');
  expect(screen.getByText('até 09:15')).toBeTruthy();
  expect(screen.getByText('Próxima aula em')).toBeTruthy();
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Próxima aula em 10 minutos');
  expect(screen.getByText('Depois: 4ª aula · MATERIA 4.4 · 09:15')).toBeTruthy();
  // The row of the lesson going on is marked.
  expect(within(phoneList()).getAllByRole('listitem')[3]!.getAttribute('aria-current')).toBe('time');

  act(() => {
    at('2026-10-22T09:50:00');
    vi.advanceTimersByTime(1000);
  });
  expect(nowTitle()).toBe('Agora: 4ª aula · MATERIA 4.4');
  expect(screen.getByText('Intervalo em')).toBeTruthy();
  expect(screen.getByText('Depois: 5ª aula · MATERIA 4.5 · 10:15')).toBeTruthy();

  act(() => {
    at('2026-10-22T10:05:00');
    vi.advanceTimersByTime(1000);
  });
  expect(nowTitle()).toBe('Agora: Intervalo');
  expect(screen.getByText('Volta em')).toBeTruthy();

  act(() => {
    at('2026-10-22T11:30:00');
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByText('Saída em')).toBeTruthy();

  // After the last lesson, the clock runs to the next day's first one (owner request 23/10/2026).
  act(() => {
    at('2026-10-22T11:50:00');
    vi.advanceTimersByTime(1000);
  });
  expect(nowTitle()).toBe('Próximas aulas: amanhã');
  // Friday starts with the parada at 06:45.
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Começa em 18 horas e 54 minutos');
});

it('before the day, says when it starts: with the parada, which is never a lesson', () => {
  at('2026-10-23T06:30:00'); // Friday: the parada 06:45–07:45, then the lessons.
  render(<SchedulePageV3 classes={[morning()]} />);
  expect(screen.getByText('Hoje a parada começa às 06:45')).toBeTruthy();
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Começa em 15 minutos');
  expect(screen.getByText('Primeira: 1ª aula · MATERIA 5.1')).toBeTruthy();
  // During the parada: the lessons start at 07:45.
  act(() => {
    at('2026-10-23T07:00:00');
    vi.advanceTimersByTime(1000);
  });
  expect(nowTitle()).toBe('Agora: Parada');
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Aulas começam em 45 minutos');
});

it("counts Friday afternoon's last lesson to the parada, then the parada to 18:00", () => {
  const afternoon = { ...morning(), label: '6º ANO C - VESPERTINO', bells: officialBells2026V1().vespertino };
  at('2026-10-23T17:00:00');
  render(<SchedulePageV3 classes={[afternoon]} />);
  expect(screen.getByText('Parada em')).toBeTruthy();
  expect(screen.getByText('Depois: Parada · 17:15')).toBeTruthy();
  act(() => {
    at('2026-10-23T17:30:00');
    vi.advanceTimersByTime(1000);
  });
  expect(nowTitle()).toBe('Agora: Parada');
  expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Saída em 30 minutos');
  expect(rows().at(-1)).toBe('Paradaagora17:15 – 18:00');
});

it('on a day without school says why, from the ADM calendar, and counts to the next lessons', () => {
  at('2026-10-12T09:00:00'); // Monday, a holiday.
  const daysOff = [
    { date: '2026-10-12', kind: 'feriado' as const, note: 'Nossa Senhora Aparecida' },
    { date: '2026-10-14', kind: 'feriado' as const, note: 'Antecipação do dia 28' },
  ];
  render(<SchedulePageV3 classes={[morning()]} daysOff={daysOff} />);
  expect(screen.getAllByText('Sem aula hoje')[0]).toBeTruthy();
  expect(screen.getAllByText('Feriado · Nossa Senhora Aparecida')[0]).toBeTruthy();
  // No lesson going on: the clock runs to Tuesday's first lesson (Wednesday is a holiday too).
  expect(screen.queryByText(/^Agora/u)).toBeNull();
  expect(nowTitle()).toBe('Próximas aulas: amanhã');
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
  expect(screen.getByText('O horário da turma ainda não está disponível.')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});

it('marks the break going on with "agora" and a steaming mug (owner requests 23/10/2026)', () => {
  at('2026-10-22T10:05:00'); // Thursday's break, 10:00–10:15.
  render(<SchedulePageV3 classes={[morning()]} />);
  const pause = within(phoneList()).getAllByRole('listitem')[5]!;
  expect(pause.textContent).toContain('Intervalo');
  expect(pause.getAttribute('aria-current')).toBe('time');
  expect(within(pause).getByText('agora')).toBeTruthy();
  expect(pause.querySelector('.pa3-icon--coffee.is-live')).not.toBeNull();
  // Outside the break the mug is still.
  cleanup();
  at('2026-10-22T09:05:00');
  render(<SchedulePageV3 classes={[morning()]} />);
  expect(document.querySelector('.pa3-icon--coffee.is-live')).toBeNull();
});

it('moves only the icon of the lesson going on, and dots the timeline (owner request 27/10/2026)', () => {
  at('2026-10-22T09:05:00'); // Thursday's 3rd lesson, 08:30–09:15.
  render(<SchedulePageV3 classes={[morning()]} />);
  const items = within(phoneList()).getAllByRole('listitem');
  const stateOf = (item: HTMLElement) => {
    if (item.classList.contains('is-now')) return 'now';
    return item.classList.contains('is-done') ? 'done' : 'later';
  };
  // The parada, the 1st and the 2nd lessons are over; the 3rd goes on; the rest are still to come.
  expect(items.map(stateOf)).toEqual(['done', 'done', 'done', 'now', 'later', 'later', 'later', 'later']);
  expect(items.map((item) => item.querySelector('.pa3-schedule-icon .pa3-icon.is-live') !== null)).toEqual([
    false, false, false, true, false, false, false, false,
  ]);
  // The large faint copy behind the name never moves.
  expect(items[3]!.querySelector('.pa3-schedule-watermark .is-live')).toBeNull();
});

it('runs the clock across a recess to the first day back', () => {
  at('2026-07-17T12:00:00'); // Friday before the July recess (20 to 31/07).
  const recess = Array.from({ length: 10 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 20 + index + (index >= 5 ? 2 : 0)));
    return { date: date.toISOString().slice(0, 10), kind: 'recesso' as const };
  });
  render(<SchedulePageV3 classes={[morning()]} daysOff={recess} />);
  expect(nowTitle()).toBe('Próximas aulas: segunda-feira');
  // The day starts with the parada at 06:45.
  expect(screen.getByText('03/08 · 06:45')).toBeTruthy();
});

it("ends the year at the calendar's last lesson, whatever its date (owner request 27/10/2026)", () => {
  const schoolYear = { firstDay: '2026-02-23', lastDay: '2026-12-15' };
  at('2026-12-15T13:00:00'); // The last school day, after its lessons.
  render(<SchedulePageV3 classes={[morning()]} schoolYear={schoolYear} />);
  expect(nowTitle()).toBe('O ano letivo terminou.');
  expect(screen.queryByRole('timer')).toBeNull();
  cleanup();
  // A weekday the calendar does not mark, after the year: no lesson going on.
  at('2026-12-23T08:00:00');
  render(<SchedulePageV3 classes={[morning()]} schoolYear={schoolYear} />);
  expect(nowTitle()).toBe('O ano letivo terminou.');
  expect(document.querySelector('.pa3-schedule-row.is-now')).toBeNull();
  // The year ends where the calendar says: one marked a day later still has lessons that day.
  cleanup();
  at('2026-12-15T13:00:00');
  render(<SchedulePageV3 classes={[morning()]} schoolYear={{ ...schoolYear, lastDay: '2026-12-16' }} />);
  expect(nowTitle()).toBe('Próximas aulas: amanhã');
});

it('changes the day with a sideways swipe on a phone, never with a vertical one', () => {
  render(<SchedulePageV3 classes={[morning()]} />);
  const slider = document.querySelector('.pa3-day-slider') as HTMLElement;
  Object.defineProperty(slider, 'offsetWidth', { value: 300 });
  const drag = (from: [number, number], to: [number, number]) => {
    fireEvent.touchStart(slider, { touches: [{ clientX: from[0], clientY: from[1] }] });
    fireEvent.touchMove(slider, { touches: [{ clientX: to[0], clientY: to[1] }] });
    fireEvent.touchEnd(slider, { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
    act(() => {
      vi.advanceTimersByTime(300);
    });
  };
  const pressed = () =>
    screen
      .getAllByRole('button', { pressed: true })
      .map((button) => button.getAttribute('aria-label'));
  const shownDay = () => slider.querySelector('.pa3-day-panel:not([aria-hidden]) h3')!.textContent;
  expect(shownDay()).toBe('Hoje, quinta-feira');
  // Up the page: the page's scroll, the day stays.
  drag([150, 300], [160, 100]);
  expect(shownDay()).toBe('Hoje, quinta-feira');
  // A short sideways move slides back.
  drag([150, 300], [120, 300]);
  expect(shownDay()).toBe('Hoje, quinta-feira');
  // A swipe to the left: Friday; to the right twice: Thursday, then Wednesday.
  drag([250, 300], [60, 305]);
  expect(shownDay()).toBe('Sexta-feira');
  expect(pressed()).toContain('Sexta-feira');
  drag([60, 300], [250, 300]);
  drag([60, 300], [250, 300]);
  expect(shownDay()).toBe('Quarta-feira');
});
