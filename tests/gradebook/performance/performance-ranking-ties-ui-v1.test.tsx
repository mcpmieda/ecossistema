// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { learningFixtureV1 } from './learning-fixture-v1';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';
import { PerformanceDashboardWidgetsV5 } from '../../../src/features/gradebook/performance/performance-dashboard-widgets-v5';
import { buildPerformanceAnalysisV3 } from '../../../server/gradebook/application/read-models/performance/performance-analysis-v3';
import { buildPerformanceDashboardOverviewV5 } from '../../../server/gradebook/application/read-models/performance/performance-dashboard-v5';
import { performanceAnalysisRequestSchemaV3 } from '../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import type { PerformanceDashboardV5 } from '../../../shared/gradebook-contracts/performance/performance-dashboard-v5';

beforeEach(setupOperationsDomV1);
afterEach(cleanup);

it('students with the same total share the place and the medal in the Top 10', () => {
  const { matrix, projections } = learningFixtureV1({ period: 2 });
  const analysis = buildPerformanceAnalysisV3(
    matrix,
    projections,
    performanceAnalysisRequestSchemaV3.parse({
      transportVersion: 3,
      operation: 'analysis',
      year: matrix.context.year,
      classId: matrix.classGroup.id,
      period: matrix.period,
      mode: 'regular',
      statuses: [null, 7],
      lens: 'result',
      offerId: null,
    }),
  );
  const overview = buildPerformanceDashboardOverviewV5(analysis);
  const ids = analysis.matrix.rows.map((row) => row.student.id);
  expect(ids.length).toBeGreaterThanOrEqual(4);
  const totals = [300_000, 290_000, 290_000, 280_000];
  const dashboard: PerformanceDashboardV5 = {
    transportVersion: 5,
    operation: 'dashboard',
    state: 'ready',
    view: analysis,
    overview: {
      ...overview,
      ranking: totals.map((totalMilli, index) => ({
        studentId: ids[index]!,
        totalMilli,
        partial: false,
      })),
    },
  };
  const { container } = render(
    <PerformanceDashboardWidgetsV5
      value={dashboard}
      selection={null}
      onSelectionChange={vi.fn()}
      open={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Classificação da turma: 10 maiores somatórios' }),
  );
  const rows = [
    ...container.querySelectorAll('.performance-bars__student-group--ranking li button'),
  ];
  const places = rows.map((row) => row.getAttribute('aria-label')!.split(',')[0]);
  expect(places).toEqual(['1º lugar', '2º lugar (empate)', '2º lugar (empate)', '4º lugar']);
  const medals = rows.map(
    (row) =>
      row.querySelector('.performance-medal')?.getAttribute('class') ??
      row.querySelector('small')?.textContent,
  );
  expect(medals[0]).toContain('gold');
  expect(medals[1]).toContain('silver');
  expect(medals[2]).toContain('silver');
  expect(medals[3]).toBe('4');
});
