// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FrequencyClientErrorV2 } from '../../../../src/features/student-portal/frequency/client-v2';
import type {
  StudentIncidentV1,
  StudentIncidentsClientV1,
} from '../../../../src/features/student-portal/incidents/client-v1';
import { IncidentsPageV3 } from '../../../../src/features/student-portal/redesign/incidents-page-v3';
import { PortalPagesV3 } from '../../../../src/features/student-portal/redesign/portal-pages-v3';

/*
 * The Ocorrências page (owner decisions 29/10/2026), fed through a client with answers shaped like
 * /api/student/incidents: the whole description, newest first, "Toque aqui para confirmar que leu"
 * with a confirmation and no undo, and the open count on the menu.
 */
const incident = (fields: Partial<StudentIncidentV1>): StudentIncidentV1 => ({
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'ADVERTÊNCIA',
  date: '2026-09-29',
  leave: null,
  description: 'Advertido(a) por usar o uniforme fora do padrão.',
  acknowledgedAt: null,
  ...fields,
});
const warning = incident({});
const suspension = incident({
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'SUSPENSÃO',
  date: '2026-10-22',
  leave: { from: '2026-10-22', to: '2026-10-28', days: 3 },
  description: 'Três dias de suspensão por desrespeito a um colega.',
});
const seen = incident({
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'OUTRAS',
  date: '2026-06-10',
  leave: { from: null, to: '2026-06-11', days: 1 },
  description: 'A família foi chamada para conversar com a coordenação.',
  acknowledgedAt: '2026-06-11T13:20:00.000Z',
});
const clientOf = (
  incidents: StudentIncidentV1[],
  acknowledge: StudentIncidentsClientV1['acknowledge'] = async () => ({
    acknowledgedAt: '2026-10-29T12:40:00.000Z',
  }),
) => ({
  read: vi.fn<StudentIncidentsClientV1['read']>(async () => ({ incidents: structuredClone(incidents) })),
  acknowledge: vi.fn(acknowledge),
});
const cards = () => [...document.querySelectorAll('.pa3-incident')] as HTMLElement[];
const confirmFirstOpen = async () => {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Toque aqui para confirmar que leu' }))[0]!);
  fireEvent.click(await screen.findByRole('button', { name: 'Sim, li' }));
};
afterEach(cleanup);

it('lists the records newest first, each with its kind, date, leave and whole description (no class)', async () => {
  render(<IncidentsPageV3 client={clientOf([warning, seen, suspension])} />);
  await waitFor(() => expect(cards()).toHaveLength(3));
  expect(cards().map((card) => card.querySelector('.pa3-incident-date')?.textContent)).toEqual([
    '22/10/2026',
    '29/09/2026',
    '10/06/2026',
  ]);
  const [first, second, third] = cards() as [HTMLElement, HTMLElement, HTMLElement];
  expect(within(first).getByText('Suspensão')).toBeTruthy();
  expect(first.querySelector('.pa3-incident-leave')?.textContent).toBe(
    'Afastamento: De 22/10/2026 a 28/10/2026 · 3 dias',
  );
  expect(within(first).getByText('Três dias de suspensão por desrespeito a um colega.')).toBeTruthy();
  // A warning has no leave; a part the Smecel left blank is left out, never guessed.
  expect(within(second).getByText('Advertência')).toBeTruthy();
  expect(second.querySelector('.pa3-incident-leave')).toBeNull();
  expect(third.querySelector('.pa3-incident-leave')?.textContent).toBe('Afastamento: Até 11/06/2026 · 1 dia');
  // Already confirmed: the check with the day and time (school time), no button.
  expect(third.querySelector('.pa3-incident-seen')?.textContent).toContain(
    'Você confirmou a leitura em 11/06/2026, às 10:20',
  );
  expect(within(third).queryByRole('button')).toBeNull();
});

it('says so when the year has no record', async () => {
  render(<IncidentsPageV3 client={clientOf([])} />);
  expect(await screen.findByText('Nenhuma ocorrência registrada neste ano.')).toBeTruthy();
});

it('asks before confirming, and a cancel keeps the record open', async () => {
  const client = clientOf([warning]);
  render(<IncidentsPageV3 client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Toque aqui para confirmar que leu' }));
  expect(screen.getByText(/não dá para desfazer/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
  expect(client.acknowledge).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Toque aqui para confirmar que leu' })).toBeTruthy();
});

it('turns a confirmed record into a check at once, for that version, without reading again', async () => {
  const client = clientOf([warning]);
  render(<IncidentsPageV3 client={client} />);
  await confirmFirstOpen();
  expect(await screen.findByText(/Você confirmou a leitura em 29\/10\/2026, às 09:40/u)).toBeTruthy();
  expect(client.acknowledge).toHaveBeenCalledExactlyOnceWith(warning.id);
  expect(client.read).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Toque aqui para confirmar que leu' })).toBeNull();
});

it('keeps the record open with a message when the confirmation fails', async () => {
  render(
    <IncidentsPageV3
      client={clientOf([warning], async () => {
        throw new FrequencyClientErrorV2('unavailable');
      })}
    />,
  );
  await confirmFirstOpen();
  expect(await screen.findByText('Não foi possível registrar agora. Tente de novo em instantes.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Toque aqui para confirmar que leu' })).toBeTruthy();
});

it('reads again and warns when the school edited the record meanwhile', async () => {
  const edited = incident({ id: '66666666-6666-4666-8666-666666666666', description: 'Texto corrigido pela escola.' });
  const client = clientOf([warning], async () => {
    throw new FrequencyClientErrorV2('changed');
  });
  render(<IncidentsPageV3 client={client} />);
  await waitFor(() => expect(cards()).toHaveLength(1));
  client.read.mockResolvedValueOnce({ incidents: [edited] });
  await confirmFirstOpen();
  expect(
    await screen.findByText('A escola alterou uma ocorrência. Confira o texto atualizado antes de confirmar.'),
  ).toBeTruthy();
  expect(await screen.findByText('Texto corrigido pela escola.')).toBeTruthy();
  expect(client.read).toHaveBeenCalledTimes(2);
  // The new version is open again.
  expect(screen.getByRole('button', { name: 'Toque aqui para confirmar que leu' })).toBeTruthy();
});

it('hands an expired session to the portal', async () => {
  const lost = vi.fn();
  render(
    <IncidentsPageV3
      client={clientOf([warning], async () => {
        throw new FrequencyClientErrorV2('unauthenticated');
      })}
      onAuthenticationLost={lost}
    />,
  );
  await confirmFirstOpen();
  await waitFor(() => expect(lost).toHaveBeenCalledOnce());
});

it('shows on the menu item how many records are still open, and nothing once all are confirmed', async () => {
  render(<PortalPagesV3 hero={null} grades={<p>Notas</p>} incidents={<IncidentsPageV3 client={clientOf([warning, suspension, seen])} />} />);
  const item = () => screen.getByRole('button', { name: /Ocorrências/u });
  await waitFor(() => expect(item().querySelector('.pa3-nav-badge')?.textContent).toBe('2 sem confirmação'));
  fireEvent.click(item());
  await confirmFirstOpen();
  await waitFor(() => expect(item().querySelector('.pa3-nav-badge')?.textContent).toBe('1 sem confirmação'));
  await confirmFirstOpen();
  await waitFor(() => expect(item().querySelector('.pa3-nav-badge')).toBeNull());
});
