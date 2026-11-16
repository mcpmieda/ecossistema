// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  self: vi.fn(),
  batchContexts: vi.fn(),
  batchSources: vi.fn(),
}));
vi.mock('../../../server/student-portal/admin/seal-source-batch-v1', () => ({
  sealContextsBatchV1: mocks.batchContexts,
  sealSourcesBatchV1: mocks.batchSources,
}));
vi.mock('../../../server/student-portal/publication/self-projection-reader-v1', () => ({
  publicationContextV1: mocks.context,
}));
vi.mock('../../../server/student-portal/publication/scoped-self-v2', () => ({
  scopedSelfV2: mocks.self,
}));
vi.mock('../../../server/student-portal/persistence/postgres-persistence-v1', () => ({
  StudentPortalPostgresPersistenceV1: class {
    transaction<T>(run: (store: unknown) => Promise<T>) {
      return run({});
    }
  },
}));
const { readSealsV1 } = await import('../../../server/student-portal/admin/seals-read-v1');

const ids = [
  '75600000-0000-4000-8000-000000009901',
  '75600000-0000-4000-8000-000000009902',
  '75600000-0000-4000-8000-000000009903',
];
const score = (value: number) => ({
  kind: 'score' as const,
  value,
  maximum: 30,
  meetsMinimum: value >= 18,
});
const self = (value: number) => ({
  state: 'ready',
  endedPeriods: ['T1'],
  subjects: [
    {
      subjectId: 1,
      label: 'Sintética',
      order: 0,
      periods: [
        {
          period: 'T1',
          final: score(value),
          partials: [
            {
              assessmentId: 9,
              label: 'AV1',
              mark: { kind: 'score', value: 10, maximum: 10, meetsMinimum: true },
              assessment: true,
            },
          ],
        },
      ],
    },
  ],
});
const query = {
  contractVersion: 2 as const,
  operation: 'seals-read' as const,
  page: { limit: 100 },
};
const request = '75600000-0000-4000-8000-000000000001';

describe('readSealsV1 (owner request 29/09/2026)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts with the shared rule, per student of a class, null when no marks are shown', async () => {
    const tx = { unsafe: vi.fn(async () => ids.map((id) => ({ id }))) };
    mocks.batchContexts.mockResolvedValue(new Map(ids.slice(0, 2).map((id) => [id, { id }])));
    mocks.batchSources.mockResolvedValue({});
    mocks.self.mockImplementation(async (_tx, context: { id: string }) =>
      context.id === ids[0] ? self(28) : self(20),
    );
    const result = await readSealsV1(
      tx as never,
      { ...query, scope: { kind: 'class', academicYear: 2026, classId: 3 } },
      request,
      new Date(),
    );
    expect(result).toMatchObject({
      state: 'seals-read',
      items: [
        { accountId: ids[0], seals: 2 },
        { accountId: ids[1], seals: 1 },
        { accountId: ids[2], seals: null },
      ],
    });
    // Read-only snapshot: no account lock, access not required.
    expect(mocks.batchContexts).toHaveBeenCalledWith(tx, ids, undefined);
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it('reads one record without listing the class and never the whole school', async () => {
    const tx = { unsafe: vi.fn() };
    mocks.context.mockResolvedValue({ id: ids[0] });
    mocks.self.mockRejectedValue(new Error('student-portal-preparation-unavailable'));
    const result = await readSealsV1(
      tx as never,
      { ...query, scope: { kind: 'account', academicYear: 2026, accountId: ids[0]! } },
      request,
      new Date(),
    );
    expect(result).toMatchObject({ items: [{ accountId: ids[0], seals: null }] });
    expect(tx.unsafe).not.toHaveBeenCalled();
    expect(mocks.context.mock.calls[0]?.slice(4)).toEqual([false, false]);
    await expect(
      readSealsV1(
        tx as never,
        { ...query, scope: { kind: 'school', academicYear: 2026 } },
        request,
        new Date(),
      ),
    ).rejects.toThrow();
  });
});
