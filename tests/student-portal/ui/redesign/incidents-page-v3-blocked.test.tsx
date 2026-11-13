// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FrequencyClientErrorV2 } from '../../../../src/features/student-portal/frequency/client-v2';
import type { StudentIncidentsClientV1 } from '../../../../src/features/student-portal/incidents/client-v1';
import { IncidentsPageV3 } from '../../../../src/features/student-portal/redesign/incidents-page-v3';
import { PortalPagesV3 } from '../../../../src/features/student-portal/redesign/portal-pages-v3';

/* A20: Ocorrências turned off (403) or an expired session is no "try again" failure. */
const failing = (state: string): StudentIncidentsClientV1 => ({
  read: vi.fn(async () => {
    throw new FrequencyClientErrorV2(state);
  }),
  acknowledge: vi.fn(),
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '');
});

it('says Ocorrências is not available, with no retry button, when the school turned it off', async () => {
  render(<IncidentsPageV3 client={failing('forbidden')} />);
  expect(await screen.findByText('As ocorrências não estão disponíveis no momento.')).toBeTruthy();
  expect(screen.queryByText('Não foi possível carregar as ocorrências agora.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
});

it('says the session expired, with no retry button, on 401', async () => {
  const lost = vi.fn();
  render(<IncidentsPageV3 client={failing('unauthenticated')} onAuthenticationLost={lost} />);
  expect(await screen.findByText('Sua sessão expirou. Entre novamente para ver as ocorrências.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  expect(lost).toHaveBeenCalled();
});

it('keeps the generic message and the retry button for other failures', async () => {
  render(<IncidentsPageV3 client={failing('unavailable')} />);
  expect(await screen.findByText('Não foi possível carregar as ocorrências agora.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
});

const menuItem = () => screen.queryByRole('button', { name: /Ocorrências/u });

it('takes Ocorrências off the menu when a read behind the menu answers 403', async () => {
  const client = failing('forbidden');
  render(<PortalPagesV3 hero={null} grades={<p>Notas</p>} incidents={<IncidentsPageV3 client={client} />} />);
  await waitFor(() => expect(client.read).toHaveBeenCalled());
  await waitFor(() => expect(menuItem()).toBeNull());
  expect(screen.getByRole('button', { name: /Notas/u })).toBeTruthy();
});

it('keeps the item while the reader is on Ocorrências, and drops it once they leave', async () => {
  let answer: 'ok' | 'forbidden' = 'ok';
  const client: StudentIncidentsClientV1 = {
    read: vi.fn(async () => {
      if (answer === 'forbidden') throw new FrequencyClientErrorV2('forbidden');
      return { incidents: [] };
    }),
    acknowledge: vi.fn(),
  };
  render(<PortalPagesV3 hero={null} grades={<p>Notas</p>} incidents={<IncidentsPageV3 client={client} />} />);
  fireEvent.click(await screen.findByRole('button', { name: /Ocorrências/u }));
  expect(await screen.findByText('Nenhuma ocorrência registrada neste ano.')).toBeTruthy();
  // The school turns Ocorrências off; the next read (here the page's own) answers 403.
  answer = 'forbidden';
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(await screen.findByText('As ocorrências não estão disponíveis no momento.')).toBeTruthy();
  expect(menuItem()?.getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: /Notas/u }));
  await waitFor(() => expect(menuItem()).toBeNull());
  vi.restoreAllMocks();
});
