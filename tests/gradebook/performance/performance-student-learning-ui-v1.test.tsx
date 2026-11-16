// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PerformanceAnalyticsWorkspaceV6 } from '../../../src/features/gradebook/performance/performance-analytics-workspace-v6';
import { learningFixtureV1 } from './learning-fixture-v1';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function props(tab: 'students' | 'components' | 'teachers' = 'students') {
  return {
    value: learningFixtureV1().value,
    tab,
    selection: { studentId: 1, offerId: 10, teacherId: 1 },
    onSelection: vi.fn(),
    onNavigate: vi.fn(),
    onPeriod: vi.fn(),
    onCell: vi.fn(),
    onNotes: vi.fn(),
  };
}

function entityTrigger(value: RegExp, label: string) {
  return screen.getByRole('button', {
    // HeroUI composes the selected value before the visible Label in the
    // trigger's accessible name. Keep the real component in this test.
    name: new RegExp(`${value.source}.*${label}`, 'i'),
  });
}

it('replaces the old statistical student cards with learning and follow-up indicators', () => {
  render(<PerformanceAnalyticsWorkspaceV6 {...props()} />);
  expect(screen.getByTestId('performance-student-learning-v1')).toBeTruthy();
  for (const label of [
    'Desempenho atual',
    'Evolução trimestral',
    'Atenção recorrente',
    'Participação avaliada',
  ])
    expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Onde olhar primeiro' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Dificuldades que se repetem' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Componentes do aluno' })).toBeTruthy();
  expect(screen.queryByText('Mediana')).toBeNull();
  expect(screen.queryByText(/Dispersão/)).toBeNull();
  expect(
    screen.getByRole('button', { name: /Recuperação · detalhes/ }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(
    screen.getByRole('button', { name: /Base dos indicadores/ }).getAttribute('aria-expanded'),
  ).toBe('false');
});

it('opens highlighted components through the existing student detail entry point', async () => {
  const model = props();
  render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
  const panel = screen
    .getByRole('heading', { name: 'Onde olhar primeiro' })
    .closest('[data-slot="card"]');
  expect(panel).toBeTruthy();
  const button = within(panel as HTMLElement)
    .getAllByRole('button')
    .find((item) => item.textContent?.includes('Melhor resultado atual'));
  expect(button).toBeTruthy();
  await userEvent.setup().click(button!);
  expect(model.onCell).toHaveBeenCalledWith(1, expect.any(Number));
});

it('reuses period and component-detail callbacks in the student perspective', async () => {
  const model = props();
  render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: /Consultar 1º trimestre/ }));
  expect(model.onPeriod).toHaveBeenCalledWith(1);

  const table = screen.getByRole('grid', { name: 'Componentes do aluno' });
  await user.click(within(table).getByRole('button', { name: 'Matemática' }));
  expect(model.onCell).toHaveBeenCalledWith(1, 10);

  const recurring = screen
    .getByRole('heading', { name: 'Dificuldades que se repetem' })
    .closest('[data-slot="card"]');
  expect(recurring).toBeTruthy();
  await user.click(within(recurring as HTMLElement).getByRole('button', { name: /Matemática/ }));
  expect(model.onCell).toHaveBeenLastCalledWith(1, 10);
});

it('closes the student select on an outside touch, on Escape, and after choosing another student', async () => {
  const model = props();
  render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
  const user = userEvent.setup();
  const trigger = entityTrigger(/Aluno exemplo 01/, 'Aluno');

  await user.click(trigger);
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.pointerDown(document.body, { pointerType: 'touch' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard('{Enter}');
  expect(screen.getByRole('listbox')).toBeTruthy();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(document.activeElement).toBe(trigger);

  await user.click(trigger);
  await user.click(screen.getByRole('option', { name: /2\. Aluno exemplo 02/i }));
  expect(model.onSelection).toHaveBeenCalledWith({ studentId: 2 });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
});

it.each([
  ['components', 'Componente', /Matemática/, /Português/, { offerId: 11 }],
  ['teachers', 'Professor', /Docente sintético 1/, /Docente sintético 2/, { teacherId: 2 }],
] as const)(
  'uses the same dismissible entity select for %s',
  async (tab, label, value, next, expected) => {
    const model = props(tab);
    render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
    const user = userEvent.setup();
    const trigger = entityTrigger(value, label);
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    if (tab === 'components') await user.click(document.body);
    else fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: next }));
    expect(model.onSelection).toHaveBeenCalledWith(expected);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  },
);

it('preserves the selected student panel, expanded state and focus on same-scope revalidation', async () => {
  const model = props();
  const view = render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
  const user = userEvent.setup();
  const recovery = screen.getByRole('button', { name: /Recuperação · detalhes/ });
  await user.click(recovery);
  expect(recovery.getAttribute('aria-expanded')).toBe('true');
  const panel = screen.getByTestId('performance-student-learning-v1');

  view.rerender(
    <PerformanceAnalyticsWorkspaceV6
      {...model}
      value={{ ...model.value, readAt: '2026-09-17T12:00:00Z' }}
    />,
  );

  expect(screen.getByTestId('performance-student-learning-v1')).toBe(panel);
  expect(screen.getByRole('button', { name: /Recuperação · detalhes/ })).toBe(recovery);
  expect(recovery.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(recovery);
  expect(entityTrigger(/Aluno exemplo 01/, 'Aluno').getAttribute('aria-expanded')).toBe('false');
});

it('resets student-local state when period or student scope changes', async () => {
  const model = props();
  const view = render(<PerformanceAnalyticsWorkspaceV6 {...model} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Recuperação · detalhes/ }));
  const previous = screen.getByTestId('performance-student-learning-v1');

  view.rerender(
    <PerformanceAnalyticsWorkspaceV6 {...model} value={learningFixtureV1({ period: 1 }).value} />,
  );
  expect(screen.getByTestId('performance-student-learning-v1')).not.toBe(previous);
  expect(
    screen.getByRole('button', { name: /Recuperação · detalhes/ }).getAttribute('aria-expanded'),
  ).toBe('false');

  const periodPanel = screen.getByTestId('performance-student-learning-v1');
  view.rerender(
    <PerformanceAnalyticsWorkspaceV6
      {...model}
      value={learningFixtureV1({ period: 1 }).value}
      selection={{ ...model.selection, studentId: 2 }}
    />,
  );
  expect(screen.getByTestId('performance-student-learning-v1')).not.toBe(periodPanel);
  expect(entityTrigger(/Aluno exemplo 02/, 'Aluno')).toBeTruthy();
});

it('reads a student with nothing recorded as not done, with results to highlight', () => {
  const model = props();
  render(
    <PerformanceAnalyticsWorkspaceV6 {...model} selection={{ ...model.selection, studentId: 4 }} />,
  );

  const learning = screen.getByTestId('performance-student-learning-v1');
  expect(
    within(learning).queryByText('Ainda não há resultados suficientes para destacar.'),
  ).toBeNull();
  expect(
    within(learning).queryByText('Ainda não há notas suficientes para avaliar recorrência.'),
  ).toBeNull();
  expect(within(learning).queryByText(/Maior avanço|Maior queda/)).toBeNull();
  expect(within(learning).queryByText('Sem notas suficientes neste recorte.')).toBeNull();
});
