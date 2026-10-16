// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type {
  ReconciliationListItemV1,
  ReconciliationRequestV1,
  ReconciliationResponseV1,
} from '../../shared/student-identity/reconciliation-v1';
import { readReconciliationListV1 } from '../../src/features/student-portal-admin/accounts/reconciliation-list-read-v1';
import type { ReconciliationClientV1 } from '../../src/features/student-portal-admin/shared/reconciliation-client-v1';

type Person = Extract<ReconciliationListItemV1, { kind: 'person' }>;
const context = {
  generation: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  nameSource: 'report' as const,
  relationAvailable: true,
};
const input: Extract<ReconciliationRequestV1, { operation: 'list' }> = {
  contractVersion: 1,
  academicYear: 2026,
  operation: 'list',
  cursor: null,
  classId: null,
  search: '',
  limit: 50,
};
const person = (reconciliation: Person['reconciliation'], index = 1): Person => ({
  kind: 'person',
  studentUid: '22222222-2222-4222-8222-' + String(index).padStart(12, '0'),
  academicStudentId: index,
  academicYear: 2026,
  name: 'SYNTHETIC PERSON ' + index,
  relationName: 'SYNTHETIC PERSON ' + index,
  classId: 7,
  classLabel: 'SYNTHETIC CLASS',
  version: 1,
  reconciliation,
  portal: 'without-portal',
  accountId: null,
  possibleSamePerson: false,
});
const external: ReconciliationListItemV1 = {
  kind: 'external',
  id: 'synthetic-pending',
  sourceId: null,
  batchId: '33333333-3333-4333-8333-333333333333',
  name: 'SYNTHETIC EXTERNAL',
  classLabel: 'SYNTHETIC CLASS',
  reason: 'awaiting_relation',
  expiresAt: null,
  warning: false,
  sourceRow: 2,
};
const page = (
  items: ReconciliationListItemV1[],
  nextCursor: string | null,
): ReconciliationResponseV1 => ({
  contractVersion: 1,
  state: 'ready',
  operation: 'list',
  context,
  items,
  nextCursor,
});
const mock = (...pages: ReconciliationResponseV1[]) => {
  const request = vi.fn<ReconciliationClientV1['request']>();
  pages.forEach((response) => request.mockResolvedValueOnce(response));
  return { request };
};
const signal = () => new AbortController().signal;

describe('pending-only reconciliation reads over the existing opaque cursor', () => {
  it('removes only reconciled people and keeps every other canonical situation and external pending record', async () => {
    const pending = [
      person('without-report'),
      person('pending', 2),
      person('review-required', 3),
      person('missing-current-report', 4),
      external,
    ];
    const client = mock(
      page(
        [
          ...pending,
          person('reconciled', 5),
          { ...person('reconciled', 6), possibleSamePerson: true },
        ],
        'more',
      ),
      page([person('reconciled', 7)], null),
    );
    expect(await readReconciliationListV1(client, input, signal(), true)).toEqual(
      page(pending, null),
    );
    expect(client.request).toHaveBeenCalledTimes(2);
  });
  it('advances past all-reconciled pages while carrying class, search, limit and signal unchanged', async () => {
    const client = mock(
      page([person('reconciled')], 'opaque-a'),
      page([person('reconciled', 2)], 'opaque-b'),
      page([person('pending', 3)], 'opaque-c'),
      page([person('reconciled', 4), external], null),
    );
    const request = { ...input, classId: 7, search: 'SYNTHETIC', limit: 25 };
    const abort = signal();
    expect(await readReconciliationListV1(client, request, abort, true)).toEqual(
      page([person('pending', 3), external], null),
    );
    expect(client.request.mock.calls.map(([value]) => value)).toEqual([
      { ...request, cursor: null },
      { ...request, cursor: 'opaque-a' },
      { ...request, cursor: 'opaque-b' },
      { ...request, cursor: 'opaque-c' },
    ]);
    expect(client.request.mock.calls.every(([, value]) => value === abort)).toBe(true);
  });
  it('follows intermediate empty filtered pages when loading more, without repeating the prior page', async () => {
    const client = mock(
      page([person('reconciled')], 'opaque-next'),
      page([person('reconciled', 2), external], null),
    );
    expect(
      await readReconciliationListV1(
        client,
        { ...input, cursor: 'opaque-previous' },
        signal(),
        true,
      ),
    ).toEqual(page([external], null));
    expect(
      client.request.mock.calls.map(([request]) =>
        request.operation === 'list' ? request.cursor : undefined,
      ),
    ).toEqual(['opaque-previous', 'opaque-next']);
  });
  it('returns an empty pending result only after exhausting all pages of reconciled people', async () => {
    const client = mock(
      page([person('reconciled')], 'next'),
      page([person('reconciled', 2)], null),
    );
    expect(await readReconciliationListV1(client, input, signal(), true)).toEqual(page([], null));
    expect(client.request).toHaveBeenCalledTimes(2);
  });
  it('joins pending rows scattered over several pages and stops once a page of them is in', async () => {
    const client = mock(
      page([external, person('reconciled')], 'opaque-a'),
      page([person('without-report', 2), person('pending', 3)], 'opaque-b'),
      page([person('pending', 4)], 'opaque-c'),
    );
    expect(await readReconciliationListV1(client, { ...input, limit: 3 }, signal(), true)).toEqual(
      page([external, person('without-report', 2), person('pending', 3)], 'opaque-b'),
    );
    expect(client.request).toHaveBeenCalledTimes(2);
  });
  it('preserves a genuinely empty result', async () => {
    const client = mock(page([], null));
    expect(await readReconciliationListV1(client, input, signal(), true)).toEqual(page([], null));
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it('preserves the legacy mixed page and pagination without automatically consuming any other page', async () => {
    const response = page([person('reconciled'), person('pending', 2)], 'next');
    const client = mock(response);
    expect(await readReconciliationListV1(client, input, signal(), false)).toBe(response);
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it('does not turn a revision conflict after skipped pages into an empty result', async () => {
    const conflict: ReconciliationResponseV1 = { contractVersion: 1, state: 'conflict' };
    const client = mock(page([person('reconciled')], 'next'), conflict);
    expect(await readReconciliationListV1(client, input, signal(), true)).toBe(conflict);
  });
  it('stops before requesting another page when an obsolete read is aborted', async () => {
    const controller = new AbortController();
    const request = vi.fn<ReconciliationClientV1['request']>(async () => {
      controller.abort();
      return page([person('reconciled')], 'next');
    });
    await expect(
      readReconciliationListV1({ request }, input, controller.signal, true),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects a nonadvancing cursor instead of looping or declaring a false empty result', async () => {
    const client = mock(
      page([person('reconciled')], 'loop'),
      page([person('reconciled', 2)], 'loop'),
    );
    await expect(readReconciliationListV1(client, input, signal(), true)).rejects.toMatchObject({
      state: 'invalid-response',
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});
