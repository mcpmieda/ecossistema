// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SchoolCalendarEditorV1 } from '../../../src/features/student-portal-admin/settings/school-calendar-editor-v1';
import { SchoolBellsEditorV1 } from '../../../src/features/student-portal-admin/settings/school-bells-editor-v1';
import type { PortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import type { SchoolCalendarDayV1 } from '../../../shared/student-portal-contracts/school-calendar-v1';

/*
 * A22: the editor never marks a dia letivo on a weekend (a drag passes over it) nor a sábado letivo
 * on a weekday. A24: after a save, a failure only in reading it back still says it was saved.
 */
const calendar = {
  timezone: 'America/Sao_Paulo',
  enrollmentStartsAt: '2025-12-20T03:00:00Z',
  yearStartsAt: '2026-02-23T03:00:00Z',
  t1EndsAt: '2026-05-16T03:00:00Z',
  t2StartsAt: '2026-05-18T03:00:00Z',
  t2EndsAt: '2026-09-01T03:00:00Z',
  t3StartsAt: '2026-09-01T03:00:00Z',
  t3EndsAt: '2026-12-16T03:00:00Z',
  recoveriesStartAt: '2026-12-16T03:00:00Z',
  yearEndsAt: '2026-12-23T03:00:00Z',
  finalDisclosureAt: null,
  accessStartsAt: '2026-09-27T11:57:00Z',
  disclosure: { mode: 'single', at: null, periods: ['T1'] },
};
const calendarClientOf = (days: SchoolCalendarDayV1[] = officialCalendar2026V1()) => {
  const command = vi.fn(async (_input: unknown) => ({ state: 'committed', operationId: 'x', version: 2 }));
  const query = vi.fn(async (input: { operation: string }) =>
    input.operation === 'settings'
      ? { state: 'settings', settings: { version: 7, value: { calendar } } }
      : { state: 'school-calendar', calendar: { academicYear: 2026, version: 1, days } },
  );
  return { client: { query, command } as unknown as PortalAdminClientV1, query, command };
};
const day = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}:`, 'u') });
const brush = (id: string) => document.querySelector(`.pa-school-brush.pa-school-kind--${id}`) as HTMLElement;

afterEach(cleanup);

it('skips the weekend while dragging a dia letivo, and says why on a click', async () => {
  render(<SchoolCalendarEditorV1 client={calendarClientOf().client} canWrite />);
  await screen.findByText('Datas principais');
  fireEvent.click(brush('clear'));
  fireEvent.pointerDown(day('11/12'));
  fireEvent.pointerDown(day('14/12'));
  window.dispatchEvent(new Event('pointerup'));
  expect(screen.getByText('198')).toBeTruthy();

  fireEvent.click(brush('letivo'));
  fireEvent.pointerDown(day('11/12'));
  fireEvent.pointerEnter(day('12/12'));
  fireEvent.pointerEnter(day('13/12'));
  fireEvent.pointerEnter(day('14/12'));
  window.dispatchEvent(new Event('pointerup'));
  expect(day('12/12').getAttribute('aria-label')).toBe('12/12: sem marcação');
  expect(day('13/12').getAttribute('aria-label')).toBe('13/12: sem marcação');
  expect(day('14/12').getAttribute('aria-label')).toBe('14/12: Dia letivo');
  expect(screen.getByText('200')).toBeTruthy();
  expect(screen.queryByText(/Dia letivo só de segunda a sexta/u)).toBeNull();

  fireEvent.click(brush('sabado-letivo'));
  fireEvent.pointerDown(day('16/12'));
  window.dispatchEvent(new Event('pointerup'));
  expect(screen.getByText('Sábado letivo só pode ser num sábado.')).toBeTruthy();
  expect(day('16/12').getAttribute('aria-label')).not.toContain('Sábado letivo');
});

it('flags a dia letivo saved on a Sunday before the rule and does not save it', async () => {
  const days = officialCalendar2026V1().filter((each) => each.date !== '2026-12-15');
  days.push({ date: '2026-06-07', kind: 'letivo' });
  render(<SchoolCalendarEditorV1 client={calendarClientOf(days).client} canWrite />);
  await screen.findByText('Datas principais');
  expect(screen.getByText(/^07\/06 está como Dia letivo no dia da semana errado/u)).toBeTruthy();
  fireEvent.click(brush('clear'));
  fireEvent.pointerDown(day('14/12'));
  window.dispatchEvent(new Event('pointerup'));
  expect((screen.getByRole('button', { name: 'Salvar calendário' }) as HTMLButtonElement).disabled).toBe(true);
});

it('says the calendar was saved when only reading it back fails', async () => {
  const { client, query, command } = calendarClientOf();
  render(<SchoolCalendarEditorV1 client={client} canWrite />);
  await screen.findByText('Datas principais');
  query.mockImplementation(async () => {
    throw new Error('503');
  });
  fireEvent.click(brush('clear'));
  fireEvent.pointerDown(day('14/12'));
  window.dispatchEvent(new Event('pointerup'));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await screen.findByText('Calendário salvo.');
  expect(command).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Salvo, mas não foi possível atualizar a tela/u)).toBeTruthy();
  expect(screen.queryByText('Não foi possível carregar o calendário.')).toBeNull();
  // Nothing left to save: the screen knows the days were saved.
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Salvar calendário' }) as HTMLButtonElement).disabled).toBe(true),
  );
});

it('says the bells were saved when only reading them back fails', async () => {
  const query = vi.fn(async (_input: unknown) => ({ state: 'school-bells', bells: null }));
  const command = vi.fn(async (_input: unknown) => ({ state: 'committed', operationId: 'x', version: 1 }));
  render(<SchoolBellsEditorV1 client={{ query, command } as unknown as PortalAdminClientV1} canWrite />);
  await screen.findByText('Horário de cada aula');
  query.mockImplementation(async () => {
    throw new Error('503');
  });
  const monday = screen
    .getByText('Segunda', { selector: '.pa-school-bells__day-head *' })
    .closest('.pa-school-bells__day') as HTMLElement;
  fireEvent.click(within(monday).getByRole('button', { name: 'Parada' }));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar horários' }));
  await screen.findByText('Horários salvos.');
  expect(command).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Salvo, mas não foi possível atualizar a tela/u)).toBeTruthy();
  expect(screen.queryByText('Não foi possível carregar os horários.')).toBeNull();
});
