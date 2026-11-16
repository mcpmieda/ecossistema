// @vitest-environment node
import { expect, it } from 'vitest';
import {
  isPortalHistoryV1,
  isPortalHistoryPointV1,
  isHistoryRequestV1,
  portalHistoryPointStateV1,
  portalHistoryChangeV1,
  HEALTH_HISTORY_RETENTION_MS_V1,
} from '../../shared/system-health-history-v1';
import { historyFixtureV1, historyPointV1 } from './history-fixtures-v1';

it('accepts closed, ordered aggregates with real zero values', () => {
  expect(isPortalHistoryV1(historyFixtureV1())).toBe(true);
  expect(portalHistoryPointStateV1(historyPointV1())).toBe('normal');
});
it.each(['name', 'studentId', 'ip', 'url', 'token', 'message', 'payload'])(
  'rejects additional %s at either level',
  (key) => {
    expect(isPortalHistoryV1({ ...historyFixtureV1(), [key]: 'synthetic' })).toBe(false);
    expect(isPortalHistoryPointV1({ ...historyPointV1(), [key]: 'synthetic' })).toBe(false);
  },
);
it.each([-1, 1002, Infinity, NaN, '0'])(
  'rejects a count outside its contract: %s',
  (publicationDue) => {
    expect(isPortalHistoryPointV1({ ...historyPointV1(), publicationDue })).toBe(false);
  },
);
it('does not mistake unavailable sources, missing live data or disabled serving for normality', () => {
  expect(isPortalHistoryV1({ ...historyFixtureV1(), state: 'unavailable' })).toBe(false);
  expect(portalHistoryPointStateV1({ ...historyPointV1(), livePending: null })).toBe('unknown');
  expect(portalHistoryPointStateV1({ ...historyPointV1(), servingEnabled: false })).toBe(
    'attention',
  );
  expect(portalHistoryPointStateV1({ ...historyPointV1(), maintenanceState: 'intervention' })).toBe(
    'critical',
  );
});
it('bounds pages, ordering, cursor and the exact 30-day frontier', () => {
  const fixture = historyFixtureV1();
  expect(isPortalHistoryV1({ ...fixture, points: [historyPointV1(), historyPointV1()] })).toBe(
    false,
  );
  expect(isPortalHistoryV1({ ...fixture, points: [historyPointV1(1), historyPointV1()] })).toBe(
    false,
  );
  expect(
    isPortalHistoryV1({
      ...fixture,
      points: Array.from({ length: 49 }, (_, i) => historyPointV1(i)),
    }),
  ).toBe(false);
  expect(isPortalHistoryV1({ ...fixture, nextBefore: historyPointV1().bucketAt })).toBe(false);
  const at = Date.parse(historyPointV1().observedAt);
  expect(
    isPortalHistoryV1({
      ...fixture,
      generatedAt: new Date(at + HEALTH_HISTORY_RETENTION_MS_V1).toISOString(),
    }),
  ).toBe(false);
  expect(
    isPortalHistoryV1({
      ...fixture,
      generatedAt: new Date(at + HEALTH_HISTORY_RETENTION_MS_V1 - 1).toISOString(),
    }),
  ).toBe(true);
  expect(isPortalHistoryV1({ ...fixture, generatedAt: new Date(at - 1).toISOString() })).toBe(
    false,
  );
});
it('accepts only a bounded time cursor, never arbitrary selectors', () => {
  expect(isHistoryRequestV1({ before: null })).toBe(true);
  expect(isHistoryRequestV1({ before: historyPointV1().bucketAt })).toBe(true);
  for (const value of [
    {},
    { before: 'invalid' },
    { before: historyPointV1().observedAt },
    { before: null, studentId: 'synthetic' },
    { before: 0 },
  ])
    expect(isHistoryRequestV1(value)).toBe(false);
});
it('marks recovery only between consecutive, confirmed samples', () => {
  const old = { ...historyPointV1(1), maintenanceState: 'intervention' as const };
  expect(portalHistoryChangeV1(historyPointV1(), old)).toBe('recovered');
  expect(
    portalHistoryChangeV1(historyPointV1(), {
      ...old,
      ...historyPointV1(2),
      maintenanceState: 'intervention',
    }),
  ).toBe('gap');
  expect(
    portalHistoryChangeV1(historyPointV1(), {
      ...old,
      maintenanceState: 'normal',
      livePending: null,
    }),
  ).toBe('sample');
  expect(portalHistoryChangeV1(historyPointV1())).toBe('sample');
});
