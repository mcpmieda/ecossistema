import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  frequencyScheduleV2,
  type FrequencyStatusV2,
} from '../../shared/attendance-contracts/frequency-v2';
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
        shift: 'MATUTINO',
        marks: ['X', 'J', null],
      },
    ],
    unresolved: [],
    failures: [],
  };
}
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('shows exact collection times, recheck and timezone without an agenda editor', async () => {
  const value = fixture();
  const monday = value.settings.schedule!.rules.find(
    (r) => r.weekday === 1 && r.shift === 'matutino',
  )!;
  Object.assign(monday, { enabled: true, times: ['11:30', '09:00', '07:30'], recheck: '12:15' });
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  const agenda = await screen.findByRole('region', { name: 'Agenda de coleta' });
  expect(within(agenda).getByText(/Tarefas > Editar agenda/)).toBeTruthy();
  expect(within(agenda).getByText('Fuso horário: America/Sao_Paulo')).toBeTruthy();
  await userEvent.setup().click(within(agenda).getByRole('button', { name: /Segunda-feira/ }));
  const morning = within(agenda).getByRole('group', { name: 'Segunda-feira · Matutino' });
  expect(within(morning).getByText('Coletas: 07:30, 09:00, 11:30')).toBeTruthy();
  expect(within(morning).getByText('Rechecagem: 12:15')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Salvar agenda' })).toBeNull();
  expect(screen.queryByLabelText('Fuso horário')).toBeNull();
  expect(client.mutate).not.toHaveBeenCalled();
});

it.each([
  {
    name: 'morning only',
    morning: { enabled: true, times: ['07:30'], recheck: null },
    afternoon: { enabled: false, times: ['13:00'], recheck: '18:00' },
    count: 1,
    shared: null,
  },
  {
    name: 'afternoon only',
    morning: { enabled: false, times: [], recheck: null },
    afternoon: { enabled: true, times: ['13:30'], recheck: '18:00' },
    count: 2,
    shared: null,
  },
  {
    name: 'same moments in both shifts',
    morning: { enabled: true, times: ['07:30', '11:30'], recheck: '12:15' },
    afternoon: { enabled: true, times: ['07:30', '11:30'], recheck: '12:15' },
    count: 3,
    shared: 'Nos dois turnos: 07:30, 11:30, 12:15.',
  },
  {
    name: 'different moments and rechecks',
    morning: { enabled: true, times: ['07:30', '09:00'], recheck: '12:15' },
    afternoon: { enabled: true, times: ['13:00', '15:00'], recheck: '18:30' },
    count: 6,
    shared: null,
  },
  {
    name: 'same collection and different rechecks',
    morning: { enabled: true, times: ['07:30'], recheck: '12:15' },
    afternoon: { enabled: true, times: ['07:30'], recheck: '18:30' },
    count: 3,
    shared: 'Nos dois turnos: 07:30.',
  },
  {
    name: 'recheck only',
    morning: { enabled: true, times: [], recheck: '12:15' },
    afternoon: { enabled: false, times: [], recheck: null },
    count: 1,
    shared: null,
  },
  {
    name: 'legacy enabled rule without moments',
    morning: { enabled: true, times: [], recheck: null },
    afternoon: { enabled: false, times: [], recheck: null },
    count: 0,
    shared: null,
  },
] as const)(
  'preserves each rule in a read-only $name agenda',
  async ({ morning, afternoon, count, shared }) => {
    const value = fixture();
    Object.assign(value.settings.schedule!.rules[2]!, structuredClone(morning));
    Object.assign(value.settings.schedule!.rules[3]!, structuredClone(afternoon));
    frequencyScheduleV2.parse(value.settings.schedule);
    const mutate = vi.fn(async () => {});
    render(<FrequencyPanelV2 client={{ status: async () => value, mutate }} />);
    const agenda = await screen.findByRole('region', { name: 'Agenda de coleta' });
    const day = within(agenda).getByRole('button', { name: /Segunda-feira/ });
    expect(day.textContent).toContain(`${count} horário(s) ativo(s)`);
    await userEvent.setup().click(day);
    for (const [label, rule] of [
      ['Matutino', morning],
      ['Vespertino', afternoon],
    ] as const) {
      const group = within(agenda).getByRole('group', { name: `Segunda-feira · ${label}` });
      expect(within(group).getByText(rule.enabled ? 'Ativo' : 'Desativado')).toBeTruthy();
      expect(
        within(group).getByText(`Coletas: ${rule.times.join(', ') || 'Nenhuma'}`),
      ).toBeTruthy();
      expect(within(group).getByText(`Rechecagem: ${rule.recheck ?? 'Não definida'}`)).toBeTruthy();
    }
    if (shared) expect(within(agenda).getByText(shared)).toBeTruthy();
    else expect(within(agenda).queryByText(/Nos dois turnos/)).toBeNull();
    expect(within(agenda).queryByText(/Somente coleta manual/)).toBeNull();
    expect(within(agenda).queryByRole('textbox')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  },
);

it.each([
  { schedule: null, message: 'Agenda ainda não configurada no Coletor.' },
  {
    schedule: fixture().settings.schedule,
    message: 'Coletas automáticas desativadas. Somente coleta manual.',
  },
])(
  'distinguishes missing configuration from manual-only collection: $message',
  async ({ schedule, message }) => {
    const value = fixture();
    value.settings.schedule = schedule;
    value.settings.paused = true;
    value.devices[0]!.state = 'revoked';
    render(<FrequencyPanelV2 client={{ status: async () => value, mutate: async () => {} }} />);
    const agenda = await screen.findByRole('region', { name: 'Agenda de coleta' });
    expect(within(agenda).getByText(message)).toBeTruthy();
    expect(within(agenda).getByText(/Nenhum computador autorizado/)).toBeTruthy();
    expect(screen.getByText('Coleta escolar pausada')).toBeTruthy();
    expect(within(agenda).queryByRole('button', { name: 'Salvar agenda' })).toBeNull();
  },
);

it('renders all seven days and all 48 distinct moments without truncating', async () => {
  const value = fixture();
  const times = Array.from(
    { length: 48 },
    (_, index) =>
      `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`,
  );
  for (const rule of value.settings.schedule!.rules)
    Object.assign(rule, { enabled: true, times: [...times].reverse() });
  render(<FrequencyPanelV2 client={{ status: async () => value, mutate: async () => {} }} />);
  const agenda = await screen.findByRole('region', { name: 'Agenda de coleta' });
  const user = userEvent.setup();
  for (const name of [
    'Domingo',
    'Segunda-feira',
    'Terça-feira',
    'Quarta-feira',
    'Quinta-feira',
    'Sexta-feira',
    'Sábado',
  ]) {
    const day = within(agenda).getByRole('button', { name: new RegExp(name) });
    expect(day.textContent).toContain('48 horário(s) ativo(s)');
    await user.click(day);
    for (const shift of ['Matutino', 'Vespertino']) {
      const group = within(agenda).getByRole('group', { name: `${name} · ${shift}` });
      expect(within(group).getByText(`Coletas: ${times.join(', ')}`)).toBeTruthy();
    }
  }
});

it('confirms the new revision and middle time only when a delayed refresh finishes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T22:00:00Z'));
  const value = fixture();
  Object.assign(value.settings.schedule!.rules[2]!, {
    enabled: true,
    times: ['07:30', '09:00', '12:15'],
  });
  let finish!: (value: FrequencyStatusV2) => void;
  const client = {
    status: vi
      .fn<FrequencyAdminClientV2['status']>()
      .mockResolvedValueOnce(structuredClone(value))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    mutate: vi.fn(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  const agenda = await screen.findByRole('region', { name: 'Agenda de coleta' });
  const user = userEvent.setup();
  await user.click(within(agenda).getByRole('button', { name: /Segunda-feira/ }));
  expect(within(agenda).getByText('Coletas: 07:30, 09:00, 12:15')).toBeTruthy();
  expect(agenda.querySelector('time')?.dateTime).toBe('2026-10-19T22:00:00.000Z');
  await user.click(within(agenda).getByRole('button', { name: 'Atualizar agenda' }));
  expect(within(agenda).getByRole('status').textContent).toContain('aguarda confirmação');
  expect(within(agenda).getByText(/Revisão 3/)).toBeTruthy();
  expect(agenda.getAttribute('aria-busy')).toBe('true');
  vi.setSystemTime(new Date('2026-10-19T22:01:05Z'));
  value.settings.revision = 4;
  value.settings.schedule!.rules[2]!.times = ['07:30', '10:30', '12:15'];
  await act(async () => finish(value));
  expect(within(agenda).getByText(/Revisão 4/)).toBeTruthy();
  expect(within(agenda).getByText('Coletas: 07:30, 10:30, 12:15')).toBeTruthy();
  expect(within(agenda).queryByText('Coletas: 07:30, 09:00, 12:15')).toBeNull();
  expect(agenda.querySelector('time')?.dateTime).toBe('2026-10-19T22:01:05.000Z');
  expect(agenda.getAttribute('aria-busy')).toBe('false');
  expect(client.mutate).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Salvar agenda' })).toBeNull();
});

it('removes the agenda and its confirmation timestamp after a failed refresh and recovers explicitly', async () => {
  const next = fixture();
  next.settings.revision = 4;
  const client = {
    status: vi
      .fn<FrequencyAdminClientV2['status']>()
      .mockResolvedValueOnce(fixture())
      .mockRejectedValueOnce(new FrequencyClientErrorV2('unavailable'))
      .mockResolvedValueOnce(next),
    mutate: vi.fn(async () => {}),
  };
  render(<FrequencyPanelV2 client={client} />);
  await screen.findByRole('region', { name: 'Agenda de coleta' });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Atualizar agenda' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('region', { name: 'Agenda de coleta' })).toBeNull();
  expect(screen.queryByText(/Consultado às/)).toBeNull();
  expect(
    screen.getByText('Agenda e status indisponíveis. Atualize a frequência para conferir.'),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Atualizar frequência' }));
  await screen.findByText(/Revisão 4/);
  expect(client.mutate).not.toHaveBeenCalled();
});

it('re-reads the agenda after a settings CAS conflict and after returning to the tab', async () => {
  const value = fixture();
  const client = {
    status: vi.fn(async () => structuredClone(value)),
    mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {
      throw new FrequencyClientErrorV2('revision-conflict');
    }),
  };
  const view = render(<FrequencyPanelV2 client={client} />);
  await screen.findByText(/Revisão 3/);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Pausar coleta escolar' }));
  await screen.findByRole('alert');
  expect(client.mutate.mock.calls[0]?.[0]).toMatchObject({
    operation: 'set-paused',
    expectedRevision: 3,
  });
  value.settings.revision = 4;
  view.rerender(<FrequencyPanelV2 client={client} active={false} />);
  expect(screen.queryByText(/Revisão/)).toBeNull();
  view.rerender(<FrequencyPanelV2 client={client} active />);
  await screen.findByText(/Revisão 4/);
  expect(client.mutate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Salvar agenda' })).toBeNull();
});

it('pauses the school collection only after an explicit action', async () => {
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
  expect(client.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Pausar coleta escolar' }));
  await screen.findByRole('button', { name: 'Retomar coleta escolar' });
  expect(client.mutate.mock.calls[0]?.[0]).toMatchObject({
    operation: 'set-paused',
    expectedRevision: 3,
    paused: true,
    requestId: expect.any(String),
  });
});

it.each([
  {
    marks: ['X', 'J'] as ('X' | 'J' | null)[],
    choices: ['', 'X', 'J'],
    decision: 'J',
    expected: 'J',
  },
  {
    marks: ['X', null] as ('X' | 'J' | null)[],
    choices: ['', 'X', 'remove'],
    decision: 'remove',
    expected: null,
  },
])(
  'offers only conflict decisions found in the recorded evidence: $choices',
  async ({ marks, choices, decision, expected }) => {
    const value = fixture();
    value.conflicts[0]!.marks = marks;
    const client = {
      status: vi.fn(async () => structuredClone(value)),
      mutate: vi.fn<FrequencyAdminClientV2['mutate']>(async () => {}),
    };
    render(<FrequencyPanelV2 client={client} />);
    await screen.findByText('ALUNO INVENTADO');
    expect(screen.getByText(/Posição 2 · Matutino/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Conferir conflito' }));
    const select = screen.getByLabelText('Decisão');
    expect(Array.from(select.querySelectorAll('option'), (option) => option.value)).toEqual(
      choices,
    );
    await user.selectOptions(select, decision);
    await user.type(screen.getByLabelText('Motivo da decisão'), 'Conferência sintética');
    await user.click(screen.getByRole('button', { name: 'Confirmar decisão' }));
    await waitFor(() => expect(client.mutate).toHaveBeenCalledOnce());
    expect(client.mutate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'resolve-conflict',
      conflictId,
      mark: expected,
    });
  },
);

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

it('lists unrecognized Smecel students and the failure trail with the actions that resolve them', async () => {
  const value = fixture();
  value.unresolved = [
    {
      classId: 1,
      classLabel: 'TURMA INVENTADA',
      name: 'ALUNA NOVA INVENTADA',
      reason: 'not_found',
      marks: 2,
      observedAt: '2026-10-14T12:00:00Z',
    },
    {
      classId: 1,
      classLabel: 'TURMA INVENTADA',
      name: 'HOMÔNIMO INVENTADO',
      reason: 'ambiguous',
      marks: 0,
      observedAt: '2026-10-14T12:00:00Z',
    },
  ];
  value.failures = [
    {
      firstAt: '2026-10-14T11:00:00Z',
      lastAt: '2026-10-14T11:20:00Z',
      occurrences: 3,
      origin: 'collector',
      operation: 'collect',
      code: 'source-invalid',
      detail: 'observed-in-future',
      deviceId,
      classId: 1,
    },
    {
      firstAt: '2026-10-14T12:30:00Z',
      lastAt: '2026-10-14T12:30:00Z',
      occurrences: 1,
      origin: 'device-report',
      operation: 'heartbeat',
      code: 'SOURCE_LOGIN_REQUIRED',
      detail: '',
      deviceId,
      classId: null,
    },
  ];
  const openReport = vi.fn();
  render(
    <FrequencyPanelV2
      client={{ status: async () => structuredClone(value), mutate: async () => {} }}
      onOpenReport={openReport}
    />,
  );
  const unresolved = await screen.findByRole('region', { name: 'Alunos não reconhecidos' });
  expect(within(unresolved).getByText('ALUNA NOVA INVENTADA')).toBeTruthy();
  expect(within(unresolved).getByText(/Não está no Relatório · 2 registro/)).toBeTruthy();
  expect(within(unresolved).getByText(/Conferir na Conciliação/)).toBeTruthy();
  expect(
    within(unresolved).getByRole('link', { name: 'Abrir Conciliação' }).getAttribute('href'),
  ).toBe('#/painel-do-aluno?area=reconciliation');
  await userEvent
    .setup()
    .click(within(unresolved).getByRole('button', { name: 'Atualizar Relatório' }));
  expect(openReport).toHaveBeenCalledOnce();
  const failures = screen.getByRole('region', { name: 'Falhas dos últimos 7 dias' });
  expect(within(failures).getByText('Dados recusados')).toBeTruthy();
  expect(within(failures).getByText('O relógio do computador está adiantado.')).toBeTruthy();
  expect(within(failures).getByText(/3 vezes desde/)).toBeTruthy();
  expect(within(failures).getByText(/COMPUTADOR INVENTADO · TURMA INVENTADA/)).toBeTruthy();
  expect(within(failures).getByText('Smecel desconectado')).toBeTruthy();
});
