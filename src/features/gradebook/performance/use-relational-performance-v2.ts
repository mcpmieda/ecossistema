import type {
  PerformanceAnalysisV3,
  PerformanceLensV3,
} from '../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import {
  dashboardAnalysisV5,
  dashboardComparisonV5,
  type PerformanceDashboardV5,
} from '../../../../shared/gradebook-contracts/performance/performance-dashboard-v5';
import { requestPerformanceDashboardV5 } from './performance-dashboard-client-v5';
import type {
  PerformanceReferencePeriodV4,
  PerformanceTermComparisonV4,
} from '../../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PERFORMANCE_LENSES_V3 } from '../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { readSessionViewV1, writeSessionViewV1 } from '../../../shared/ui/session-view-v1';
import type {
  PerformanceRequestV2,
  PerformanceReadyV2,
  PerformanceMatrixV2,
  PerformanceFailureV2,
  PerformancePeriodV2,
  PerformanceModeV2,
  PerformanceStatusV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { LIVE_HEAVY_READ_INTERVAL_V1 } from '../../../shared/live-data/live-refresh-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { createOperationalWorkspaceRequestGate } from '../operational-workspace/operational-workspace-request-gate';
import { requestRelationalPerformanceV2 } from './relational-performance-client-v2';

type Filters = {
  classId: number | null;
  period: PerformancePeriodV2;
  mode: PerformanceModeV2;
  statuses: PerformanceStatusV2[];
  lens: PerformanceLensV3;
  offerId: number | null;
  referencePeriod: PerformanceReferencePeriodV4 | null;
};
type Detail = Extract<PerformanceReadyV2, { operation: 'student-detail' | 'cell-detail' }>;
/** Filters kept for the tab so a reload returns to the same reading; ids and choices only. */
const storedFiltersV2 = z
  .object({
    classId: z.number().int().positive().nullable(),
    period: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('annual')]),
    mode: z.enum(['regular', 'recovery']),
    statuses: z.array(z.number().int().min(1).max(7).nullable()).min(1).max(8),
    lens: z.enum(PERFORMANCE_LENSES_V3),
    offerId: z.number().int().positive().nullable(),
    referencePeriod: z.union([z.literal(1), z.literal(2)]).nullable(),
  })
  .strict();
/** The reading always brings every situation; which ones are listed is chosen on screen. */
const EVERY_STATUS_V2: PerformanceStatusV2[] = [null, 1, 2, 3, 4, 5, 7];
const filtersKeyV2 = (year: number) => `gradebook-performance-filters:${year}`;
const readStoredFiltersV2 = (year: number) =>
  readSessionViewV1(filtersKeyV2(year), (value) => {
    const parsed = storedFiltersV2.safeParse(value);
    return parsed.success ? (parsed.data as Filters) : null;
  });
export function useRelationalPerformanceV2(dashboardEnabled = true, isActive = true) {
  const shared = useGradebookYear();
  const year = shared?.year ?? null;
  const clearAuthorization = shared?.clearAuthorization;
  const [gates] = useState(() => ({
    classes: createOperationalWorkspaceRequestGate(),
    matrix: createOperationalWorkspaceRequestGate(),
    detail: createOperationalWorkspaceRequestGate(),
  }));
  const [classes, setClasses] = useState<Extract<
    PerformanceReadyV2,
    { operation: 'classes' }
  > | null>(null);
  const [filters, setFilters] = useState<Filters>(
    () =>
      (year === null ? null : readStoredFiltersV2(year)) ?? {
        classId: null,
        period: 1,
        mode: 'regular',
        statuses: [null, 7],
        lens: 'result',
        offerId: null,
        referencePeriod: null,
      },
  );
  // A restored class still has to exist in what the server lists, and its reading is asked
  // for once the classes are in.
  const restoring = useRef(filters.classId !== null);
  const [matrix, setMatrix] = useState<PerformanceMatrixV2 | null>(null);
  const [analysis, setAnalysis] = useState<PerformanceAnalysisV3 | null>(null);
  const [comparison, setComparison] = useState<PerformanceTermComparisonV4 | null>(null);
  const [dashboard, setDashboard] = useState<PerformanceDashboardV5 | null>(null);
  // The same reading of the trimester before, for the arrows of the component chart.
  const [previousDashboard, setPreviousDashboard] = useState<PerformanceDashboardV5 | null>(null);
  const [offers, setOffers] = useState<PerformanceMatrixV2['offers']>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailTarget = useRef<{
    studentId: number;
    offerId?: number;
    mode: PerformanceModeV2;
  } | null>(null);
  const [failure, setFailure] = useState<PerformanceFailureV2 | null>(null);
  const [detailFailure, setDetailFailure] = useState<PerformanceFailureV2 | null>(null);
  const [busy, setBusy] = useState({ classes: year !== null, matrix: false, detail: false });
  useEffect(() => () => Object.values(gates).forEach((gate) => gate.invalidate()), [gates]);
  useEffect(() => {
    if (year === null) return;
    const request = {
      transportVersion: 2,
      operation: 'classes',
      year,
      offset: 0,
      limit: 100,
    } as const;
    const ticket = gates.classes.begin(JSON.stringify(request));
    if (!ticket) return;
    void requestRelationalPerformanceV2(request, ticket.signal)
      .then((response) => {
        if (!ticket.isCurrent()) return;
        if (response.state === 'not-authorized') {
          clearAuthorization?.();
          setFailure(response.state);
        } else if (response.state === 'ready' && response.operation === 'classes')
          setClasses(response);
        else if (response.state !== 'ready') setFailure(response.state);
      })
      .catch(() => {
        if (ticket.isCurrent()) setFailure('unavailable');
      })
      .finally(() => {
        if (ticket.isCurrent()) setBusy((value) => ({ ...value, classes: false }));
        ticket.complete();
      });
    return () => gates.classes.invalidate();
  }, [year, gates, clearAuthorization]);
  function closeDetail() {
    detailTarget.current = null;
    gates.detail.invalidate();
    setDetail(null);
    setDetailOpen(false);
    setDetailFailure(null);
    setBusy((value) => ({ ...value, detail: false }));
  }
  function loseAccess() {
    clearAuthorization?.();
    Object.values(gates).forEach((gate) => gate.invalidate());
    setClasses(null);
    setMatrix(null);
    setAnalysis(null);
    setComparison(null);
    setDashboard(null);
    setPreviousDashboard(null);
    setOffers([]);
    closeDetail();
    setBusy({ classes: false, matrix: false, detail: false });
  }
  async function run(
    request: PerformanceRequestV2,
    concern: keyof typeof gates,
    apply: (value: PerformanceReadyV2) => void,
  ) {
    const ticket = gates[concern].begin(JSON.stringify(request));
    if (!ticket) return;
    const error = concern === 'detail' ? setDetailFailure : setFailure;
    error(null);
    setBusy((value) => ({ ...value, [concern]: true }));
    try {
      const response = await requestRelationalPerformanceV2(request, ticket.signal);
      if (!ticket.isCurrent()) return;
      if (response.state === 'not-authorized') loseAccess();
      if (response.state !== 'ready') {
        error(response.state);
        return false;
      }
      apply(response);
      return true;
    } catch {
      if (ticket.isCurrent()) {
        error('unavailable');
        return false;
      }
    } finally {
      if (ticket.isCurrent()) setBusy((value) => ({ ...value, [concern]: false }));
      ticket.complete();
    }
  }
  async function loadClasses(offset = 0) {
    if (year === null) return;
    await run(
      { transportVersion: 2, operation: 'classes', year, offset, limit: 100 },
      'classes',
      (value) => {
        if (value.operation !== 'classes') return;
        setClasses((old) =>
          offset === 0 || !old
            ? value
            : {
                ...value,
                classes: [
                  ...new Map(
                    [...old.classes, ...value.classes].map((item) => [item.id, item]),
                  ).values(),
                ],
              },
        );
      },
    );
  }
  async function loadDashboard(selected: Filters): Promise<boolean | undefined> {
    if (
      year === null ||
      selected.classId === null ||
      (selected.lens === 'assessments' && selected.offerId === null)
    )
      return;
    const request = {
      transportVersion: 5,
      operation: 'dashboard',
      year,
      classId: selected.classId,
      period: selected.period,
      mode: selected.mode,
      statuses: EVERY_STATUS_V2,
      lens: selected.lens,
      offerId: selected.offerId,
      referencePeriod: selected.referencePeriod,
    } as const;
    const ticket = gates.matrix.begin(JSON.stringify(request));
    if (!ticket) return;
    setBusy((value) => ({ ...value, matrix: true }));
    setFailure(null);
    const previousPeriod = request.period === 2 ? 1 : request.period === 3 ? 2 : null;
    try {
      const [response, previous] = await Promise.all([
        requestPerformanceDashboardV5(request, ticket.signal),
        // A comparison already sets the two trimesters side by side; the arrows are not needed.
        previousPeriod === null || request.lens === 'assessments' || request.referencePeriod !== null
          ? null
          : requestPerformanceDashboardV5(
              { ...request, period: previousPeriod, referencePeriod: null },
              ticket.signal,
            ).catch(() => null),
      ]);
      if (!ticket.isCurrent()) return;
      if (response.state === 'not-authorized') loseAccess();
      if (response.state !== 'ready') {
        setFailure(response.state);
        return false;
      }
      const current = dashboardAnalysisV5(response);
      setDashboard(response);
      setPreviousDashboard(previous?.state === 'ready' ? previous : null);
      setMatrix(current.matrix);
      setAnalysis(current);
      setComparison(dashboardComparisonV5(response));
      setOffers(current.matrix.offers);
      return true;
    } catch {
      if (ticket.isCurrent()) {
        setFailure('unavailable');
        return false;
      }
    } finally {
      if (ticket.isCurrent()) setBusy((value) => ({ ...value, matrix: false }));
      ticket.complete();
    }
  }
  async function readDetail(target: {
    studentId: number;
    offerId?: number;
    mode: PerformanceModeV2;
  }) {
    if (year === null || filters.classId === null) return;
    const scope = {
      transportVersion: 2,
      year,
      classId: filters.classId,
      period: filters.period,
      mode: target.mode,
      studentId: target.studentId,
    } as const;
    return run(
      target.offerId === undefined
        ? { ...scope, operation: 'student-detail' }
        : { ...scope, operation: 'cell-detail', offerId: target.offerId },
      'detail',
      (value) => {
        if (
          detailTarget.current === target &&
          (value.operation === 'student-detail' || value.operation === 'cell-detail')
        )
          setDetail(value);
      },
    );
  }
  async function refresh(forceDashboard = false) {
    if (busy.matrix || failure === 'not-authorized') return;
    const target = detailTarget.current;
    if (!dashboardEnabled && !forceDashboard) {
      if (target) return readDetail(target);
      return;
    }
    const refreshed = await loadDashboard(filters);
    if (refreshed !== true) return refreshed;
    if (target && detailTarget.current === target) return readDetail(target);
    return true;
  }
  useLiveRefreshV1(refresh, {
    domains: ['gradebook'],
    // The whole class is read at once: the heavy cadence, as in the other perspectives.
    intervalMs: LIVE_HEAVY_READ_INTERVAL_V1,
    enabled: year !== null && (dashboardEnabled || detailOpen),
    active: isActive,
    canRefresh: () =>
      filters.classId !== null && !busy.matrix && !busy.detail && failure !== 'not-authorized',
  });
  useEffect(() => {
    if (year !== null) writeSessionViewV1(filtersKeyV2(year), filters);
  }, [year, filters]);
  useEffect(() => {
    if (!restoring.current || year === null || !classes || classes.nextOffset != null) return;
    restoring.current = false;
    if (!classes.classes.some((item) => item.id === filters.classId)) {
      setFilters((current) => ({
        ...current,
        classId: null,
        lens: 'result',
        offerId: null,
        referencePeriod: null,
      }));
      return;
    }
    if (dashboardEnabled) void loadDashboard(filters);
    // Runs once, when the classes of the restored year arrive.
  }, [classes, year]);
  async function select(next: Partial<Filters>, forceDashboard = false) {
    const selected = { ...filters, ...next };
    if ('classId' in next && next.classId !== filters.classId) {
      selected.lens = 'result';
      selected.offerId = null;
      selected.referencePeriod = null;
      setOffers([]);
    }
    if (selected.lens !== 'assessments') selected.offerId = null;
    else selected.referencePeriod = null;
    if (
      selected.period === 'annual' ||
      selected.period === 1 ||
      (selected.referencePeriod !== null && selected.referencePeriod >= selected.period)
    )
      selected.referencePeriod = null;
    if (selected.statuses.length === 0) return;
    if (JSON.stringify(selected) === JSON.stringify(filters)) {
      await refresh(forceDashboard);
      return;
    }
    // The situations listed only filter the reading already on screen: nothing is read again.
    if (
      JSON.stringify({ ...selected, statuses: null }) ===
      JSON.stringify({ ...filters, statuses: null })
    ) {
      setFilters(selected);
      return;
    }
    // Only a real context/filter change clears the old data and closes its detail.
    setFilters(selected);
    closeDetail();
    gates.matrix.invalidate();
    setMatrix(null);
    setAnalysis(null);
    setComparison(null);
    setDashboard(null);
    setPreviousDashboard(null);
    setFailure(null);
    setBusy((value) => ({ ...value, matrix: false }));
    if (dashboardEnabled || forceDashboard) await loadDashboard(selected);
  }
  async function open(studentId: number, offerId?: number) {
    if (year === null || filters.classId === null) return;
    const target = {
      studentId,
      offerId,
      mode: dashboardEnabled ? filters.mode : ('regular' as const),
    };
    detailTarget.current = target;
    setDetail(null);
    setDetailOpen(true);
    await readDetail(target);
  }
  return {
    year,
    classes,
    filters,
    matrix,
    analysis,
    comparison,
    dashboard,
    previousDashboard,
    offers,
    detail,
    detailOpen,
    busy,
    failure,
    detailFailure,
    select,
    refresh,
    open,
    closeDetail,
    loadClasses,
  };
}
