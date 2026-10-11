import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentAccountsV1 } from '../../../../src/features/student-portal-admin/accounts/student-accounts-v1';
import { SYNTHETIC_QR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { clearPhotoMemoryV1 } from '../../../../src/features/student-photos/photo-memory-v1';
import {
  PHOTO_AVATAR_BATCH_PATH_V1,
  PHOTO_AVATAR_BATCH_TYPE_V1,
  encodePhotoAvatarBatchV1,
} from '../../../../shared/student-photos/avatar-batch-v1';
import { controlledContinuousObserverV1 } from '../continuous-observer-v1';
import type { ReconciliationClientV1 } from '../../../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import {
  accountsMockV1,
  accountFixtureV1,
  accountJsonV1,
  accountPageV1,
  emptyReconciliationReadV1,
  ACCOUNT_META_V1,
  ACCOUNT_CLASS_V1,
} from './fixtures-v1';
function setupAccountsDomV1() {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
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
}
beforeEach(setupAccountsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const ready = () => screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' });
const detail = () => screen.findByRole('button', { name: 'Bloquear acesso' });
describe('account list and detail', () => {
  it('restores a valid account hash through the reconciliation wrapper and clears it when leaving the list', async () => {
    const mock = accountsMockV1({ count: 1 });
    const accountId = mock.accounts[0]!.accountId;
    window.history.replaceState(null, '', `/#/painel-do-aluno?area=accounts&aluno=${accountId}`);
    const request = vi.fn<ReconciliationClientV1['request']>(async (input) =>
      emptyReconciliationReadV1(input.operation),
    );
    render(createElement(StudentAccountsV1, { ...mock.props, reconciliation: { request } }));
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog', { name: 'Ficha do aluno' });
    expect(await within(drawer).findByText('SYNTHETIC ACCOUNT 001')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    await user.click(within(drawer).getByRole('button', { name: 'Fechar ficha' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ficha do aluno' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Alunos' }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('aluno')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Acessos e QR' }));
    await ready();
    expect(screen.queryByRole('dialog', { name: 'Ficha do aluno' })).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it.each(['', '&aluno=invalid-account'])('starts reconciliation without a valid account hash: %s', async (suffix) => {
    window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts' + suffix);
    const mock = accountsMockV1({ count: 1 });
    const request = vi.fn<ReconciliationClientV1['request']>(async (input) =>
      emptyReconciliationReadV1(input.operation),
    );
    render(createElement(StudentAccountsV1, { ...mock.props, reconciliation: { request } }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' })).toBeNull();
    expect(mock.queries).toHaveLength(0);
  });
  it('offers bulk operations only for a selected class and keeps the read-only preview inert', async () => {
    const mock = accountsMockV1();
    render(createElement(StudentAccountsV1, { ...mock.props, canWrite: false }));
    await ready();
    expect(screen.queryByRole('heading', { name: 'Operações em massa' })).toBeNull();
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'SYNTHETIC CLASS A' }));
    expect(await screen.findByRole('heading', { name: 'Operações em massa' })).toBeTruthy();
    const controls = document.querySelector('.pa-account-controls-card');
    expect(controls?.contains(screen.getByRole('searchbox', { name: 'Buscar aluno' }))).toBe(true);
    expect(controls?.contains(screen.getByRole('region', { name: 'QR code' }))).toBe(true);
    expect(controls?.contains(screen.getByRole('heading', { name: 'Operações em massa' }))).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Preparar prévia' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Mudar QR' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mock.writes).toHaveLength(0);
  });
  it('discards the QR selection when the search changes and stays empty on return', async () => {
    const mock = accountsMockV1();
    render(createElement(StudentAccountsV1, { ...mock.props, scope: ACCOUNT_CLASS_V1 }));
    await ready();
    expect(screen.getByRole('region', { name: 'QR code' })).toBeTruthy();
    expect(screen.getAllByRole('grid', { name: 'Contas do Portal' })).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })[0]!);
    expect(screen.getByText('1 selecionados')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Buscar aluno' }), '002');
    await screen.findByText('SYNTHETIC ACCOUNT 002');
    expect(await screen.findByText(/^Lista inteira · \d+$/)).toBeTruthy();
    await user.clear(screen.getByRole('searchbox', { name: 'Buscar aluno' }));
    await ready();
    expect(screen.getByText(/^Lista inteira · \d+$/)).toBeTruthy();
    expect(
      screen.getAllByRole<HTMLInputElement>('checkbox', { name: /^Selecionar para QR/ }).every(
        (checkbox) => !checkbox.checked,
      ),
    ).toBe(true);
    expect(mock.writes).toHaveLength(0);
  });
  it('shows official names and distinct states with a complete empty-class catalog', async () => {
    const mock = accountsMockV1();
    mock.accounts[1]!.state = 'pending-activation';
    mock.accounts[2]!.linkClosed = true;
    render(createElement(StudentAccountsV1, mock.props));
    await ready();
    expect(
      within(screen.getByRole('region', { name: /Tabela de contas/ })).getByText('Primeiro acesso'),
    ).toBeTruthy();
    expect(screen.getByText('Encerrada')).toBeTruthy();
    expect(screen.getAllByText('Desconhecido nos últimos 12 meses')).toHaveLength(3);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'SYNTHETIC EMPTY CLASS' }));
    expect(await screen.findByText('Nenhuma conta encontrada neste filtro.')).toBeTruthy();
    // A class is a view of the school collection already read, with that class's own tools.
    expect(mock.queries.filter((query) => query.operation === 'accounts-read')).toEqual([
      expect.objectContaining({ scope: { kind: 'school', academicYear: 2026 } }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Operações em massa' })).toBeTruthy();
    await user.click(await screen.findByRole('tab', { name: 'SYNTHETIC CLASS A' }));
    await ready();
    expect(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })).toHaveLength(3);
    expect(mock.queries.filter((query) => query.operation === 'accounts-read')).toHaveLength(1);
    expect(mock.writes).toHaveLength(0);
  });
  it('loads 400 accounts per request without speculative pages or seal reads', async () => {
    const observer = controlledContinuousObserverV1();
    const mock = accountsMockV1({ count: 405 });
    render(createElement(StudentAccountsV1, mock.props));
    const row = (number: string) =>
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="Abrir ficha de SYNTHETIC ACCOUNT ${number}"]`,
      );
    // One request brings the page; only the first rows mount and the scroll reveals the others.
    await waitFor(() => expect(row('060')).not.toBeNull());
    const first = row('001');
    expect(row('061')).toBeNull();
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0]?.page.limit).toBe(400);
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    expect(screen.queryByText('Próxima página')).toBeNull();
    const scroll = screen.getByRole('region', { name: /Tabela de contas/ });
    scroll.scrollTop = 137;
    await act(async () => observer.intersect());
    await waitFor(() => expect(row('180')).not.toBeNull());
    expect(row('181')).toBeNull();
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    await act(async () => observer.intersect());
    await waitFor(() => expect(row('400')).not.toBeNull());
    await waitFor(() => expect(observer.isObserving()).toBe(true));
    expect(row('405')).toBeNull();
    expect(mock.queries).toHaveLength(1);
    await act(async () => observer.intersect());
    await waitFor(() => expect(row('405')).not.toBeNull());
    expect(row('001')).toBe(first);
    expect(scroll.scrollTop).toBe(137);
    expect(mock.queries.some((query) => query.page.cursor)).toBe(true);
    expect(mock.writes).toHaveLength(0);
  }, 60_000);
  describe('with an accumulated 105-account list', () => {
    let mock: ReturnType<typeof accountsMockV1>;
    let firstName: HTMLElement;
    let lastName: HTMLElement;
    // Fixture preparation and interaction have independent bounded phases. This suite
    // verifies continuity and accessibility, not a combined production latency SLA.
    beforeAll(async () => {
      setupAccountsDomV1();
      mock = accountsMockV1({ count: 105 });
      render(createElement(StudentAccountsV1, { ...mock.props, scope: ACCOUNT_CLASS_V1 }));
      const button = (name: string) =>
        document.querySelector<HTMLButtonElement>(`button[aria-label="Abrir ficha de ${name}"]`);
      await waitFor(() => expect(button('SYNTHETIC ACCOUNT 001')).not.toBeNull());
      firstName = within(button('SYNTHETIC ACCOUNT 001')!).getByText('SYNTHETIC ACCOUNT 001');
      await screen.findByText('105 alunos');
      await waitFor(() => expect(button('SYNTHETIC ACCOUNT 105')).not.toBeNull());
      lastName = within(button('SYNTHETIC ACCOUNT 105')!).getByText('SYNTHETIC ACCOUNT 105');
    }, 30_000);
    it('opens a right-side student drawer by name and preserves the accumulated list when closing', async () => {
      const trigger = firstName.closest('button')!;
      expect(trigger.getAttribute('aria-label')).toBe('Abrir ficha de SYNTHETIC ACCOUNT 001');
      fireEvent.click(trigger);
      await waitFor(() => expect(document.querySelector('.pa-student-drawer')).not.toBeNull());
      const drawer = document.querySelector<HTMLElement>('.pa-student-drawer')!;
      expect(drawer.getAttribute('aria-label')).toBe('Ficha do aluno');
      expect(drawer.getAttribute('role')).toBe('dialog');
      await within(drawer).findByRole('button', { name: 'Bloquear acesso' });
      expect(drawer.closest('[data-placement="right"]')).toBeTruthy();
      expect(within(drawer).getByText('SYNTHETIC ACCOUNT 001')).toBeTruthy();
      expect(document.activeElement?.textContent).toBe('Ficha do aluno');
      expect(screen.queryByText('Próxima página')).toBeNull();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Fechar ficha' }));
      await waitFor(() => expect(drawer.isConnected).toBe(false));
      expect(lastName.isConnected).toBe(true);
      expect(lastName.closest('button')!.getAttribute('aria-label')).toBe(
        'Abrir ficha de SYNTHETIC ACCOUNT 105',
      );
      expect(screen.getByText('SYNTHETIC ACCOUNT 001').closest('button')).toBe(trigger);
      expect(mock.queries.some((q) => q.page.cursor && q.scope.kind === 'class')).toBe(false);
      expect(mock.writes).toHaveLength(0);
    }, 40_000);
  });
  it('shows what the list knows at the tap and offers actions only after the record reads the account', async () => {
    let answer = () => {};
    const mock = accountsMockV1({
      query: (input) =>
        input.operation === 'accounts-read' && input.scope.kind === 'account'
          ? new Promise<Response>((resolve) => {
              // Meanwhile the account was blocked in another session.
              answer = () =>
                resolve(accountJsonV1(accountPageV1([{ ...accountFixtureV1(1), blocked: true, version: 12 }])));
            })
          : undefined,
    });
    render(createElement(StudentAccountsV1, mock.props));
    fireEvent.click(await ready());
    await waitFor(() => expect(document.querySelector('.pa-student-drawer')).not.toBeNull());
    const drawer = within(document.querySelector<HTMLElement>('.pa-student-drawer')!);
    // The record's own read has not answered: identity, state and facts come from the list.
    expect(drawer.getByText('SYNTHETIC ACCOUNT 001')).toBeTruthy();
    expect(drawer.getByText('Sessões ativas')).toBeTruthy();
    expect(drawer.queryByText('Carregando aluno…')).toBeNull();
    expect(drawer.queryByText('Bloqueado')).toBeNull();
    // Nothing can be decided on the list row.
    expect(
      drawer.queryByRole('button', {
        name: /^(Bloquear acesso|Desbloquear acesso|Redefinir senha|Redefinir conta|Mudar QR)$/,
      }),
    ).toBeNull();
    expect(drawer.queryByRole('tablist')).toBeNull();
    answer();
    expect(await drawer.findByRole('button', { name: 'Desbloquear acesso' })).toBeTruthy();
    expect(drawer.getByText('Bloqueado')).toBeTruthy();
    await userEvent.setup().click(drawer.getByRole('button', { name: 'Desbloquear acesso' }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await waitFor(() => expect(mock.writes).toHaveLength(1));
    // The decision carries the version the record read, not the one the list had (9).
    expect(mock.writes[0]).toMatchObject({ operation: 'block', blocked: false, expectedVersion: 12 });
  });
  it('cancels a review and uses fresh detail CAS rather than the stale list row', async () => {
    const mock = accountsMockV1();
    render(createElement(StudentAccountsV1, mock.props));
    await ready();
    mock.accounts[0]!.version = 12;
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    await user.click(screen.getByRole('button', { name: 'Redefinir senha' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/mesmo QR e o ano de nascimento/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mock.writes).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Redefinir senha' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await screen.findByText(/Alteração salva/);
    expect(mock.writes[0]).toMatchObject({ operation: 'password-reset', expectedVersion: 12 });
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Ficha da conta')).getByText('Redefinição pendente'),
      ).toBeTruthy(),
    );
  });
  it('requires a new review after conflict and does not infer success from optimism', async () => {
    const mock = accountsMockV1();
    render(createElement(StudentAccountsV1, mock.props));
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    await user.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    mock.accounts[0]!.version = 14;
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await screen.findByText('A conta mudou. Recarregue e revise uma nova ação.');
    expect(screen.queryByText(/Alteração salva/)).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Recarregar ficha' }));
    await user.click(await screen.findByRole('button', { name: 'Bloquear acesso' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await screen.findByText(/Alteração salva/);
    expect(mock.writes.map((item) => item.expectedVersion)).toEqual([9, 14]);
    expect(mock.writes[0]!.idempotencyKey).not.toBe(mock.writes[1]!.idempotencyKey);
  });
  it('keeps account reset distinct from QR regeneration and never renders the credential', async () => {
    const mock = accountsMockV1(),
      onQr = vi.fn();
    render(createElement(StudentAccountsV1, { ...mock.props, onQr }));
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    await user.click(screen.getByRole('button', { name: 'Redefinir conta' }));
    expect(
      within(screen.getByRole('alertdialog')).getByText(
        /não encerra o vínculo nem libera o reset anual/,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await user.click(await screen.findByRole('button', { name: 'Mudar QR' }));
    expect(within(screen.getByRole('alertdialog')).getByText(/Preserva a senha/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await waitFor(() => expect(onQr).toHaveBeenCalledOnce());
    expect(document.body.innerHTML).not.toContain(SYNTHETIC_QR_V1);
    expect(mock.writes[0]?.operation).toBe('qr-regenerate');
  });
  it('disables actions for a closed Portal account despite an existing eligible academic link', async () => {
    const mock = accountsMockV1();
    mock.accounts[0]!.linkClosed = true;
    render(createElement(StudentAccountsV1, mock.props));
    await userEvent.setup().click(await ready());
    expect((await detail()).hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('Encerrada')).toHaveLength(2);
    expect(mock.writes).toHaveLength(0);
  });
  it('blocks destructive recovery actions when the backend says recovery is not ready', async () => {
    const mock = accountsMockV1();
    mock.accounts[0]!.firstAccess.recoveryReady = false;
    render(createElement(StudentAccountsV1, mock.props));
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    expect(
      (screen.getByRole('button', { name: 'Redefinir senha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Redefinir conta' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Mudar QR' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(mock.writes).toHaveLength(0);
  });
  it.each(['identity', 'capability'] as const)(
    'clears selected data and open confirmation when %s changes',
    async (changed) => {
      window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
      const mock = accountsMockV1();
      const view = render(createElement(StudentAccountsV1, mock.props));
      const user = userEvent.setup();
      await user.click(await ready());
      await detail();
      await user.click(screen.getByRole('button', { name: 'Redefinir conta' }));
      const previousReads = mock.queries.length;
      view.rerender(
        createElement(StudentAccountsV1, {
          ...mock.props,
          identityKey: changed === 'identity' ? 'another-synthetic-admin' : mock.props.identityKey,
          canWrite: changed === 'capability' ? false : mock.props.canWrite,
        }),
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Bloquear acesso' })).toBeNull();
      const open = await ready();
      expect(
        mock.queries.slice(previousReads).filter((query) => query.scope.kind === 'account'),
      ).toHaveLength(0);
      expect(new URLSearchParams(window.location.hash.split('?')[1]).get('aluno')).toBeNull();
      await user.click(open);
      expect((await detail()).hasAttribute('disabled')).toBe(changed === 'capability');
      expect(mock.writes).toHaveLength(0);
    },
  );
  it('clears the list and the detail when a command loses administrative authorization', async () => {
    const mock = accountsMockV1({
      write: async () => accountJsonV1({ ...ACCOUNT_META_V1, state: 'unauthenticated' }, 401),
    });
    render(createElement(StudentAccountsV1, mock.props));
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    await user.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await screen.findByText('Sessão administrativa expirada. Entre novamente.');
    expect(screen.queryByText('SYNTHETIC ACCOUNT 001')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bloquear acesso' })).toBeNull();
    expect(mock.writes).toHaveLength(1);
  });
  it('applies state and manual-block filters without selecting rows by their position', async () => {
    const mock = accountsMockV1();
    mock.accounts[1]!.state = 'pending-activation';
    mock.accounts[1]!.blocked = true;
    render(createElement(StudentAccountsV1, mock.props));
    await ready();
    const user = userEvent.setup();
    await user.click(
      within(screen.getByRole('grid', { name: 'Situação' })).getByRole('row', {
        name: 'Primeiro acesso',
      }),
    );
    await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 002' });
    await user.click(
      within(screen.getByRole('grid', { name: 'Bloqueio' })).getByRole('row', {
        name: 'Bloqueadas',
      }),
    );
    await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 002' });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' }),
      ).toBeNull(),
    );
    // The filters narrow the collection already read: no new request and no server-side filter.
    const reads = mock.queries.filter((query) => query.operation === 'accounts-read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toHaveProperty('accountState');
    expect(reads[0]).not.toHaveProperty('blocked');
    await user.click(
      within(screen.getByRole('grid', { name: 'Bloqueio' })).getByRole('row', {
        name: 'Sem bloqueio',
      }),
    );
    await user.click(
      within(screen.getByRole('grid', { name: 'Bloqueio' })).getByRole('row', {
        name: 'Bloqueadas',
      }),
    );
    await waitFor(() => expect(screen.getByText('Nenhuma conta encontrada neste filtro.')).toBeTruthy());
    expect(mock.queries.filter((query) => query.operation === 'accounts-read')).toHaveLength(1);
  });
  it('keeps the collection read when the panel changes class and shows each class from it', async () => {
    const mock = accountsMockV1();
    mock.accounts[2]!.classId = 753002;
    mock.accounts[2]!.classLabel = 'SYNTHETIC OTHER CLASS';
    const view = render(createElement(StudentAccountsV1, mock.props));
    await ready();
    const classProps = (classId: number, scopeLabel: string) => ({
      ...mock.props,
      scope: { ...ACCOUNT_CLASS_V1, classId },
      scopeLabel,
    });
    view.rerender(createElement(StudentAccountsV1, classProps(753001, 'SYNTHETIC CLASS A')));
    expect(await screen.findByRole('heading', { name: 'Operações em massa' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })).toHaveLength(2),
    );
    await userEvent.setup().click(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })[0]!);
    expect(screen.getByText('1 selecionados')).toBeTruthy();
    view.rerender(createElement(StudentAccountsV1, classProps(753002, 'SYNTHETIC OTHER CLASS')));
    await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 003' });
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })).toHaveLength(1),
    );
    // The selection made in one class never follows the operator into another.
    expect(screen.getByText(/^Lista inteira · \d+$/)).toBeTruthy();
    view.rerender(createElement(StudentAccountsV1, classProps(753001, 'SYNTHETIC CLASS A')));
    await ready();
    expect(screen.getByText(/^Lista inteira · \d+$/)).toBeTruthy();
    expect(
      screen.getAllByRole<HTMLInputElement>('checkbox', { name: /^Selecionar para QR/ }).every(
        (checkbox) => !checkbox.checked,
      ),
    ).toBe(true);
    expect(mock.queries.filter((query) => query.operation === 'accounts-read')).toEqual([
      expect.objectContaining({ scope: { kind: 'school', academicYear: 2026 } }),
    ]);
    expect(mock.writes).toHaveLength(0);
  });
  it('clears the QR selection when a filter hides the selected row', async () => {
    const mock = accountsMockV1();
    mock.accounts[1]!.state = 'pending-activation';
    render(createElement(StudentAccountsV1, { ...mock.props, scope: ACCOUNT_CLASS_V1 }));
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('checkbox', { name: /^Selecionar para QR/ })[0]!);
    expect(screen.getByText('1 selecionados')).toBeTruthy();
    await user.click(
      within(screen.getByRole('grid', { name: 'Situação' })).getByRole('row', {
        name: 'Primeiro acesso',
      }),
    );
    expect(await screen.findByText(/^Lista inteira · \d+$/)).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
  });
  it('searches the collection already read, ignoring accents and case, without a new request', async () => {
    const mock = accountsMockV1();
    mock.accounts[2]!.name = 'SYNTHETIC JOSÉ ÂNGELO';
    render(createElement(StudentAccountsV1, mock.props));
    await ready();
    fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'old' } });
    expect(await screen.findByText('Nenhuma conta encontrada neste filtro.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'jose angelo' } });
    await screen.findByRole('button', { name: 'Abrir ficha de SYNTHETIC JOSÉ ÂNGELO' });
    expect(
      screen.queryByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: '' } });
    await ready();
    const reads = mock.queries.filter((query) => query.operation === 'accounts-read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toHaveProperty('nameSearch');
  });
  it('asks for the photos of the rows left on screen together with the list after a reload', async () => {
    window.sessionStorage.clear();
    clearPhotoMemoryV1();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:synthetic' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const events: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== PHOTO_AVATAR_BATCH_PATH_V1) return new Response(null, { status: 404 });
      const { subjects } = JSON.parse(String(init?.body)) as { subjects: unknown[] };
      events.push('photos:' + subjects.length);
      const body = encodePhotoAvatarBatchV1(subjects.map(() => new Uint8Array(64).fill(7)));
      return new Response(body.buffer as ArrayBuffer, {
        headers: { 'Content-Type': PHOTO_AVATAR_BATCH_TYPE_V1 },
      });
    });
    const photos = () => document.querySelectorAll('img.avatar__image').length;
    const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
    /** A list whose answer waits for `release`. */
    const pendingList = () => {
      let answer = () => {};
      const mock = accountsMockV1({
        query: (input) => {
          if (input.operation !== 'accounts-read') return undefined;
          events.push('list');
          return new Promise<Response>((resolve) => {
            answer = () => resolve(accountJsonV1(accountPageV1([1, 2, 3].map((n) => accountFixtureV1(n)))));
          });
        },
      });
      return { props: mock.props, release: () => answer() };
    };
    try {
      // First visit: nothing is known, so the photos are asked for when the accounts arrive.
      const first = pendingList();
      const view = render(createElement(StudentAccountsV1, first.props));
      await waitFor(() => expect(events).toEqual(['list']));
      await settle();
      expect(events).toEqual(['list']);
      first.release();
      await ready();
      await waitFor(() => expect(photos()).toBe(3));
      expect(events).toEqual(['list', 'photos:3']);
      // The tab keeps account identifiers only.
      const kept = window.sessionStorage.getItem('pa-first-rows-v1')!;
      expect(JSON.parse(kept).accountIds).toEqual([1, 2, 3].map((n) => accountFixtureV1(n).accountId));
      expect(kept).not.toContain('SYNTHETIC');
      // Reload: the page memory is gone, the tab still knows which rows were first.
      view.unmount();
      clearPhotoMemoryV1();
      events.length = 0;
      const second = pendingList();
      render(createElement(StudentAccountsV1, second.props));
      await waitFor(() => expect(events).toContain('photos:3'));
      expect(events.filter((event) => event === 'list')).toHaveLength(1);
      await settle();
      second.release();
      await ready();
      // The rows mount with their photos and nothing is asked for again.
      expect(photos()).toBe(3);
      expect(events.filter((event) => event.startsWith('photos'))).toEqual(['photos:3']);
      // Another administrator in the same tab starts without them.
      cleanup();
      clearPhotoMemoryV1();
      events.length = 0;
      const third = pendingList();
      render(createElement(StudentAccountsV1, { ...third.props, identityKey: 'another-admin' }));
      await waitFor(() => expect(events).toEqual(['list']));
      await settle();
      expect(events).toEqual(['list']);
      third.release();
      await ready();
      await waitFor(() => expect(events).toEqual(['list', 'photos:3']));
    } finally {
      cleanup();
      clearPhotoMemoryV1();
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
  it('recovers an uncertain response under StrictMode with identical bytes', async () => {
    let attempt = 0;
    const mock = accountsMockV1({
      write: async () => {
        if (attempt++ < 2) throw new Error('Synthetic lost response');
        return accountJsonV1({
          ...ACCOUNT_META_V1,
          state: 'committed',
          operationId: ACCOUNT_META_V1.requestId,
          version: 10,
        });
      },
    });
    render(createElement(StrictMode, null, createElement(StudentAccountsV1, mock.props)));
    const user = userEvent.setup();
    await user.click(await ready());
    await detail();
    await user.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
    await user.click(await screen.findByRole('button', { name: 'Repetir mesma solicitação' }));
    await screen.findByText(/Alteração salva/);
    expect(mock.bodies).toHaveLength(3);
    expect(new Set(mock.bodies).size).toBe(1);
  });
});
it('confirms a complete reset and tells the operator to reprint the current QR', async () => {
  const mock = accountsMockV1();
  render(createElement(StudentAccountsV1, mock.props));
  const user = userEvent.setup();
  await user.click(await ready());
  await detail();
  await user.click(screen.getByRole('button', { name: 'Redefinir conta' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar ação' }));
  await screen.findByText(/Conta redefinida: o QR anterior/);
  expect(mock.writes[0]?.operation).toBe('account-reset');
  expect(screen.getByText(/Reimprima o QR atual/)).toBeTruthy();
});
