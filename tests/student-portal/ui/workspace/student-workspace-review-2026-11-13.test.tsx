// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalWorkspaceV1 } from '../../../../src/features/student-portal/workspace/student-workspace-v1';
import { gradesFixtureV1 } from '../grades/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';

/*
 * Review 13/11/2026: A8 (N/C and R/R on a recovery), A10 (scroll on Boletim ⇄ Disciplina), A16
 * (meter percent in integers) and A17 (a drop of exactly 10 points).
 */
beforeEach(() => {
  setupOperationsDomV1();
  window.history.replaceState(null, '', window.location.href);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

type PeriodsV1 = ReturnType<typeof gradesFixtureV1>['subjects'][number]['periods'];
const scoreOf = (value: number, maximum: number) =>
  ({ kind: 'score', value, maximum, meetsMinimum: value * 100 >= maximum * 60 }) as const;

/** Opens the first discipline with these periods, on the period tab at `tab`. */
async function openFirstOn(periods: PeriodsV1, tab: number) {
  const data = gradesFixtureV1(false);
  const first = data.subjects.find((subject) => subject.order === 1)!;
  first.periods = periods;
  render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
  const bar = screen.getByRole('tablist', { name: 'Períodos de ' + first.label });
  await user.click(within(bar).getAllByRole('tab')[tab]!);
}

it.each([
  ['nc', 'Não compareceu à recuperação'],
  ['rr', 'Reprovado'],
] as const)('A8: a recovery marked %s reads as final, never "Nota em análise"', async (kind, label) => {
  await openFirstOn([{ period: 'T1', final: scoreOf(12, 30) }, { period: 'REC1', final: { kind } }], 1);
  expect(screen.queryByText('Nota em análise')).toBeNull();
  expect(screen.getByText(label)).toBeTruthy();
});

it('A16: 23,4 of 30 fills the meter to 78%, not 77%', async () => {
  await openFirstOn([{ period: 'T1', final: scoreOf(12, 30) }, { period: 'REC1', final: scoreOf(23.4, 30) }], 1);
  expect(screen.getByRole('img', { name: /^78% dos pontos/u })).toBeTruthy();
  expect(screen.queryByRole('img', { name: /^77% dos pontos/u })).toBeNull();
});

it('A17: a drop of exactly 10 points below the minimum reads "consideravelmente"', async () => {
  await openFirstOn([{ period: 'T1', final: scoreOf(17, 30) }, { period: 'T2', final: scoreOf(14, 30) }], 1);
  expect(screen.getByText('Caiu consideravelmente em relação ao 1º')).toBeTruthy();
});

it('A17: a drop of less than 10 points stays plain', async () => {
  await openFirstOn([{ period: 'T1', final: scoreOf(17, 30) }, { period: 'T2', final: scoreOf(14.1, 30) }], 1);
  expect(screen.getByText('Caiu em relação ao 1º')).toBeTruthy();
});

it('A10: opening a discipline from far down the Boletim brings the top into view and focuses its title', async () => {
  const data = gradesFixtureV1(false);
  const first = [...data.subjects].sort((a, b) => a.order - b.order)[0]!;
  render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 });
  const user = userEvent.setup();

  await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
  // jsdom has no layout: the sheet's top is 0 in the viewport, so the window goes to 900 - 16.
  expect(scrollTo).toHaveBeenCalledWith({ top: 884, behavior: 'instant' });
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: first.label }));

  scrollTo.mockClear();
  await user.click(screen.getByRole('button', { name: 'Voltar para o boletim' }));
  expect(scrollTo).toHaveBeenCalledWith({ top: 884, behavior: 'instant' });
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Minhas notas' }));
});

it('A10: a window already above the sheet is left where it is', async () => {
  const data = gradesFixtureV1(false);
  const first = [...data.subjects].sort((a, b) => a.order - b.order)[0]!;
  render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
  expect(scrollTo).not.toHaveBeenCalled();
});
