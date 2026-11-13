import { render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDrawerSwipeV1 } from '../src/platform/drawer-swipe-v1';

afterEach(() => vi.restoreAllMocks());

function Shell() {
  const drawer = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useDrawerSwipeV1(open, setOpen, drawer);
  return <aside ref={drawer} />;
}

/** Owner report 12/11/2026: every scroll on the phone had a small hitch. */
it('no touch or wheel listener on the page can hold up a scroll', () => {
  const blocking: string[] = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    const passive = typeof options === 'object' && options !== null && options.passive === true;
    if (['touchstart', 'touchmove', 'wheel'].includes(type) && !passive) blocking.push(type);
    add(type, listener, options);
  });
  render(<Shell />);
  expect(blocking).toEqual([]);
});
