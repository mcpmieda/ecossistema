// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SchoolCalendarEditorV1 } from '../../../src/features/student-portal-admin/settings/school-calendar-editor-v1';
import type { PortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';
import { officialCalendar2026V1 } from '../../../shared/student-portal-contracts/school-calendar-2026-start-v1';
import { PortalClientErrorV1 } from '../../../src/features/student-portal/shared/transport-v1';

/*
 * Datas principais on the school calendar (owner decision 23/10/2026): the year's main dates are
 * marked on its days and saved in the school's Calendário policy, as whole days in Brasília time.
 */
const calendar = {
  timezone: 'America/Sao_Paulo',
  enrollmentStartsAt: '2025-12-20T03:00:00Z',
  yearStartsAt: '2026-02-23T03:00:00Z',
  t1EndsAt: '2026-05-16T03:00:00Z',
  t2StartsAt: '2026-05-18T03:00:00Z',
  t2EndsAt: '2026-09-01T03:00:00Z',
  t3StartsAt: '2026-09-01T03:00:00Z',
  t3EndsAt: null,
  recoveriesStartAt: '2026-12-16T03:00:00Z',
  yearEndsAt: '2026-12-23T03:00:00Z',
  finalDisclosureAt: null,
  accessStartsAt: '2026-09-27T11:57:00Z',
  disclosure: { mode: 'single', at: null, periods: ['T1'] },
};
const clientOf = () => {
  const command = vi.fn(async (_input: unknown) => ({ state: 'committed' }));
  const query = vi.fn(async (input: { operation: string }) =>
    input.operation === 'settings'
      ? { state: 'settings', settings: { version: 7, value: { calendar } } }
      : { state: 'school-calendar', calendar: { academicYear: 2026, version: 1, days: officialCalendar2026V1() } },
  );
  return { client: { query, command } as unknown as PortalAdminClientV1, query, command };
};
const chip = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`, 'u') });
const day = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}:`, 'u') });

afterEach(() => {
  cleanup();
});

it('shows each main date as its day, an end as its last day, and the missing ones as pending', async () => {
  render(<SchoolCalendarEditorV1 client={clientOf().client} canWrite />);
  await screen.findByText('Datas principais');
  expect(chip('Início das matrículas').textContent).toContain('20/12/2025');
  expect(chip('Fim do 1º trimestre').textContent).toContain('15/05');
  expect(chip('Fim do 2º trimestre').textContent).toContain('31/08');
  expect(chip('Início do 3º trimestre').textContent).toContain('01/09');
  expect(chip('Fim do ano letivo').textContent).toContain('22/12');
  expect(chip('Fim do 3º trimestre').textContent).toContain('Pendente');
  expect(screen.getByText('Falta marcar 1 data')).toBeTruthy();
  expect(screen.getByText('Fim do 3º trimestre.')).toBeTruthy();
  // The day shows it too.
  expect(day('15/05').getAttribute('aria-label')).toContain('Fim do 1º trimestre');
});

it('marks a pending date on a click and saves only the dates that changed, keeping the rest', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T12:00:00Z'));
  const { client, command } = clientOf();
  const onSaved = vi.fn();
  render(<SchoolCalendarEditorV1 client={client} canWrite onSaved={onSaved} />);
  await screen.findByText('Datas principais');
  fireEvent.click(chip('Fim do 3º trimestre'));
  expect(screen.getByText('Clique no dia de: Fim do 3º trimestre.')).toBeTruthy();
  fireEvent.pointerDown(day('15/12'));
  expect(chip('Fim do 3º trimestre').textContent).toContain('15/12');
  expect(screen.queryByText(/Falta marcar/u)).toBeNull();
  // The click marked the date and painted nothing.
  expect(day('15/12').getAttribute('aria-label')).toBe('15/12: Dia letivo · Fim do 3º trimestre');
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]![0]).toMatchObject({
    operation: 'settings-set',
    scope: { kind: 'school', academicYear: 2026 },
    expectedVersion: 7,
    value: { calendar: { ...calendar, t3EndsAt: '2026-12-16T03:00:00Z' } },
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

it('refuses to save main dates out of order, and a cleared one becomes pending', async () => {
  render(<SchoolCalendarEditorV1 client={clientOf().client} canWrite />);
  await screen.findByText('Datas principais');
  fireEvent.click(chip('Fim do 1º trimestre'));
  fireEvent.pointerDown(day('21/09'));
  expect(screen.getByText(/fora de ordem: confira Início do 2º trimestre/u)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Salvar calendário' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Apagar Início do 2º trimestre' }));
  expect(chip('Início do 2º trimestre').textContent).toContain('Pendente');
});

it('saves the days once: when only the main dates fail, trying again sends just them', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T12:00:00Z'));
  const { client, command } = clientOf();
  let refused = false;
  command.mockImplementation(async (input: unknown) => {
    const { operation } = input as { operation: string };
    if (operation === 'settings-set' && !refused) {
      refused = true;
      throw new PortalClientErrorV1('conflict');
    }
    return { state: 'committed', operationId: 'x', version: 2 };
  });
  render(<SchoolCalendarEditorV1 client={client} canWrite />);
  await screen.findByText('Datas principais');
  fireEvent.pointerDown(day('14/12'));
  fireEvent.click(chip('Fim do 3º trimestre'));
  fireEvent.pointerDown(day('15/12'));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await screen.findByText(/Os dias foram salvos, mas as datas principais não/u);
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
  expect(command.mock.calls.map(([input]) => (input as { operation: string }).operation)).toEqual([
    'school-calendar-set',
    'settings-set',
    'settings-set',
  ]);
});

it('saves the main dates on the policy version read at save time', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T12:00:00Z'));
  const { client, query, command } = clientOf();
  let reads = 0;
  query.mockImplementation(async (input: { operation: string }) =>
    input.operation === 'settings'
      ? { state: 'settings', settings: { version: ++reads === 1 ? 7 : 8, value: { calendar } } }
      : { state: 'school-calendar', calendar: { academicYear: 2026, version: 1, days: officialCalendar2026V1() } },
  );
  render(<SchoolCalendarEditorV1 client={client} canWrite />);
  await screen.findByText('Datas principais');
  fireEvent.click(chip('Fim do 3º trimestre'));
  fireEvent.pointerDown(day('15/12'));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]![0]).toMatchObject({ operation: 'settings-set', expectedVersion: 8 });
});

it('asks before changing a main date that already came', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T12:00:00Z'));
  const { client, command } = clientOf();
  render(<SchoolCalendarEditorV1 client={client} canWrite />);
  await screen.findByText('Datas principais');
  fireEvent.click(chip('Fim do 1º trimestre'));
  fireEvent.pointerDown(day('14/05'));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar calendário' }));
  await screen.findByText(/Estas datas já chegaram/u);
  expect(screen.getByText('Fim do 1º trimestre.')).toBeTruthy();
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Salvar mesmo assim' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]![0]).toMatchObject({ value: { calendar: { t1EndsAt: '2026-05-15T03:00:00Z' } } });
});

it('lists two days of a break apart when a class day lies between them', async () => {
  const { client, query } = clientOf();
  query.mockImplementation(async (input: { operation: string }) =>
    input.operation === 'settings'
      ? { state: 'settings', settings: { version: 7, value: { calendar } } }
      : {
          state: 'school-calendar',
          calendar: {
            academicYear: 2026,
            version: 1,
            days: [
              { date: '2026-07-24', kind: 'recesso' },
              { date: '2026-07-25', kind: 'sabado-letivo' },
              { date: '2026-07-27', kind: 'recesso' },
              { date: '2026-08-07', kind: 'recesso' },
              { date: '2026-08-10', kind: 'recesso' },
            ],
          },
        },
  );
  render(<SchoolCalendarEditorV1 client={client} canWrite />);
  await screen.findByText('Datas principais');
  expect(screen.getByText('24/07 · Recesso')).toBeTruthy();
  expect(screen.getByText('27/07 · Recesso')).toBeTruthy();
  // An unmarked weekend still joins them.
  expect(screen.getByText('07/08 a 10/08 · Recesso')).toBeTruthy();
});

it('takes only the enrollment in December of the year before', async () => {
  render(<SchoolCalendarEditorV1 client={clientOf().client} canWrite />);
  await screen.findByText('Datas principais');
  expect((day('15/12/2025') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(chip('Início das matrículas'));
  fireEvent.pointerDown(day('15/12/2025'));
  expect(chip('Início das matrículas').textContent).toContain('15/12/2025');
});
