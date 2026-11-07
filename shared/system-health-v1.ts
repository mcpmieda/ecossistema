/** Closed, aggregate-only DTOs. Never add student, session, credential or raw-error fields. */
export type HealthStateV1 = 'normal' | 'attention' | 'critical' | 'unknown';
export type PortalMaintenanceSampleV1 = {
  status: 'normal' | 'attention' | 'intervention';
  liveOutboxAvailable: boolean;
  expiredIp: number;
  expiredAudit: number;
  backlog: boolean;
  exhausted: boolean;
  publicationDue: number;
  oldestPublicationDueMs: number;
  liveBacklog: boolean;
  livePending: number;
  liveRetrying: number;
  oldestLiveDueMs: number;
  waitingConnections: number;
  oldestWaitingQueryMs: number;
};
export type PortalMonitorSampleV1 = {
  schemaVersion: 1;
  observedAt: string;
  servingEnabled: boolean;
  credentialsConfigured: boolean;
  database: 'ok' | 'unconfigured' | 'unavailable';
  readDurationMs: number;
  maintenance: PortalMaintenanceSampleV1 | null;
};
export type PublicEntrySampleV1 = {
  outcome: 'ok' | 'http-error' | 'unexpected-response' | 'unavailable' | 'not-probed';
  status: number | null;
  durationMs: number | null;
  observedAt: string | null;
};
export type SystemHealthSnapshotV1 = {
  schemaVersion: 1;
  generatedAt: string;
  portalReadState: 'ok' | 'unavailable' | 'unconfigured';
  portal: PortalMonitorSampleV1 | null;
  publicEntry: PublicEntrySampleV1;
};
export const SYSTEM_HEALTH_POLL_MS_V1 = 60_000;
export const SYSTEM_HEALTH_TTL_MS_V1 = 30_000;
const SYSTEM_HEALTH_STALE_MS_V1 = 120_000;
export const SYSTEM_HEALTH_BODY_BYTES_V1 = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value);
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return number(value, max) && Number.isSafeInteger(value);
}
export function isHealthInstantV1(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const maintenanceKeys = ['status', 'liveOutboxAvailable', 'expiredIp', 'expiredAudit', 'backlog',
  'exhausted', 'publicationDue', 'oldestPublicationDueMs', 'liveBacklog', 'livePending',
  'liveRetrying', 'oldestLiveDueMs', 'waitingConnections', 'oldestWaitingQueryMs'] as const;
export function isPortalMaintenanceSampleV1(value: unknown): value is PortalMaintenanceSampleV1 {
  if (!record(value) || !exact(value, maintenanceKeys)) return false;
  return oneOf(value.status, ['normal', 'attention', 'intervention'])
    && ['liveOutboxAvailable', 'backlog', 'exhausted', 'liveBacklog'].every((key) => typeof value[key] === 'boolean')
    && ['expiredIp', 'expiredAudit'].every((key) => integer(value[key], 101))
    && ['publicationDue', 'livePending', 'liveRetrying'].every((key) => integer(value[key], 1001))
    && integer(value.waitingConnections)
    && ['oldestPublicationDueMs', 'oldestLiveDueMs', 'oldestWaitingQueryMs'].every((key) => number(value[key]));
}
export function isPortalMonitorSampleV1(value: unknown): value is PortalMonitorSampleV1 {
  if (!record(value) || !exact(value, ['schemaVersion', 'observedAt', 'servingEnabled',
    'credentialsConfigured', 'database', 'readDurationMs', 'maintenance'])) return false;
  return value.schemaVersion === 1 && isHealthInstantV1(value.observedAt)
    && typeof value.servingEnabled === 'boolean' && typeof value.credentialsConfigured === 'boolean'
    && oneOf(value.database, ['ok', 'unconfigured', 'unavailable']) && number(value.readDurationMs)
    && (value.database === 'ok' ? isPortalMaintenanceSampleV1(value.maintenance) : value.maintenance === null);
}
function isPublicEntry(value: unknown): value is PublicEntrySampleV1 {
  if (!record(value) || !exact(value, ['outcome', 'status', 'durationMs', 'observedAt'])) return false;
  if (!oneOf(value.outcome, ['ok', 'http-error', 'unexpected-response', 'unavailable', 'not-probed'])) return false;
  if (value.outcome === 'not-probed') return value.status === null && value.durationMs === null && value.observedAt === null;
  if (!number(value.durationMs) || !isHealthInstantV1(value.observedAt)) return false;
  if (value.outcome === 'unavailable') return value.status === null;
  if (!integer(value.status, 599) || (value.status as number) < 200) return false;
  if (value.outcome === 'http-error') return value.status !== 200;
  return value.status === 200;
}
export function isSystemHealthSnapshotV1(value: unknown): value is SystemHealthSnapshotV1 {
  if (!record(value) || !exact(value, ['schemaVersion', 'generatedAt', 'portalReadState', 'portal', 'publicEntry'])) return false;
  return value.schemaVersion === 1 && isHealthInstantV1(value.generatedAt)
    && oneOf(value.portalReadState, ['ok', 'unavailable', 'unconfigured'])
    && (value.portalReadState === 'ok' ? isPortalMonitorSampleV1(value.portal) : value.portal === null)
    && isPublicEntry(value.publicEntry);
}
export function sampleIsFreshV1(at: string, now: number, maxAge = SYSTEM_HEALTH_STALE_MS_V1): boolean {
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age >= -5_000 && age <= maxAge;
}
export function systemHealthStateV1(snapshot: SystemHealthSnapshotV1, now: number): HealthStateV1 {
  const portal = snapshot.portal;
  const entry = snapshot.publicEntry;
  if (!sampleIsFreshV1(snapshot.generatedAt, now)
    || (portal && !sampleIsFreshV1(portal.observedAt, now))
    || (entry.observedAt && !sampleIsFreshV1(entry.observedAt, now))) return 'unknown';
  if (entry.outcome === 'http-error' || entry.outcome === 'unexpected-response'
    || portal?.database === 'unavailable' || portal?.maintenance?.status === 'intervention') return 'critical';
  if (portal && (!portal.servingEnabled || !portal.credentialsConfigured || portal.maintenance?.status === 'attention')) return 'attention';
  if (snapshot.portalReadState !== 'ok' || portal?.database !== 'ok'
    || entry.outcome !== 'ok' || !portal.maintenance?.liveOutboxAvailable) return 'unknown';
  return 'normal';
}
export function cappedHealthCountV1(value: number, cap: 101 | 1001 = 1001): string {
  return value >= cap ? `${(cap - 1).toLocaleString('pt-BR')}+` : value.toLocaleString('pt-BR');
}
