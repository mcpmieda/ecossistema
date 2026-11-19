// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
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

function renderGrid(rowCount?: number) {
  const { matrix } = learningFixtureV1({ period: 2 });
  const columns = matrix.offers.map((offer) => ({
    key: String(offer.id),
    label: offer.subject.label,
    title: offer.subject.label,
    offerId: offer.id,
  }));
  const rows = matrix.rows.map((row) => ({
    student: row.student,
    values: row.cells.map(() => '1'),
  }));
  const open = vi.fn();
  const focusOffer = vi.fn();
  const grid = (list: typeof rows) => (
    <>
      <button type="button">antes</button>
      <PerformanceGridV2
        label="Matriz"
        open={open}
        focusOffer={focusOffer}
        columns={columns}
        rows={list}
      />
      <button type="button">depois</button>
    </>
  );
  const view = render(grid(rows.slice(0, rowCount)));
  const table = view.container.querySelector('table')!;
  const [before, after] = [...view.container.querySelectorAll(':scope > button')] as [
    HTMLButtonElement,
    HTMLButtonElement,
  ];
  const rerender = (list: typeof rows) => view.rerender(grid(list));
  return { table, open, columns, rows, rerender, before, after };
}

const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement!, { key, ...init });
/** Where the focus is: "row r", "cell r:c" or "head c", plus whether a control holds it. */
function place() {
  const element = document.activeElement as HTMLElement;
  const row = element.closest('tr')!;
  const cell = element.closest('td, th') as HTMLTableCellElement | null;
  const control = element.tagName === 'BUTTON' ? '+button' : '';
  if (element === row) return `row ${row.sectionRowIndex}`;
  if (row.parentElement!.tagName === 'THEAD') return `head ${cell!.cellIndex}${control}`;
  return `cell ${row.sectionRowIndex}:${cell!.cellIndex}${control}`;
}
const tabStops = (table: HTMLTableElement) =>
  [table, ...table.querySelectorAll<HTMLElement>('tr, td, th, button')].filter(
    (element) => element.tabIndex === 0,
  );
const lastControl = (table: HTMLTableElement) => [...table.querySelectorAll('button')].at(-1)!;

/** Owner decision 18/11/2026 (#1539): the grade matrix is a native table and keeps React Aria's
 * grid semantics and keyboard, measured key by key against the previous Table. */
it("keeps the grid roles and names, and React Aria's two ways in", () => {
  const { table, rows } = renderGrid();
  expect(table.getAttribute('role')).toBe('grid');
  expect(table.getAttribute('aria-label')).toBe('Matriz');
  const heads = [...table.tHead!.rows[0]!.cells];
  expect(heads.map((cell) => cell.getAttribute('role'))).toEqual(heads.map(() => 'columnheader'));
  const body = [...table.tBodies[0]!.rows];
  expect(body).toHaveLength(rows.length);
  for (const row of body) {
    expect(row.getAttribute('role')).toBe('row');
    const student = row.cells[2]!;
    expect(student.getAttribute('role')).toBe('rowheader');
    expect(row.getAttribute('aria-labelledby')).toBe(student.id);
    expect([...row.cells].filter((cell) => cell.getAttribute('role') === 'gridcell')).toHaveLength(
      row.cells.length - 1,
    );
  }
  // Before any focus: Tab from above reaches the table, Shift+Tab from below the last control.
  expect(tabStops(table)).toEqual([table, lastControl(table)]);
});

it('moves like React Aria: rows, cells, header and back', () => {
  const { table, columns } = renderGrid();
  const lastRow = table.tBodies[0]!.rows.length - 1;
  const lastColumn = 3 + columns.length - 1;
  act(() => table.focus());
  expect(place()).toBe('row 0');
  press('ArrowDown');
  expect(place()).toBe('row 1');
  press('ArrowRight');
  expect(place()).toBe('cell 1:0');
  press('ArrowRight');
  press('ArrowRight');
  expect(place()).toBe('cell 1:2+button');
  press('ArrowRight');
  expect(place()).toBe('cell 1:3+button');
  press('ArrowUp');
  expect(place()).toBe('cell 0:3+button');
  press('ArrowUp');
  expect(place()).toBe('head 3+button');
  press('ArrowDown');
  expect(place()).toBe('cell 0:3+button');
  press('End');
  expect(place()).toBe(`cell 0:${lastColumn}+button`);
  press('ArrowRight');
  expect(place()).toBe('row 0');
  press('ArrowLeft');
  expect(place()).toBe(`cell 0:${lastColumn}+button`);
  press('Home');
  expect(place()).toBe('cell 0:0');
  press('ArrowLeft');
  expect(place()).toBe('row 0');
  press('ArrowUp');
  expect(place()).toBe('head 0');
  press('ArrowLeft');
  expect(place()).toBe(`head ${lastColumn}+button`);
  press('ArrowRight');
  expect(place()).toBe('head 0');
  press('End', { ctrlKey: true });
  expect(place()).toBe(`cell ${lastRow}:${lastColumn}+button`);
  press('Home', { ctrlKey: true });
  expect(place()).toBe('cell 0:0');
  press('PageDown');
  expect(place()).toBe(`cell ${lastRow}:0`);
  press('PageUp');
  expect(place()).toBe('head 0');
  press('ArrowDown');
  press('ArrowLeft');
  press('End');
  expect(place()).toBe(`row ${lastRow}`);
  press('Home');
  expect(place()).toBe('row 0');
  press('ArrowDown');
  press('PageUp');
  expect(place()).toBe('head 0');
});

it('keeps the page still where React Aria did: Up/Down at the edges, Space on a header cell', () => {
  const { table, columns } = renderGrid();
  const lastColumn = 3 + columns.length - 1;
  act(() => table.focus());
  press('ArrowUp');
  expect(place()).toBe('head 0');
  expect(press('ArrowUp')).toBe(false);
  expect(press(' ')).toBe(false);
  expect(place()).toBe('head 0');
  press('End', { ctrlKey: true });
  expect(press('ArrowDown')).toBe(false);
  expect(place()).toBe(`cell ${table.tBodies[0]!.rows.length - 1}:${lastColumn}+button`);
  // Keys the grid does not use stay with the page.
  expect(press('a')).toBe(true);
  expect(press('Tab')).toBe(true);
  expect(press('ArrowLeft', { altKey: true })).toBe(true);
});

it('keeps one Tab stop on the last focused place, and Enter or Space for the control', () => {
  const { table, open } = renderGrid();
  act(() => table.focus());
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  press('ArrowRight');
  const grade = document.activeElement as HTMLButtonElement;
  expect(place()).toBe('cell 0:3+button');
  expect(tabStops(table)).toEqual([grade]);
  // The grid lets Enter and Space through to the native button.
  expect(fireEvent.keyDown(grade, { key: 'Enter' })).toBe(true);
  expect(fireEvent.keyDown(grade, { key: ' ' })).toBe(true);
  fireEvent.click(grade);
  expect(open).toHaveBeenCalledTimes(1);
  // A click elsewhere moves the stop there.
  const other = table.tBodies[0]!.rows[1]!.cells[5]!.querySelector('button')!;
  act(() => other.focus());
  expect(tabStops(table)).toEqual([other]);
});

it('hands the focus of a clicked cell to its control, as React Aria did', () => {
  const { table } = renderGrid();
  const cell = table.tBodies[0]!.rows[1]!.cells[3]!;
  act(() => cell.focus());
  expect(document.activeElement).toBe(cell.querySelector('button'));
  expect(tabStops(table)).toEqual([cell.querySelector('button')]);
  // A cell without a control keeps the focus itself.
  const number = table.tBodies[0]!.rows[1]!.cells[0]!;
  act(() => number.focus());
  expect(document.activeElement).toBe(number);
});

/** jsdom has no keyboard modality: the keyboard's focus is told apart by :focus-visible. */
function keyboardModality(on: boolean) {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':focus-visible' ? on : matches.call(this, selector);
  });
}

it('enters from below on the last row; a click there keeps the clicked control', () => {
  const { table, after } = renderGrid();
  keyboardModality(true);
  act(() => after.focus());
  // The browser's Shift+Tab lands on the last control; the grid takes the last row.
  act(() => lastControl(table).focus());
  expect(place()).toBe(`row ${table.tBodies[0]!.rows.length - 1}`);
  expect(tabStops(table)).toEqual([document.activeElement]);

  cleanup();
  vi.restoreAllMocks();
  const second = renderGrid();
  keyboardModality(false);
  act(() => second.after.focus());
  act(() => lastControl(second.table).focus());
  expect(document.activeElement).toBe(lastControl(second.table));
});

it('moves the place to the item now there when its row leaves, as React Aria does', () => {
  const { table, rows, rerender } = renderGrid();
  act(() => table.focus());
  press('ArrowDown');
  press('ArrowDown');
  expect(place()).toBe('row 2');
  act(() => (document.activeElement as HTMLElement).blur());
  rerender(rows.slice(0, 2));
  // The remembered row left while the focus was elsewhere: the neighbour keeps the stop.
  expect(tabStops(table)).toEqual([table.tBodies[0]!.rows[1]]);
  act(() => table.focus());
  expect(place()).toBe('row 1');
  // The focused grade's row leaves: the focus moves to the same column of the row now in place.
  rerender(rows);
  act(() => table.tBodies[0]!.rows[1]!.cells[4]!.querySelector('button')!.focus());
  expect(place()).toBe('cell 1:4+button');
  rerender([rows[0]!, ...rows.slice(2)]);
  expect(place()).toBe('cell 1:4+button');
  expect(document.activeElement!.closest('tr')!.dataset.key).toBe(String(rows[2]!.student.id));
});

it("with no rows keeps React Aria's empty table: no grid keys, header buttons take Tab", () => {
  const { table } = renderGrid(0);
  const empty = table.tBodies[0]!.rows[0]!.cells[0]!;
  expect(empty.textContent).toBe('Nenhum aluno neste recorte.');
  expect(empty.getAttribute('role')).toBe('rowheader');
  expect(empty.className).toBe('');
  const buttons = [...table.tHead!.querySelectorAll('button')];
  expect(buttons.length).toBeGreaterThan(0);
  expect(tabStops(table)).toEqual(buttons);
  act(() => table.focus());
  expect(document.activeElement).toBe(table);
  expect(press('ArrowRight')).toBe(true);
  expect(press('ArrowDown')).toBe(true);
  expect(document.activeElement).toBe(table);
});

it("follows React Aria's Mac keys: Option moves, Ctrl is left to the page", () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
  );
  const { table } = renderGrid();
  act(() => table.focus());
  press('ArrowDown', { altKey: true });
  expect(place()).toBe('row 1');
  press('ArrowRight');
  press('ArrowRight');
  expect(place()).toBe('cell 1:1');
  expect(press('Home', { ctrlKey: true })).toBe(true);
  expect(place()).toBe('cell 1:1');
});
