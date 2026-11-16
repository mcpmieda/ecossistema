// @vitest-environment node
import { expect, it } from 'vitest';
import {
  HEALTH_HISTORY_BODY_BYTES_V1,
  isPortalHistoryPointV1,
  isPortalHistoryV1,
  portalHistoryFreshV1,
} from '../../shared/system-health-history-v1';
import { historyFixtureV1, historyPointV1, HISTORY_NOW_V1 } from './history-fixtures-v1';

it('rejects enum coercion, rather than accepting arrays or objects as state labels', () => {
  expect(isPortalHistoryPointV1({ ...historyPointV1(), maintenanceState: ['normal'] })).toBe(false);
  expect(isPortalHistoryV1({ ...historyFixtureV1(), state: ['ok'] })).toBe(false);
  expect(isPortalHistoryV1({ ...historyFixtureV1(), state: { toString: () => 'ok' } })).toBe(false);
});
it('expires read confirmation at its exact deadline and refuses future clocks or absent points', () => {
  const data = historyFixtureV1();
  expect(portalHistoryFreshV1(data, HISTORY_NOW_V1 + 120_000)).toBe(true);
  expect(portalHistoryFreshV1(data, HISTORY_NOW_V1 + 120_001)).toBe(false);
  expect(portalHistoryFreshV1(data, HISTORY_NOW_V1 - 5001)).toBe(false);
  expect(portalHistoryFreshV1({ ...data, points: [] }, HISTORY_NOW_V1)).toBe(false);
});
it('does not renew an old sample merely by reading the history again', () => {
  const data = historyFixtureV1();
  data.points = [
    { ...historyPointV1(2), observedAt: new Date(HISTORY_NOW_V1 - 600_000).toISOString() },
  ];
  expect(portalHistoryFreshV1(data, HISTORY_NOW_V1)).toBe(true);
  expect(portalHistoryFreshV1(data, HISTORY_NOW_V1 + 1)).toBe(false);
});
it('fits the worst permitted page inside the transport budget', () => {
  const data = {
    ...historyFixtureV1(),
    points: Array.from({ length: 48 }, (_, i) => ({
      ...historyPointV1(i),
      publicationDue: 1001,
      livePending: 1001,
      waitingConnections: 2_147_483_647,
      readDurationMs: 2_147_483_647,
    })),
    nextBefore: historyPointV1(47).bucketAt,
  };
  expect(isPortalHistoryV1(data)).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThan(
    HEALTH_HISTORY_BODY_BYTES_V1,
  );
});
