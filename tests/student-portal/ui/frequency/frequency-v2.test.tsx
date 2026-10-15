import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FrequencySummaryV2 } from '../../../../shared/attendance-contracts/frequency-v2';
import { StudentFrequencyV2 } from '../../../../src/features/student-portal/frequency/student-frequency-v2';
import {
  createStudentFrequencyClientV2,
  FrequencyClientErrorV2,
} from '../../../../src/features/student-portal/frequency/client-v2';
import { useFrequencyReadV2 } from '../../../../src/features/student-portal/frequency/use-frequency-read-v2';
import { setupOperationsDomV1 } from '../overview/dom-v1';

const fixture = (month = '2026-10'): FrequencySummaryV2 => ({
  contractVersion: 2,
  state: 'ready',
  month,
  absences: null,
  justified: null,
  denominator: null,
  percentage: null,
  coverage: 'incomplete',
  observedAt: '2026-10-14T13:00:00Z',
  receivedAt: '2026-10-14T13:01:00Z',
  conflicts: 1,
  marks: [
    {
      date: month + '-01',
      slot: 6,
      shift: 'MATUTINO',
      mark: 'X',
      classLabels: ['TURMA HISTÓRICA INVENTADA'],
    },
    {
      date: month + '-02',
      slot: 1,
      shift: 'VESPERTINO',
      mark: 'J',
      classLabels: ['TURMA ATUAL INVENTADA'],
    },
  ],
});
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('shows known X/J and historical origin while partial totals and percentage remain unavailable', async () => {
  render(<StudentFrequencyV2 client={{ read: async (month) => fixture(month) }} />);
  await screen.findByText('Dados parciais');
  expect(screen.getAllByText('Indisponível')).toHaveLength(4);
  expect(screen.getByText(/Posição 6 · Matutino/)).toBeTruthy();
  expect(screen.getByText(/Posição 1 · Vespertino/)).toBeTruthy();
  expect(screen.getByText(/Turma de origem: TURMA HISTÓRICA INVENTADA/)).toBeTruthy();
  expect(screen.getByText(/Falta \(X\)/)).toBeTruthy();
  expect(screen.getByText(/Justificada \(J\)/)).toBeTruthy();
  expect(screen.getByText(/Coletado em:/)).toBeTruthy();
  expect(screen.getByText(/Sincronizado em:/)).toBeTruthy();
  expect(screen.queryByText(/presen[çc]a/i)).toBeNull();
});

it('does not expose totals even if an incomplete response accidentally includes numbers', async () => {
  render(
    <StudentFrequencyV2
      client={{
        read: async (month) => ({
          ...fixture(month),
          absences: 99,
          justified: 8,
          denominator: 120,
          percentage: 80,
        }),
      }}
    />,
  );
  await screen.findByText('Dados parciais');
  expect(screen.queryByText('80%')).toBeNull();
  expect(screen.queryByText('99')).toBeNull();
});

it('drops a late previous-month read and clears marks after authentication failure', async () => {
  let finish!: (value: FrequencySummaryV2) => void;
  const read = vi.fn((_month: string) =>
    read.mock.calls.length === 1
      ? new Promise<FrequencySummaryV2>((resolve) => {
          finish = resolve;
        })
      : Promise.reject(new FrequencyClientErrorV2('unauthenticated')),
  );
  render(<StudentFrequencyV2 client={{ read }} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  await userEvent.setup().selectOptions(screen.getByLabelText('Mês'), '2026-09');
  await screen.findByText('Sessão expirada. Entre novamente.');
  await act(async () => finish(fixture('2026-10')));
  expect(screen.queryByText(/TURMA HISTÓRICA/)).toBeNull();
});

it('uses a private month-only endpoint, rejects unknown payloads and removes stale data after a 404', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ contractVersion: 2, state: 'something-new' }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const client = createStudentFrequencyClientV2(fetcher);
  await expect(client.read('2026-10', new AbortController().signal)).rejects.toMatchObject({
    state: 'unavailable',
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/student/frequency?month=2026-10');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });
});

it('pauses hidden reads, avoids overlap, backs off errors and fences late visibility responses', async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useFrequencyReadV2(read, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(read).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => finish('PRIVATE INVENTED DATA'));
  expect(view.result.current.data).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(read).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  const failing = vi.fn(async () => {
    throw new FrequencyClientErrorV2('unavailable');
  });
  renderHook(() => useFrequencyReadV2(failing, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(failing).toHaveBeenCalledOnce();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(failing).toHaveBeenCalledTimes(2);
});
