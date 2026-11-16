// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  auditPendingLabelV1,
  auditPendingSnapshotV1,
  publishAuditPendingV1,
  publishAuditYearV1,
} from '../../../src/platform/audit-pending-v1';

describe('Auditoria tab count', () => {
  it('shows the count of the Banco year and hides zero', () => {
    expect(auditPendingLabelV1(null)).toBeNull();
    expect(auditPendingLabelV1(0)).toBeNull();
    expect(auditPendingLabelV1(17)).toBe('17');
    expect(auditPendingLabelV1(1200)).toBe('999+');
  });

  it('follows the resolved problems and never shows the count of another year', () => {
    publishAuditYearV1(2090);
    publishAuditPendingV1(2090, 5);
    expect(auditPendingSnapshotV1()).toEqual({ year: 2090, count: 5 });
    publishAuditPendingV1(2091, 9);
    expect(auditPendingSnapshotV1()).toEqual({ year: 2090, count: 5 });
    publishAuditPendingV1(2090, 2);
    expect(auditPendingSnapshotV1()).toEqual({ year: 2090, count: 2 });
    publishAuditYearV1(2091);
    expect(auditPendingSnapshotV1()).toEqual({ year: 2091, count: null });
    publishAuditPendingV1(2091, 0);
    expect(auditPendingLabelV1(auditPendingSnapshotV1().count)).toBeNull();
  });
});
