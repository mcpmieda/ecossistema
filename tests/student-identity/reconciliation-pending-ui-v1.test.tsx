import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ReconciliationListItemV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';
import { StudentReconciliationV1 } from '../../src/features/student-portal-admin/accounts/student-reconciliation-v1';
import type { ReconciliationClientV1 } from '../../src/features/student-portal-admin/shared/reconciliation-client-v1';
import { setupOperationsDomV1 } from '../student-portal/ui/overview/dom-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const context = {
  generation: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const base = { contractVersion: 1 as const, state: 'ready' as const, context };
const scope = { kind: 'school' as const, academicYear: 2026 as const };
type Person = Extract<ReconciliationListItemV1, { kind: 'person' }>;
const person = (
  index: number,
  reconciliation: Person['reconciliation'],
  name = 'SYNTHETIC PERSON ' + index,
): Person => ({
  kind: 'person',
  studentUid: '22222222-2222-4222-8222-' + String(index).padStart(12, '0'),
  academicStudentId: index,
  academicYear: 2026,
  name,
  relationName: name,
  classId: 7,
  classLabel: 'SYNTHETIC CLASS',
  version: 1,
  reconciliation,
  portal: 'without-portal',
  accountId: null,
  possibleSamePerson: false,
});
const page = (items: Person[], nextCursor: string | null): ReconciliationResponseV1 => ({
  ...base,
  operation: 'list',
  items,
  nextCursor,
});
const catalog = (): ReconciliationResponseV1 => ({
  ...base,
  operation: 'catalog',
  classes: [],
  reportClasses: [],
});
const mount = (request: ReconciliationClientV1['request']) =>
  render(
    <StudentReconciliationV1
      client={{ request }}
      scope={scope}
      canWrite={false}
      pendingOnly
      showPortalAccess={false}
    />,
  );

it('joins the pendencies of mixed and filtered-empty pages into one list, with no load-more left', async () => {
  const request = vi.fn<ReconciliationClientV1['request']>(async (input) => {
    if (input.operation === 'catalog') return catalog();
    if (input.operation !== 'list') throw new Error('Synthetic reads only');
    if (!input.cursor) return page([person(1, 'pending'), person(2, 'reconciled')], 'a');
    if (input.cursor === 'a') return page([person(3, 'reconciled')], 'b');
    return page([person(4, 'review-required'), person(5, 'reconciled')], null);
  });
  mount(request);
  // Every pending row the side column counts is on screen at once (owner report of 16/10/2026).
  expect(await screen.findByText('2 pendências carregadas')).toBeTruthy();
  // The count can render a tick before the table rows (React Aria collection).
  expect(await screen.findByText('SYNTHETIC PERSON 1')).toBeTruthy();
  expect(await screen.findByText('SYNTHETIC PERSON 4')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC PERSON 2')).toBeNull();
  expect(screen.queryByText('SYNTHETIC PERSON 3')).toBeNull();
  expect(screen.queryByText('SYNTHETIC PERSON 5')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  expect(
    request.mock.calls
      .map(([input]) => input)
      .filter((input) => input.operation === 'list')
      .map((input) => input.cursor),
  ).toEqual([null, 'a', 'b']);
});

it('does not declare an empty list or zero count while a later page is unresolved, or after a failure', async () => {
  let fail!: (error: Error) => void;
  const waiting = new Promise<ReconciliationResponseV1>((_, reject) => {
    fail = reject;
  });
  const request = vi.fn<ReconciliationClientV1['request']>(async (input) => {
    if (input.operation === 'catalog') return catalog();
    if (input.operation !== 'list') throw new Error('Synthetic reads only');
    return input.cursor ? waiting : page([person(1, 'reconciled')], 'later');
  });
  mount(request);
  await waitFor(() =>
    expect(
      request.mock.calls.some(([input]) => input.operation === 'list' && input.cursor === 'later'),
    ).toBe(true),
  );
  expect(screen.getByText('Carregando…')).toBeTruthy();
  expect(screen.queryByText('Nenhuma pendência encontrada.')).toBeNull();
  expect(screen.queryByText('0 pendências carregadas')).toBeNull();
  await act(async () => {
    fail(new Error('SYNTHETIC READ FAILED'));
  });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByText('Nenhuma pendência encontrada.')).toBeNull();
  expect(screen.queryByText('0 pendências carregadas')).toBeNull();
});

it('shows a verified empty pending result after every reconciled page has been consumed', async () => {
  const request = vi.fn<ReconciliationClientV1['request']>(async (input) => {
    if (input.operation === 'catalog') return catalog();
    if (input.operation !== 'list') throw new Error('Synthetic reads only');
    return page([person(input.cursor ? 2 : 1, 'reconciled')], input.cursor ? null : 'last');
  });
  mount(request);
  expect(await screen.findByText('Nenhuma pendência encontrada.')).toBeTruthy();
  expect(screen.getByText('0 pendências carregadas')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC PERSON 1')).toBeNull();
  expect(screen.queryByText('SYNTHETIC PERSON 2')).toBeNull();
  expect(screen.queryByRole('grid', { name: 'Pendências de conciliação' })).toBeNull();
});

it('resets pending rows and opaque cursor for search and class changes, retaining both filters on skipped pages', async () => {
  const request = vi.fn<ReconciliationClientV1['request']>(async (input) => {
    if (input.operation === 'catalog') return catalog();
    if (input.operation !== 'list') throw new Error('Synthetic reads only');
    if (input.classId === 7)
      return page([person(4, 'missing-current-report', 'SYNTHETIC CLASS PENDING')], null);
    if (input.search === 'match')
      return input.cursor
        ? page([person(3, 'pending', 'SYNTHETIC MATCH')], null)
        : page([person(2, 'reconciled')], 'search-page');
    return input.cursor ? page([], null) : page([person(1, 'pending')], 'old-page');
  });
  const client = { request };
  const view = render(
    <StudentReconciliationV1 client={client} scope={scope} canWrite={false} pendingOnly />,
  );
  await screen.findByText('SYNTHETIC PERSON 1');
  await userEvent
    .setup()
    .type(screen.getByRole('searchbox', { name: 'Buscar aluno ou pendência' }), 'match');
  expect(await screen.findByText('SYNTHETIC MATCH')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC PERSON 1')).toBeNull();
  expect(screen.getByText('1 pendência carregada')).toBeTruthy();
  const filtered = request.mock.calls
    .map(([input]) => input)
    .filter((input) => input.operation === 'list' && input.search === 'match');
  expect(filtered.map((input) => (input.operation === 'list' ? input.cursor : undefined))).toEqual([
    null,
    'search-page',
  ]);
  view.rerender(
    <StudentReconciliationV1
      client={client}
      scope={{ kind: 'class', academicYear: 2026, classId: 7 }}
      canWrite={false}
      pendingOnly
    />,
  );
  expect(await screen.findByText('SYNTHETIC CLASS PENDING')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC MATCH')).toBeNull();
  expect(request.mock.calls.map(([input]) => input).at(-2)).toMatchObject({
    operation: 'list',
    cursor: null,
    classId: 7,
    search: 'match',
  });
  expect(request.mock.calls.every(([input]) => ['catalog', 'list', 'automatic-report'].includes(input.operation))).toBe(
    true,
  );
});
