// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { learningFixtureV1 } from './learning-fixture-v1';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';
import { PerformanceGridV2 } from '../../../src/features/gradebook/performance/performance-grid-v2';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const frame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
const rect = (top: number, height: number, width = 360) =>
  ({ top, bottom: top + height, height, width, left: 0, right: width, x: 0, y: top }) as DOMRect;

/** Owner report 12/11/2026: scrolling the Notas page hitched. The pinned header of the grid now
 * shows and hides without re-rendering the grid, at most once a frame. */
it('the pinned header follows the scroll without rebuilding the table', async () => {
  const { matrix } = learningFixtureV1({ period: 2 });
  const topbar = document.createElement('header');
  topbar.className = 'shell-topbar';
  document.body.appendChild(topbar);
  let headTop = 200;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === topbar) return rect(0, 56);
    if (this.matches('thead')) return rect(headTop, 32);
    if (this.matches('.table__scroll-container')) return rect(headTop, 900);
    return rect(0, 20, 60);
  });
  const { container } = render(
    <PerformanceGridV2
      label="Matriz"
      open={vi.fn()}
      columns={matrix.offers.map((offer) => ({
        key: String(offer.id),
        label: offer.subject.label,
        title: offer.subject.label,
        offerId: offer.id,
      }))}
      rows={matrix.rows.map((row) => ({ student: row.student, values: row.cells.map(() => '1') }))}
    />,
  );
  const pin = document.querySelector<HTMLElement>('.performance-grid-pin')!;
  expect(pin.hidden).toBe(true);
  const firstCell = container.querySelector('tbody td');

  headTop = -40;
  for (let index = 0; index < 5; index += 1) window.dispatchEvent(new Event('scroll'));
  await frame();
  expect(pin.hidden).toBe(false);
  expect(pin.style.top).toBe('56px');
  expect((pin.firstElementChild!.children[0] as HTMLElement).style.width).toBe('60px');
  // The same cells as before: the scroll did not re-render the table.
  expect(container.querySelector('tbody td')).toBe(firstCell);

  headTop = 200;
  window.dispatchEvent(new Event('scroll'));
  await frame();
  expect(pin.hidden).toBe(true);
});
