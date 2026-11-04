// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
import { StudentSettingsV1 } from '../../src/features/student-portal-admin/settings/student-settings-v1';
import { StudentPublicationV1 } from '../../src/features/student-portal-admin/publication/student-publication-v1';
import { StudentOverviewV1 } from '../../src/features/student-portal-admin/overview/student-overview-v1';
import { StudentSessionsV1 } from '../../src/features/student-portal-admin/sessions/student-sessions-v1';
import { LiveRefreshAutomaticV1Provider } from '../../src/shared/live-data/live-refresh-scope-v1';
import { createPortalAdminClientV1 } from '../../src/features/student-portal-admin/shared/admin-client-v1';
import type { AdminQueryV1 } from '../../shared/student-portal-contracts/admin-v1';
import { SYNTHETIC_ID_V1 } from '../../shared/student-portal-contracts/fixtures-v1';
import { SETTINGS_CLASS_V1, settingsFixtureV1 } from '../student-portal/ui/settings/fixtures-v1';
import {
  PUBLICATION_META_V1,
  publicationFixtureV1,
  publicationResponseV1,
} from '../student-portal/ui/publication/fixtures-v1';
import { operationsMockV1, opJsonV1 } from '../student-portal/ui/overview/fixtures-v1';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';
import { emptyReconciliationReadV1 } from '../student-portal/ui/accounts/fixtures-v1';
import userEvent from '@testing-library/user-event';
import { StudentPortalAdminPage } from '../../src/features/student-portal-admin/student-portal-admin-page';
import type { PortalFetchV1 } from '../../src/features/student-portal/shared/transport-v1';
import type { AdminReadQueryV2 } from '../../shared/student-portal-contracts/admin-read-v2';

/** A read the window's return starts in the background never shows "loading", never disables a
 * control and leaves the page as it was when the server answers the same data. */
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const base = { contractVersion: 1, requestId: SYNTHETIC_ID_V1 } as const;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
async function until(check: () => unknown) {
  for (let step = 0; step < 200 && !check(); step++) await advance(10);
  expect(check()).toBeTruthy();
}
const focusReturn = () =>
  act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
const disabledControls = () =>
  document.querySelectorAll('[disabled], [data-disabled="true"], [aria-disabled="true"]').length;
/** Server answers the test releases one by one, so the read stays in flight while it looks. */
function heldAnswers() {
  const held: Array<() => void> = [];
  let holding = false;
  return {
    hold: () => {
      holding = true;
    },
    wait: <T,>(value: T) =>
      holding
        ? new Promise<T>((resolve) => held.push(() => resolve(value)))
        : Promise.resolve(value),
    release: () => {
      holding = false;
      held.splice(0).forEach((resolve) => resolve());
    },
    pending: () => held.length,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  mockSecureJitterV1(0);
  setupOperationsDomV1();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('Configurações: the return read keeps every control enabled and the page unchanged', async () => {
  const answers = heldAnswers();
  let reads = 0;
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (!path.endsWith('/query')) throw new Error('Unexpected synthetic write');
      reads++;
      JSON.parse(String(init.body));
      return answers.wait(json({ ...base, state: 'settings', settings: settingsFixtureV1(SETTINGS_CLASS_V1) }));
    },
  });
  render(
    createElement(StudentSettingsV1, {
      client,
      scope: SETTINGS_CLASS_V1,
      canWrite: true,
      scopeLabel: 'Turma sintética · 2026',
    }),
  );
  await until(() => screen.queryByRole('heading', { name: 'Entrada no Portal' }));
  const page = document.body.innerHTML;
  const disabled = disabledControls();
  answers.hold();
  await focusReturn();
  await advance(300);
  expect(reads).toBe(2);
  expect(answers.pending()).toBe(1);
  expect(disabledControls()).toBe(disabled);
  expect(document.body.innerHTML).toBe(page);
  answers.release();
  await advance(50);
  expect(document.body.innerHTML).toBe(page);
});

it('Publicação: the return read keeps the period actions and hides the reading status', async () => {
  const answers = heldAnswers();
  const fixture = publicationFixtureV1();
  let reads = 0;
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (!path.endsWith('/query')) throw new Error('Unexpected synthetic write');
      reads++;
      const input: AdminQueryV1 = JSON.parse(String(init.body));
      return answers.wait(
        json(
          input.operation === 'publication'
            ? publicationResponseV1(fixture)
            : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings },
        ),
      );
    },
  });
  render(
    createElement(StudentPublicationV1, {
      client,
      scope: SETTINGS_CLASS_V1,
      canWrite: true,
      scopeLabel: 'Turma sintética · 2026',
    }),
  );
  await until(() => screen.queryByRole('heading', { name: '1º trimestre' }));
  const page = document.body.innerHTML;
  const disabled = disabledControls();
  answers.hold();
  await focusReturn();
  await advance(300);
  expect(reads).toBe(4);
  expect(disabledControls()).toBe(disabled);
  expect(document.body.innerHTML).toBe(page);
  answers.release();
  await advance(50);
  expect(document.body.innerHTML).toBe(page);
});

it('Sessões: a return read that fails minutes later keeps the list, then recovers without loading', async () => {
  let failing = false;
  const mock = operationsMockV1({
    query: () =>
      failing ? Promise.resolve(opJsonV1({ ...base, state: 'unavailable' }, 503)) : undefined,
  });
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <StudentSessionsV1 {...mock.props} scope={{ kind: 'school', academicYear: 2026 }} />
    </LiveRefreshAutomaticV1Provider>,
  );
  await until(() => screen.queryByRole('grid', { name: 'Sessões ativas' }));
  const list = screen.getByRole('grid', { name: 'Sessões ativas' });
  // The administrator left the window for a few minutes; the network is not back yet.
  await advance(5 * 60_000);
  failing = true;
  await focusReturn();
  await advance(300);
  expect(screen.getByRole('grid', { name: 'Sessões ativas' })).toBe(list);
  expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  expect(screen.getAllByText(/Sincronização temporariamente indisponível/)).toHaveLength(1);
  failing = false;
  let loading = false;
  for (let step = 0; step < 70; step++) {
    await advance(1_000);
    if (screen.queryByText('Consultando sessões…')) loading = true;
  }
  expect(loading).toBe(false);
  expect(screen.getByRole('grid', { name: 'Sessões ativas' })).toBe(list);
  expect(screen.queryByText(/Sincronização temporariamente indisponível/)).toBeNull();
});

it('Visão geral: a return read without network keeps the summary instead of "indisponível"', async () => {
  let offline = false;
  const mock = operationsMockV1({
    query: () => (offline ? Promise.reject(new TypeError('Synthetic network failure')) : undefined),
  });
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <StudentOverviewV1 {...mock.props} scope={{ kind: 'school', academicYear: 2026 }} scopeLabel="Escola" />
    </LiveRefreshAutomaticV1Provider>,
  );
  await until(() => screen.queryByText('Operando normalmente'));
  const summary = screen.getByText('Operando normalmente');
  await advance(5 * 60_000);
  offline = true;
  await focusReturn();
  await advance(300);
  expect(screen.getByText('Operando normalmente')).toBe(summary);
  expect(screen.queryByText(/Resumo indisponível/)).toBeNull();
  expect(screen.queryByText(/Saúde indisponível/)).toBeNull();
  expect(screen.getByText(/Sincronização temporariamente indisponível/)).toBeTruthy();
});

it('F5 brings the Painel do Aluno back on the same area, class and open record', async () => {
  vi.useRealTimers();
  const mock = operationsMockV1();
  const fetcher: PortalFetchV1 = async (path, init) => {
    if (path === '/api/me')
      return opJsonV1({
        authenticated: true,
        identityKey: 'synthetic-f5-session',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        capabilities: ['platform.settings.read'],
      });
    const input = JSON.parse(String(init.body));
    if (path === '/api/student-reconciliation/v1')
      return opJsonV1(emptyReconciliationReadV1(input.operation));
    return opJsonV1(
      input.contractVersion === 2
        ? await mock.reader.query(input as AdminReadQueryV2)
        : await mock.client.query(input as AdminQueryV1),
    );
  };
  // The class catalog is the Gradebook's own HTTP boundary.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      opJsonV1({
        contractVersion: 2,
        state: 'ready',
        operation: 'search',
        context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
        items: [
          {
            entity: { kind: 'class-group', id: 756001, label: 'SYNTHETIC OP CLASS' },
            description: null,
          },
        ],
        nextOffset: null,
      }),
    ),
  );
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
  const first = render(<StudentPortalAdminPage fetcher={fetcher} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'SYNTHETIC OP CLASS' }));
  await user.click(await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC OP STUDENT 1' }));
  await screen.findByRole('dialog', { name: 'Ficha do aluno' });
  const address = window.location.hash;
  expect(address).toContain('area=accounts');
  expect(address).toContain('turma=756001');
  expect(address).toContain('aluno=');
  // F5: a new page on the same address and tab memory. A real reload runs no unmount effects, so
  // the address the browser keeps is the one shown before it.
  first.unmount();
  window.history.replaceState(null, '', '/' + address);
  render(<StudentPortalAdminPage fetcher={fetcher} />);
  expect(await screen.findByRole('dialog', { name: 'Ficha do aluno' })).toBeTruthy();
  expect(
    (await screen.findByRole('tab', { name: 'SYNTHETIC OP CLASS', hidden: true })).getAttribute(
      'aria-selected',
    ),
  ).toBe('true');
  expect(screen.getByRole('tab', { name: 'Alunos', hidden: true }).getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(window.location.hash).toBe(address);
});
