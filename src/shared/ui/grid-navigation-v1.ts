import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';

const FOCUSABLE_V1 = 'button, a[href], input, select, textarea, [tabindex]';

type GridPlaceV1 =
  | { kind: 'row'; row: HTMLTableRowElement }
  | { kind: 'cell'; row: HTMLTableRowElement; cell: HTMLTableCellElement; head: boolean };

/** Body rows that stand for items (the empty-state row has no key). */
const bodyRowsV1 = (table: HTMLTableElement) =>
  [...(table.tBodies[0]?.rows ?? [])].filter((row) => row.dataset.key !== undefined);
const headCellsV1 = (table: HTMLTableElement) => [...(table.tHead?.rows[0]?.cells ?? [])];

function placeOfV1(table: HTMLTableElement, from: Element): GridPlaceV1 | null {
  const row = from.closest('tr');
  if (!row || !table.contains(row)) return null;
  if (from === row) return { kind: 'row', row };
  const cell = from.closest<HTMLTableCellElement>('td, th');
  if (!cell) return null;
  return { kind: 'cell', row, cell, head: row.parentElement === table.tHead };
}
const itemOfV1 = (place: GridPlaceV1) => (place.kind === 'cell' ? place.cell : place.row);

/** React Aria's platform rule: on a Mac, Option moves like the plain key and Ctrl is left to the
 * page; elsewhere Ctrl moves like the plain key and, with Home/End, reaches the whole grid. */
const isMacV1 = () => {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /^Mac/i.test(data?.platform ?? '') || /Macintosh/.test(navigator.userAgent);
};

/** Where the focus is when a key is pressed, with the grid's rows and header around it. */
interface GridSpotV1 {
  readonly rows: readonly HTMLTableRowElement[];
  readonly head: readonly HTMLTableCellElement[];
  readonly row: HTMLTableRowElement;
  /** The cell's column, or -1 on a row. */
  readonly column: number;
  /** Ctrl (outside a Mac): Home/End reach the whole grid. */
  readonly ctrl: boolean;
}
type GridMoveV1 = (spot: GridSpotV1) => HTMLElement | null;

const cellAtV1 = (row: HTMLTableRowElement | undefined, column: number) =>
  row?.cells[column] ?? null;
const lastCellV1 = (row: HTMLTableRowElement | undefined) =>
  row ? cellAtV1(row, row.cells.length - 1) : null;
const rowAtV1 = (rows: readonly HTMLTableRowElement[], index: number) => rows[index] ?? null;

/** React Aria's table keyboard delegate, by where the focus is: a row, a header cell or a cell. */
const ROW_MOVES_V1 = new Map<string, GridMoveV1>([
  ['ArrowDown', ({ rows, row }) => rowAtV1(rows, rows.indexOf(row) + 1)],
  ['ArrowUp', ({ rows, row, head }) => rows[rows.indexOf(row) - 1] ?? head[0] ?? null],
  ['ArrowRight', ({ row }) => cellAtV1(row, 0)],
  ['ArrowLeft', ({ row }) => lastCellV1(row)],
  ['Home', ({ rows }) => rowAtV1(rows, 0)],
  ['End', ({ rows }) => rowAtV1(rows, rows.length - 1)],
  ['PageDown', ({ rows }) => rowAtV1(rows, rows.length - 1)],
  ['PageUp', ({ head }) => head[0] ?? null],
]);
const HEAD_MOVES_V1 = new Map<string, GridMoveV1>([
  ['ArrowRight', ({ head, column }) => head[column + 1] ?? head[0] ?? null],
  ['ArrowLeft', ({ head, column }) => head[column - 1] ?? head.at(-1) ?? null],
  ['ArrowDown', ({ rows, column }) => cellAtV1(rows[0], column)],
  ['PageDown', ({ rows, column }) => cellAtV1(rows.at(-1), column)],
  ['Home', ({ rows, head, ctrl }) => (ctrl ? cellAtV1(rows[0], 0) : (head[0] ?? null))],
  ['End', ({ rows, head, ctrl }) => (ctrl ? lastCellV1(rows.at(-1)) : (head.at(-1) ?? null))],
]);
const CELL_MOVES_V1 = new Map<string, GridMoveV1>([
  ['ArrowRight', ({ row, column }) => row.cells[column + 1] ?? row],
  ['ArrowLeft', ({ row, column }) => (column > 0 ? cellAtV1(row, column - 1) : row)],
  ['ArrowDown', ({ rows, row, column }) => cellAtV1(rows[rows.indexOf(row) + 1], column)],
  [
    'ArrowUp',
    ({ rows, row, head, column }) => {
      const index = rows.indexOf(row);
      return index > 0 ? cellAtV1(rows[index - 1], column) : (head[column] ?? null);
    },
  ],
  [
    'PageDown',
    ({ rows, row, column }) => (row === rows.at(-1) ? null : cellAtV1(rows.at(-1), column)),
  ],
  ['PageUp', ({ head, column }) => head[column] ?? null],
  ['Home', ({ rows, row, ctrl }) => (ctrl ? cellAtV1(rows[0], 0) : cellAtV1(row, 0))],
  ['End', ({ rows, row, ctrl }) => (ctrl ? lastCellV1(rows.at(-1)) : lastCellV1(row))],
]);

/** Where a key takes the focus, following React Aria's table keyboard delegate. */
function targetOfV1(
  table: HTMLTableElement,
  place: GridPlaceV1,
  key: string,
  ctrl: boolean,
): HTMLElement | null {
  let moves = CELL_MOVES_V1;
  if (place.kind === 'row') moves = ROW_MOVES_V1;
  else if (place.head) moves = HEAD_MOVES_V1;
  const move = moves.get(key);
  if (!move) return null;
  return move({
    rows: bodyRowsV1(table),
    head: headCellsV1(table),
    row: place.row,
    column: place.kind === 'cell' ? place.cell.cellIndex : -1,
    ctrl,
  });
}

/** A cell takes the focus through its control, when it has one (React Aria's focusMode "child"). */
const focusTargetV1 = (item: HTMLElement) =>
  item instanceof HTMLTableCellElement
    ? (item.querySelector<HTMLElement>(FOCUSABLE_V1) ?? item)
    : item;

/** Whether the focus came from somewhere after the grid in the page (Shift+Tab from below). */
const fromBelowV1 = (table: HTMLTableElement, from: Node | null) =>
  !!from && (table.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** React Aria's scrollIntoViewport: the least scroll that shows the item and, when the page had to
 * move, the table centred first so the item appears in context. */
function scrollIntoViewportV1(item: HTMLElement, table: HTMLElement) {
  if (typeof item.scrollIntoView !== 'function') return;
  const before = item.getBoundingClientRect();
  item.scrollIntoView({ block: 'nearest' });
  const after = item.getBoundingClientRect();
  if (Math.abs(before.left - after.left) > 1 || Math.abs(before.top - after.top) > 1) {
    table.scrollIntoView({ block: 'center', inline: 'center' });
    item.scrollIntoView({ block: 'nearest' });
  }
}

/** React Aria let the page keep these keys only where its cells did not: Up/Down at the grid's
 * edges and Space on a header cell itself are held, so the page does not scroll. */
const holdsKeyV1 = (place: GridPlaceV1, key: string, target: EventTarget) =>
  place.kind === 'cell' &&
  (key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    (key === ' ' && place.head && target === place.cell));

/**
 * Keyboard and focus of a native `<table role="grid">`, as React Aria's Table gives them: a single
 * Tab stop (entering from above, the first row; from below, the last row; afterwards, whatever row,
 * cell or cell control was focused last), Up/Down between rows or along a column up into the
 * header, Left/Right across the cells and back to the row, Home/End within the row (with Ctrl
 * outside a Mac, the whole grid), Page Up to the header and Page Down to the last row, Left/Right
 * wrapping along the header, and the place kept when its row or column leaves. Rows, cells and
 * the controls inside them render with tabIndex -1; the hook moves the 0 without rendering again.
 * An empty table keeps React Aria's rules: no grid keys, and the header's own buttons take Tab.
 */
export function useGridNavigationV1() {
  const table = useRef<HTMLTableElement | null>(null);
  const active = useRef<HTMLElement | null>(null);
  /** Before any focus, the last control also takes Tab, so Shift+Tab from below enters there. */
  const backStop = useRef<HTMLElement | null>(null);
  /** Where the remembered item stood (body row, cell or -1 for the row) and how many rows there were. */
  const spot = useRef({ row: -1, cell: -1, rows: 0 });
  /** Whether the grid holds the focus; React sends no blur when the focused node is removed. */
  const inside = useRef(false);

  const note = (element: HTMLTableElement, target: HTMLElement) => {
    const rows = bodyRowsV1(element);
    const place = placeOfV1(element, target);
    if (!place) return;
    spot.current = {
      row: place.kind === 'cell' && place.head ? 0 : rows.indexOf(place.row),
      cell: place.kind === 'row' ? -1 : place.cell.cellIndex,
      rows: rows.length,
    };
  };
  const dropBackStop = (keep?: HTMLElement) => {
    if (backStop.current && backStop.current !== keep) backStop.current.tabIndex = -1;
    backStop.current = null;
  };
  const remember = (element: HTMLTableElement, target: HTMLElement) => {
    note(element, target);
    dropBackStop(target);
    if (active.current === target) return;
    if (active.current && element.contains(active.current)) active.current.tabIndex = -1;
    target.tabIndex = 0;
    active.current = target;
    element.tabIndex = -1;
  };
  /** The focus the grid had, lost with a removed node, goes to `target`. */
  const keepFocus = (target: HTMLElement) => {
    const current = document.activeElement;
    if (inside.current && (current === null || current === document.body))
      target.focus({ preventScroll: true });
  };
  /** React Aria's empty table: no remembered place; the header's own buttons, when there are any,
   * take Tab, else the table, which also keeps the focus the grid had. */
  const settleEmpty = (element: HTMLTableElement) => {
    if (active.current && active.current.tagName !== 'BUTTON') active.current.tabIndex = -1;
    active.current = null;
    dropBackStop();
    element.tabIndex = element.tHead?.querySelector('button') ? -1 : 0;
    keepFocus(element);
  };
  /** The remembered item left with its row or column: as in React Aria, the item now in its place
   * takes the stop, and the focus when the grid had it. */
  const replaceRemoved = (element: HTMLTableElement, rows: readonly HTMLTableRowElement[]) => {
    active.current = null;
    const { row, cell, rows: before } = spot.current;
    const gone = before - rows.length;
    const index = Math.min(gone > 1 ? Math.max(row - gone + 1, 0) : row, rows.length - 1);
    const line = rows[index];
    if (!line) return;
    const target = focusTargetV1(cell < 0 ? line : (line.cells[cell] ?? line));
    remember(element, target);
    keepFocus(target);
  };
  /** Before any focus: Tab from above reaches the table, Shift+Tab from below the last control. */
  const offerEntries = (element: HTMLTableElement) => {
    element.tabIndex = 0;
    const controls = element.querySelectorAll<HTMLElement>('button');
    const lastControl = controls[controls.length - 1] ?? null;
    if (backStop.current === lastControl) return;
    dropBackStop();
    if (lastControl) lastControl.tabIndex = 0;
    backStop.current = lastControl;
  };
  useLayoutEffect(() => {
    const element = table.current;
    if (!element) return;
    const rows = bodyRowsV1(element);
    if (rows.length === 0) {
      settleEmpty(element);
      return;
    }
    if (active.current && !element.contains(active.current)) replaceRemoved(element, rows);
    if (!active.current) {
      offerEntries(element);
      return;
    }
    element.tabIndex = -1;
    note(element, active.current);
  });

  /** Moves the focus to an item as React Aria does: no jump on focus, then the least scroll. */
  const enter = (element: HTMLTableElement, item: HTMLElement) => {
    focusTargetV1(item).focus({ preventScroll: true });
    scrollIntoViewportV1(item, element);
  };
  /** Tab reached the grid itself: back to the last place, else the first (from below, last) row. */
  const enterGrid = (element: HTMLTableElement, rows: HTMLTableRowElement[], below: boolean) => {
    const place = active.current ? placeOfV1(element, active.current) : null;
    if (!active.current || !place) {
      enter(element, below ? rows.at(-1)! : rows[0]!);
      return;
    }
    active.current.focus({ preventScroll: true });
    scrollIntoViewportV1(itemOfV1(place), element);
  };
  /** Focus that lands inside the grid: a cell focused by a click on its padding or photo hands it
   * to its control, unless it came out of that control (React Aria's focusMode "child"). */
  const settleInside = (element: HTMLTableElement, target: HTMLElement, from: Node | null) => {
    if (!placeOfV1(element, target)) return;
    const control = focusTargetV1(target);
    if (control !== target && !target.contains(from)) {
      control.focus({ preventScroll: true });
      return;
    }
    remember(element, target);
  };
  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const element = event.currentTarget;
    const target = event.target as HTMLElement;
    inside.current = true;
    const rows = bodyRowsV1(element);
    if (rows.length === 0) return;
    const from = event.relatedTarget as Node | null;
    const below = fromBelowV1(element, from);
    if (target === element) {
      enterGrid(element, rows, below);
      return;
    }
    // Shift+Tab from below lands on the last control: as in React Aria, the last row takes it.
    const entering = !active.current && target === backStop.current && !element.contains(from);
    if (entering && target.matches(':focus-visible')) {
      enter(element, below ? rows.at(-1)! : rows[0]!);
      return;
    }
    settleInside(element, target, from);
  };
  const onBlur = (event: FocusEvent<HTMLTableElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) inside.current = false;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const mac = isMacV1();
    if (event.defaultPrevented || event.metaKey || (mac ? event.ctrlKey : event.altKey)) return;
    const element = event.currentTarget;
    if (bodyRowsV1(element).length === 0) return;
    const place = placeOfV1(element, event.target as Element);
    if (!place) return;
    const item = targetOfV1(element, place, event.key, !mac && event.ctrlKey);
    if (item) {
      event.preventDefault();
      enter(element, item);
    } else if (holdsKeyV1(place, event.key, event.target)) event.preventDefault();
  };
  return { ref: table, onFocus, onBlur, onKeyDown };
}
