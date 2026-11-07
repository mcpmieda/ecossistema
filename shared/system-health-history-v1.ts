import { isHealthInstantV1, type HealthStateV1 } from './system-health-v1';

export const HEALTH_HISTORY_INTERVAL_MS_V1 = 300_000;
export const HEALTH_HISTORY_RETENTION_MS_V1 = 30 * 24 * 60 * 60_000;
export const HEALTH_HISTORY_PAGE_SIZE_V1 = 48;
export const HEALTH_HISTORY_BODY_BYTES_V1 = 32_768;
const HEALTH_HISTORY_STALE_MS_V1 = 600_000;
export type PortalHistoryPointV1 = {
  bucketAt: string;
  observedAt: string;
  servingEnabled: boolean;
  credentialsConfigured: boolean;
  maintenanceState: 'normal' | 'attention' | 'intervention';
  publicationDue: number;
  livePending: number | null;
  waitingConnections: number;
  readDurationMs: number;
};
export type PortalHistoryV1 = {
  schemaVersion: 1;
  generatedAt: string;
  retentionDays: 30;
  state: 'ok' | 'unconfigured' | 'unavailable';
  points: PortalHistoryPointV1[];
  nextBefore: string | null;
};
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function count(value: unknown, max = 2_147_483_647): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value);
}
export function isHistoryBeforeV1(value: unknown): value is string | null {
  return value === null || (isHealthInstantV1(value) && Date.parse(value) % HEALTH_HISTORY_INTERVAL_MS_V1 === 0);
}
export function isHistoryRequestV1(value: unknown): value is { before: string | null } {
  return exact(value, ['before']) && isHistoryBeforeV1(value.before);
}
export function isPortalHistoryPointV1(value: unknown): value is PortalHistoryPointV1 {
  if (!exact(value, ['bucketAt', 'observedAt', 'servingEnabled', 'credentialsConfigured',
    'maintenanceState', 'publicationDue', 'livePending', 'waitingConnections', 'readDurationMs'])) return false;
  if (typeof value.bucketAt !== 'string' || !isHistoryBeforeV1(value.bucketAt) || !isHealthInstantV1(value.observedAt)) return false;
  const offset = Date.parse(value.observedAt) - Date.parse(value.bucketAt);
  return offset >= 0 && offset < HEALTH_HISTORY_INTERVAL_MS_V1
    && typeof value.servingEnabled === 'boolean' && typeof value.credentialsConfigured === 'boolean'
    && oneOf(value.maintenanceState, ['normal', 'attention', 'intervention'])
    && count(value.publicationDue, 1001) && (value.livePending === null || count(value.livePending, 1001))
    && count(value.waitingConnections) && count(value.readDurationMs);
}
export function emptyPortalHistoryV1(state: 'unconfigured' | 'unavailable', generatedAt = new Date().toISOString()): PortalHistoryV1 {
  return { schemaVersion: 1, generatedAt, retentionDays: 30, state, points: [], nextBefore: null };
}
export function isPortalHistoryV1(value: unknown): value is PortalHistoryV1 {
  if (!exact(value, ['schemaVersion', 'generatedAt', 'retentionDays', 'state', 'points', 'nextBefore'])
    || value.schemaVersion !== 1 || value.retentionDays !== 30 || !isHealthInstantV1(value.generatedAt)
    || !oneOf(value.state, ['ok', 'unconfigured', 'unavailable'])
    || !Array.isArray(value.points) || value.points.length > HEALTH_HISTORY_PAGE_SIZE_V1
    || !isHistoryBeforeV1(value.nextBefore)) return false;
  if (value.state !== 'ok') return value.points.length === 0 && value.nextBefore === null;
  const now = Date.parse(value.generatedAt);
  let previous = Infinity;
  for (const point of value.points) {
    if (!isPortalHistoryPointV1(point)) return false;
    const bucket = Date.parse(point.bucketAt), at = Date.parse(point.observedAt);
    if (bucket >= previous || at > now || at <= now - HEALTH_HISTORY_RETENTION_MS_V1) return false;
    previous = bucket;
  }
  return value.nextBefore === null || (value.points.length === HEALTH_HISTORY_PAGE_SIZE_V1
    && value.nextBefore === value.points.at(-1)?.bucketAt);
}
/** Only configuration and maintenance were sampled; this is not a login or uptime verdict. */
export function portalHistoryPointStateV1(point: PortalHistoryPointV1): HealthStateV1 {
  if (point.maintenanceState === 'intervention') return 'critical';
  if (!point.servingEnabled || !point.credentialsConfigured || point.maintenanceState === 'attention') return 'attention';
  return point.livePending === null ? 'unknown' : 'normal';
}
export function portalHistoryChangeV1(point: PortalHistoryPointV1, older?: PortalHistoryPointV1): 'sample' | 'gap' | 'recovered' {
  if (!older) return 'sample';
  if (Date.parse(point.bucketAt) - Date.parse(older.bucketAt) !== HEALTH_HISTORY_INTERVAL_MS_V1) return 'gap';
  const previous = portalHistoryPointStateV1(older);
  return portalHistoryPointStateV1(point) === 'normal' && (previous === 'attention' || previous === 'critical')
    ? 'recovered' : 'sample';
}
export function portalHistoryFreshV1(data: PortalHistoryV1, now: number): boolean {
  const point = data.points[0];
  if (data.state !== 'ok' || !point) return false;
  const readAge = now - Date.parse(data.generatedAt), sampleAge = now - Date.parse(point.observedAt);
  return readAge >= -5000 && readAge <= 120_000 && sampleAge >= -5000 && sampleAge <= HEALTH_HISTORY_STALE_MS_V1;
}
