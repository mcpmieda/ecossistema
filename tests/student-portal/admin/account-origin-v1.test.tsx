import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountDetailV1 } from '../../../src/features/student-portal-admin/accounts/account-detail-v1';
import { originLinesV1 } from '../../../src/features/student-portal-admin/accounts/record-origin-v1';
import { LiveRefreshAutomaticV1Provider } from '../../../src/shared/live-data/live-refresh-scope-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { accountJsonV1, accountsMockV1, ACCOUNT_META_V1 } from '../ui/accounts/fixtures-v1';

vi.mock('../../../src/features/student-photos/student-photo-panel-v1', () => ({
  StudentPhotoPanelV1: () => <span>Foto</span>,
}));

beforeEach(() => {
  setupOperationsDomV1();
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const advance = async () => {
  for (let step = 0; step < 5; step++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
};
const origin = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: 2 as const,
  requestId: ACCOUNT_META_V1.requestId,
  observedAt: '2026-11-10T15:00:00.000Z',
  state: 'account-origin' as const,
  accountId: '',
  version: 0,
  createdAt: '2026-09-14T19:29:10.000Z',
  everAccessed: false,
  classesThisYear: 0,
  closable: true,
  sameName: [{ classLabel: '7º ANO A', accountActive: true }],
  ...overrides,
});

it('explica pelos registros, em tópicos curtos e em ordem (10/11/2026)', () => {
  const text = originLinesV1(origin());
  expect(text.lines).toEqual([
    'Sem turma em 2026: nenhuma matrícula registrada para este cadastro.',
    'Conta criada em 14/09/2026.',
    'Nunca entrou no Portal.',
    'Outro cadastro com o mesmo nome está na 7º ANO A, com conta ativa.',
  ]);
  expect(text.conclusion).toBe('Pelos registros, é um cadastro repetido e pode ser encerrado.');
  expect(originLinesV1(origin({ closable: false, everAccessed: true })).conclusion).toBe(
    'Só dá para encerrar uma conta sem turma que nunca entrou no Portal.',
  );
});

it('mostra o motivo na ficha sem turma e encerra só depois da confirmação', async () => {
  const commands: unknown[] = [];
  const mock = accountsMockV1({
    query: (input) =>
      input.operation === 'account-origin'
        ? Promise.resolve(
            accountJsonV1(origin({ accountId: mock.accounts[0]!.accountId, version: mock.accounts[0]!.version })),
          )
        : undefined,
    write: (input) => {
      commands.push(input);
      return Promise.resolve(
        accountJsonV1({ ...ACCOUNT_META_V1, state: 'committed', operationId: crypto.randomUUID(), version: 9 }),
      );
    },
  });
  mock.accounts[0]!.classId = null;
  mock.accounts[0]!.classLabel = '';
  mock.accounts[0]!.eligibility = 'unresolved';
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <AccountDetailV1
        {...mock.props}
        accountId={mock.accounts[0]!.accountId}
        parentScope={mock.props.scope}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    </LiveRefreshAutomaticV1Provider>,
  );
  await advance();
  const card = screen.getByRole('heading', { name: 'Por que está sem turma' }).closest('.card')!;
  expect(within(card as HTMLElement).getByText('Nunca entrou no Portal.')).toBeTruthy();
  expect(commands).toHaveLength(0);
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Encerrar conta' }));
  await advance();
  expect(within(screen.getByRole('alertdialog')).getByText(/sai da lista e dos totais/)).toBeTruthy();
  expect(commands).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar ação' }));
  await advance();
  expect(commands).toEqual([
    expect.objectContaining({ operation: 'account-close', accountId: mock.accounts[0]!.accountId, confirmed: true }),
  ]);
});
