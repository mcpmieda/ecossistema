import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useBackClosesOverlayV1 } from '../src/platform/back-closes-overlay-v1';

const tick = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const activation = { isActive: true };

beforeEach(() => {
  // A fresh entry drops the ones ahead left by the test before, so the count is this test's.
  window.history.pushState(null, '', '/#/banco-de-notas');
  activation.isActive = true;
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'userActivation');
});

/** The phone menu: always in the page, a modal window only while open. */
function Shell() {
  useBackClosesOverlayV1();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Menu
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Fora
      </button>
      <aside
        data-testid="drawer"
        data-open={open ? 'true' : undefined}
        {...(open ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      />
    </>
  );
}

it('gives the phone menu its entry when opened by a tap after an opening without one (A15)', async () => {
  // The browser's activation state, as on the phone (each tap counted once, here the first).
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
  render(<Shell />);
  const start = window.history.length;
  // Opened by dragging the finger: no tap of its own, no entry.
  activation.isActive = false;
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
  await tick(20);
  expect(window.history.length).toBe(start);
  fireEvent.click(screen.getByRole('button', { name: 'Fora' }));
  await tick(20);
  // Opened again by the Menu button, now with a real tap.
  activation.isActive = true;
  fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
  await tick(20);
  expect(window.history.length).toBe(start + 1);
  window.history.back();
  await tick(80);
  expect(screen.getByTestId('drawer').getAttribute('data-open')).toBeNull();
});

/** The phone search, a layer of the page's own, with the Centro's mark outside it. */
function Search() {
  useBackClosesOverlayV1();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Buscar
      </button>
      <a href="#/painel-do-aluno" onPointerDown={() => setOpen(false)}>
        Centro de Administração
      </a>
      {open ? <div data-back-layer="" data-testid="search" /> : null}
    </>
  );
}

it('a link tapped as the search closes takes the released entry, so one back returns (A28)', async () => {
  render(<Search />);
  const start = window.history.length;
  fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
  await tick(20);
  expect(window.history.length).toBe(start + 1);
  const link = screen.getByRole('link', { name: 'Centro de Administração' });
  fireEvent.pointerDown(link);
  await tick(20);
  expect(screen.queryByTestId('search')).toBeNull();
  fireEvent.click(link);
  await tick(600);
  expect(window.location.hash).toBe('#/painel-do-aluno');
  expect(window.history.length).toBe(start + 1);
  window.history.back();
  await tick(80);
  expect(window.location.hash).toBe('#/banco-de-notas');
});
