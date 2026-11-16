// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  adminClassCatalogRequestV2,
  adminReadQueryV2,
  adminReadResponseV2,
  adminQueryRequestV2,
  adminAccountReadV2,
} from '../../../shared/student-portal-contracts/admin-read-v2';
import {
  adminCommandV1,
  adminQueryV1,
  adminResponseV1,
} from '../../../shared/student-portal-contracts/admin-v1';
const scope = { kind: 'school', academicYear: 2026 };
const query = { contractVersion: 2, operation: 'accounts-read', scope, page: {} };
const response = {
  contractVersion: 2,
  requestId: '74600000-0000-4000-8000-000000000001',
  observedAt: '2026-09-13T12:00:00Z',
  state: 'accounts-read',
  scopeVersion: 1,
  items: [],
  nextCursor: null,
  lastAuthenticationWindowMonths: 12,
};
describe('opt-in administrative read contract', () => {
  it('requires authoritative session time/status and forbids filters that hide revocation members', () => {
    const sessions = { ...query, operation: 'sessions-read' };
    expect(adminReadQueryV2.safeParse(sessions).success).toBe(true);
    for (const fields of [{ nameSearch: 'a' }, { blocked: false }, { accountState: 'active' }])
      expect(adminReadQueryV2.safeParse({ ...sessions, ...fields }).success).toBe(false);
    const data = {
      contractVersion: 2,
      requestId: response.requestId,
      state: 'sessions-read',
      observedAt: response.observedAt,
      scope,
      version: 1,
      revocableCount: 0,
      items: [],
      nextCursor: null,
    };
    expect(adminReadResponseV2.safeParse(data).success).toBe(true);
    expect(adminReadResponseV2.safeParse({ ...data, observedAt: undefined }).success).toBe(false);
    expect(adminResponseV1.safeParse(data).success).toBe(false);
  });
  it('requires an explicit Portal closure instead of inferring it from unresolved access', () => {
    const item = {
      accountId: response.requestId,
      link: { academicYear: 2026, studentId: 753001 },
      name: 'SYNTHETIC ACCOUNT',
      classLabel: 'TEST CLASS',
      classId: 753001,
      state: 'active',
      eligibility: 'eligible',
      blocked: false,
      version: 1,
      access: {
        state: 'unresolved',
        enabled: null,
        source: null,
        settingsVersion: null,
        accessPermitted: false,
      },
      lastAuthenticationAt: null,
      validSessionCount: 0,
      firstAccess: { state: 'not-required', qrIssued: true, recoveryReady: true },
    };
    expect(adminAccountReadV2.safeParse(item).success).toBe(false);
    expect(
      adminAccountReadV2.parse({
        ...item,
        linkClosed: true,
        link: null,
        classId: null,
        eligibility: 'unlinked',
      }).linkClosed,
    ).toBe(true);
    expect(adminAccountReadV2.parse({ ...item, linkClosed: false }).linkClosed).toBe(false);
  });
  it('keeps V1 envelopes strict and accepts either version only at the read boundary', () => {
    expect(adminReadQueryV2.parse(query).page.limit).toBe(50);
    const legacy = { ...query, contractVersion: 1, operation: 'accounts' };
    expect(adminQueryRequestV2.safeParse(legacy).success).toBe(true);
    expect(adminQueryRequestV2.safeParse(query).success).toBe(true);
    expect(adminQueryV1.safeParse(query).success).toBe(false);
    expect(adminResponseV1.safeParse(response).success).toBe(false);
    expect(adminReadResponseV2.safeParse(response).success).toBe(true);
    expect(adminCommandV1.safeParse({ ...query, operation: 'block' }).success).toBe(false);
  });
  it('rejects foreign years, overlong pages, unused identity fields and overview cursors', () => {
    for (const invalid of [
      { ...query, scope: { ...scope, academicYear: 2025 } },
      { ...query, page: { limit: 401 } },
      { ...query, operation: 'overview', page: { limit: 101 } },
      { ...query, actorId: response.requestId },
      { ...query, operation: 'overview', page: { cursor: 'a'.repeat(80) } },
      { ...query, operation: 'audit-detail' },
    ])
      expect(adminQueryRequestV2.safeParse(invalid).success).toBe(false);
    expect(adminQueryRequestV2.safeParse({ ...query, page: { limit: 400 } }).success).toBe(true);
    expect(
      adminReadResponseV2.safeParse({ ...response, lastAuthenticationWindowMonths: 24 }).success,
    ).toBe(false);
    expect(
      adminReadResponseV2.safeParse({ ...response, privateSource: 'not-allowed' }).success,
    ).toBe(false);
  });
  it('fixes the complete class catalog to 2026 and explicitly bounds continuation', () => {
    expect(adminClassCatalogRequestV2()).toEqual({
      contractVersion: 2,
      operation: 'search',
      year: 2026,
      kind: 'class-group',
      offset: 0,
      limit: 100,
      query: '',
    });
    expect(adminClassCatalogRequestV2(100).offset).toBe(100);
    for (const offset of [-1, 1.5, 100001])
      expect(() => adminClassCatalogRequestV2(offset)).toThrow();
    expect(() => adminClassCatalogRequestV2(0, 101)).toThrow();
    expect(() => adminClassCatalogRequestV2(0, 100, '\0')).toThrow();
  });
});
