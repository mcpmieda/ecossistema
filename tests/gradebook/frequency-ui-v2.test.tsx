import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FrequencyStatusV2 } from '../../shared/attendance-contracts/frequency-v2';
import { FrequencyPanelV2 } from '../../src/features/gradebook/import/frequency-panel-v2';
import type { FrequencyAdminClientV2 } from '../../src/features/gradebook/import/frequency-client-v2';
import { FrequencyClientErrorV2 } from '../../src/features/student-portal/frequency/client-v2';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';

const deviceId = '11111111-1111-4111-8111-111111111111';
const conflictId = '22222222-2222-4222-8222-222222222222';
function fixture(): FrequencyStatusV2 {
  return {
    contractVersion: 2,
    state: 'ready',
    academicYear: 2026,
    serverTime: '2026-10-14T13:00:00Z',
    settings: {
      revision: 3,
      paused: false,
      schedule: {
        timezone: 'America/Sao_Paulo',
        rules: Array.from({ length: 14 }, (_, index) => ({
          weekday: Math.floor(index / 2),
          shift: index % 2 ? 'vespertino' : 'matutino',
          enabled: false,
          times: [],
          recheck: null,
        })),
      },
    },
    lease: { deviceId, expiresAt: '2026-10-14T13:05:00Z', fencingToken: 8 },
    classes: [{ classId: 1, sourceClassLabel: 'TURMA INVENTADA', shift: 'matutino', revision: 0 }],
    devices: [
      {
        deviceId,
        label: 'COMPUTADOR INVENTADO',
        state: 'ready',
        lastSeenAt: '2026-10-14T13:00:00Z',
        classId: 1,
        code: null,
        lastCollectionAt: null,
      },
    ],
    collections: [],
    conflicts: [
      {
        id: conflictId,
        revision: 4,
        studentUid: '33333333-3333-4333-8333-333333333333',
        studentName: 'ALUNO INVENTADO',
        classLabel: 'TURMA INVENTADA',
        date: '2026-10-01',
        slot: 2,
        shift: 'matutino',
        marks: ['X', 'J', null],
      },
    ],
  };
}
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('preserves an edited schedule after refresh and refuses to save over a newer revision', async () => {
  const value = fixture();
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  const user = userEvent.setup();
  const timezone = await screen.findByLabelText('Fuso horário');
  await waitFor(() =>
    expect((timezone.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false),
  );
  await user.clear(timezone);
  await user.type(timezone, 'America/Manaus');
  value.settings.revision = 4;
  await user.click(screen.getByRole('button', { name: 'Atualizar frequência' }));
  await screen.findByText(/A agenda mudou durante sua edição/);
  expect((screen.getByLabelText('Fuso horário') as HTMLInputElement).value).toBe('America/Manaus');
  expect(
    (screen.getByRole('button', { name: 'Salvar agenda' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(client.mutate).not.toHaveBeenCalled();
});

it('saves multiple typed schedule times with CAS and pauses only after an explicit action', async () => {
  const value = fixture();
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async (input) => {
      if (input.operation === 'set-paused') value.settings.paused = input.paused;
    }),
  };
  render(<FrequencyPanelV2 client={client} />);
  const user = userEvent.setup();
  await screen.findByText('COMPUTADOR INVENTADO');
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Fuso horário').closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(false),
  );
  await user.click(screen.getAllByLabelText('Coletar neste turno')[0]!);
  await user.type(screen.getAllByLabelText('Horários de coleta')[0]!, '07:30, 11:30');
  await user.click(screen.getByRole('button', { name: 'Salvar agenda' }));
  await waitFor(() => expect(client.mutate).toHaveBeenCalledTimes(1));
  expect(client.mutate.mock.calls[0]?.[0]).toMatchObject({
    operation: 'save-settings',
    expectedRevision: 3,
    academicYear: 2026,
    schedule: {
      rules: expect.arrayContaining([expect.objectContaining({ times: ['07:30', '11:30'] })]),
    },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Pausar coleta escolar' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole('button', { name: 'Pausar coleta escolar' }));
  await screen.findByRole('button', { name: 'Retomar coleta escolar' });
  expect(client.mutate.mock.calls[1]?.[0]).toMatchObject({
    operation: 'set-paused',
    expectedRevision: 3,
    paused: true,
    requestId: expect.any(String),
  });
});

it.each([
  { marks: ['X', 'J'] as ('X' | 'J' | null)[], choices: ['', 'X', 'J'], decision: 'J', expected: 'J' },
  { marks: ['X', null] as ('X' | 'J' | null)[], choices: ['', 'X', 'remove'], decision: 'remove', expected: null },
])('offers only conflict decisions found in the recorded evidence: $choices', async ({ marks, choices, decision, expected }) => {
  const value = fixture();
  value.conflicts[0]!.marks = marks;
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  await screen.findByText('ALUNO INVENTADO');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Conferir conflito' }));
  const select = screen.getByLabelText('Decisão');
  expect(Array.from(select.querySelectorAll('option'), (option) => option.value)).toEqual(choices);
  await user.selectOptions(select, decision);
  await user.type(screen.getByLabelText('Motivo da decisão'), 'Conferência sintética');
  await user.click(screen.getByRole('button', { name: 'Confirmar decisão' }));
  await waitFor(() => expect(client.mutate).toHaveBeenCalledOnce());
  expect(client.mutate.mock.calls[0]?.[0]).toMatchObject({
    operation: 'resolve-conflict',
    conflictId,
    mark: expected,
  });
});

it('requires device confirmation and an explicit conflict decision/reason', async () => {
  const value = fixture();
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  const user = userEvent.setup();
  await screen.findByText('Líder');
  await user.click(screen.getByRole('button', { name: 'Revogar computador' }));
  expect(client.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirmar revogação' }));
  await waitFor(() => expect(client.mutate).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Conferir conflito' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole('button', { name: 'Conferir conflito' }));
  expect(
    (screen.getByRole('button', { name: 'Confirmar decisão' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.selectOptions(screen.getByLabelText('Decisão'), 'remove');
  await user.type(screen.getByLabelText('Motivo da decisão'), 'Conferido com a fonte inventada');
  await user.click(screen.getByRole('button', { name: 'Confirmar decisão' }));
  await waitFor(() => expect(client.mutate).toHaveBeenCalledTimes(2));
  expect(client.mutate.mock.calls[1]?.[0]).toMatchObject({
    operation: 'resolve-conflict',
    conflictId,
    expectedRevision: 4,
    mark: null,
    reason: 'Conferido com a fonte inventada',
  });
});

it.each(['not-authorized', 'unavailable', 'revision-conflict'])(
  'clears sensitive results after %s and never treats an error as current data',
  async (state) => {
    const client = {
      status: vi.fn(async () => fixture()),
      mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {
        throw new FrequencyClientErrorV2(state);
      }),
    };
    render(<FrequencyPanelV2 client={client} />);
    await screen.findByText('ALUNO INVENTADO');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pausar coleta escolar' }));
    await waitFor(() => expect(screen.queryByText('ALUNO INVENTADO')).toBeNull());
    expect(screen.getByRole('alert')).toBeTruthy();
  },
);

it('drops an aborted late completion when the frequency tab becomes inactive', async () => {
  let finish!: (value: FrequencyStatusV2) => void;
  const client = {
    status: vi.fn(
      () =>
        new Promise<FrequencyStatusV2>((resolve) => {
          finish = resolve;
        }),
    ),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
  };
  const view = render(<FrequencyPanelV2 client={client} />);
  await waitFor(() => expect(client.status).toHaveBeenCalledOnce());
  view.rerender(<FrequencyPanelV2 client={client} active={false} />);
  await act(async () => {
    finish(fixture());
  });
  expect(screen.queryByText('ALUNO INVENTADO')).toBeNull();
});

it('renders every operational device state without simulating a connected computer', async () => {
  const value = fixture();
  const states = [
    'collecting',
    'reserve',
    'offline',
    'revoked',
    'paused',
    'error',
    'login-required',
  ] as const;
  value.devices = states.map((state, index) => ({
    ...value.devices[0]!,
    deviceId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
    label: 'PC INVENTADO ' + index,
    state,
  }));
  render(<FrequencyPanelV2 client={{ status: async () => value, mutate: async () => {} }} />);
  const computers = await screen.findByRole('region', { name: 'Computadores autorizados' });
  for (const label of [
    'Coletando',
    'Reserva',
    'Offline',
    'Revogado',
    'Pausado',
    'Erro',
    'Sessão da fonte expirada',
  ])
    expect(within(computers).getByText(label)).toBeTruthy();
});
