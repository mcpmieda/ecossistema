import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminCommandV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { ShiftSummaryV1 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { EffectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { StudentPoliciesV1 } from '../../../../src/features/student-portal-admin/settings/student-policies-v1';
import {
  PolicyScopeTabsV1,
  PortalScopeTabsV1,
} from '../../../../src/features/student-portal-admin/settings/policy-scope-tabs-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { createPortalAdminReadClientV2 } from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import type { PortalFetchV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { SETTINGS_CLASS_V1, settingsFixtureV1 } from './fixtures-v1';
import { StudentPortalAdminPage } from '../../../../src/features/student-portal-admin/student-portal-admin-page';
import { customizationsUiFixture827 } from './customizations-ui-fixture-827';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const SHIFT = { kind: 'shift', academicYear: 2026, shift: 'MATUTINO' } as const;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const shifts: ShiftSummaryV1[] = [
  {
    shift: 'MATUTINO',
    ownFields: ['accessEnabled'],
    classes: [
      { classId: 900001, label: 'Turma sintética A', ownFields: ['accessEnabled'] },
      { classId: 900002, label: 'Turma sintética B', ownFields: [] },
    ],
  },
];
function readerOf(items = shifts) {
  const fetch = vi.fn<PortalFetchV1>(async () =>
    json({
      contractVersion: 2,
      requestId: SYNTHETIC_ID_V1,
      observedAt: '2026-09-28T12:00:00Z',
      state: 'shifts-read',
      items,
    }),
  );
  return { reader: createPortalAdminReadClientV2({ fetch }), fetch };
}
function settingsClient(initial: EffectiveSettingsV1) {
  let settings = structuredClone(initial);
  const writes: AdminCommandV1[] = [];
  const base = { contractVersion: 1, requestId: SYNTHETIC_ID_V1 };
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (path.endsWith('/query')) return json({ ...base, state: 'settings', settings });
      const command = JSON.parse(String(init.body)) as AdminCommandV1;
      writes.push(command);
      if (command.operation === 'settings-set')
        settings = {
          ...settings,
          version: settings.version + 1,
          value: { ...settings.value, ...command.value },
          sources: {
            ...settings.sources,
            ...Object.fromEntries(Object.keys(command.value).map((key) => [key, settings.scope])),
          },
        };
      return json({
        ...base,
        state: 'committed',
        operationId: SYNTHETIC_ID_V1,
        version: settings.version,
      });
    },
  });
  return { client, writes };
}

it('shows only available shifts with class counts and keeps them out of other areas', async () => {
  const user = userEvent.setup();
  const { reader, fetch } = readerOf();
  const onShiftChange = vi.fn();
  const props = {
    reader,
    items: [{ id: 900001, label: 'Turma sintética A' }],
    selectedId: null,
    selectedShift: null,
    onShiftChange,
    onChange: vi.fn(),
    allLabel: 'Todas as turmas',
  };
  const view = render(
    <PortalScopeTabsV1 {...props} policies={false}>
      Conteúdo
    </PortalScopeTabsV1>,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('tab', { name: /Turno/ })).toBeNull();
  view.rerender(
    <PortalScopeTabsV1 {...props} policies>
      Conteúdo
    </PortalScopeTabsV1>,
  );
  // Shifts and classes stay out of the way until asked for.
  expect(screen.queryByRole('tab', { name: /Turno/ })).toBeNull();
  await user.click(
    await screen.findByRole('button', { name: 'Configurar política para turma ou turno' }),
  );
  await user.click(await screen.findByRole('tab', { name: 'Turno Matutino · 2 turmas' }));
  expect(onShiftChange).toHaveBeenCalledWith('MATUTINO');
  expect(screen.queryByRole('tab', { name: /Noturno|Vespertino/ })).toBeNull();
});

it('returns an unavailable shift to the owner so the unsaved-draft guard can run', async () => {
  const onShiftChange = vi.fn();
  const first = readerOf();
  const props = {
    items: [],
    selectedId: null,
    selectedShift: 'MATUTINO' as const,
    onShiftChange,
    onChange: vi.fn(),
  };
  const view = render(<PolicyScopeTabsV1 {...props} reader={first.reader} />);
  await screen.findByRole('tab', { name: /Turno Matutino/ });
  const empty = readerOf([]);
  view.rerender(<PolicyScopeTabsV1 {...props} reader={empty.reader} />);
  await vi.waitFor(() => expect(onShiftChange).toHaveBeenCalledWith(null));
});

it('edits all six grade agendas at shift scope without publication commands and refreshes its warning', async () => {
  const user = userEvent.setup();
  const { client, writes } = settingsClient({ ...settingsFixtureV1(), scope: SHIFT });
  const { reader, fetch } = readerOf();
  render(
    <StudentPoliciesV1
      client={client}
      reader={reader}
      scope={SHIFT}
      canWrite
      onOpenCustomization={vi.fn()}
    />,
  );
  await screen.findByText(/1 turma tem regras suspensas pelo turno/);
  expect(screen.getByText('Este turno')).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Políticas personalizadas' })).toBeNull();
  await user.click(await screen.findByRole('tab', { name: 'Notas' }));
  expect(screen.getAllByRole('switch', { name: /^Mostrar/ })).toHaveLength(7);
  await user.click(screen.getByRole('switch', { name: 'Mostrar as notas do 1º trimestre agora' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar alteração' }),
  );
  await screen.findByText('Salvo.');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    operation: 'settings-set',
    scope: SHIFT,
    value: { calendar: { disclosure: { mode: 'agenda' } } },
  });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    fetch.mock.calls.every(
      ([, init]) => JSON.parse(String(init?.body)).operation === 'shifts-read',
    ),
  ).toBe(true);
});

it('disables class fields controlled by its shift while leaving independent fields editable', async () => {
  const user = userEvent.setup();
  const settings = settingsFixtureV1(SETTINGS_CLASS_V1);
  settings.sources.accessEnabled = SHIFT;
  settings.sources.accessSchedule = SHIFT;
  settings.sources.calendar = SHIFT;
  const { client, writes } = settingsClient(settings);
  const { reader } = readerOf();
  render(<StudentPoliciesV1 client={client} reader={reader} scope={settings.scope} canWrite />);
  await screen.findByText(/Controlado pelo turno:/);
  expect(
    (screen.getByRole('switch', { name: 'Portal aberto agora' }) as HTMLInputElement).disabled,
  ).toBe(true);
  // The dates follow the shift (owner decision 23/10/2026: marked on the school calendar, never per class).
  await user.click(screen.getByRole('tab', { name: 'Notas' }));
  expect(await screen.findByText(/Esta turma segue as datas de/u)).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Segurança' }));
  expect(
    screen.getByRole('spinbutton', { name: 'Pedir verificação após' }).hasAttribute('disabled'),
  ).toBe(false);
  expect(writes).toHaveLength(0);
});

it('selects a shift inside the full administrative page without changing the outer section', async () => {
  const mock = customizationsUiFixture827();
  const { fetch: shiftsFetch } = readerOf();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(mock.catalog)),
  );
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=policies');
  const fetcher: PortalFetchV1 = (path, init) => {
    if (path.endsWith('/query') && JSON.parse(String(init.body)).operation === 'shifts-read')
      return shiftsFetch(path, init);
    return mock.fetcher(path, init);
  };
  render(<StudentPortalAdminPage fetcher={fetcher} />);
  const user = userEvent.setup();
  await screen.findByRole('switch', { name: 'Portal aberto agora' });
  await user.click(
    await screen.findByRole('button', { name: 'Configurar política para turma ou turno' }),
  );
  await user.click(await screen.findByRole('tab', { name: 'Turno Matutino · 2 turmas' }));
  await screen.findByText('Este turno');
  expect(
    screen.getByRole('tab', { name: 'Turno Matutino · 2 turmas' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(screen.getByRole('tab', { name: 'Políticas' }).getAttribute('aria-selected')).toBe('true');
}, 30_000);

it('preserves unsaved access and grade agendas when saving another field', async () => {
  const user = userEvent.setup();
  const { client, writes } = settingsClient({ ...settingsFixtureV1(), scope: SHIFT });
  const { reader } = readerOf();
  render(<StudentPoliciesV1 client={client} reader={reader} scope={SHIFT} canWrite />);
  await user.click(await screen.findByRole('button', { name: 'Novo agendamento' }));
  await user.click(screen.getByRole('tab', { name: 'Notas' }));
  const firstPeriod = () =>
    screen
      .getByRole('heading', { name: '1º trimestre' })
      .closest('section, article, .pa-grade-card') as HTMLElement;
  await user.click(within(firstPeriod()).getByRole('button', { name: 'Novo agendamento' }));
  await user.click(screen.getByRole('tab', { name: 'Segurança' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Pedir verificação após' }), {
    target: { value: '4' },
  });
  await user.click(screen.getByRole('button', { name: 'Revisar Segurança do acesso' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar alteração' }),
  );
  await screen.findByText('Salvo.');
  expect(
    within(document.querySelector('.pa-settings-card--access') as HTMLElement).getByRole('button', {
      name: 'Remover agendamento 1',
    }),
  ).toBeTruthy();
  expect(within(firstPeriod()).getByRole('button', { name: 'Remover agendamento 1' })).toBeTruthy();
  expect(writes).toHaveLength(1);
});

it('preserves an unsaved grade agenda when saving another period', async () => {
  const user = userEvent.setup();
  const { client, writes } = settingsClient({ ...settingsFixtureV1(), scope: SHIFT });
  const { reader } = readerOf();
  render(<StudentPoliciesV1 client={client} reader={reader} scope={SHIFT} canWrite />);
  await user.click(await screen.findByRole('tab', { name: 'Notas' }));
  const firstPeriod = () =>
    screen.getByRole('heading', { name: '1º trimestre' }).closest('.pa-grade-card') as HTMLElement;
  await user.click(within(firstPeriod()).getByRole('button', { name: 'Novo agendamento' }));
  await user.click(screen.getByRole('switch', { name: 'Mostrar as notas do 2º trimestre agora' }));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmar alteração' }),
  );
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(firstPeriod()).getByRole('button', { name: 'Remover agendamento 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Desfazer edições' })).toBeTruthy();
});
