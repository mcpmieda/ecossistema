// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { learningFixtureV1 } from './learning-fixture-v1';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';
import {
  PerformanceAnalyticsWorkspaceV6,
} from '../../../src/features/gradebook/performance/performance-analytics-workspace-v6';
import {
  AnalyticsCompositionV6,
  AnalyticsCoverageV6,
  AnalyticsDistributionV6,
  AnalyticsRecoveryV6,
  AnalyticsTimelineV6,
} from '../../../src/features/gradebook/performance/performance-analytics-charts-v6';
import {
  analyticsDeltaV6 as delta,
  analyticsPercentV6 as percent,
} from '../../../src/features/gradebook/performance/analytics-format-v6';
import {
  PerformanceDashboardWidgetsV5,
} from '../../../src/features/gradebook/performance/performance-dashboard-widgets-v5';
import {
  PerformanceTermComparisonPanelV4,
} from '../../../src/features/gradebook/performance/performance-term-comparison-panel-v4';
import {
  buildPerformanceAnalysisV3,
} from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import {
  buildPerformanceDashboardOverviewV5,
} from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import {
  buildPerformanceTermComparisonV4,
} from '../../../server/gradebook/application/read-models/performance/performance-term-comparison-v4';
import {
  performanceAnalysisRequestSchemaV3,
} from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import {
  performanceTermComparisonRequestSchemaV4,
} from '../../../shared/gradebook-contracts/performance/performance-term-comparison-v4';
import type {
  PerformanceDashboardV5,
} from '../../../shared/gradebook-contracts/performance/performance-dashboard-v5';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

function valueAfter(label: string): string | null {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.parentElement?.querySelector('dd')?.textContent ?? null;
}

it('renders the overview KPI counts and the three exclusive situation groups from the proven payload', () => {
  const { value } = learningFixtureV1({ period: 2 });
  const { container } = render(
    <PerformanceAnalyticsWorkspaceV6
      value={value}
      tab="overview"
      selection={{ studentId: null, offerId: null, teacherId: null }}
      onSelection={vi.fn()}
      onNavigate={vi.fn()}
      onPeriod={vi.fn()}
      onCell={vi.fn()}
      onNotes={vi.fn()}
    />,
  );
  const evidence = new Map(
    value.learning!.students.map((item) => [item.studentId, item]),
  );
  const rising = value.students.filter(
    (student) => student.summary.movement.meanDeltaPP !== null &&
      student.summary.movement.meanDeltaPP > 0,
  ).length;
  const compared = value.students.filter(
    (student) => student.summary.movement.meanDeltaPP !== null,
  ).length;
  const attention = value.students.filter(
    (student) => (evidence.get(student.student.id)?.recurring.length ?? 0) > 0,
  ).length;
  const assessed = value.learning!.students.filter(
    (student) => student.recurrenceAssessed,
  ).length;
  const studentsWithResult = value.students.filter(
    (student) => student.summary.complete > 0,
  ).length;
  expect(
    screen.getByRole('button', { name: 'Ver alunos: Desempenho médio' }).textContent,
  ).toContain(percent(value.summary.result.mean));
  expect(
    screen.getByText(
      studentsWithResult + ' alunos com resultado · 2º trimestre',
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Ver alunos: Evolução trimestral' }).textContent,
  ).toContain(delta(value.summary.movement.meanDeltaPP));
  expect(screen.getByRole('button', { name: 'Ver alunos: Alunos em evolução' }).textContent)
    .toContain(String(rising));
  expect(screen.getByText('de ' + compared + ' alunos com comparação')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ver alunos: Atenção recorrente' }).textContent)
    .toContain(assessed ? String(attention) : '—');
  expect(screen.getByText(assessed + ' alunos com base para analisar')).toBeTruthy();

  const groups = [
    ['Na referência em todos', value.summary.studentsAtOrAbove],
    ['Abaixo em algum componente', value.summary.studentsBelow],
    ['Ainda sem conclusão', value.summary.studentsPending],
  ] as const;
  for (const [label, count] of groups) {
    const button = screen.getByText(label).closest('button');
    expect(button?.textContent).toContain(String(count));
  }
  expect(groups.reduce((sum, item) => sum + item[1], 0)).toBe(value.summary.students);
  const participationPanel = screen
    .getByText('Participação avaliada')
    .closest('[data-slot="card"]');
  expect(participationPanel?.textContent).toContain(
    percent(value.learning!.participation.percent),
  );
  if (value.learning!.participation.deltaPP !== null)
    expect(participationPanel?.textContent).toContain(
      delta(value.learning!.participation.deltaPP),
    );
  expect(
    screen.getByText(
      value.learning!.participation.students + ' alunos · ' +
      value.learning!.participation.recorded + ' notas consideradas',
    ),
  ).toBeTruthy();
  const recoverySummary = container.querySelector('.learning-recovery-summary');
  expect(recoverySummary?.textContent).toContain(
    String(value.learning!.parallel.students),
  );
  expect(recoverySummary?.textContent).toContain(
    'alunos melhoraram com a recuperação paralela',
  );

  for (const component of value.components) {
    const button = screen.getByRole('button', { name: component.offer.subject.label });
    expect(button.parentElement?.parentElement?.textContent).toContain(
      component.summary.below + ' abaixo da referência · ' +
      component.summary.complete + ' com resultado',
    );
  }

  expect(
    screen.getByText(
      'Base comum: ' + (value.learning?.dimensions.students ?? 0) + ' alunos.',
    ),
  ).toBeTruthy();
  const change = (student: (typeof value.students)[number]) =>
    student.summary.movement.meanDeltaPP;
  const belowUp = value.students.filter(
    (student) => student.summary.below > 0 && change(student) !== null && change(student)! > 0,
  ).length;
  const belowDown = value.students.filter(
    (student) => student.summary.below > 0 && change(student) !== null && change(student)! < 0,
  ).length;
  const aboveDown = value.students.filter(
    (student) =>
      student.summary.studentsAtOrAbove === 1 &&
      change(student) !== null &&
      change(student)! < 0,
  ).length;
  const priority = container.querySelector('.learning-priority');
  expect(priority).toBeTruthy();
  for (const [label, count] of [
    ['Abaixo, mas melhorando', belowUp],
    ['Abaixo e com queda', belowDown],
    ['Na referência, mas com queda', aboveDown],
  ] as const) {
    const button = [...priority!.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(label),
    );
    expect(button?.textContent).toContain(String(count));
  }
  expect(container.querySelector('.learning-list-heading')?.textContent)
    .toContain(String(attention));

  const instrumentByKey = new Map(
    value.components.flatMap((component) =>
      component.instruments.map((instrument) => [
        instrument.key,
        { ...instrument, offerId: component.offer.id },
      ] as const),
    ),
  );
  const reviewed = value.learning!.activitiesToReview
    .map((key) => instrumentByKey.get(key))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, 5);
  const activityButtons = container.querySelectorAll('.learning-activity');
  expect(activityButtons).toHaveLength(reviewed.length);
  reviewed.forEach((item, index) =>
    expect(activityButtons[index]?.textContent).toContain(
      item.below + ' de ' + item.stats.n + ' alunos abaixo',
    ),
  );
  expect(container.querySelector('.learning-footer')?.textContent).toContain(
    value.summary.students + '/' + value.classStudents + ' alunos',
  );
});


it('renders the selected student indicators with the exact proven student summary and evidence', () => {
  const { value } = learningFixtureV1({ period: 2 });
  const student = value.students[0]!;
  const evidence = value.learning!.students.find(
    (item) => item.studentId === student.student.id,
  )!;
  const { container } = render(
    <PerformanceAnalyticsWorkspaceV6
      value={value}
      tab="students"
      selection={{ studentId: student.student.id, offerId: null, teacherId: null }}
      onSelection={vi.fn()}
      onNavigate={vi.fn()}
      onPeriod={vi.fn()}
      onCell={vi.fn()}
      onNotes={vi.fn()}
    />,
  );
  const card = (label: string) =>
    screen.getByText(label).closest('[data-slot="card"]');

  expect(card('Desempenho atual')?.textContent).toContain(
    percent(student.summary.result.mean),
  );
  expect(card('Desempenho atual')?.textContent).toContain(
    student.summary.complete + ' componentes com resultado',
  );
  expect(card('Evolução trimestral')?.textContent).toContain(
    delta(student.summary.movement.meanDeltaPP),
  );
  expect(card('Atenção recorrente')?.textContent).toContain(
    evidence.recurrenceAssessed ? String(evidence.recurring.length) : '—',
  );
  expect(card('Atenção recorrente')?.textContent).toContain(
    student.summary.below + ' componentes abaixo da referência agora',
  );
  expect(card('Participação avaliada')?.textContent).toContain(
    percent(evidence.participation.percent),
  );

  for (const item of student.summary.timeline)
    expect(
      screen.getByRole('button', {
        name:
          'Consultar ' + item.term + 'º trimestre: ' +
          percent(item.mean) + ', ' + item.n + ' resultados',
      }),
    ).toBeTruthy();

  const quantitative = screen.queryByRole('meter', { name: 'Quantitativo' });
  const qualitative = screen.queryByRole('meter', { name: 'Qualitativo' });
  if (evidence.dimensions?.quantitativePercent === null)
    expect(quantitative).toBeNull();
  else
    expect(Number(quantitative?.getAttribute('aria-valuenow'))).toBeCloseTo(
      evidence.dimensions?.quantitativePercent ?? 0,
    );
  if (evidence.dimensions?.qualitativePercent === null)
    expect(qualitative).toBeNull();
  else
    expect(Number(qualitative?.getAttribute('aria-valuenow'))).toBeCloseTo(
      evidence.dimensions?.qualitativePercent ?? 0,
    );
  expect(
    screen.getByText(
      'Componentes comparados: ' + (evidence.dimensions?.components ?? 0) + '.',
    ),
  ).toBeTruthy();

  const recurring = screen
    .getByRole('heading', { name: 'Dificuldades que se repetem' })
    .closest('[data-slot="card"]');
  const recurringLabels = new Set(
    evidence.recurring.map(
      (item) =>
        value.components.find((component) => component.offer.id === item.offerId)
          ?.offer.subject.label,
    ),
  );
  const recurringButtons = recurring
    ? [...recurring.querySelectorAll('button')].filter((button) =>
        [...recurringLabels].some(
          (label) => label !== undefined && button.textContent?.includes(label),
        ),
      )
    : [];
  expect(recurringButtons).toHaveLength(evidence.recurring.length);
  expect(
    screen.getByRole('grid', { name: 'Componentes do aluno' })
      .querySelectorAll('tbody tr'),
  ).toHaveLength(student.cells.length);
  if (evidence.parallelImprovements > 0)
    expect(container.textContent).toContain(
      evidence.parallelImprovements + ' resultado(s) melhoraram com recuperação paralela.',
    );
});


it.each(['classes', 'components', 'teachers'] as const)(
  'renders exact selected-summary counts in the %s perspective',
  (tab) => {
    const { value } = learningFixtureV1({ period: 2 });
    const component = value.components[0]!;
    const teacher = value.teachers[0]!;
    const summary =
      tab === 'components'
        ? component.summary
        : tab === 'teachers'
          ? teacher.summary
          : value.summary;
    render(
      <PerformanceAnalyticsWorkspaceV6
        value={value}
        tab={tab}
        selection={{
          studentId: null,
          offerId: component.offer.id,
          teacherId: teacher.id,
        }}
        onSelection={vi.fn()}
        onNavigate={vi.fn()}
        onPeriod={vi.fn()}
        onCell={vi.fn()}
        onNotes={vi.fn()}
      />,
    );

    const kpi = (label: string) =>
      screen
        .getByRole('button', { name: 'Sobre ' + label })
        .closest('[data-slot="card"]');
    expect(kpi('Aproveitamento')?.textContent).toContain(
      percent(summary.result.mean),
    );
    expect(kpi('Aproveitamento')?.textContent).toContain(
      summary.result.n + '/' + summary.readings + ' resultados considerados',
    );
    expect(kpi('Mediana')?.textContent).toContain(percent(summary.result.median));
    expect(kpi('Alunos abaixo')?.textContent).toContain(
      String(summary.studentsBelow),
    );
    expect(kpi('Alunos abaixo')?.textContent).toContain(
      summary.students + ' alunos considerados',
    );
    expect(kpi('Notas lançadas')?.textContent).toContain(
      percent(summary.coverage.percent),
    );
    expect(kpi('Notas lançadas')?.textContent).toContain(
      summary.coverage.recorded +
        '/' +
        summary.coverage.expected +
        ' instrumentos',
    );
    expect(valueAfter('REC aplicável')).toBe(String(summary.recovery.applicable));
    expect(valueAfter('REC lançada')).toBe(String(summary.recovery.recorded));
    expect(valueAfter('REC pendente')).toBe(String(summary.recovery.pending));
    expect(valueAfter('Resultados considerados')).toBe(String(summary.complete));
    // The marker of blank instruments is counted from the cells of the scope on screen.
    const offers = tab === 'components' ? [component.offer.id] : tab === 'teachers' ? teacher.offerIds : null;
    expect(valueAfter('Desses, com instrumento em branco')).toBe(String(value.students.reduce((sum, item) => sum +
      item.cells.filter((cell) => (offers === null || offers.includes(cell.offerId)) &&
        cell.result.state === 'partial').length, 0)));
    expect(valueAfter('Sem nota')).toBe(String(summary.missing));
    expect(valueAfter('Zeros registrados')).toBe(String(summary.coverage.zeros));

    if (tab !== 'classes') {
      for (const item of summary.timeline)
        expect(
          screen.getByRole('button', {
            name:
              'Consultar ' +
              item.term +
              'º trimestre: ' +
              percent(item.mean) +
              ', ' +
              item.n +
              ' leituras',
          }),
        ).toBeTruthy();
      expect(
        screen.getByText(summary.composition.n + ' pares de resultados'),
      ).toBeTruthy();
    }

    if (tab === 'classes') {
      const figure = screen.getByRole('figure', {
        name: 'Distribuição por faixa de aproveitamento',
      });
      expect(figure.querySelector('figcaption')?.textContent).toBe(
        summary.distribution
          .map((bin) => bin.label + ': ' + bin.count)
          .join('; '),
      );
      for (const item of value.components) {
        const button = screen.getByRole('button', {
          name: item.offer.subject.label,
        });
        expect(button.parentElement?.parentElement?.textContent).toContain(
          item.summary.complete +
            '/' +
            item.summary.readings +
            ' resultados · ' +
            item.summary.below +
            ' abaixo',
        );
      }
    }

    if (tab === 'components') {
      const grid = screen.getByRole('grid', {
        name: 'Aproveitamento por instrumento',
      });
      expect(within(grid).getAllByRole('row')).toHaveLength(
        component.instruments.length + 1,
      );
      for (const instrument of component.instruments)
        expect(grid.textContent).toContain(
          instrument.coverage.recorded +
            '/' +
            instrument.coverage.expected,
        );
    }

    if (tab === 'teachers') {
      const teacherComponents = value.components.filter((item) =>
        teacher.offerIds.includes(item.offer.id),
      );
      for (const item of teacherComponents) {
        const button = screen.getByRole('button', {
          name: item.offer.subject.label,
        });
        expect(button.parentElement?.parentElement?.textContent).toContain(
          item.summary.complete +
            '/' +
            item.summary.readings +
            ' resultados · ' +
            item.summary.below +
            ' abaixo',
        );
      }
    }
  },
);

it('renders timeline, histogram, composition, recovery and coverage with the exact payload denominators', () => {
  const { value } = learningFixtureV1({ period: 2 });
  const { container } = render(
    <div>
      <AnalyticsTimelineV6 summary={value.summary} onPeriod={vi.fn()} schoolLanguage />
      <AnalyticsDistributionV6 summary={value.summary} />
      <AnalyticsCompositionV6 summary={value.summary} />
      <AnalyticsRecoveryV6 summary={value.summary} />
      <AnalyticsCoverageV6
        summary={value.summary}
        partial={value.students.reduce((sum, item) => sum +
          item.cells.filter((cell) => cell.result.state === 'partial').length, 0)}
      />
    </div>,
  );

  for (const item of value.summary.timeline)
    expect(
      screen.getByRole('button', {
        name:
          'Consultar ' + item.term + 'º trimestre: ' +
          percent(item.mean) + ', ' + item.n + ' resultados',
      }),
    ).toBeTruthy();

  const distribution = container.querySelector('figcaption');
  expect(distribution?.textContent).toBe(
    value.summary.distribution
      .map((bin) => bin.label + ': ' + bin.count)
      .join('; '),
  );
  expect(value.summary.distribution.reduce((sum, bin) => sum + bin.count, 0))
    .toBe(value.summary.result.n);

  const composition = screen.getByRole('img', { name: /Participação nos pontos/ });
  expect(composition.getAttribute('aria-label')).toBe(
    'Participação nos pontos: quantitativo ' +
      percent(value.summary.composition.quantitativeShare) +
      ', qualitativo ' +
      percent(value.summary.composition.qualitativeShare),
  );
  expect(screen.getByText(value.summary.composition.n + ' pares de resultados')).toBeTruthy();

  expect(valueAfter('REC aplicável')).toBe(String(value.summary.recovery.applicable));
  expect(valueAfter('REC lançada')).toBe(String(value.summary.recovery.recorded));
  expect(valueAfter('REC pendente')).toBe(String(value.summary.recovery.pending));
  expect(valueAfter('N/C')).toBe(String(value.summary.recovery.noShow));
  expect(valueAfter('R/R')).toBe(String(value.summary.recovery.repeatFailure));
  expect(
    screen.getByText(
      'Paralela aplicada: ' +
      value.summary.parallel.applied +
      '/' +
      value.summary.parallel.applicable,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Aplicabilidade indefinida: ' + value.summary.recovery.unknown,
    ),
  ).toBeTruthy();

  expect(valueAfter('Resultados considerados')).toBe(String(value.summary.complete));
  expect(valueAfter('Desses, com instrumento em branco')).toBe(String(value.students.reduce((sum, item) => sum +
    item.cells.filter((cell) => cell.result.state === 'partial').length, 0)));
  expect(valueAfter('Sem nota')).toBe(String(value.summary.missing));
  expect(valueAfter('Indisponíveis')).toBe(String(value.summary.unavailable));
  expect(valueAfter('Zeros registrados')).toBe(String(value.summary.coverage.zeros));
  expect(valueAfter('Lançamentos ausentes')).toBe(String(value.summary.coverage.missing));
});

it('renders every Notas V5 component bar, class panorama and completeness KPI from server aggregates', () => {
  const { matrix, projections } = learningFixtureV1({ period: 2 });
  const request = performanceAnalysisRequestSchemaV3.parse({
    transportVersion: 3,
    operation: 'analysis',
    year: matrix.context.year,
    classId: matrix.classGroup.id,
    period: matrix.period,
    mode: 'regular',
    statuses: [null, 7],
    lens: 'result',
    offerId: null,
  });
  const analysis = buildPerformanceAnalysisV3(matrix, projections, request);
  const dashboard: PerformanceDashboardV5 = {
    transportVersion: 5,
    operation: 'dashboard',
    state: 'ready',
    view: analysis,
    overview: buildPerformanceDashboardOverviewV5(analysis),
  };
  const { container } = render(
    <PerformanceDashboardWidgetsV5
      value={dashboard}
      selection={null}
      onSelectionChange={vi.fn()}
      open={vi.fn()}
    />,
  );
  const kpis = screen.getByLabelText('Resumo da turma').querySelectorAll('.performance-kpi');
  expect(kpis[0]?.textContent).toContain(
    analysis.matrix.statistics.visibleRows + 'estudantes',
  );
  expect(kpis[1]?.textContent).toContain(
    dashboard.overview.students.withBelow + 'abaixo do mínimo',
  );
  const completePercent =
    analysis.matrix.statistics.consideredCells === 0
      ? 0
      : (analysis.matrix.statistics.completeCells /
          analysis.matrix.statistics.consideredCells) *
        100;
  expect(kpis[2]?.textContent).toContain(
    number.format(completePercent) + '%completos',
  );
  // The fourth indicator only exists while some student waits for a classification.
  if (dashboard.overview.students.pending > 0)
    expect(kpis[3]?.textContent).toContain(
      dashboard.overview.students.pending + 'com pendências',
    );
  else expect(kpis).toHaveLength(3);

  const offers = new Map(analysis.matrix.offers.map((offer) => [offer.id, offer]));
  for (const column of dashboard.overview.columns) {
    const title = offers.get(column.offerId)!.subject.label;
    expect(
      screen.getByRole('button', {
        name:
          title +
          ': ' +
          column.atOrAbove +
          ' estudante(s) no mínimo ou acima',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name:
          title +
          ': ' +
          column.below +
          ' estudante(s) abaixo do mínimo',
      }),
    ).toBeTruthy();
  }

  expect(
    screen.getByRole('img', {
      name:
        dashboard.overview.students.allAtOrAbove +
        ' estudantes com todos os componentes no mínimo ou acima, ' +
        dashboard.overview.students.withBelow +
        ' com pelo menos um abaixo e ' +
        dashboard.overview.students.pending +
        ' sem leitura classificada',
    }),
  ).toBeTruthy();
  // The ranking opens inside the panorama card (owner request of 15/10/2026).
  fireEvent.click(screen.getByRole('button', { name: 'Classificação da turma: 10 maiores somatórios' }));
  expect(container.querySelectorAll('.performance-bars__student-group--ranking li')).toHaveLength(
    dashboard.overview.ranking.length,
  );
});

it('renders the four V4 comparison totals as the exact partition of compared cells', () => {
  const { matrix, projections } = learningFixtureV1({ period: 2 });
  const request = performanceTermComparisonRequestSchemaV4.parse({
    transportVersion: 4,
    operation: 'term-comparison',
    year: matrix.context.year,
    classId: matrix.classGroup.id,
    period: 2,
    referencePeriod: 1,
    mode: 'regular',
    statuses: [null, 7],
    lens: 'result',
    offerId: null,
  });
  const comparison = buildPerformanceTermComparisonV4(matrix, projections, request);
  const totals = comparison.rows
    .flatMap((row) => row.values)
    .reduce(
      (result, item) => {
        result[item.state === 'unavailable' ? 'unavailable' : item.relation]++;
        return result;
      },
      { higher: 0, equal: 0, lower: 0, unavailable: 0 },
    );
  render(<PerformanceTermComparisonPanelV4 value={comparison} open={vi.fn()} />);
  const summary = screen.getByLabelText('Resumo comparativo');
  const cells = within(summary).getAllByText(/\d+/u, { selector: 'strong' });
  expect(cells.map((cell) => Number(cell.textContent))).toEqual([
    totals.higher,
    totals.equal,
    totals.lower,
    totals.unavailable,
  ]);
  expect(
    totals.higher + totals.equal + totals.lower + totals.unavailable,
  ).toBe(comparison.rows.length * comparison.columns.length);
});
