import type { PortalHistoryPointV1, PortalHistoryV1 } from '../../shared/system-health-history-v1';
import type { PortalMaintenanceSampleV1 } from '../../shared/system-health-v1';
export const HISTORY_NOW_V1 = Date.parse('2026-09-21T12:01:00.000Z');
export function historyPointV1(offset = 0): PortalHistoryPointV1 {
  const at = Date.parse('2026-09-21T12:00:00.000Z') - offset * 300_000;
  return {
    bucketAt: new Date(at).toISOString(),
    observedAt: new Date(at + 1000).toISOString(),
    servingEnabled: true,
    credentialsConfigured: true,
    maintenanceState: 'normal',
    publicationDue: 0,
    livePending: 0,
    waitingConnections: 0,
    readDurationMs: 10,
  };
}
export function historyFixtureV1(): PortalHistoryV1 {
  return {
    schemaVersion: 1,
    generatedAt: new Date(HISTORY_NOW_V1).toISOString(),
    retentionDays: 30,
    state: 'ok',
    points: [historyPointV1()],
    nextBefore: null,
  };
}
export function historyMaintenanceV1(): PortalMaintenanceSampleV1 {
  return {
    status: 'normal',
    liveOutboxAvailable: true,
    expiredIp: 0,
    expiredAudit: 0,
    backlog: false,
    exhausted: false,
    publicationDue: 0,
    oldestPublicationDueMs: 0,
    liveBacklog: false,
    livePending: 0,
    liveRetrying: 0,
    oldestLiveDueMs: 0,
    waitingConnections: 0,
    oldestWaitingQueryMs: 0,
  };
}
