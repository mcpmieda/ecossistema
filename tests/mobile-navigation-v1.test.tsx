import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryStepV1 } from '../src/shared/ui/history-step-v1';
import { useBackClosesOverlayV1 } from '../src/platform/back-closes-overlay-v1';
import { useDrawerSwipeV1 } from '../src/platform/drawer-swipe-v1';
import { Tooltip } from '../src/shared/ui/tap-tooltip-v1';

const tick = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
/** jsdom moves through history asynchronously, like a browser. */
async function goBack() {
  window.history.back();
  await tick(60);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const parsePeriod = (value: unknown) =>
  value !== null && typeof value === 'object' && typeof (value as { period?: unknown }).period === 'number'
    ? { period: (value as { period: number }).period }
    : null;

function Periods() {
  const [view, setView] = useState({ period: 1 });
  useHistoryStepV1('test-periods', view, setView, parsePeriod);
  return (
    <>
      <p data-testid="period">{view.period}</p>
      {[1, 2, 3].map((period) => (
        <button key={period} type="button" onClick={() => setView({ period })}>
          {`Período ${period}`}
        </button>
      ))}
    </>
  );
}

describe('history steps v1', () => {
  it('turns each choice into a step that back undoes, without leaving the page', async () => {
    render(<Periods />);
    await tick(450);
    fireEvent.click(screen.getByText('Período 2'));
    await tick(200);
    fireEvent.click(screen.getByText('Período 3'));
    await tick(200);
    await goBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('2'));
    await goBack();
    await waitFor(() => expect(screen.getByTestId('period').textContent).toBe('1'));
  });

  it('takes the step away when the view goes straight back, so back does not reopen it', async () => {
    render(<Periods />);
    await tick(450);
    fireEvent.click(screen.getByText('Período 2'));
    await tick(200);
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back');
    // Closing with the screen's own button returns to the view before the step.
    fireEvent.click(screen.getByText('Período 1'));
    expect(screen.getByTestId('period').textContent).toBe('1');
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    expect(push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((window.history.state as Record<string, unknown>)['step-v1:test-periods']).toEqual({ period: 1 }),
    );
    push.mockRestore();
    back.mockRestore();
  });

  it('keeps a correction made right after loading in the same step', async () => {
    const start = window.history.length;
    const { rerender } = renderHook(({ value }) => useHistoryStepV1('test-load', value, () => {}, parsePeriod), {
      initialProps: { value: { period: 1 } },
    });
    rerender({ value: { period: 2 } });
    await tick(20);
    expect(window.history).toHaveLength(start);
    expect((window.history.state as Record<string, unknown>)['step-v1:test-load']).toEqual({ period: 2 });
  });
});

function Layer() {
  const [open, setOpen] = useState(false);
  useBackClosesOverlayV1();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir</button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <button type="button" onClick={() => setOpen(false)}>Fechar</button>
        </div>
      ) : null}
    </>
  );
}

describe('back closes an open layer v1', () => {
  it('closes the open window on back and leaves the history as it was', async () => {
    render(<Layer />);
    fireEvent.click(screen.getByText('Abrir'));
    await tick(20);
    expect((window.history.state as Record<string, unknown>).__centroOverlayV1).toBe(true);
    await goBack();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes its entry away when the window is closed on the page', async () => {
    render(<Layer />);
    fireEvent.click(screen.getByText('Abrir'));
    await tick(20);
    const marked = window.history.state as Record<string, unknown>;
    expect(marked.__centroOverlayV1).toBe(true);
    fireEvent.click(screen.getByText('Fechar'));
    await tick(40);
    expect((window.history.state as Record<string, unknown> | null)?.__centroOverlayV1).toBeUndefined();
  });
});

describe('drawer follows the finger v1', () => {
  const touch = (type: string, target: Element, x: number, y = 300) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: x, clientY: y };
    Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] });
    target.dispatchEvent(event);
    return event;
  };
  function Shell() {
    const drawer = useRef<HTMLElement>(null);
    const shade = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    useDrawerSwipeV1(open, setOpen, drawer, shade);
    return (
      <>
        <aside ref={drawer} data-testid="drawer" data-open={open ? 'true' : undefined} />
        <div ref={shade} data-testid="shade" />
        <p>Texto da página.</p>
      </>
    );
  }
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 280 } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  it('moves with the finger and settles open past its share of the width', async () => {
    render(<Shell />);
    const page = screen.getByText('Texto da página.');
    const drawer = screen.getByTestId('drawer');
    touch('touchstart', page, 20);
    const move = touch('touchmove', page, 40);
    touch('touchmove', page, 160);
    expect(move.defaultPrevented).toBe(true);
    expect(drawer.style.transform).toBe('translateX(-50%)');
    expect(screen.getByTestId('shade').style.opacity).toBe('0.5');
    await tick(40);
    act(() => void touch('touchend', page, 160));
    expect(drawer.getAttribute('data-open')).toBe('true');
    expect(drawer.style.transform).toBe('');
  });

  it('slides back shut when let go early, and leaves a drag on the right half to the page', async () => {
    render(<Shell />);
    const page = screen.getByText('Texto da página.');
    const drawer = screen.getByTestId('drawer');
    touch('touchstart', page, 20);
    touch('touchmove', page, 40);
    await tick(40);
    touch('touchmove', page, 70);
    await tick(40);
    act(() => void touch('touchend', page, 70));
    expect(drawer.getAttribute('data-open')).toBeNull();
    touch('touchstart', page, 700);
    const move = touch('touchmove', page, 900);
    act(() => void touch('touchend', page, 900));
    expect(move.defaultPrevented).toBe(false);
    expect(drawer.getAttribute('data-open')).toBeNull();
  });

  it('leaves a vertical scroll alone', () => {
    render(<Shell />);
    const page = screen.getByText('Texto da página.');
    touch('touchstart', page, 20, 100);
    const move = touch('touchmove', page, 30, 200);
    touch('touchmove', page, 160, 210);
    act(() => void touch('touchend', page, 160, 210));
    expect(move.defaultPrevented).toBe(false);
    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBeNull();
  });
});

describe('tooltip on touch v1', () => {
  const tap = (element: Element) => {
    fireEvent.pointerDown(element, { pointerType: 'touch' });
    fireEvent.pointerUp(element, { pointerType: 'touch' });
    fireEvent.click(element);
  };
  it('opens with a tap, closes with a tap outside, and leaves a wrapped button its tap', async () => {
    const press = vi.fn();
    render(
      <>
        <Tooltip>
          <Tooltip.Trigger aria-label="Sobre">i</Tooltip.Trigger>
          <Tooltip.Content>Explicação sintética.</Tooltip.Content>
        </Tooltip>
        <Tooltip>
          <Tooltip.Trigger>
            <button type="button" onClick={press}>Editar</button>
          </Tooltip.Trigger>
          <Tooltip.Content>Nome do botão.</Tooltip.Content>
        </Tooltip>
        <p>Fora.</p>
      </>,
    );
    tap(screen.getByLabelText('Sobre'));
    expect(await screen.findByText('Explicação sintética.')).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('Fora.'), { pointerType: 'touch' });
    await tick(300);
    expect(screen.queryByText('Explicação sintética.')).toBeNull();
    tap(screen.getByText('Editar'));
    expect(press).toHaveBeenCalledTimes(1);
    await tick(50);
    expect(screen.queryByText('Nome do botão.')).toBeNull();
  });
});
