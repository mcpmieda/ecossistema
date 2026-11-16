import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PerformanceAnalyticsV6,
  PerformanceAnalyticsRequestV6,
} from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import type {
  PerformanceFailureV2,
  PerformancePeriodV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { LIVE_HEAVY_READ_INTERVAL_V1 } from '../../../shared/live-data/live-refresh-v1';
import { createOperationalWorkspaceRequestGate } from '../operational-workspace/operational-workspace-request-gate';
import { requestPerformanceAnalyticsV6 } from './performance-analytics-client-v6';

export function usePerformanceAnalyticsV6(
  classId: number | null,
  period: PerformancePeriodV2,
  enabled: boolean,
) {
  const shared = useGradebookYear(),
    year = shared?.year ?? null,
    epoch = shared?.epoch ?? 0;
  const clearAuthorization = shared?.clearAuthorization;
  const [gate] = useState(createOperationalWorkspaceRequestGate);
  const request = useMemo<PerformanceAnalyticsRequestV6 | null>(
    () =>
      year === null || classId === null
        ? null
        : {
            transportVersion: 6,
            operation: 'analytics',
            year,
            classId,
            period,
            includeLearning: true,
            includeStudentDimensions: true,
          },
    [year, classId, period],
  );
  const key = JSON.stringify([epoch, request]);
  const previousScope = useRef<{ key: string; enabled: boolean; hasRequest: boolean } | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; data: PerformanceAnalyticsV6 } | null>(
    null,
  );
  const [status, setStatus] = useState<{
    key: string;
    busy: boolean;
    failure: PerformanceFailureV2 | null;
  }>({ key: '', busy: false, failure: null });
  const refresh = useCallback(async () => {
    if (!request || !enabled) return;
    const ticket = gate.begin(key);
    if (!ticket) return;
    setStatus({ key, busy: true, failure: null });
    try {
      const result = await requestPerformanceAnalyticsV6(request, ticket.signal);
      if (!ticket.isCurrent()) return;
      if (result.state === 'ready') {
        setSnapshot({ key, data: result });
        return true;
      }
      if (result.state === 'not-authorized') {
        setSnapshot(null);
        clearAuthorization?.();
      }
      setStatus({ key, busy: false, failure: result.state });
      return false;
    } catch {
      if (ticket.isCurrent()) {
        setStatus({ key, busy: false, failure: 'unavailable' });
        return false;
      }
    } finally {
      if (ticket.isCurrent()) setStatus((previous) => ({ ...previous, busy: false }));
      ticket.complete();
    }
  }, [request, enabled, gate, key, clearAuthorization]);
  useEffect(() => () => gate.invalidate(), [gate, key]);
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = { key, enabled, hasRequest: request !== null };
    if (!enabled || !request || previous?.key === key) return;
    // A retained reader resumes through the shared clock, preserving its failure cooldown.
    // Fresh mounts and context changes while visible still load immediately.
    if (previous && !previous.enabled && previous.hasRequest) return;
    void refresh();
  }, [refresh, enabled, key, request]);
  useLiveRefreshV1(refresh, {
    domains: ['gradebook'],
    intervalMs: LIVE_HEAVY_READ_INTERVAL_V1,
    enabled: request !== null,
    active: enabled,
    canRefresh: () => (status.key !== key || !status.busy) && status.failure !== 'not-authorized',
  });
  const data = request && snapshot?.key === key ? snapshot.data : null;
  return {
    data,
    busy: enabled && request !== null && (status.key !== key || status.busy),
    failure: status.key === key ? status.failure : null,
  };
}
