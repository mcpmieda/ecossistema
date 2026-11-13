// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FrequencyClientErrorV2 } from '../../../../src/features/student-portal/frequency/client-v2';
import type { StudentIncidentsClientV1 } from '../../../../src/features/student-portal/incidents/client-v1';
import { IncidentsPageV3 } from '../../../../src/features/student-portal/redesign/incidents-page-v3';

/* A20: Ocorrências turned off (403) or an expired session is no "try again" failure. */
const failing = (state: string): StudentIncidentsClientV1 => ({
  read: vi.fn(async () => {
    throw new FrequencyClientErrorV2(state);
  }),
  acknowledge: vi.fn(),
});
afterEach(cleanup);

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
