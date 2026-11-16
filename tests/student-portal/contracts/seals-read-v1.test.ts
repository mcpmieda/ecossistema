// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  adminReadQueryV2,
  adminReadResponseV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';

const base = {
  contractVersion: 2 as const,
  operation: 'seals-read' as const,
  page: { limit: 100 },
};
const account = '75600000-0000-4000-8000-000000009901';

describe('Selos brilhantes read (owner request 29/09/2026)', () => {
  it('reads one record or one class, never the whole school or with list filters', () => {
    expect(
      adminReadQueryV2.safeParse({
        ...base,
        scope: { kind: 'account', academicYear: 2026, accountId: account },
      }).success,
    ).toBe(true);
    expect(
      adminReadQueryV2.safeParse({
        ...base,
        scope: { kind: 'class', academicYear: 2026, classId: 3 },
      }).success,
    ).toBe(true);
    expect(
      adminReadQueryV2.safeParse({ ...base, scope: { kind: 'school', academicYear: 2026 } })
        .success,
    ).toBe(false);
    expect(
      adminReadQueryV2.safeParse({
        ...base,
        scope: { kind: 'class', academicYear: 2026, classId: 3 },
        nameSearch: 'a',
      }).success,
    ).toBe(false);
  });

  it('returns a count per account, or null when the student sees no marks', () => {
    const response = {
      contractVersion: 2,
      requestId: '75600000-0000-4000-8000-000000000001',
      observedAt: '2026-09-29T10:00:00.000Z',
      state: 'seals-read',
      items: [
        { accountId: account, seals: 4 },
        { accountId: '75600000-0000-4000-8000-000000009902', seals: null },
      ],
    };
    expect(adminReadResponseV2.safeParse(response).success).toBe(true);
    expect(
      adminReadResponseV2.safeParse({ ...response, items: [{ accountId: account, seals: -1 }] })
        .success,
    ).toBe(false);
  });

  it('bounds explicit school batches to 400 unique accounts and rejects unrelated operations', () => {
    const accountIds = Array.from(
      { length: 400 },
      (_, index) => `75600000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const query = { ...base, scope: { kind: 'school', academicYear: 2026 }, accountIds };
    expect(adminReadQueryV2.safeParse(query).success).toBe(true);
    for (const invalid of [
      { ...query, accountIds: [] },
      { ...query, accountIds: [...accountIds, account] },
      { ...query, accountIds: [account, account] },
      { ...query, operation: 'accounts-read' },
      { ...query, scope: { kind: 'class', academicYear: 2026, classId: 3 } },
      { ...query, blocked: false },
    ])
      expect(adminReadQueryV2.safeParse(invalid).success).toBe(false);
  });
});
