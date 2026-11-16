import { AlertDialog } from '@heroui/react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrawerSwipeV1 } from '../src/platform/drawer-swipe-v1';

const touch = (type: string, target: Element, x: number, y: number) => {
  const event = new Event(type, { bubbles: true });
  const point = { clientX: x, clientY: y };
  Object.assign(event, { touches: type === 'touchend' ? [] : [point], changedTouches: [point] });
  target.dispatchEvent(event);
};
const swipe = (target: Element, from: [number, number], to: [number, number]) => {
  touch('touchstart', target, ...from);
  touch('touchend', target, ...to);
};
let phone = true;
const setOpen = vi.fn();
const mount = (open: boolean, drawer: HTMLElement | null = null) =>
  renderHook(() => useDrawerSwipeV1(open, setOpen, { current: drawer }));

beforeEach(() => {
  phone = true;
  setOpen.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone, media: query }));
  document.body.innerHTML = '<main><p id="text">texto</p><input id="field" /></main>';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('phone drawer swipe', () => {
  it('opens on a swipe to the right and closes on a swipe to the left', () => {
    const text = document.getElementById('text')!;
    mount(false);
    swipe(text, [20, 300], [140, 310]);
    expect(setOpen).toHaveBeenLastCalledWith(true);
    cleanup();
    setOpen.mockClear();
    mount(true);
    swipe(text, [200, 300], [80, 305]);
    expect(setOpen).toHaveBeenLastCalledWith(false);
  });

  it('ignores short, slanted, vertical and slow movements, and swipes the wrong way', () => {
    const text = document.getElementById('text')!;
    mount(false);
    swipe(text, [20, 300], [60, 300]); // short
    swipe(text, [20, 300], [120, 380]); // slanted
    swipe(text, [20, 100], [30, 400]); // vertical scroll
    swipe(text, [200, 300], [60, 300]); // to the left while closed
    expect(setOpen).not.toHaveBeenCalled();
    vi.useFakeTimers();
    touch('touchstart', text, 20, 300);
    vi.advanceTimersByTime(900);
    touch('touchend', text, 160, 300);
    vi.useRealTimers();
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('leaves the swipe to content that can still slide that way, read when the finger lands', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    scroller.innerHTML = '<span id="cell">nota</span>';
    document.body.appendChild(scroller);
    Object.defineProperties(scroller, {
      scrollWidth: { value: 900, configurable: true },
      clientWidth: { value: 300, configurable: true },
    });
    const cell = document.getElementById('cell')!;
    mount(false);
    // Slid to the right: a finger moving right pulls the table back, so the drawer stays shut,
    // even though the table is at its start by the time the finger lifts.
    scroller.scrollLeft = 200;
    touch('touchstart', cell, 20, 300);
    scroller.scrollLeft = 0;
    touch('touchend', cell, 160, 300);
    expect(setOpen).not.toHaveBeenCalled();
    // At its start there is nothing to pull back: the swipe opens the drawer.
    swipe(cell, [20, 300], [160, 300]);
    expect(setOpen).toHaveBeenLastCalledWith(true);
  });

  it('does nothing on a text field or on a computer', () => {
    mount(false);
    swipe(document.getElementById('field')!, [20, 300], [160, 300]);
    expect(setOpen).not.toHaveBeenCalled();
    phone = false;
    swipe(document.getElementById('text')!, [20, 300], [160, 300]);
    expect(setOpen).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog'])('neither opens nor closes under an open %s', (role) => {
    const layer = document.createElement('div');
    layer.setAttribute('role', role);
    layer.textContent = 'Confirmar';
    document.body.appendChild(layer);
    mount(false);
    swipe(layer, [20, 300], [160, 300]);
    cleanup();
    // The drawer comes first in the page and is open; the other layer still counts.
    const drawer = document.createElement('aside');
    drawer.setAttribute('role', 'dialog');
    document.body.insertBefore(drawer, document.body.firstChild);
    mount(true, drawer);
    swipe(layer, [200, 300], [60, 300]);
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('is not held back by a list that is part of the page or by a hidden layer', () => {
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    const hidden = document.createElement('div');
    hidden.setAttribute('role', 'alertdialog');
    hidden.checkVisibility = () => false;
    document.body.appendChild(list);
    document.body.appendChild(hidden);
    mount(false);
    swipe(document.getElementById('text')!, [20, 300], [160, 300]);
    expect(setOpen).toHaveBeenLastCalledWith(true);
  });

  it('counts a popover of the component library as an open layer', () => {
    const popover = document.createElement('div');
    popover.setAttribute('data-slot', 'select-popover');
    document.body.appendChild(popover);
    mount(false);
    swipe(document.getElementById('text')!, [20, 300], [160, 300]);
    expect(setOpen).not.toHaveBeenCalled();
  });

  it('stays out of the way while the page is enlarged by zoom, and works again at normal scale', () => {
    const text = document.getElementById('text')!;
    const view = { scale: 2, offsetLeft: 187.5 };
    vi.stubGlobal('visualViewport', view);
    mount(false);
    // Dragging the enlarged view back to its start: zoomed when the finger lands.
    touch('touchstart', text, 40, 300);
    view.offsetLeft = 0;
    touch('touchend', text, 330, 300);
    expect(setOpen).not.toHaveBeenCalled();
    // Still zoomed with the view already at its start.
    swipe(text, [40, 300], [330, 300]);
    expect(setOpen).not.toHaveBeenCalled();
    // The view moved during the gesture even though the scale reads as normal.
    view.scale = 1;
    view.offsetLeft = 30;
    touch('touchstart', text, 40, 300);
    view.offsetLeft = 0;
    touch('touchend', text, 330, 300);
    expect(setOpen).not.toHaveBeenCalled();
    swipe(text, [40, 300], [330, 300]);
    expect(setOpen).toHaveBeenLastCalledWith(true);
  });

  it('leaves the drawer alone under a real confirmation of the component library', async () => {
    function Screen({ confirming }: { confirming: boolean }) {
      const drawer = useRef<HTMLElement>(null);
      const [open, setOpenState] = useState(false);
      useDrawerSwipeV1(open, setOpenState, drawer);
      return (
        <>
          <aside ref={drawer} data-testid="drawer" data-open={String(open)} />
          <p>Texto da página.</p>
          {confirming ? (
            <AlertDialog.Backdrop isOpen isDismissable={false}>
              <AlertDialog.Container>
                <AlertDialog.Dialog>
                  <AlertDialog.Header>
                    <AlertDialog.Heading>Confirmar encerramento de sessões</AlertDialog.Heading>
                  </AlertDialog.Header>
                  <AlertDialog.Body>
                    <p>Corpo sintético da confirmação.</p>
                  </AlertDialog.Body>
                </AlertDialog.Dialog>
              </AlertDialog.Container>
            </AlertDialog.Backdrop>
          ) : null}
        </>
      );
    }
    const drawerState = () => screen.getByTestId('drawer').getAttribute('data-open');
    const view = render(<Screen confirming />);
    const dialog = await screen.findByRole('alertdialog');
    // The state change is flushed before it is read, so "false" means the swipe was refused.
    act(() => swipe(screen.getByText('Corpo sintético da confirmação.'), [20, 300], [200, 300]));
    expect(dialog.isConnected).toBe(true);
    expect(drawerState()).toBe('false');
    // Control: the same screen without the confirmation opens on the same swipe.
    view.rerender(<Screen confirming={false} />);
    act(() => swipe(screen.getByText('Texto da página.'), [20, 300], [200, 300]));
    expect(drawerState()).toBe('true');
  });

  it('does not treat the drawer itself as another layer', () => {
    const drawer = document.createElement('aside');
    drawer.setAttribute('role', 'dialog');
    document.body.appendChild(drawer);
    mount(true, drawer);
    swipe(drawer, [200, 300], [60, 300]);
    expect(setOpen).toHaveBeenLastCalledWith(false);
  });
});
