import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ReconciliationListItemV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';
import { StudentReconciliationV1 } from '../../src/features/student-portal-admin/accounts/student-reconciliation-v1';
import type { ReconciliationClientV1 } from '../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';
import {
  accountJsonV1,
  accountsMockV1,
  ACCOUNT_META_V1,
} from '../student-portal/ui/accounts/fixtures-v1';

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
const advance = async () => {
  for (let step = 0; step < 6; step++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
};
const context = {
  generation: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const base = { contractVersion: 1 as const, state: 'ready' as const, context };

it('encerra na Conciliação a conta de um cadastro sem turma, como na ficha (11/11/2026)', async () => {
  const commands: unknown[] = [];
  const mock = accountsMockV1({
    count: 1,
    query: (input) =>
      input.operation === 'account-origin'
        ? Promise.resolve(
            accountJsonV1({
              contractVersion: 2,
              requestId: ACCOUNT_META_V1.requestId,
              observedAt: '2026-11-11T12:00:00.000Z',
              state: 'account-origin',
              accountId: mock.accounts[0]!.accountId,
              version: mock.accounts[0]!.version,
              createdAt: '2026-09-14T19:29:10.000Z',
              everAccessed: false,
              classesThisYear: 0,
              closable: true,
              sameName: [{ classLabel: 'SYNTHETIC CLASS A', accountActive: true }],
            }),
          )
        : undefined,
    write: (input) => {
      commands.push(input);
      return Promise.resolve(
        accountJsonV1({
          ...ACCOUNT_META_V1,
          state: 'committed',
          operationId: crypto.randomUUID(),
          version: 10,
        }),
      );
    },
  });
  const account = mock.accounts[0]!;
  Object.assign(account, {
    classId: null,
    classLabel: '',
    eligibility: 'unresolved',
    state: 'pending-activation',
  });
  const repeated: ReconciliationListItemV1 = {
    kind: 'person',
    studentUid: '22222222-2222-4222-8222-000000000001',
    academicStudentId: 1,
    academicYear: 2026,
    name: 'SYNTHETIC REPEATED RECORD',
    relationName: 'SYNTHETIC REPEATED RECORD',
    classId: null,
    classLabel: null,
    version: 1,
    reconciliation: 'without-report',
    portal: 'with-portal',
    accountId: account.accountId,
    possibleSamePerson: false,
  };
  let closed = false;
  const request = vi.fn<ReconciliationClientV1['request']>(
    async (input): Promise<ReconciliationResponseV1> => {
      if (input.operation === 'catalog')
        return { ...base, operation: 'catalog', classes: [], reportClasses: [] };
      if (input.operation === 'detail')
        return {
          ...base,
          operation: 'detail',
          selectedObservationId: null,
          sources: [],
          candidates: [],
          history: [],
        };
      if (input.operation !== 'list') throw new Error('Synthetic reads only');
      // The server settles the record once its account is closed.
      return { ...base, operation: 'list', nextCursor: null, items: closed ? [] : [repeated] };
    },
  );
  render(
    <StudentReconciliationV1
      client={{ request }}
      scope={{ kind: 'school', academicYear: 2026 }}
      canWrite
      pendingOnly
      showPortalAccess={false}
      accountClose={{ client: mock.props.client, reader: mock.props.reader }}
    />,
  );
  await advance();
  fireEvent.click(screen.getByRole('button', { name: 'SYNTHETIC REPEATED RECORD' }));
  await advance();
  const card = screen.getByRole('heading', { name: 'Por que está sem turma' }).closest('.card')!;
  expect(within(card as HTMLElement).getByText('Nunca entrou no Portal.')).toBeTruthy();
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Encerrar conta' }));
  await advance();
  expect(
    within(screen.getByRole('alertdialog')).getByText(/sai da lista e dos totais/),
  ).toBeTruthy();
  expect(commands).toHaveLength(0);
  closed = true;
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar ação' }));
  await advance();
  expect(commands).toEqual([
    expect.objectContaining({
      operation: 'account-close',
      accountId: account.accountId,
      confirmed: true,
    }),
  ]);
  expect(screen.getByText(/Conta encerrada\. O cadastro saiu da Conciliação/)).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC REPEATED RECORD')).toBeNull();
});

it('não oferece encerrar a conta de quem tem turma', async () => {
  const mock = accountsMockV1({ count: 1 });
  const request = vi.fn<ReconciliationClientV1['request']>(
    async (input): Promise<ReconciliationResponseV1> => {
      if (input.operation === 'catalog')
        return { ...base, operation: 'catalog', classes: [], reportClasses: [] };
      if (input.operation === 'detail')
        return {
          ...base,
          operation: 'detail',
          selectedObservationId: null,
          sources: [],
          candidates: [],
          history: [],
        };
      if (input.operation !== 'list') throw new Error('Synthetic reads only');
      return {
        ...base,
        operation: 'list',
        nextCursor: null,
        items: [
          {
            kind: 'person',
            studentUid: '22222222-2222-4222-8222-000000000002',
            academicStudentId: 2,
            academicYear: 2026,
            name: 'SYNTHETIC CLASSED RECORD',
            relationName: 'SYNTHETIC CLASSED RECORD',
            classId: 7,
            classLabel: 'SYNTHETIC CLASS',
            version: 1,
            reconciliation: 'without-report',
            portal: 'with-portal',
            accountId: mock.accounts[0]!.accountId,
            possibleSamePerson: false,
          },
        ],
      };
    },
  );
  render(
    <StudentReconciliationV1
      client={{ request }}
      scope={{ kind: 'school', academicYear: 2026 }}
      canWrite
      pendingOnly
      showPortalAccess={false}
      accountClose={{ client: mock.props.client, reader: mock.props.reader }}
    />,
  );
  await advance();
  fireEvent.click(screen.getByRole('button', { name: 'SYNTHETIC CLASSED RECORD' }));
  await advance();
  expect(screen.queryByRole('heading', { name: 'Por que está sem turma' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Encerrar conta' })).toBeNull();
  expect(mock.queries.some((query) => query.operation === 'accounts-read')).toBe(false);
});
