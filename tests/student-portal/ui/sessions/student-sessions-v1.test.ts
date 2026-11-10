import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentSessionsV1 } from '../../../../src/features/student-portal-admin/sessions/student-sessions-v1';
import {
  operationsMockV1,
  opJsonV1,
  OP_META_V1,
  OP_CLASS_V1,
  OP_ACCOUNT_V1,
} from '../overview/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { controlledContinuousObserverV1 } from '../continuous-observer-v1';
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function confirm() {
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Encerrar sessões',
    }),
  );
}
describe('administrative sessions interface', () => {
  it('loads history only when visible, retains it while hidden and invalidates after revocation', async () => {
    const observers = new Set<{
      target: Element | null;
      callback: IntersectionObserverCallback;
    }>();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        target: Element | null = null;
        constructor(readonly callback: IntersectionObserverCallback) {
          observers.add(this);
        }
        observe(target: Element) {
          this.target = target;
        }
        unobserve() {
          this.target = null;
        }
        disconnect() {
          observers.delete(this);
        }
      },
    );
    const showHistory = (isIntersecting: boolean) => {
      const observer = [...observers].find((item) => item.target?.matches('.pa-session-history'));
      if (!observer?.target) throw new Error('Missing history visibility observer');
      observer.callback(
        [{ target: observer.target, isIntersecting } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    };
    const mock = operationsMockV1();
    const historyQueries = () =>
      mock.queries.filter((q) => q.operation === 'sessions-read' && q.sessionView === 'history');
    render(createElement(StudentSessionsV1, mock.props));
    await screen.findByRole('grid', { name: 'Sessões ativas' });
    expect(screen.getByRole('heading', { name: 'Histórico de sessões' })).toBeTruthy();
    expect(historyQueries()).toHaveLength(0);
    await act(async () => showHistory(true));
    await screen.findByRole('grid', { name: 'Histórico de sessões' });
    expect(historyQueries()).toHaveLength(1);
    await act(async () => showHistory(false));
    expect(screen.getByRole('grid', { name: 'Histórico de sessões' })).toBeTruthy();
    await act(async () => showHistory(true));
    expect(historyQueries()).toHaveLength(1);
    await act(async () => showHistory(false));
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar todas do aluno' }));
    await confirm();
    await screen.findByText('Sessões encerradas.');
    await waitFor(() =>
      expect(screen.queryByRole('grid', { name: 'Histórico de sessões' })).toBeNull(),
    );
    expect(historyQueries()).toHaveLength(1);
    await act(async () => showHistory(true));
    await screen.findByRole('grid', { name: 'Histórico de sessões' });
    expect(historyQueries()).toHaveLength(2);
    expect(mock.writes[0]).toMatchObject({ expectedVersion: 11, scope: OP_ACCOUNT_V1 });
  });
  it.each(['individual', 'account', 'class'] as const)(
    'reviews and commits %s with the correct fresh scope CAS',
    async (mode) => {
      const mock = operationsMockV1();
      render(
        createElement(StudentSessionsV1, {
          ...mock.props,
          scope: mode === 'class' ? OP_CLASS_V1 : OP_ACCOUNT_V1,
        }),
      );
      await screen.findByRole('grid', { name: 'Sessões ativas' });
      for (const label of ['Ativa', 'Expirou', 'Encerrada', 'Sem acesso'])
        expect(await screen.findByText(label)).toBeTruthy();
      const button =
        mode === 'individual'
          ? screen.getAllByRole('button', { name: /Encerrar sessão de/ })[0]!
          : screen.getByRole('button', {
              name: mode === 'class' ? 'Encerrar sessões da turma' : 'Encerrar todas do aluno',
            });
      fireEvent.click(button);
      const dialog = await screen.findByRole('alertdialog');
      expect(mock.writes).toHaveLength(0);
      expect(within(dialog).getByText(/Senha e QR permanecem/)).toBeTruthy();
      await confirm();
      await screen.findByText(/Sessões encerradas/);
      await screen.findByRole('region', { name: 'Sessões ativas' });
      expect(mock.writes[0]).toMatchObject({
        operation: 'sessions-revoke',
        scope: mode === 'class' ? OP_CLASS_V1 : OP_ACCOUNT_V1,
        expectedVersion: mode === 'class' ? 756 : 11,
        confirmed: true,
      });
      expect(mock.writes[0] && 'sessionId' in mock.writes[0]).toBe(mode === 'individual');
      expect(mock.sessions.filter((s) => !s.revokedAt)).toHaveLength(mode === 'individual' ? 2 : 0);
    },
  );
  it('Escape cancels without mutation and restores focus', async () => {
    const user = userEvent.setup(),
      mock = operationsMockV1();
    render(createElement(StudentSessionsV1, mock.props));
    const button = await screen.findByRole('button', { name: 'Encerrar todas do aluno' });
    await user.click(button);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(mock.writes).toHaveLength(0);
  });
  it('uses account CAS from a class row and removes protected content after 401', async () => {
    let denied = false;
    const mock = operationsMockV1({
      write: () => Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unauthenticated' }, 401)),
      query: () =>
        denied
          ? Promise.resolve(opJsonV1({ ...OP_META_V1, state: 'unauthenticated' }, 401))
          : undefined,
    });
    render(createElement(StudentSessionsV1, { ...mock.props, scope: OP_CLASS_V1 }));
    fireEvent.click((await screen.findAllByRole('button', { name: /Encerrar sessão de/ }))[0]!);
    await screen.findByRole('alertdialog');
    denied = true;
    await confirm();
    await screen.findByText('Sessão administrativa expirada. Entre novamente.');
    expect(mock.writes[0]).toMatchObject({ scope: OP_ACCOUNT_V1, expectedVersion: 11 });
    expect(screen.queryAllByRole('grid')[0] ?? null).toBeNull();
    expect(document.body.textContent).not.toContain('SYNTHETIC OP STUDENT');
  });
  it('does not offer school-wide revocation, disables writes for read-only and pages beyond 100', async () => {
    const observer = controlledContinuousObserverV1();
    const mock = operationsMockV1({ count: 420 });
    render(
      createElement(
        StrictMode,
        null,
        createElement(StudentSessionsV1, {
          ...mock.props,
          scope: { kind: 'school', academicYear: 2026 },
          canWrite: false,
        }),
      ),
    );
    const activeGrid = await screen.findByLabelText('Sessões ativas', {
      selector: '[role="grid"]',
    });
    const revokeButtons = () =>
      Array.from(
        activeGrid.querySelectorAll<HTMLButtonElement>('button[aria-label^="Encerrar sessão de"]'),
      );
    expect(screen.queryByText('Encerrar sessões da turma', { selector: 'button' })).toBeNull();
    await waitFor(() => expect(revokeButtons()).toHaveLength(100));
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    await act(async () => observer.intersect());
    await waitFor(() => expect(revokeButtons()).toHaveLength(105));
    expect(revokeButtons().every((button) => button.disabled)).toBe(true);
    expect(screen.queryByText('Próxima', { selector: 'button' })).toBeNull();
    expect(mock.queries.some((q) => q.operation === 'sessions-read' && q.page.cursor)).toBe(true);
    expect(mock.writes).toHaveLength(0);
  }, 20_000);
});
