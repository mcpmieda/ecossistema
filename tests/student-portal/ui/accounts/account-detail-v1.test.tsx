import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountDetailV1 } from '../../../../src/features/student-portal-admin/accounts/account-detail-v1';
import { AccountClosingPreviewV1 } from '../../../../src/features/student-portal-admin/accounts/account-closing-preview-v1';
import type { PortalAdminReadClientV2 } from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import { PortalClientErrorV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { LiveRefreshAutomaticV1Provider } from '../../../../src/shared/live-data/live-refresh-scope-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { accountJsonV1, accountsMockV1, ACCOUNT_META_V1 } from './fixtures-v1';

vi.mock('../../../../src/features/student-photos/student-photo-panel-v1', () => ({
  StudentPhotoPanelV1: ({ canWrite }: { canWrite?: boolean }) => (
    <span>{canWrite ? 'Foto editável' : 'Foto somente leitura'}</span>
  ),
}));

beforeEach(() => {
  setupOperationsDomV1();
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const advance = async (milliseconds: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};
function openRecord(
  mock: ReturnType<typeof accountsMockV1>,
  extra: Partial<Parameters<typeof AccountDetailV1>[0]> = {},
) {
  const onClose = vi.fn();
  // As the page runs it: automatic reads paused (PORTAL_ADMIN_AUTO_REFRESH_V1).
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <AccountDetailV1
        {...mock.props}
        accountId={mock.accounts[0]!.accountId}
        parentScope={mock.props.scope}
        onClose={onClose}
        onChanged={vi.fn()}
        {...extra}
      />
    </LiveRefreshAutomaticV1Provider>,
  );
  return onClose;
}
async function block() {
  fireEvent.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
  await advance(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar ação' }));
  await advance(0);
}

it('says when the read after a saved action fails, and offers to reload the record', async () => {
  let failing = false;
  const mock = accountsMockV1({
    count: 1,
    query: (input) =>
      failing && input.operation === 'accounts-read'
        ? Promise.resolve(accountJsonV1({ ...ACCOUNT_META_V1, state: 'unavailable' }, 503))
        : undefined,
  });
  openRecord(mock);
  await advance(0);
  failing = true;
  await block();
  await advance(0);
  expect(mock.accounts[0]!.blocked).toBe(true);
  expect(screen.getByText('Alteração salva.')).toBeTruthy();
  expect(screen.getByText(/Sincronização temporariamente indisponível/)).toBeTruthy();
  const reload = screen.getByRole('button', { name: 'Recarregar ficha' }) as HTMLButtonElement;
  failing = false;
  await advance(6_000);
  expect(reload.disabled).toBe(false);
  fireEvent.click(reload);
  await advance(0);
  expect(screen.getByRole('button', { name: 'Desbloquear acesso' })).toBeTruthy();
  expect(screen.queryByText(/Sincronização temporariamente indisponível/)).toBeNull();
});

it('reads again after a saved action even while an older read is still on its way', async () => {
  let release: ((response: Response) => void) | undefined;
  let hold = false;
  const mock = accountsMockV1({
    count: 1,
    query: (input) =>
      hold && input.operation === 'accounts-read'
        ? new Promise<Response>((resolve) => {
            hold = false;
            release = resolve;
          })
        : undefined,
  });
  openRecord(mock);
  await advance(0);
  // A background read sent before the write, answering with the account as it was.
  hold = true;
  fireEvent.focus(window);
  await advance(12_000);
  expect(release).toBeDefined();
  await block();
  await advance(0);
  release!(
    accountJsonV1({
      contractVersion: 2,
      requestId: ACCOUNT_META_V1.requestId,
      state: 'accounts-read',
      observedAt: '2026-09-13T15:00:00Z',
      scopeVersion: 4,
      items: [{ ...mock.accounts[0]!, blocked: false, version: 9 }],
      nextCursor: null,
      lastAuthenticationWindowMonths: 12,
    }),
  );
  await advance(0);
  expect(screen.getByRole('button', { name: 'Desbloquear acesso' })).toBeTruthy();
});

it('keeps the record open while an action is saving', async () => {
  const mock = accountsMockV1({ count: 1, write: () => new Promise<Response>(() => undefined) });
  const onClose = openRecord(mock);
  await advance(0);
  await block();
  expect(screen.getByText('Salvando…')).toBeTruthy();
  const close = screen.getByRole('button', { name: 'Fechar ficha' }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Ficha do aluno' }), { key: 'Escape' });
  await advance(0);
  expect(onClose).not.toHaveBeenCalled();
});

it('names the action group and keeps the photo read-only for a student who left', async () => {
  const mock = accountsMockV1({ count: 1 });
  mock.accounts[0]!.eligibility = 'exit';
  openRecord(mock);
  await advance(0);
  expect(screen.getByText('Aluno com saída da escola: ficha somente para consulta.')).toBeTruthy();
  expect(screen.getByText('Foto somente leitura')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'Ações de acesso' })).toBeTruthy();
});

it('gives the slots a new revision after each saved action', async () => {
  const mock = accountsMockV1({ count: 1 });
  openRecord(mock, {
    initialSlot: 'closing',
    slots: { closing: (context) => <span>Revisão {context.revision}</span> },
  });
  await advance(0);
  expect(screen.getByText('Revisão 0')).toBeTruthy();
  await block();
  await advance(0);
  expect(screen.getByText('Revisão 1')).toBeTruthy();
});

const preview = (visibleToStudent: boolean) => ({
  contractVersion: 2,
  requestId: ACCOUNT_META_V1.requestId,
  observedAt: '2026-09-13T15:00:00Z',
  state: 'closing-preview',
  scope: { kind: 'account', academicYear: 2026, accountId: ACCOUNT_META_V1.requestId },
  available: true,
  visibleToStudent,
  mode: 'closed',
  closedPeriods: ['T1'],
  subjects: [],
});

it('reads the closing preview again on a new revision and retries a failed read', async () => {
  const query = vi.fn();
  const reader = { query } as unknown as PortalAdminReadClientV2;
  const scope = {
    kind: 'account',
    academicYear: 2026,
    accountId: ACCOUNT_META_V1.requestId,
  } as const;
  query.mockRejectedValueOnce(new PortalClientErrorV1('network-error'));
  const view = render(<AccountClosingPreviewV1 reader={reader} scope={scope} refreshKey={0} />);
  await advance(0);
  expect(screen.getByText('Prévia indisponível. Tente novamente.')).toBeTruthy();
  query.mockResolvedValueOnce(preview(true));
  fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
  await advance(0);
  expect(screen.getByText('O aluno já vê este fechamento no Portal.')).toBeTruthy();
  query.mockResolvedValueOnce(preview(false));
  view.rerender(<AccountClosingPreviewV1 reader={reader} scope={scope} refreshKey={1} />);
  await advance(0);
  expect(query).toHaveBeenCalledTimes(3);
  expect(screen.getByText(/o aluno ainda não vê este fechamento/)).toBeTruthy();
});
