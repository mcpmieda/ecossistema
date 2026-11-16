// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { portalMaintenanceHealthV1 } from '../../../server/student-portal/observability/maintenance-health-v1';
import type {
  StudentPortalPostgresQueryV1,
  StudentPortalPostgresResultV1,
} from '../../../server/student-portal/persistence/postgres-persistence-v1';

function query(
  fixture: Record<string, unknown>,
  liveOutbox = true,
): StudentPortalPostgresQueryV1 {
  return {
    unsafe: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ) => {
      const rows = sql.includes("to_regclass('student_portal.live_event_outbox_v1')")
        ? [{ live_outbox: liveOutbox }]
        : [fixture];
      return Object.assign(rows, { count: rows.length }) as unknown as
        StudentPortalPostgresResultV1<Row>;
    },
  };
}

const healthy = {
  expired_ip: 0,
  expired_audit: 0,
  overdue_ip: false,
  exhausted: false,
  backlog: false,
  publication_due: 0,
  oldest_publication_due_ms: 0,
  live_backlog: false,
  live_pending: 0,
  live_retrying: 0,
  oldest_live_due_ms: 0,
  waiting_connections: 0,
  oldest_waiting_query_ms: 0,
} as const;

describe('portal maintenance health bounded backlog metrics', () => {
  it('returns only aggregate depth and age for publication and live queues', async () => {
    const health = await portalMaintenanceHealthV1(query({
      ...healthy,
      publication_due: 17,
      oldest_publication_due_ms: 42_000,
      live_pending: 185,
      live_retrying: 12,
      oldest_live_due_ms: 91_000,
    }));

    expect(health).toMatchObject({
      status: 'normal',
      liveOutboxAvailable: true,
      publicationDue: 17,
      oldestPublicationDueMs: 42_000,
      livePending: 185,
      liveRetrying: 12,
      oldestLiveDueMs: 91_000,
    });
    expect(Object.keys(health)).not.toEqual(
      expect.arrayContaining(['accountId', 'studentId', 'classId', 'payload', 'sql']),
    );
  });

  it('marks a stale live outbox as attention without escalating normal retries', async () => {
    await expect(portalMaintenanceHealthV1(query({
      ...healthy,
      live_backlog: true,
      live_pending: 73,
      live_retrying: 9,
      oldest_live_due_ms: 301_000,
    }))).resolves.toMatchObject({
      status: 'attention',
      liveBacklog: true,
      livePending: 73,
      liveRetrying: 9,
    });
  });

  it('keeps exhausted publication work at intervention priority', async () => {
    await expect(portalMaintenanceHealthV1(query({
      ...healthy,
      exhausted: true,
      backlog: true,
      publication_due: 4,
      oldest_publication_due_ms: 900_000,
    }))).resolves.toMatchObject({
      status: 'intervention',
      exhausted: true,
      publicationDue: 4,
    });
  });

  it('keeps pre-0011 Portal catalogs diagnosable with neutral live metrics', async () => {
    await expect(portalMaintenanceHealthV1(query(healthy, false))).resolves.toMatchObject({
      status: 'normal',
      liveOutboxAvailable: false,
      liveBacklog: false,
      livePending: 0,
      liveRetrying: 0,
      oldestLiveDueMs: 0,
    });
  });
});
