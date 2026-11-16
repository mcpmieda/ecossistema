// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GradebookYearProvider } from '../../../src/platform/gradebook-year-provider';
import { RelationalPerformancePageV2 } from '../../../src/features/gradebook/performance/relational-performance-page-v2';
import { performanceAnalyticsFixtureV6 } from './performance-analytics-fixture-v6';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';

const context = { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 };
const labels = ['Visão geral', 'Notas', 'Turmas', 'Alunos', 'Componentes', 'Professores'];
const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
const scrolling = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
let stylesheet: HTMLStyleElement;
let requests: Record<string, unknown>[];

beforeEach(() => {
  setupOperationsDomV1();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.operation === 'bootstrap')
        return Response.json({
          contractVersion: 2,
          state: 'ready',
          operation: 'bootstrap',
          years: [context],
        });
      if (body.operation === 'classes')
        return Response.json({
          transportVersion: 2,
          state: 'ready',
          operation: 'classes',
          context,
          readAt: '2026-09-16T12:00:00.000Z',
          authority: 'calculated-preview',
          statusOptions: [
            { value: null, label: 'Em curso' },
            { value: 7, label: 'Estava no' },
          ],
          classes: [{ id: 10, label: 'TURMA SINTETICA A' }],
          nextOffset: null,
        });
      if (body.operation === 'analytics')
        return Response.json(
          performanceAnalyticsFixtureV6({
            year: Number(body.year),
            classId: Number(body.classId),
            period: body.period as 1 | 2 | 3 | 'annual',
          }),
        );
      // The detail never answers: what the drawer shows meanwhile is what the page already knew.
      if (body.operation === 'student-detail' || body.operation === 'cell-detail')
        return new Promise<Response>(() => undefined);
      throw new Error(`Unexpected synthetic navigation request: ${String(body.operation)}`);
    }),
  );
  stylesheet = document.createElement('style');
  // Reproduce the upstream full-width tab, then apply the real application CSS.
  // The page itself must supply its scope; the test never adds a workspace wrapper.
  stylesheet.textContent =
    '.tabs__tab { width: 100%; }\n' + readFileSync('src/shared/ui/workspace-tabs-v1.css', 'utf8');
  document.head.appendChild(stylesheet);
});
afterEach(() => {
  cleanup();
  stylesheet.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  if (scrolling) Object.defineProperty(Element.prototype, 'scrollIntoView', scrolling);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
function mountPage() {
  return render(
    createElement(GradebookYearProvider, null, createElement(RelationalPerformancePageV2)),
  );
}
function expectCompact(list: HTMLElement) {
  const scroller = list.parentElement!;
  const container = scroller.parentElement!;
  expect(scroller.classList.contains('tabs__list-container__scroller')).toBe(true);
  expect(container.classList.contains('tabs__list-container')).toBe(true);
  expect(getComputedStyle(container).width).toBe('fit-content');
  expect(getComputedStyle(container).maxWidth).toBe('100%');
  expect(getComputedStyle(list).width).toBe('max-content');
  for (const tab of within(list).getAllByRole('tab'))
    expect(getComputedStyle(tab).width).toBe('auto');
}

it('applies compact navigation to the actual performance page before a class is selected', async () => {
  mountPage();
  const perspectives = await screen.findByRole('tablist', { name: 'Perspectivas de Desempenho' });
  await screen.findByRole('tab', { name: 'TURMA SINTETICA A' });
  expect(
    screen
      .getByRole('region', { name: 'Desempenho relacional' })
      .classList.contains('performance-workspace'),
  ).toBe(true);
  expect(
    within(perspectives)
      .getAllByRole('tab')
      .map((tab) => tab.textContent),
  ).toEqual(labels);
  expect(
    within(perspectives).getByRole('tab', { name: 'Visão geral' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(screen.getByText('Escolha uma turma para começar.')).toBeTruthy();
  expectCompact(perspectives);
  expectCompact(screen.getByRole('tablist', { name: 'Turmas de Desempenho' }));
  expect(perspectives.parentElement!.parentElement!.classList.contains('overflow-x-auto')).toBe(
    false,
  );
  expect(requests.some((body) => body.operation === 'analytics')).toBe(false);
});

it('heads the detail drawer with the student already on screen while the detail is read', async () => {
  mountPage();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'TURMA SINTETICA A' }));
  await waitFor(() => expect(screen.queryByLabelText('Carregando indicadores')).toBeNull());
  const cell = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>('td button');
    expect(found).not.toBeNull();
    return found!;
  });
  await user.click(cell);
  const drawer = await screen.findByRole('dialog');
  await waitFor(() =>
    expect(requests.some((body) => String(body.operation).endsWith('-detail'))).toBe(true),
  );
  const asked = requests.find((body) => String(body.operation).endsWith('-detail'))!;
  const known = performanceAnalyticsFixtureV6({ year: 2026, classId: 10, period: 1 });
  const student =
    known.state === 'ready'
      ? known.students.find((item) => item.student.id === asked.studentId)
      : undefined;
  expect(student).toBeDefined();
  expect(within(drawer).getByRole('heading').textContent).toBe(student!.student.name);
  expect(within(drawer).getByText('Carregando detalhe…')).toBeTruthy();
});

it('keeps the real perspective bar compact through keyboard navigation and a selected-class snapshot', async () => {
  mountPage();
  const user = userEvent.setup();
  const perspectives = await screen.findByRole('tablist', { name: 'Perspectivas de Desempenho' });
  const classTab = await screen.findByRole('tab', { name: 'TURMA SINTETICA A' });
  await user.click(classTab);
  await waitFor(() =>
    expect(requests.filter((body) => body.operation === 'analytics')).toHaveLength(1),
  );
  await waitFor(() => expect(screen.queryByLabelText('Carregando indicadores')).toBeNull());
  expect(screen.queryByText('Nenhuma leitura disponível.')).toBeNull();
  expect(screen.queryByText('Consulta indisponível')).toBeNull();
  await user.click(within(perspectives).getByRole('tab', { name: 'Visão geral' }));
  await user.keyboard('{End}{Enter}');
  expect(
    within(perspectives).getByRole('tab', { name: 'Professores' }).getAttribute('aria-selected'),
  ).toBe('true');
  await user.click(within(perspectives).getByRole('tab', { name: 'Componentes' }));
  expect(
    within(perspectives).getByRole('tab', { name: 'Componentes' }).getAttribute('aria-selected'),
  ).toBe('true');
  expect(classTab.getAttribute('aria-selected')).toBe('true');
  expect(requests.filter((body) => body.operation === 'analytics')).toHaveLength(1);
  expect(requests.find((body) => body.operation === 'analytics')).toMatchObject({
    year: 2026,
    classId: 10,
    period: 1,
  });
  expectCompact(perspectives);
});
