// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createPortalAdminReadClientV2,
  createPortalClassCatalogV2,
} from '../../../../src/features/student-portal-admin/accounts/accounts-client-v2';
import { accountJsonV1, accountPageV1, accountFixtureV1, ACCOUNT_SCHOOL_V1 } from './fixtures-v1';
describe('administrative account readers', () => {
  it('uses the fixed no-store V2 endpoint and rejects a mismatched operation response', async () => {
    const fetcher = vi.fn(async () => accountJsonV1(accountPageV1([accountFixtureV1()])));
    const client = createPortalAdminReadClientV2({ fetch: fetcher });
    const input = {
      contractVersion: 2 as const,
      operation: 'accounts-read' as const,
      scope: ACCOUNT_SCHOOL_V1,
      page: {},
    };
    await client.query(input);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/student-portal/admin/query',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', method: 'POST' }),
    );
    await expect(client.query({ ...input, operation: 'overview' })).rejects.toMatchObject({
      state: 'invalid-response',
    });
  });
  it('fetches a full paged BN catalog including empty classes, always in2026', async () => {
    const calls: unknown[] = [];
    const catalog = createPortalClassCatalogV2(async (request) => {
      calls.push(request);
      return {
        contractVersion: 2,
        state: 'ready',
        operation: 'search',
        context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
        items: [
          {
            entity: { kind: 'class-group', id: 753002, label: 'SYNTHETIC EMPTY CLASS' },
            description: null,
          },
        ],
        nextOffset: null,
      };
    });
    expect((await catalog(100, '')).items[0]?.id).toBe(753002);
    expect(calls[0]).toMatchObject({ year: 2026, kind: 'class-group', offset: 100, limit: 100 });
  });
  it('does not accept a foreign year, nonadvancing catalog or unauthorized response', async () => {
    const result = {
      contractVersion: 2 as const,
      state: 'ready' as const,
      operation: 'search' as const,
      context: { year: 2025, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
      items: [],
      nextOffset: null,
    };
    await expect(createPortalClassCatalogV2(async () => result)(0, '')).rejects.toThrow();
    await expect(
      createPortalClassCatalogV2(async () => ({
        ...result,
        context: { ...result.context, year: 2026 },
        nextOffset: 0,
      }))(0, ''),
    ).rejects.toThrow();
    await expect(
      createPortalClassCatalogV2(async () => ({ contractVersion: 2, state: 'not-authorized' }))(
        0,
        '',
      ),
    ).rejects.toMatchObject({ state: 'forbidden' });
  });
});
