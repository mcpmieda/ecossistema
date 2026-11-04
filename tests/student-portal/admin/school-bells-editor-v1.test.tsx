// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SchoolBellsEditorV1 } from '../../../src/features/student-portal-admin/settings/school-bells-editor-v1';
import type { PortalAdminClientV1 } from '../../../src/features/student-portal-admin/shared/admin-client-v1';

/*
 * Horário das aulas (owner decision 23/10/2026): a parada only before or after the lessons, so the
 * add buttons keep a day valid on the official sheets.
 */
const clientOf = () =>
  ({
    query: vi.fn(async () => ({ state: 'school-bells', bells: null })),
    command: vi.fn(),
  }) as unknown as PortalAdminClientV1;
const dayCard = (label: string) =>
  screen.getByText(label, { selector: '.pa-school-bells__day-head *' }).closest('.pa-school-bells__day') as HTMLElement;

afterEach(cleanup);

it('adds a second parada after the lessons when the day already starts with one', async () => {
  render(<SchoolBellsEditorV1 client={clientOf()} canWrite />);
  await screen.findByText('Horário de cada aula');
  const monday = dayCard('Segunda');
  fireEvent.click(within(monday).getByRole('button', { name: 'Parada' }));
  expect(within(monday).getAllByRole('button', { name: /^Remover Parada/u })).toHaveLength(2);
  expect(screen.queryByText(/Confira os horários/u)).toBeNull();
});

it('adds a lesson before the parada that closes the day', async () => {
  render(<SchoolBellsEditorV1 client={clientOf()} canWrite />);
  await screen.findByText('Horário de cada aula');
  fireEvent.click(screen.getByText('Vespertino'));
  const friday = dayCard('Sexta');
  fireEvent.click(within(friday).getByRole('button', { name: 'Aula' }));
  expect(within(friday).getByText('6 aulas')).toBeTruthy();
  expect(screen.queryByText(/Confira os horários/u)).toBeNull();
});
