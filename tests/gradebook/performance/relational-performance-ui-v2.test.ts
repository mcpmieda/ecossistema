import { performanceAnalyticsFixtureV6 } from './performance-analytics-fixture-v6';
import { requestPerformanceAnalyticsV6 } from '../../../src/features/gradebook/performance/performance-analytics-client-v6';
import { notifyLiveChangeV1 } from '../../../src/shared/live-data/live-refresh-v1';
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { buildPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import {
  projectPerformanceFactsV2,
  EMPTY_PERFORMANCE_CLOSING_V2,
} from '../../../server/gradebook/application/results/relational-performance-facts-v2';
import { performanceAnalysisRequestSchemaV3 } from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import { performanceTermComparisonResponseSchemaV4 } from '../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import { buildPerformanceDashboardOverviewV5 } from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GradebookWorkspaceShell } from '../../../src/platform/gradebook-workspace-shell';
import { requestRelationalPerformanceV2 } from '../../../src/features/gradebook/performance/relational-performance-client-v2';
import {
  performanceResponseMatchesV2,
  performanceResponseSchemaV2,
  type PerformanceRequestV2,
  type PerformanceStatusV2,
} from '../../../shared/gradebook-contracts/performance/relational-performance-v2';

const context = { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 };
const common = {
  transportVersion: 2,
  state: 'ready',
  context,
  readAt: '2026-05-01T12:00:00.000Z',
  authority: 'calculated-preview',
};
const offering = {
  id: 10,
  subject: { id: 1, label: 'MATEMATICA SINTETICA' },
  teacher: { id: 1, label: 'DOCENTE SINTETICO' },
};
const cell = {
  offerId: 10,
  valueMilli: 24000,
  maximumMilli: 30000,
  state: 'complete',
  level: 'at-or-above',
  sourceReferenceMilli: 24000,
  sourceComparison: 'match',
  recoveryApplicable: false,
  warningCodes: [],
};
const student = {
  id: 1,
  name: 'ALUNO SINTETICO',
  number: 1,
  status: null,
  statusLabel: 'Em curso',
  indicatorEligible: true,
};
const row = {
  student,
  calculatedAnnual: {
    state: 'in-progress',
    label: 'EM CURSO',
    councilEligibility: 'not-applicable',
  },
  formalCouncilDecision: null,
  cells: [cell],
};
const belowCell = {
  ...cell,
  valueMilli: 12000,
  state: 'partial',
  level: 'below',
  sourceReferenceMilli: 12000,
  sourceComparison: 'unavailable',
};
const belowStudent = {
  ...student,
  id: 2,
  name: 'OUTRO ALUNO SINTETICO',
  number: 2,
  status: 7,
  statusLabel: 'ESTAVA NO 6A',
};
const belowRow = { ...row, student: belowStudent, cells: [belowCell] };
const selected = { classGroup: { id: 10, label: 'A1' }, period: 1, mode: 'regular' };
const matrix = {
  ...common,
  ...selected,
  operation: 'matrix',
  offers: [offering],
  rows: [row, belowRow],
  comparison: { available: false, reason: 'comparability-not-contracted' },
  statistics: {
    classRows: 2,
    visibleRows: 2,
    eligibleRows: 2,
    recoveryUnknownRows: 0,
    consideredCells: 2,
    completeCells: 1,
    noShowCells: 0,
    incompleteCells: 1,
    attentionRows: 1,
  },
};
const request: PerformanceRequestV2 = {
  transportVersion: 2,
  operation: 'matrix',
  year: 2026,
  classId: 10,
  period: 1,
  mode: 'regular',
  statuses: [null, 7],
};
const catalog = {
  ...common,
  operation: 'classes',
  statusOptions: [
    { value: null, label: 'Em curso' },
    { value: 7, label: 'Estava no' },
  ],
  classes: [{ id: 10, label: 'A1' }],
  nextOffset: null,
};
let root: Root | null = null;
let host: HTMLDivElement;
let mock: ReturnType<typeof vi.fn<typeof fetch>>;
let requests: Record<string, unknown>[];
const reply = (data: unknown, status = 200) => Response.json(data, { status });

const animationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'scrollIntoView',
);
let scrollIntoView: ReturnType<typeof vi.fn>;
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  requests = [];
  mock = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.operation === 'bootstrap')
      return reply({
        contractVersion: 2,
        state: 'ready',
        operation: 'bootstrap',
        years: [context],
      });
    if (body.operation === 'classes')
      return reply({ ...catalog, context: { ...context, year: body.year } });
    if (body.operation === 'analytics')
      return reply(
        performanceAnalyticsFixtureV6({
          year: Number(body.year),
          classId: Number(body.classId),
          period: body.period as 1 | 2 | 3 | 'annual',
        }),
      );
    if (body.operation === 'term-comparison') return reply(comparisonFixture(body));
    if (body.operation === 'analysis') return reply(analysisFixture(body));
    if (body.operation === 'dashboard') return reply(dashboardFixture(body));
    if (body.operation === 'matrix')
      return reply({ ...matrix, period: body.period, mode: body.mode });
    if (body.operation === 'student-detail')
      return reply({
        ...common,
        ...selected,
        operation: 'student-detail',
        row,
        offers: [offering],
        trajectory: [{ offerId: 10, terms: [cell, cell, cell] }],
      });
    if (body.operation === 'cell-detail')
      return reply({
        ...common,
        ...selected,
        period: body.period,
        mode: body.mode,
        operation: 'cell-detail',
        student,
        offer: offering,
        terms: ([1, 2, 3] as const).map((term) => ({
          term,
          hasGrades: true,
          showParallel: false,
          showRecovery: false,
          regular: cell,
          recovery: {
            ...cell,
            valueMilli: null,
            state: 'not-applicable',
            level: 'not-classified',
            sourceReferenceMilli: null,
            sourceComparison: 'unavailable',
          },
          quantitativeOriginalMilli: 12000,
          quantitativeConsideredMilli: 12000,
          qualitativeMilli: 12000,
          parallelMilli: null,
          parallelApplicable: false,
          instruments: [
            {
              slot: 1,
              label: `AVALIAÇÃO SINTÉTICA T${term}`,
              maximumMilli: 6750,
              valueMilli: 6000,
            },
          ],
        })),
      });
    throw new Error('unexpected-synthetic-request');
  });
  vi.stubGlobal('fetch', mock);
  host = document.createElement('div');
  document.body.appendChild(host);
  window.location.hash = '#/banco-de-notas?area=performance';
});
afterEach(async () => {
  if (root)
    await act(async () => {
      root!.unmount();
    });
  root = null;
  host.remove();
  vi.unstubAllGlobals();
  if (animationsDescriptor)
    Object.defineProperty(Element.prototype, 'getAnimations', animationsDescriptor);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  if (scrollIntoViewDescriptor)
    Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await settle();
  }
  expect(predicate()).toBe(true);
}
async function mount() {
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(GradebookWorkspaceShell));
  });
  await settle();
}
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLElement>('button,[role=tab]')].find(
    (element) => element.textContent === text,
  );
  if (!button) throw new Error(`missing-button:${text}`);
  await act(async () => {
    button.click();
  });
  await settle();
}
async function closeDetail() {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Fechar detalhe"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  await waitFor(() => document.querySelector('[data-slot="drawer-body"]') === null);
}
function selectRoot(label: string) {
  return (
    [...document.querySelectorAll<HTMLElement>('[data-slot="select"]')].find(
      (element) => element.querySelector('[data-slot="label"]')?.textContent === label,
    ) ?? null
  );
}
function selectTrigger(label: string) {
  return (
    selectRoot(label)?.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]') ?? null
  );
}
function selectedValue(label: string) {
  if (label === 'Período') {
    const key = document
      .querySelector('[role="tablist"][aria-label="Período"] [aria-selected="true"]')
      ?.getAttribute('data-key');
    return key === 'annual' ? 'Ano completo' : key ? `${key}º trimestre` : null;
  }
  return (
    selectRoot(label)?.querySelector<HTMLElement>('[data-slot="select-value"]')?.textContent ?? null
  );
}
async function select(label: string, value: string) {
  if (label === 'Período') {
    // The period is a row of buttons in the header.
    const selector = `[role="tablist"][aria-label="Período"] [data-key="${value}"]`;
    await waitFor(() => Boolean(document.querySelector(selector)));
    await act(async () => document.querySelector<HTMLElement>(selector)!.click());
    await settle();
    return;
  }
  if (label === 'Turma') {
    await waitFor(() =>
      Boolean(
        document.querySelector(
          `[role="tablist"][aria-label="Turmas de Desempenho"] [data-key="${value}"]`,
        ),
      ),
    );
    const tab = document.querySelector<HTMLElement>(
      `[role="tablist"][aria-label="Turmas de Desempenho"] [data-key="${value}"]`,
    )!;
    await act(async () => tab.click());
    await settle();
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const element = selectRoot(label)?.querySelector(
      'select',
    ) as unknown as HTMLSelectElement | null;
    if (
      element &&
      !element.disabled &&
      [...element.options].some((option) => option.value === value)
    )
      break;
    await settle();
  }
  const element = selectRoot(label)?.querySelector('select') as unknown as HTMLSelectElement | null;
  expect(element).not.toBeNull();
  await act(async () => {
    element!.value = value;
    element!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function loaded() {
  await mount();
  // A cold module load (test run alone) can take longer than one settle to show the shell.
  await waitFor(() =>
    [...document.querySelectorAll('button,[role=tab]')].some(
      (element) => element.textContent === 'Notas',
    ),
  );
  await click('Notas');
  await select('Turma', '10');
  await waitFor(
    () =>
      host.textContent?.includes(student.name) === true &&
      requests.some((value) => value.operation === 'dashboard'),
  );
}

describe('V2 contract and transport', () => {
  it('validates the real matrix contract and matching scope', () => {
    const parsed = performanceResponseSchemaV2.parse(matrix);
    expect(performanceResponseMatchesV2(request, parsed)).toBe(true);
    expect(performanceResponseMatchesV2({ ...request, year: 2025 }, parsed)).toBe(false);
  });
  it('uses no-store, same-origin and an abort signal', async () => {
    const controller = new AbortController();
    expect(await requestRelationalPerformanceV2(request, controller.signal)).toMatchObject({
      state: 'ready',
    });
    expect(mock).toHaveBeenCalledWith(
      '/api/gradebook/performance',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([401, 403])('normalizes a legacy opaque authorization failure (%i)', async (status) => {
    mock.mockResolvedValueOnce(reply({ transportVersion: 1, state: 'not-authorized' }, status));
    expect(await requestRelationalPerformanceV2(request)).toEqual({
      transportVersion: 2,
      state: 'not-authorized',
    });
  });
  it.each([
    { ...matrix, context: { ...context, year: 2025 } },
    { ...matrix, rows: [row, row] },
    { ...matrix, offers: [] },
    { ...matrix, period: 3 },
    { ...matrix, authority: 'official' },
  ])('rejects mismatched, duplicate or falsely official data', async (bad) => {
    mock.mockResolvedValueOnce(reply(bad));
    expect(await requestRelationalPerformanceV2(request)).toMatchObject({ state: 'unavailable' });
  });
  it('does not treat a failing HTTP status with a ready body as success', async () => {
    mock.mockResolvedValueOnce(reply(matrix, 500));
    expect(await requestRelationalPerformanceV2(request)).toMatchObject({ state: 'unavailable' });
  });
});

describe('real shell, shared year and rendered performance journey', () => {
  it('loads only the global year catalogue in Importation', async () => {
    window.location.hash = '#/banco-de-notas';
    await mount();
    expect(requests.filter((value) => value.operation === 'bootstrap')).toHaveLength(1);
    expect(
      requests.filter((value) =>
        ['classes', 'matrix', 'analysis', 'dashboard'].includes(String(value.operation)),
      ),
    ).toHaveLength(0);
    // The year is chosen in the settings of the Centro; Importation does not depend on it and
    // shows nothing about it unless it could not be read.
    expect(host.querySelector('[aria-label="Contexto acadêmico atual"]')).toBeNull();
  });
  it('loads the global catalogue and uses its selected year without browser persistence', async () => {
    await mount();
    await waitFor(() =>
      requests.some((value) => value.operation === 'classes' && value.year === 2026),
    );
    expect(document.querySelector('select[aria-label="Ano letivo do Banco"]')).toBeNull();
    expect(host.querySelector('[aria-label="Contexto acadêmico atual"]')?.textContent).toContain(
      '2026',
    );
    expect(requests.filter((value) => value.operation === 'bootstrap')).toHaveLength(1);
  });
  it('places the period first, uses class tabs, and hands open local filters off without an extra click', async () => {
    await loaded();
    expect(selectRoot('Turma')).toBeNull();
    const classTabs = document.querySelector(
      '[role="tablist"][aria-label="Turmas de Desempenho"]',
    )!;
    const period = document.querySelector('[role="tablist"][aria-label="Período"]')!;
    expect(selectRoot('Período')).toBeNull();
    expect(
      period.compareDocumentPosition(classTabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () => selectTrigger('Modo')!.click());
    await settle();
    expect(selectRoot('Modo')?.hasAttribute('data-open')).toBe(true);
    await act(async () =>
      selectTrigger('Comparar com')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    );
    await settle();
    expect(selectRoot('Modo')?.hasAttribute('data-open')).toBe(false);
    await act(async () =>
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    );
    await settle();
    expect(selectRoot('Comparar com')?.hasAttribute('data-open')).toBe(false);
  });
  it('loads shared year, class and matrix, then closes the student drawer without leaving Performance', async () => {
    await loaded();
    expect(host.textContent).toContain('Desempenho');
    expect(host.textContent).toContain(student.name);
    expect(host.querySelectorAll('select[aria-label="Ano letivo do Banco"]')).toHaveLength(0);
    await click(student.name);
    expect(document.body.textContent).not.toContain('Conselho anterior');
    expect(document.body.textContent).not.toContain('Ver cadastro nas Centrais');
    expect(requests.filter((value) => value.operation === 'dashboard')).toHaveLength(1);
    expect(requests.filter((value) => value.operation === 'student-detail')).toHaveLength(1);
    await closeDetail();
    expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
    expect(host.textContent).toContain(student.name);
    expect(requests.some((value) => value.operation === 'center')).toBe(false);
  });
  it.each([2, 3] as const)(
    'opens a component detail at trimester %i selected in the matrix',
    async (period) => {
      await loaded();
      await select('Período', String(period));
      await waitFor(() =>
        requests.some((value) => value.operation === 'dashboard' && value.period === period),
      );
      const grade = host.querySelector<HTMLButtonElement>(
        `button[aria-label="${student.name}, ${offering.subject.label}"]`,
      );
      expect(grade).not.toBeNull();
      await act(async () => {
        grade!.click();
      });
      await waitFor(() =>
        requests.some((value) => value.operation === 'cell-detail' && value.period === period),
      );
      await waitFor(() => scrollIntoView.mock.calls.length === 1);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect((scrollIntoView.mock.contexts[0] as Element).getAttribute('aria-label')).toBe(
        `${period}º trimestre`,
      );
    },
  );
  it('updates the matrix immediately from the multiple status tags', async () => {
    await loaded();
    const group = host.querySelector('[data-slot="tag-group"]');
    expect(group?.textContent).toContain('Situações exibidas');
    const labelledBy = group
      ?.querySelector('[data-slot="tag-group-list"]')
      ?.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy!.split(' ')[0]!)?.textContent).toBe(
      'Situações exibidas',
    );
    const tags = [...group!.querySelectorAll<HTMLElement>('[data-slot="tag"]')];
    expect(tags.map((tag) => tag.textContent)).toEqual(['Em curso', 'Estava no']);
    expect(tags.every((tag) => tag.getAttribute('data-selected') === 'true')).toBe(true);
    const read = requests.filter((value) => value.operation === 'dashboard');
    expect(read).toHaveLength(1);
    // One reading brings every situation; the tags only choose which ones are listed.
    expect(read[0]!.statuses).toEqual([null, 1, 2, 3, 4, 5, 7]);
    await act(async () => {
      tags[1]!.click();
    });
    await waitFor(() => tags[1]!.getAttribute('data-selected') !== 'true');
    expect(requests.filter((value) => value.operation === 'dashboard')).toHaveLength(1);
  });
  it('reopens the same student after closing without discarding the performance matrix', async () => {
    await loaded();
    await click(student.name);
    await closeDetail();
    await click(student.name);
    await waitFor(() => requests.filter((value) => value.operation === 'student-detail').length === 2);
    expect(document.querySelector('[data-slot="drawer-heading"]')?.textContent).toBe(student.name);
    await closeDetail();
    expect(requests.filter((value) => value.operation === 'dashboard')).toHaveLength(1);
    expect(requests.some((value) => value.operation === 'center')).toBe(false);
  });
  it('cancels a pending student detail on close and ignores its late response', async () => {
    await loaded();
    const original = mock.getMockImplementation()!;
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((accept) => { resolve = accept; });
    mock.mockImplementationOnce(() => pending);
    await click(student.name);
    const pendingCall = mock.mock.calls.at(-1)!;
    const pendingSignal = pendingCall[1]?.signal;
    expect(
      [...document.querySelectorAll('output')].some((item) => item.textContent?.includes('Carregando detalhe')),
    ).toBe(true);
    await closeDetail();
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => { resolve(await original(...pendingCall)); });
    await settle();
    expect(document.querySelector('[data-slot="drawer-body"]')).toBeNull();
    expect(requests.filter((value) => value.operation === 'dashboard')).toHaveLength(1);
  });
  it('drops a late old-period response rather than replacing the current trimester', async () => {
    await loaded();
    let resolve!: (response: Response) => void;
    let pendingSignal: AbortSignal | null | undefined;
    mock.mockImplementationOnce(
      (_input, init) =>
        new Promise((accept) => {
          pendingSignal = init?.signal;
          resolve = accept;
        }),
    );
    await select('Período', '2');
    await select('Período', '3');
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => {
      resolve(reply(dashboardFixture({ period: 2, referencePeriod: null })));
    });
    expect(selectedValue('Período')).toBe('3º trimestre');
    // The current trimester, then the one before for the arrows of the chart.
    expect(
      requests
        .filter((value) => value.operation === 'dashboard')
        .slice(-2)
        .map((value) => value.period),
    ).toEqual([3, 2]);
  });
  it('clears loaded student data after an authorization loss while keeping 2026 fixed', async () => {
    await loaded();
    mock.mockResolvedValueOnce(reply({}, 401));
    await select('Período', '2');
    expect(host.textContent).not.toContain(student.name);
    expect(host.textContent).toContain('Entre novamente');
    expect(document.querySelector('select[aria-label="Ano letivo do Banco"]')).toBeNull();
    expect(host.querySelector('[aria-label="Contexto acadêmico atual"]')?.textContent).toContain(
      '2026',
    );
  });
});

function analysisFixture(extra: Record<string, unknown> = {}) {
  const request = performanceAnalysisRequestSchemaV3.parse({
    transportVersion: 3,
    operation: 'analysis',
    year: 2026,
    classId: 10,
    period: 1,
    mode: 'regular',
    statuses: [null, 7],
    lens: 'result',
    offerId: null,
    ...extra,
  });
  const scopedRows = matrix.rows.filter((row) =>
    request.statuses.includes(row.student.status as PerformanceStatusV2),
  );
  const base = performanceResponseSchemaV2.parse({
    ...matrix,
    context: { ...context, year: request.year },
    period: request.period,
    mode: request.mode,
    rows: scopedRows,
    statistics: { ...matrix.statistics, visibleRows: scopedRows.length },
  });
  if (base.state !== 'ready' || base.operation !== 'matrix')
    throw new Error('invalid-synthetic-base');
  const facts = ([1, 2, 3] as const).flatMap((term) =>
    ([1, 2, 11] as const).map((slot) => ({
      term,
      slot,
      label: `ATIVIDADE SINTETICA ${slot}`,
      maximumMilli: slot === 11 ? (term === 3 ? 22000 : 16500) : term === 3 ? 9000 : 6750,
      valueMilli: slot === 11 ? 12000 : 6000,
    })),
  );
  const belowFacts = facts.map((fact) => ({ ...fact, valueMilli: fact.slot === 11 ? 4000 : 2000 }));
  return buildPerformanceAnalysisV3(
    base,
    new Map(
      [
        [1, [projectPerformanceFactsV2(10, facts, EMPTY_PERFORMANCE_CLOSING_V2, 60000)]] as const,
        [
          2,
          [projectPerformanceFactsV2(10, belowFacts, EMPTY_PERFORMANCE_CLOSING_V2, 60000)],
        ] as const,
      ].filter(([studentId]) => scopedRows.some((row) => row.student.id === studentId)),
    ),
    request,
  );
}

function comparisonFixture(extra: Record<string, unknown> = {}) {
  const analysis = analysisFixture({
    year: extra.year,
    classId: extra.classId,
    period: extra.period,
    mode: extra.mode,
    statuses: extra.statuses,
    lens: extra.lens,
    offerId: null,
  });
  const studentIds = analysis.rows.map((row) => row.studentId);
  return performanceTermComparisonResponseSchemaV4.parse({
    transportVersion: 4,
    operation: 'term-comparison',
    state: 'ready',
    authority: 'descriptive-observation',
    basis: 'percentage-points-of-official-maximum',
    referencePeriod: extra.referencePeriod,
    analysis,
    columns: analysis.columns.map((column) => ({
      key: column.key,
      offerId: column.offerId,
      label: column.label,
      summary: {
        comparable: studentIds.length,
        unavailable: 0,
        groups: { higher: studentIds, equal: [], lower: [], unavailable: [] },
      },
    })),
    rows: analysis.rows.map((row) => ({
      studentId: row.studentId,
      values: row.values.map((value) => ({
        key: value.key,
        state: 'comparable',
        currentPercent: value.percent,
        referencePercent: value.percent! - 10,
        deltaPercentagePoints: 10,
        relation: 'higher',
        reason: null,
      })),
    })),
  });
}

function dashboardFixture(extra: Record<string, unknown> = {}) {
  const allowed = new Set(['year', 'classId', 'period', 'mode', 'statuses', 'lens', 'offerId']);
  const analysisInput = Object.fromEntries(
    Object.entries(extra).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
  const analysis = analysisFixture(analysisInput);
  return {
    transportVersion: 5,
    operation: 'dashboard',
    state: 'ready',
    view:
      extra.referencePeriod === null || extra.referencePeriod === undefined
        ? analysis
        : comparisonFixture(extra),
    overview: buildPerformanceDashboardOverviewV5(analysis),
  };
}

describe('four lenses and analytical investigation V3', () => {
  it('offers only explicit prior-trimester comparisons and renders descriptive percentage-point differences', async () => {
    await loaded();
    expect(selectTrigger('Comparar com')?.disabled).toBe(true);
    await select('Período', '2');
    await select('Comparar com', '1');
    await waitFor(() =>
      requests.some((value) => value.operation === 'dashboard' && value.referencePeriod === 1),
    );
    expect(requests.at(-1)).toMatchObject({
      transportVersion: 5,
      operation: 'dashboard',
      year: 2026,
      period: 2,
      referencePeriod: 1,
      lens: 'result',
      offerId: null,
    });
    expect(host.textContent).toContain('T2 comparado ao T1');
    expect(host.textContent).toContain('+10 p.p.');
    expect(host.textContent).toContain('não mede evolução pedagógica');
    expect(
      host.querySelector(
        '[aria-label="Comparação entre trimestres"] button[aria-label^="Ver avaliações"]',
      ),
    ).toBeNull();
    await select('Período', '3');
    const comparisonOptions = [
      ...selectRoot('Comparar com')!.querySelectorAll<HTMLOptionElement>('option'),
    ].filter((option) => option.value !== '');
    expect(comparisonOptions.map((option) => option.value)).toEqual(['none', '1', '2']);
    await click('Avaliações');
    expect(selectTrigger('Comparar com')?.disabled).toBe(true);
  });
  it('changes all four lenses with one request per selection, not per student', async () => {
    await loaded();
    await click('Quantitativo');
    await waitFor(() =>
      requests
        .filter((value) => value.operation === 'dashboard')
        .some((value) => value.lens === 'quantitative'),
    );
    expect(host.textContent).toContain('88,9%');
    expect(host.querySelectorAll('[aria-label="Barras por componente curricular"]')).toHaveLength(
      1,
    );
    await click('Qualitativo');
    await waitFor(() =>
      requests
        .filter((value) => value.operation === 'dashboard')
        .some((value) => value.lens === 'qualitative'),
    );
    expect(host.textContent).toContain('72,7%');
    await click('Avaliações');
    expect(requests.filter((r) => r.operation === 'dashboard')).toHaveLength(3);
    await select('Componente das avaliações', '10');
    expect(host.textContent).toContain('ATIVIDADE SINTETICA');
    expect(requests.filter((r) => r.operation === 'dashboard')).toHaveLength(4);
    await click('Resultado');
    expect(requests.filter((r) => r.operation === 'dashboard')).toHaveLength(5);
    expect(selectRoot('Componente das avaliações')).toBeNull();
  });
  it('lists the students of the chosen bar inside the chart without filtering the matrix', async () => {
    await loaded();
    expect(host.textContent).not.toContain('Quantidade de estudantes por faixa oficial');
    expect(host.textContent).not.toContain('Todos os componentes do recorte atual');
    expect(host.textContent).not.toContain('Todos no mínimo ou acima');
    // The ranking opens inside the panorama card, and its button goes back (15/10/2026).
    const ranking = host.querySelector(
      'button[aria-label="Classificação da turma: 10 maiores somatórios"]',
    ) as HTMLButtonElement;
    expect(ranking).not.toBeNull();
    expect(host.querySelector('.performance-bars__student-group--ranking')).toBeNull();
    await act(async () => {
      ranking.click();
    });
    await settle();
    expect(host.querySelector('.performance-bars__student-group--ranking')?.textContent).toContain(
      '12*',
    );
    await click('Voltar ao gráfico');
    expect(
      host.querySelector('.performance-status-chip--regular')?.getAttribute('aria-label'),
    ).toBe('Em curso');
    expect(host.querySelector('.performance-status-chip--origin')?.getAttribute('aria-label')).toBe(
      'ESTAVA NO 6A',
    );
    expect(host.querySelector('.performance-status-chip--origin')?.textContent).toBe(
      'ESTAVA NO 6A',
    );
    const bar = host.querySelector(
      'button[aria-label="MATEMATICA SINTETICA: 1 estudante(s) no mínimo ou acima"]',
    ) as HTMLButtonElement;
    expect(bar).not.toBeNull();
    await act(async () => {
      bar.click();
    });
    await settle();
    expect(host.querySelector('[aria-label="Barras por componente curricular"]')).toBeNull();
    expect(
      host.querySelector('[aria-label="1 estudante(s) no mínimo ou acima"]')?.textContent,
    ).toContain(student.name);
    expect(host.querySelector('[aria-label="1 estudante(s) abaixo do mínimo"]')).toBeNull();
    expect(host.querySelector('[aria-label="Matriz de Desempenho"]')?.textContent).toContain(
      student.name,
    );
    expect(host.querySelector('[aria-label="Matriz de Desempenho"]')?.textContent).toContain(
      belowStudent.name,
    );
    expect(host.textContent).toContain('a matriz permanece completa');
    await click('Voltar ao gráfico');
    const redBar = host.querySelector(
      'button[aria-label="MATEMATICA SINTETICA: 1 estudante(s) abaixo do mínimo"]',
    ) as HTMLButtonElement;
    await act(async () => {
      redBar.click();
    });
    await settle();
    expect(host.querySelector('[aria-label="1 estudante(s) no mínimo ou acima"]')).toBeNull();
    expect(
      host.querySelector('[aria-label="1 estudante(s) abaixo do mínimo"]')?.textContent,
    ).toContain(belowStudent.name);
    expect(host.textContent).not.toContain('Ver estatísticas');
    await click('Voltar ao gráfico');
    expect(host.querySelector('[aria-label="1 estudante(s) abaixo do mínimo"]')).toBeNull();
    expect(requests.filter((r) => r.operation === 'dashboard')).toHaveLength(1);
  });
  it('discards a late quantitative response after the user selects qualitative', async () => {
    await loaded();
    let resolve!: (response: Response) => void;
    mock.mockImplementationOnce(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    await click('Quantitativo');
    const signal = mock.mock.calls.at(-1)?.[1]?.signal;
    await click('Qualitativo');
    await waitFor(() =>
      requests.some((value) => value.operation === 'dashboard' && value.lens === 'qualitative'),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve(reply(dashboardFixture({ lens: 'quantitative', referencePeriod: null })));
    });
    expect(host.textContent).toContain('72,7%');
    expect(requests.filter((value) => value.operation === 'dashboard').at(-1)?.lens).toBe(
      'qualitative',
    );
  });
});

async function loadedAnalytics() {
  await mount();
  await select('Turma', '10');
  await waitFor(() => host.querySelector('[data-testid="performance-analytics-v6"]') !== null);
}
const analyticsCalls = () => requests.filter((item) => item.operation === 'analytics').length;
describe('V6 HeroUI perspectives and shared live invalidation', () => {
  it('opens number-first overview and reuses one snapshot across all five analytical perspectives', async () => {
    await loadedAnalytics();
    expect(host.textContent).toContain('Desempenho médio');
    expect(host.textContent).toContain('Trajetória trimestral');
    expect(analyticsCalls()).toBe(1);
    expect(requests.some((item) => item.operation === 'dashboard')).toBe(false);
    for (const tab of ['Turmas', 'Alunos', 'Componentes', 'Professores', 'Visão geral'])
      await click(tab);
    expect(analyticsCalls()).toBe(1);
    expect(host.textContent).not.toContain('Erro inesperado');
    expect(selectRoot('Modo')).toBeNull();
    expect(selectRoot('Comparar com')).toBeNull();
  });
  it('preserves global term and local student selection across perspectives without extra fetches', async () => {
    await loadedAnalytics();
    await click('Alunos');
    await select('Aluno', '2');
    await click('Turmas');
    await click('Alunos');
    expect(selectedValue('Aluno')).toContain('Aluno exemplo 02');
    expect(analyticsCalls()).toBe(1);
    await select('Período', '2');
    await waitFor(
      () =>
        analyticsCalls() === 2 &&
        host.querySelector('[data-testid="performance-analytics-v6"]') !== null,
    );
    expect(selectedValue('Aluno')).toContain('Aluno exemplo 02');
    expect(selectedValue('Período')).toBe('2º trimestre');
  });
  it('retains visible data and table state while an invalidation is in flight', async () => {
    await loadedAnalytics();
    await click('Turmas');
    const original = mock.getMockImplementation()!;
    let release: ((response: Response) => void) | undefined;
    mock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.operation === 'analytics') {
        requests.push(body);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return original(url, init);
    });
    const table = host.querySelector('[aria-label="Mapa da turma por componente"]');
    await act(async () => notifyLiveChangeV1('gradebook'));
    await waitFor(() => release !== undefined);
    expect(host.querySelector('[aria-label="Carregando indicadores"]')).toBeNull();
    expect(host.querySelector('[aria-label="Mapa da turma por componente"]')).toBe(table);
    await act(async () => release!(reply(performanceAnalyticsFixtureV6({ revision: 7 }))));
    await settle();
    expect(host.querySelector('[aria-label="Mapa da turma por componente"]')).toBe(table);
    expect(analyticsCalls()).toBe(2);
  });
  it('drops a delayed previous-term response after a new global period selection', async () => {
    await loadedAnalytics();
    const original = mock.getMockImplementation()!;
    let release: ((response: Response) => void) | undefined;
    mock.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.operation === 'analytics' && body.period === 2) {
        requests.push(body);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return original(url, init);
    });
    await select('Período', '2');
    await waitFor(() => release !== undefined);
    await select('Período', '3');
    await waitFor(() => host.querySelector('[data-testid="performance-analytics-v6"]') !== null);
    const text = host.querySelector('[data-testid="performance-analytics-v6"]')!.textContent;
    await act(async () =>
      release!(reply(performanceAnalyticsFixtureV6({ period: 2, revision: 9 }))),
    );
    await settle();
    expect(selectedValue('Período')).toBe('3º trimestre');
    expect(host.querySelector('[data-testid="performance-analytics-v6"]')!.textContent).toBe(text);
  });
  it('suspends analytics in a hidden bank area and revalidates when returning', async () => {
    await loadedAnalytics();
    await click('Alunos');
    await select('Aluno', '2');
    await act(async () => {
      window.location.hash = '#/banco-de-notas?area=importacao';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const before = analyticsCalls();
    await act(async () => {
      notifyLiveChangeV1('gradebook');
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(analyticsCalls()).toBe(before);
    await act(async () => {
      window.location.hash = '#/banco-de-notas?area=performance';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => analyticsCalls() === before + 1);
    expect(selectedValue('Aluno')).toContain('Aluno exemplo 02');
  });
  it('uses regular facts for analytics drilldown after using recovery mode in Notes', async () => {
    await loadedAnalytics();
    await click('Notas');
    await select('Modo', 'recovery');
    await click('Componentes');
    await waitFor(() => host.textContent?.includes('Instrumentos') === true);
    await click('Aluno exemplo 01');
    await waitFor(() => requests.some((item) => item.operation === 'cell-detail'));
    expect(requests.filter((item) => item.operation === 'cell-detail').at(-1)).toMatchObject({
      mode: 'regular',
      offerId: 10,
      studentId: 1,
    });
  });
  it('opens the existing assessment lens directly from a component', async () => {
    await loadedAnalytics();
    await click('Componentes');
    await click('Notas por instrumento');
    await waitFor(() =>
      requests.some((item) => item.operation === 'dashboard' && item.lens === 'assessments'),
    );
    expect(requests.filter((item) => item.operation === 'dashboard').at(-1)).toMatchObject({
      lens: 'assessments',
      offerId: 10,
    });
    expect(selectRoot('Modo')).not.toBeNull();
  });
  it.each([401, 403])('removes visible analytics on authorization loss (%s)', async (status) => {
    await loadedAnalytics();
    mock.mockResolvedValueOnce(reply({ state: 'not-authorized' }, status));
    await act(async () => notifyLiveChangeV1('gradebook'));
    await waitFor(() => host.querySelector('[data-testid="performance-analytics-v6"]') === null);
    expect(host.textContent).toContain('autorização');
  });
  it('preserves the last valid snapshot with a short stale indication on a transient failure', async () => {
    await loadedAnalytics();
    mock.mockResolvedValueOnce(reply({ transportVersion: 6, state: 'unavailable' }, 503));
    await act(async () => notifyLiveChangeV1('gradebook'));
    await waitFor(() => host.textContent?.includes('Exibindo a última leitura') === true);
    expect(host.querySelector('[data-testid="performance-analytics-v6"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Carregando indicadores"]')).toBeNull();
  });
  it('validates scope and transport rather than trusting a mismatched analytics response', async () => {
    const query = {
      transportVersion: 6,
      operation: 'analytics',
      year: 2026,
      classId: 10,
      period: 1,
    } as const;
    const controller = new AbortController();
    expect(await requestPerformanceAnalyticsV6(query, controller.signal)).toMatchObject({
      state: 'ready',
    });
    expect(mock).toHaveBeenCalledWith(
      '/api/gradebook/performance',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      }),
    );
    for (const invalid of [
      performanceAnalyticsFixtureV6({ year: 2025 }),
      performanceAnalyticsFixtureV6({ classId: 20 }),
      performanceAnalyticsFixtureV6({ period: 3 }),
      { ...performanceAnalyticsFixtureV6(), authority: 'official' },
    ]) {
      mock.mockResolvedValueOnce(reply(invalid));
      expect(await requestPerformanceAnalyticsV6(query)).toMatchObject({ state: 'unavailable' });
    }
  });
});

it('keeps the granular drawer, focus and scroll stable during automatic revalidation', async () => {
  await loaded();
  await select('Período', '2');
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${student.name}, ${offering.subject.label}"]`,
      )!
      .click(),
  );
  await waitFor(() => scrollIntoView.mock.calls.length === 1);
  const body = document.querySelector<HTMLElement>('[data-slot="drawer-body"]')!;
  const heading = document.querySelector('[data-slot="drawer-heading"]');
  const closeButton = document.querySelector<HTMLButtonElement>('[aria-label="Fechar detalhe"]')!;
  body.scrollTop = 137;
  await act(async () => closeButton.focus());
  const baseline = requests.filter((r) => r.operation === 'cell-detail').length;
  await act(async () => notifyLiveChangeV1('gradebook'));
  await waitFor(() => requests.filter((r) => r.operation === 'cell-detail').length > baseline);
  await settle();
  await settle();
  expect(document.querySelector('[data-slot="drawer-body"]')).toBe(body);
  expect(document.querySelector('[data-slot="drawer-heading"]')).toBe(heading);
  expect(body.scrollTop).toBe(137);
  expect(document.activeElement).toBe(closeButton);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it('renders both granular statuses in the real detail and keeps the official trimester grade numerical', async () => {
  const original = mock.getMockImplementation()!;
  mock.mockImplementation(async (input, init) => {
    const response = await original(input, init);
    const request = JSON.parse(String(init?.body));
    if (request.operation !== 'cell-detail') return response;
    const data = performanceResponseSchemaV2.parse(await response.json());
    if (data.state !== 'ready' || data.operation !== 'cell-detail')
      throw new Error('Expected a ready synthetic cell detail');
    data.terms[1].instruments = [
      { slot: 1, label: 'AV1 SYNTHETIC', maximumMilli: 5000, valueMilli: null, notDone: true },
      { slot: 2, label: 'AV2 SYNTHETIC', maximumMilli: 5000, valueMilli: 0 },
      { slot: 11, label: 'Q1 SYNTHETIC', maximumMilli: 2000, valueMilli: null },
    ];
    return reply(data);
  });
  await loaded();
  await select('Período', '2');
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${student.name}, ${offering.subject.label}"]`,
      )!
      .click(),
  );
  await waitFor(() => Boolean(document.querySelector('[aria-label="Avaliações do 2º trimestre"]')));
  const table = document.querySelector('[aria-label="Avaliações do 2º trimestre"]')!;
  expect(table.textContent).toContain('Não fez');
  expect(table.textContent).toContain('Tirou zero');
  const rows = table.querySelectorAll('[data-slot="table-row"]');
  expect(rows[2]?.textContent).toContain('—');
  expect(document.querySelector('section[aria-label="2º trimestre"]')?.textContent).toContain(
    'Nota do trimestre24',
  );
});
