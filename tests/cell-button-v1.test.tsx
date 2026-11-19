// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CellButtonV1 } from '../src/shared/ui/cell-button-v1';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderButton() {
  const onClick = vi.fn();
  const view = render(<CellButtonV1 onClick={onClick}>12,5</CellButtonV1>);
  const button = view.getByRole('button', { name: '12,5' });
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 40,
    bottom: 24,
    width: 40,
    height: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { button, onClick };
}
const lift = (button: HTMLElement, pointerType: string, x = 10, y = 10) =>
  fireEvent.pointerUp(button, { pointerType, button: 0, clientX: x, clientY: y });

/** #1537: the matrices' native buttons keep React Aria's click after a long press on touch. */
it('clicks once after a long press that brought no click', () => {
  const { button, onClick } = renderButton();
  expect(button.getAttribute('type')).toBe('button');
  expect(button.className).toContain('button button--sm button--ghost cell-button-v1');
  lift(button, 'touch');
  expect(onClick).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(80));
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
});

it('does not click twice when the browser already clicked, nor for a mouse or a slide off', () => {
  const { button, onClick } = renderButton();
  lift(button, 'touch');
  fireEvent.click(button);
  act(() => vi.advanceTimersByTime(80));
  expect(onClick).toHaveBeenCalledTimes(1);
  lift(button, 'mouse');
  act(() => vi.advanceTimersByTime(80));
  lift(button, 'touch', 90, 10);
  act(() => vi.advanceTimersByTime(80));
  expect(onClick).toHaveBeenCalledTimes(1);
});
