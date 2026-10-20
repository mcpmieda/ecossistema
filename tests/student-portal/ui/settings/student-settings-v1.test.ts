import { enterDateV1 } from './date-input-v1';
import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentSettingsV1 } from '../../../../src/features/student-portal-admin/settings/student-settings-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import type {
  AdminCommandV1,
  AdminQueryV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type { EffectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import { SETTINGS_CLASS_V1, SETTINGS_SCHOOL_V1, settingsFixtureV1 } from './fixtures-v1';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const base = { contractVersion: 1, requestId: SYNTHETIC_ID_V1 } as const;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup(
  initial = settingsFixtureV1(SETTINGS_CLASS_V1),
  write?: (input: AdminCommandV1) => Promise<Response>,
) {
  let current = initial;
  const writes: AdminCommandV1[] = [],
    queries: AdminQueryV1[] = [];
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (path.endsWith('/query')) {
        queries.push(JSON.parse(String(init.body)));
        return json({ ...base, state: 'settings', settings: current });
      }
      const input: AdminCommandV1 = JSON.parse(String(init.body));
      writes.push(input);
      if (write) return write(input);
      current = { ...current, version: current.version + 1 };
      return json({
        ...base,
        state: 'committed',
        operationId: SYNTHETIC_ID_V1,
        version: current.version,
      });
    },
  });
  const props = {
    client,
    scope: initial.scope,
    canWrite: true,
    scopeLabel: 'Turma sintética · 2026',
  };
  return {
    props,
    writes,
    queries,
    current: (value: EffectiveSettingsV1) => {
      current = value;
    },
  };
}
async function ready() {
  await screen.findByRole('heading', { name: 'Entrada no Portal' });
}
describe('administrative settings UI', () => {
  it('keeps the Notas agendas untouched when the Calendário is saved', async () => {
    const plan = (at: string) => ({ enabled: false, schedule: [{ at, action: 'open' as const }] });
    const fixture = settingsFixtureV1();
    fixture.value.calendar = {
      ...fixture.value.calendar,
      finalAgenda: plan('2026-12-20T13:00:00Z'),
      disclosure: {
        mode: 'agenda',
        periods: {
          T1: plan('2026-10-01T13:00:00Z'),
          T2: plan('2026-11-01T13:00:00Z'),
          T3: { enabled: false, schedule: [] },
          REC1: { enabled: false, schedule: [] },
          REC2: { enabled: false, schedule: [] },
          REC3: { enabled: false, schedule: [] },
        },
      },
    };
    const user = userEvent.setup({ delay: null }),
      mock = setup(fixture);
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await enterDateV1(user, 'Início do ano e 1º trimestre', '2026-02-23T08:00');
    await user.click(screen.getByRole('button', { name: 'Revisar Datas' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(1));
    expect(mock.writes[0]).toMatchObject({
      value: {
        calendar: {
          yearStartsAt: '2026-02-23T11:00:00Z',
          disclosure: fixture.value.calendar.disclosure,
          finalAgenda: fixture.value.calendar.finalAgenda,
        },
      },
    });
  }, 20_000);
  it('removes protected settings and the review when write authorization expires', async () => {
    const user = userEvent.setup(),
      mock = setup(undefined, async () => json({ ...base, state: 'unauthenticated' }, 401));
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Portal aberto agora' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await screen.findByText('Sessão expirada. Entre novamente no ADM.');
    expect(screen.queryByRole('heading', { name: 'Entrada no Portal' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Repetir a mesma operação' })).toBeNull();
  });
  it('shows inherited origin and creates the class access only after review and confirmation', async () => {
    const inherited = settingsFixtureV1(SETTINGS_CLASS_V1);
    // Switch on, but no Calendário access window: the inherited plan is closed right now.
    inherited.value.accessEnabled = true;
    const user = userEvent.setup(),
      mock = setup(inherited);
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    expect(screen.getAllByText('Padrão da escola')).toHaveLength(10);
    await user.click(screen.getByRole('switch', { name: 'Portal aberto agora' }));
    expect(mock.writes).toHaveLength(0);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Aberto agora.')).toBeTruthy();
    expect(within(dialog).getByText('Os alunos poderão entrar assim que você confirmar.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar alteração' }));
    await screen.findByText('Salvo.');
    expect(mock.writes[0]).toMatchObject({
      operation: 'settings-set',
      scope: SETTINGS_CLASS_V1,
      expectedVersion: 7,
      value: { accessEnabled: true, accessSchedule: [] },
      acknowledgeImmediateEffect: true,
    });
  });
  it('removes only a chosen owned override and never offers inheritance at school scope', async () => {
    const user = userEvent.setup(),
      fixture = settingsFixtureV1(SETTINGS_CLASS_V1);
    fixture.sources.accessEnabled = SETTINGS_CLASS_V1;
    const mock = setup(fixture);
    const view = render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Usar padrão de Entrada no Portal' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Usar padrão' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(1));
    expect(mock.writes[0]).toMatchObject({
      operation: 'settings-inherit',
      // The switch and its schedules return to the default together.
      keys: ['accessEnabled', 'accessSchedule'],
      expectedVersion: 7,
    });
    expect(mock.writes[0]).not.toHaveProperty('value');
    const school = setup(settingsFixtureV1());
    view.rerender(createElement(StudentSettingsV1, school.props));
    await ready();
    expect(screen.queryByRole('button', { name: /Usar padrão/u })).toBeNull();
  });
  it('preserves an explicitly empty allowed-period list', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    const group = screen.getByRole('group', { name: 'Notas disponíveis' });
    for (const checkbox of within(group).getAllByRole('checkbox')) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Revisar Períodos permitidos' }));
    expect(within(screen.getByRole('dialog')).getByText('Nenhum período')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(1));
    expect(mock.writes[0]).toMatchObject({
      operation: 'settings-set',
      value: { allowedPeriods: [] },
    });
  });
  it('reviews a past calendar change with a full atomic payload, preserving nulls', async () => {
    const user = userEvent.setup(),
      mock = setup();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T12:00:00Z'));
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await enterDateV1(user, 'Início do ano e 1º trimestre', '2026-02-23T08:00');
    await user.click(screen.getByRole('button', { name: 'Revisar Datas' }));
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Há mudança ou remoção de datas que já chegaram:',
      ),
    ).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(1));
    expect(mock.writes[0]).toMatchObject({
      value: {
        calendar: {
          timezone: 'America/Sao_Paulo',
          yearStartsAt: '2026-02-23T11:00:00Z',
          t1EndsAt: null,
        },
      },
    });
  }, 20_000);
  it('rejects chronological and risk-limit errors without dispatching a command', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await enterDateV1(user, 'Início do ano e 1º trimestre', '2026-03-01T00:00');
    await enterDateV1(user, 'Encerramento do 1º trimestre', '2026-02-01T00:00');
    await user.click(screen.getByRole('button', { name: 'Revisar Datas' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pedir verificação após' }), {
      target: { value: '10' },
    });
    await user.click(screen.getByRole('button', { name: 'Revisar Segurança do acesso' }));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(mock.writes).toHaveLength(0);
  }, 20_000);
  it('exposes a conflict outside the modal and requires explicit reload rather than overwriting the version', async () => {
    const user = userEvent.setup(),
      mock = setup(undefined, async () => json({ ...base, state: 'conflict' }, 409));
    render(createElement(StudentSettingsV1, mock.props));
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Portal aberto agora' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await screen.findByText(
      'A configuração mudou em outra operação. Recarregue e revise antes de salvar novamente.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.writes).toHaveLength(1);
    expect(
      (screen.getByRole('switch', { name: 'Portal aberto agora' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const next = settingsFixtureV1(SETTINGS_CLASS_V1);
    next.version = 8;
    mock.current(next);
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Portal aberto agora' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(2));
    expect(mock.writes.map((command) => command.expectedVersion)).toEqual([7, 8]);
    expect(mock.writes[0]!.idempotencyKey).not.toBe(mock.writes[1]!.idempotencyKey);
  });
  it('never shows the previous scope while a different scope is loading, nor applies its late response', async () => {
    let resolve!: (value: Response) => void;
    const client = createPortalAdminClientV1({
      fetch: async (_path, init) => {
        const query: AdminQueryV1 = JSON.parse(String(init.body));
        if (query.scope.kind === 'class')
          return new Promise<Response>((done) => {
            resolve = done;
          });
        return json({ ...base, state: 'settings', settings: settingsFixtureV1() });
      },
    });
    const view = render(
      createElement(StudentSettingsV1, { client, scope: SETTINGS_CLASS_V1, canWrite: true }),
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    view.rerender(
      createElement(StudentSettingsV1, { client, scope: SETTINGS_SCHOOL_V1, canWrite: true }),
    );
    await ready();
    await act(async () => {
      resolve(json({ ...base, state: 'settings', settings: settingsFixtureV1(SETTINGS_CLASS_V1) }));
    });
    expect(screen.getByText('Escola · 2026')).toBeTruthy();
    expect(screen.queryByText('Padrão da escola')).toBeNull();
    expect(screen.queryByText('Turma 900001 · 2026')).toBeNull();
  });
  it('has no editing or dangerous preview for a read-only operator, and no invented settings on failure', async () => {
    const mock = setup(settingsFixtureV1());
    const view = render(createElement(StudentSettingsV1, { ...mock.props, canWrite: false }));
    await ready();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preparar prévia de encerramento' })).toBeNull();
    const client = createPortalAdminClientV1({
      fetch: async () => json({ ...base, state: 'unavailable' }, 503),
    });
    view.rerender(
      createElement(StudentSettingsV1, { client, scope: SETTINGS_CLASS_V1, canWrite: true }),
    );
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: 'Entrada no Portal' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('keeps the controller usable after React StrictMode setup/cleanup replay', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StrictMode, null, createElement(StudentSettingsV1, mock.props)));
    await ready();
    await user.click(screen.getByRole('switch', { name: 'Portal aberto agora' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(1));
    await screen.findByText('Salvo.');
  });
});
