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

/** React Aria's platform rule: on a Mac, Option moves like the plain key and Ctrl is left to the
 * page; elsewhere Ctrl moves like the plain key and, with Home/End, reaches the whole grid. */
const isMacV1 = () => {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /^Mac/i.test(data?.platform ?? '') || /Macintosh/.test(navigator.userAgent);
};

/** Where a key takes the focus, following React Aria's table keyboard delegate. */
function targetOfV1(
  table: HTMLTableElement,
  place: GridPlaceV1,
  key: string,
  ctrl: boolean,
): HTMLElement | null {
  const rows = bodyRowsV1(table);
  const head = headCellsV1(table);
  const first = rows[0];
  const last = rows.at(-1);
  if (place.kind === 'row') {
    const index = rows.indexOf(place.row);
    switch (key) {
      case 'ArrowDown':
        return rows[index + 1] ?? null;
      case 'ArrowUp':
        return index > 0 ? rows[index - 1]! : (head[0] ?? null);
      case 'ArrowRight':
        return place.row.cells[0] ?? null;
      case 'ArrowLeft':
        return place.row.cells[place.row.cells.length - 1] ?? null;
      case 'Home':
        return first ?? null;
      case 'End':
      case 'PageDown':
        return last ?? null;
      case 'PageUp':
        return head[0] ?? null;
      default:
        return null;
    }
  }
  const column = place.cell.cellIndex;
  const cells = [...place.row.cells];
  if (place.head) {
    switch (key) {
      case 'ArrowRight':
        return head[column + 1] ?? head[0] ?? null;
      case 'ArrowLeft':
        return head[column - 1] ?? head.at(-1) ?? null;
      case 'ArrowDown':
        return first?.cells[column] ?? null;
      case 'PageDown':
        return last?.cells[column] ?? null;
      case 'Home':
        return ctrl ? (first?.cells[0] ?? null) : (head[0] ?? null);
      case 'End':
        return ctrl ? (last?.cells[last.cells.length - 1] ?? null) : (head.at(-1) ?? null);
      default:
        return null;
    }
  }
  const index = rows.indexOf(place.row);
  switch (key) {
    case 'ArrowRight':
      return cells[column + 1] ?? place.row;
    case 'ArrowLeft':
      return column > 0 ? cells[column - 1]! : place.row;
    case 'ArrowDown':
      return rows[index + 1]?.cells[column] ?? null;
    case 'ArrowUp':
      return index > 0 ? (rows[index - 1]!.cells[column] ?? null) : (head[column] ?? null);
    case 'PageDown':
      return place.row === last ? null : (last?.cells[column] ?? null);
    case 'PageUp':
      return head[column] ?? null;
    case 'Home':
      return ctrl ? (first?.cells[0] ?? null) : (cells[0] ?? null);
    case 'End':
      return ctrl ? (last?.cells[last.cells.length - 1] ?? null) : (cells.at(-1) ?? null);
    default:
      return null;
  }
}

/** A cell takes the focus through its control, when it has one (React Aria's focusMode "child"). */
const focusTargetV1 = (item: HTMLElement) =>
  item instanceof HTMLTableCellElement
    ? (item.querySelector<HTMLElement>(FOCUSABLE_V1) ?? item)
    : item;

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
  useLayoutEffect(() => {
    const element = table.current;
    if (!element) return;
    const rows = bodyRowsV1(element);
    if (rows.length === 0) {
      // React Aria's empty table: no remembered place; the header's own buttons, when there are
      // any, take Tab, else the table, which also keeps the focus the grid had.
      if (active.current && active.current.tagName !== 'BUTTON') active.current.tabIndex = -1;
      active.current = null;
      dropBackStop();
      element.tabIndex = element.tHead?.querySelector('button') ? -1 : 0;
      const current = document.activeElement;
      if (inside.current && (current === null || current === document.body))
        element.focus({ preventScroll: true });
      return;
    }
    if (active.current && !element.contains(active.current)) {
      // The remembered item left with its row or column: as in React Aria, the item now in its
      // place takes the stop, and the focus when the grid had it.
      active.current = null;
      const { row, cell, rows: before } = spot.current;
      const gone = before - rows.length;
      const index = Math.min(gone > 1 ? Math.max(row - gone + 1, 0) : row, rows.length - 1);
      const line = index >= 0 ? rows[index] : undefined;
      if (line) {
        const target = focusTargetV1(cell < 0 ? line : (line.cells[cell] ?? line));
        remember(element, target);
        const current = document.activeElement;
        if (inside.current && (current === null || current === document.body))
          target.focus({ preventScroll: true });
      }
    }
    if (active.current) {
      element.tabIndex = -1;
      note(element, active.current);
      return;
    }
    element.tabIndex = 0;
    const controls = element.querySelectorAll<HTMLElement>('button');
    const lastControl = controls[controls.length - 1] ?? null;
    if (backStop.current !== lastControl) {
      dropBackStop();
      if (lastControl) lastControl.tabIndex = 0;
      backStop.current = lastControl;
    }
  });
  /** Moves the focus to an item as React Aria does: no jump on focus, then the least scroll. */
  const enter = (element: HTMLTableElement, item: HTMLElement) => {
    focusTargetV1(item).focus({ preventScroll: true });
    scrollIntoViewportV1(item, element);
  };
  const onFocus = (event: FocusEvent<HTMLTableElement>) => {
    const element = event.currentTarget;
    const target = event.target as HTMLElement;
    inside.current = true;
    const rows = bodyRowsV1(element);
    if (rows.length === 0) return;
    const from = event.relatedTarget as Node | null;
    const outside = !from || !element.contains(from);
    const below =
      !!from && (element.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (target === element) {
      // Tab reached the grid: back to the last place, else the first (or, from below, last) row.
      const place = active.current ? placeOfV1(element, active.current) : null;
      if (active.current && place) {
        active.current.focus({ preventScroll: true });
        scrollIntoViewportV1(place.kind === 'cell' ? place.cell : place.row, element);
      } else enter(element, below ? rows.at(-1)! : rows[0]!);
      return;
    }
    if (
      !active.current &&
      outside &&
      target === backStop.current &&
      target.matches(':focus-visible')
    ) {
      enter(element, below ? rows.at(-1)! : rows[0]!);
      return;
    }
    if (!placeOfV1(element, target)) return;
    // A cell focused by a click on its padding or photo hands the focus to its control, unless the
    // focus came out of that control (React Aria's focusMode "child").
    const control = focusTargetV1(target);
    if (control !== target && !target.contains(from)) {
      control.focus({ preventScroll: true });
      return;
    }
    remember(element, target);
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
    if (!item) {
      // React Aria kept Up/Down at the grid's edges and Space on a header cell: the page stays.
      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
      if (
        place.kind === 'cell' &&
        (vertical || (event.key === ' ' && place.head && event.target === place.cell))
      )
        event.preventDefault();
      return;
    }
    event.preventDefault();
    enter(element, item);
  };
  return { ref: table, onFocus, onBlur, onKeyDown };
}
