import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBackClosesOverlayV1 } from '../src/platform/back-closes-overlay-v1';
import { useHistoryStepV1 } from '../src/shared/ui/history-step-v1';

const tick = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function phoneBack() {
  window.history.back();
  await tick(80);
}
const state = () => JSON.stringify(window.history.state ?? {});

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});
afterEach(cleanup);

const parsePeriod = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { period?: unknown }).period === 'number'
    ? { period: (value as { period: number }).period }
    : null;
const parseTab = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { tab?: unknown }).tab === 'string'
    ? { tab: (value as { tab: string }).tab }
    : null;

/** A period chosen in an option list (a Select), as in Boletins and Desempenho. */
function PeriodList({ locked = false }: { readonly locked?: boolean }) {
  useBackClosesOverlayV1();
  const [view, setView] = useState({ period: 1 });
  useHistoryStepV1('test-list', view, (restored) => (locked ? false : setView(restored)), parsePeriod);
  const [open, setOpen] = useState(false);
  return (
    <>
      <p data-testid="period">{view.period}</p>
      <button type="button" onClick={() => setOpen(true)}>
        Período
      </button>
      <button type="button" onClick={() => setView({ period: view.period + 1 })}>
        Próximo
      </button>
      {open ? (
        <div
          data-slot="select-popover"
          role="dialog"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          {[1, 2, 3].map((period) => (
            <button
              key={period}
              type="button"
              onClick={() => {
                setOpen(false);
                setView({ period });
              }}
            >
              {`Opção ${period}`}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

const list = () => document.querySelector('[data-slot="select-popover"]');

describe('option lists and steps v1', () => {
  it('picking an option keeps the choice and one back undoes it', async () => {
    render(<PeriodList />);
    await tick(450);
    fireEvent.click(screen.getByText('Período'));
    await tick(20);
    expect(state()).toContain('__centroOverlayV1');
    fireEvent.click(screen.getByText('Opção 3'));
    await tick(600);
    expect(screen.getByTestId('period').textContent).toBe('3');
    expect(state()).not.toContain('__centroOverlayV1');
    expect(state()).not.toContain('released');
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('1'));
  });

  it('back closes an open option list without changing the choice under it', async () => {
    render(<PeriodList />);
    await tick(450);
    fireEvent.click(screen.getByText('Próximo'));
    await tick(200);
    fireEvent.click(screen.getByText('Período'));
    await tick(20);
    await phoneBack();
    await waitFor(() => expect(list()).toBeNull());
    expect(screen.getByTestId('period').textContent).toBe('2');
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('1'));
  });

  it('a list closed without a choice leaves no back press in vain', async () => {
    render(<PeriodList />);
    await tick(450);
    fireEvent.click(screen.getByText('Próximo'));
    await tick(200);
    const length = window.history.length;
    fireEvent.click(screen.getByText('Período'));
    await tick(20);
    // Closed on the page (a tap outside): the extra entry goes away by itself.
    fireEvent.keyDown(list()!, { key: 'Escape' });
    await tick(600);
    expect(state()).not.toContain('released');
    expect(window.history.length).toBeGreaterThanOrEqual(length);
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('1'));
  });

  it('a refused back keeps the screen and its entry', async () => {
    const { rerender } = render(<PeriodList />);
    await tick(450);
    fireEvent.click(screen.getByText('Próximo'));
    await tick(200);
    rerender(<PeriodList locked />);
    await phoneBack();
    expect(screen.getByTestId('period').textContent).toBe('2');
    expect((window.history.state as Record<string, unknown>)['step-v1:test-list']).toEqual({
      period: 2,
    });
    rerender(<PeriodList />);
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('1'));
  });
});

/** Two screens with steps on one page (Desempenho's perspective and its period). */
function TwoSteps() {
  const [view, setView] = useState({ tab: 'overview' });
  const [period, setPeriod] = useState({ period: 1 });
  useHistoryStepV1('test-tab', view, setView, parseTab);
  useHistoryStepV1('test-period', period, setPeriod, parsePeriod);
  return (
    <>
      <p data-testid="view">{`${view.tab}:${period.period}`}</p>
      <button type="button" onClick={() => setView({ tab: 'students' })}>
        Alunos
      </button>
      <button type="button" onClick={() => setView({ tab: 'overview' })}>
        Visão geral
      </button>
      <button type="button" onClick={() => setPeriod({ period: 2 })}>
        2º tri
      </button>
    </>
  );
}

describe('steps of two screens v1', () => {
  it('going back to a tab after another screen changed keeps both choices', async () => {
    render(<TwoSteps />);
    await tick(450);
    fireEvent.click(screen.getByText('Alunos'));
    await tick(200);
    fireEvent.click(screen.getByText('2º tri'));
    await tick(200);
    fireEvent.click(screen.getByText('Visão geral'));
    await tick(300);
    expect(screen.getByTestId('view').textContent).toBe('overview:2');
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('view').textContent).toBe('students:2'));
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('view').textContent).toBe('students:1'));
  });
});

function Menu() {
  useBackClosesOverlayV1();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir menu
      </button>
      {open ? (
        <aside role="dialog" aria-modal="true" aria-label="Menu">
          <a href="#/outra-area" onClick={() => setTimeout(() => setOpen(false), 0)}>
            Outra área
          </a>
        </aside>
      ) : null}
    </>
  );
}

describe('links inside a layer v1', () => {
  it('a link to another area takes the menu entry, so one back returns', async () => {
    window.history.replaceState(null, '', '/#/area');
    render(<Menu />);
    await tick(20);
    fireEvent.click(screen.getByText('Abrir menu'));
    await tick(20);
    expect(state()).toContain('__centroOverlayV1');
    fireEvent.click(screen.getByText('Outra área'));
    await tick(50);
    expect(window.location.hash).toBe('#/outra-area');
    // The menu's entry became the new area's: nothing marked is left under it.
    expect(state()).not.toContain('__centroOverlayV1');
    await phoneBack();
    expect(state()).not.toContain('__centroOverlayV1');
    await waitFor(() => expect(window.location.hash).toBe('#/area'));
  });
});
