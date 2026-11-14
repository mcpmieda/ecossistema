import { Button, Drawer } from '@heroui/react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackClosesOverlayV1 } from '../src/platform/back-closes-overlay-v1';
import { useHistoryStepV1 } from '../src/shared/ui/history-step-v1';

const tick = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function phoneBack() {
  window.history.back();
  await tick(80);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const parseTab = (value: unknown) =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { tab?: unknown }).tab === 'string'
    ? { tab: (value as { tab: string }).tab }
    : null;

/** The Desempenho case: a tab chosen before, a HeroUI side panel with steps inside. */
function Screen() {
  useBackClosesOverlayV1();
  const [view, setView] = useState({ tab: 'overview' });
  useHistoryStepV1('test-tabs', view, setView, parseTab);
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const back = () => setSteps((current) => current.slice(0, -1));
  return (
    <>
      <p data-testid="tab">{view.tab}</p>
      <button type="button" onClick={() => setView({ tab: 'notes' })}>
        Notas
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir aluno
      </button>
      <Drawer.Backdrop
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setSteps([]);
          }
        }}
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label="Aluno">
            {steps.length ? (
              <Button onPress={back} data-back-step={String(steps.length)}>
                Voltar às notas do ano
              </Button>
            ) : null}
            <p data-testid="step">{steps.at(-1) ?? 'ano'}</p>
            <Button onPress={() => setSteps((current) => [...current, 'trimestre'])}>
              Ver trimestre
            </Button>
            <Drawer.Footer>
              {steps.length ? (
                <Button isIconOnly aria-label="Voltar às notas do ano" onPress={back}>
                  ←
                </Button>
              ) : null}
              <Button onPress={() => setOpen(false)}>Fechar</Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </>
  );
}

const panel = () => document.querySelector('[data-slot="drawer-dialog"]:not([data-exiting])');

describe('phone back with HeroUI windows v1', () => {
  it('closes a HeroUI side panel instead of undoing the tab chosen before it', async () => {
    render(<Screen />);
    await tick(450);
    act(() => screen.getByText('Notas').click());
    await tick(200);
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    await tick(50);
    await phoneBack();
    await waitFor(() => expect(panel()).toBeNull());
    expect(screen.getByTestId('tab').textContent).toBe('notes');
  });

  it('walks the steps inside the panel back one at a time before closing it', async () => {
    render(<Screen />);
    await tick(450);
    act(() => screen.getByText('Notas').click());
    await tick(200);
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    await tick(50);
    act(() => screen.getByText('Ver trimestre').click());
    expect(screen.getByTestId('step').textContent).toBe('trimestre');
    // The tap's work (its history entry) ends before a finger can press back.
    await tick(20);
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('ano'));
    expect(panel()).not.toBeNull();
    await phoneBack();
    await waitFor(() => expect(panel()).toBeNull());
    expect(screen.getByTestId('tab').textContent).toBe('notes');
  });

  it('the button at the bottom takes the same step back as the one at the top', async () => {
    render(<Screen />);
    await tick(450);
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    act(() => screen.getByText('Ver trimestre').click());
    const bottom = screen
      .getAllByRole('button', { name: 'Voltar às notas do ano' })
      .find((button) => button.closest('[data-slot="drawer-footer"]'));
    expect(bottom).toBeDefined();
    act(() => bottom!.click());
    expect(screen.getByTestId('step').textContent).toBe('ano');
    expect(screen.queryAllByRole('button', { name: 'Voltar às notas do ano' })).toHaveLength(0);
  });

  it('closing with Fechar leaves the history as it was before the panel', async () => {
    render(<Screen />);
    await tick(450);
    const length = window.history.length;
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    await tick(50);
    act(() => screen.getByText('Fechar').click());
    await waitFor(() => expect(panel()).toBeNull());
    await tick(120);
    expect(JSON.stringify(window.history.state ?? {})).not.toContain('__centroOverlayV1');
    expect(window.history.length).toBeGreaterThanOrEqual(length);
  });
});

describe('phone back without entries Chrome would skip v1', () => {
  it('each step inside the panel gets its entry at the tap, and back never adds one', async () => {
    render(<Screen />);
    await tick(450);
    act(() => screen.getByText('Notas').click());
    await tick(200);
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    await tick(50);
    const length = window.history.length;
    act(() => screen.getByText('Ver trimestre').click());
    await tick(50);
    // The step opened by the tap has an entry of its own.
    expect(window.history).toHaveLength(length + 1);
    const push = vi.spyOn(window.history, 'pushState');
    await phoneBack();
    await waitFor(() => expect(screen.getByTestId('step').textContent).toBe('ano'));
    expect(panel()).not.toBeNull();
    await phoneBack();
    await waitFor(() => expect(panel()).toBeNull());
    await tick(450);
    expect(screen.getByTestId('tab').textContent).toBe('notes');
    // Going back added nothing: an entry added without a tap is one Chrome skips later.
    expect(push).not.toHaveBeenCalled();
  });

  it("the panel's own Voltar takes the step's entry away", async () => {
    render(<Screen />);
    await tick(450);
    act(() => screen.getByText('Abrir aluno').click());
    await waitFor(() => expect(panel()).not.toBeNull());
    await tick(50);
    act(() => screen.getByText('Ver trimestre').click());
    await tick(50);
    act(() => screen.getAllByRole('button', { name: 'Voltar às notas do ano' })[0]!.click());
    await tick(120);
    expect(screen.getByTestId('step').textContent).toBe('ano');
    // The next back closes the panel instead of landing on the step just left.
    await phoneBack();
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("with the browser's activation state, a change without a new tap adds no entry", async () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { isActive: true } });
    render(<Screen />);
    await tick(450);
    const push = vi.spyOn(window.history, 'pushState');
    act(() => screen.getByText('Notas').click());
    await tick(200);
    // No real tap was counted here (a synthetic click is not trusted): the step replaced the entry.
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId('tab').textContent).toBe('notes');
    vi.unstubAllGlobals();
  });
});
