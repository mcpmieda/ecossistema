import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button, Chip, Table } from '@heroui/react';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import '../../student-portal-admin/shared/student-avatar-v1.css';
import type { PerformanceRowV2 } from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';

interface PerformanceGridColumnV2 {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly offerId: number;
}
interface PerformanceGridRowV2 {
  readonly student: PerformanceRowV2['student'];
  readonly values: readonly ReactNode[];
  /** Per value column, whether this student is below the minimum there. */
  readonly below?: readonly boolean[];
  readonly annual?: string | null;
}
const STATUS_SHORT: Record<Exclude<PerformanceRowV2['student']['status'], null>, string> = {
  1: 'Especial',
  2: 'Assistido',
  3: 'Desistente',
  4: 'Transferido',
  5: 'Falecido',
  7: 'Estava no',
};
const STATUS_TONE: Record<Exclude<PerformanceRowV2['student']['status'], null>, string> = {
  1: 'special',
  2: 'assisted',
  3: 'withdrawn',
  4: 'transferred',
  5: 'deceased',
  7: 'origin',
};
/** The academic year of the grids below it; with it each row shows the student's photo. */
export const PerformanceGridYearV2 = createContext<number | null>(null);

/** Value columns start after number, situation and student. */
const FIXED_COLUMNS = 3;
const byName = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/** The status chip's text: in progress, the transfer's own label, or the short status. */
function statusShort(student: PerformanceRowV2['student']) {
  if (student.status === null) return 'Em curso';
  return student.status === 7 ? student.statusLabel : STATUS_SHORT[student.status];
}

/** Shared table anatomy keeps all four lenses compact and keyboard-resizable. */
export function PerformanceGridV2({
  columns,
  rows,
  open,
  focusOffer,
  showAnnual = false,
  label,
}: {
  readonly columns: readonly PerformanceGridColumnV2[];
  readonly rows: readonly PerformanceGridRowV2[];
  readonly open: (studentId: number, offerId?: number) => void;
  readonly focusOffer?: (offerId: number) => void;
  readonly showAnnual?: boolean;
  readonly label: string;
}) {
  const academicYear = useContext(PerformanceGridYearV2);
  const headers = [
    { id: 'number', label: 'Nº', width: 28 },
    { id: 'status', label: 'Situação', width: 72 },
    { id: 'student', label: 'Aluno', width: 192 },
    ...columns.map((column) => ({
      id: `value-${column.key}`,
      label: column.label,
      width: column.label.length > 5 ? 112 : 44,
    })),
    ...(showAnnual ? [{ id: 'annual', label: 'Resultado', width: 150 }] : []),
  ];
  // Shown in alphabetical order and counted from 1 over what is listed; the number and the
  // order of the source spreadsheet stay where they are stored.
  const ordered = useMemo(
    () =>
      [...rows]
        .sort((a, b) => byName.compare(a.student.name, b.student.name))
        .map((row, index) => ({ ...row, id: row.student.id, position: index + 1 })),
    [rows],
  );
  const below = useMemo(
    () => new Map(ordered.map((row) => [String(row.student.id), row.below ?? []])),
    [ordered],
  );

  const root = useRef<HTMLDivElement | null>(null);
  const pin = useRef<HTMLDivElement | null>(null);
  /** Whether the pinned copy is on screen. Kept out of React: a scroll never re-renders the grid. */
  const pinned = useRef(false);
  const hovered = useRef<{ row: string | null; column: number }>({ row: null, column: -1 });

  /** The header cells of one column: the table's own and the pinned copy's. */
  const headCells = (index: number) =>
    [
      root.current?.querySelector('thead tr')?.children[index],
      pin.current?.firstElementChild?.children[index],
    ].filter((cell): cell is Element => cell !== undefined && cell !== null);
  const markBelow = (row: string | null) => {
    const flags = row === null ? [] : (below.get(row) ?? []);
    columns.forEach((_, index) =>
      headCells(index + FIXED_COLUMNS).forEach((cell) =>
        cell.toggleAttribute('data-below', flags[index] === true),
      ),
    );
  };
  const markColumn = (column: number) => {
    root.current
      ?.querySelectorAll<HTMLElement>('[data-col-hover]')
      .forEach((cell) => delete cell.dataset.colHover);
    if (column < FIXED_COLUMNS) return;
    root.current
      ?.querySelectorAll<HTMLTableRowElement>('tbody tr')
      .forEach((line) => line.cells[column]?.setAttribute('data-col-hover', ''));
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const cell = (event.target as Element).closest<HTMLTableCellElement>('td, th');
    const line = cell?.closest<HTMLTableRowElement>('tbody tr') ?? null;
    const next = { row: line?.dataset.key ?? null, column: cell?.cellIndex ?? -1 };
    if (next.row !== hovered.current.row) markBelow(next.row);
    if (next.column !== hovered.current.column) markColumn(next.column);
    hovered.current = next;
  };
  const leave = () => {
    hovered.current = { row: null, column: -1 };
    markBelow(null);
    markColumn(-1);
  };

  /** Gives each column of the pinned copy the width of the table's own: all reads, then writes. */
  const measure = () => {
    const head = root.current?.querySelector('.table__scroll-container thead');
    const track = pin.current?.firstElementChild as HTMLElement | null | undefined;
    if (!head || !track) return;
    const cells = [...(head.querySelector('tr')?.children ?? [])];
    const widths = cells.map((cell) => cell.getBoundingClientRect().width);
    track.style.width = `${head.getBoundingClientRect().width}px`;
    [...track.children].forEach((item, index) => {
      (item as HTMLElement).style.width = `${widths[index] ?? 0}px`;
    });
  };
  /** Places the pinned copy over the table under the shell's top bar, or hides it. */
  const align = (remeasure: boolean) => {
    const scroller = root.current?.querySelector<HTMLElement>('.table__scroll-container');
    const head = scroller?.querySelector('thead');
    const copy = pin.current;
    if (!scroller || !head || !copy) return;
    // Under whatever stays on top of the page: the shell's top bar and, under it, the area's tabs.
    const top = Math.max(
      0,
      ...[...document.querySelectorAll('.shell-topbar, .shell-areabar:not(:empty)')].map(
        (bar) => bar.getBoundingClientRect().bottom,
      ),
    );
    const box = scroller.getBoundingClientRect();
    const line = head.getBoundingClientRect();
    const shown = line.height > 0 && line.top < top && box.bottom - line.height * 2 > top;
    const appearing = shown && !pinned.current;
    pinned.current = shown;
    copy.hidden = !shown;
    if (!shown) return;
    if (appearing || remeasure) measure();
    copy.style.top = `${top}px`;
    copy.style.left = `${box.left}px`;
    copy.style.width = `${box.width}px`;
    (copy.firstElementChild as HTMLElement | null)?.style.setProperty(
      'transform',
      `translateX(${-scroller.scrollLeft}px)`,
    );
    if (appearing) markBelow(hovered.current.row);
  };
  const alignLatest = useRef(align);
  useEffect(() => {
    alignLatest.current = align;
  });
  useEffect(() => {
    // At most once a frame, however many scroll events the phone sends.
    let frame = 0;
    let remeasure = false;
    const schedule = (sizes: boolean) => {
      remeasure ||= sizes;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const sized = remeasure;
        remeasure = false;
        alignLatest.current(sized);
      });
    };
    const onScroll = () => schedule(false);
    const onResize = () => schedule(true);
    const scroller = root.current?.querySelector('.table__scroll-container');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    if (scroller) observer?.observe(scroller);
    // Captured: on a computer the page scrolls inside the sheet, not the window.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize);
    alignLatest.current(true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
    };
  }, []);
  // New columns or labels: the copy on screen takes their widths again.
  useLayoutEffect(() => {
    if (!pinned.current) return;
    align(true);
    markBelow(hovered.current.row);
  });

  return (
    <div
      ref={root}
      className="performance-grid min-w-0"
      onPointerOver={point}
      onPointerLeave={leave}
    >
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <div ref={pin} className="performance-grid-pin" aria-hidden="true" hidden>
              <div className="performance-grid-pin__track">
                {headers.map((header) => (
                  <span
                    key={header.id}
                    className={
                      header.id.startsWith('value-') ? 'performance-grid-pin__value' : undefined
                    }
                  >
                    {header.label}
                  </span>
                ))}
              </div>
            </div>,
            document.body,
          )}
      <Table className="min-w-0">
        <Table.ScrollContainer className="max-w-full overflow-x-auto rounded-xl border border-separator">
          <Table.Content
            aria-label={label}
            className="w-full text-xs"
            style={{ minWidth: headers.reduce((sum, col) => sum + col.width, 0) }}
          >
            <Table.Header columns={headers}>
              {(header) => {
                const column = columns.find((item) => `value-${item.key}` === header.id);
                // A component's column opens its assessments when the page offers that.
                let title: ReactNode = header.label;
                if (column)
                  title = focusOffer ? (
                    <button
                      type="button"
                      title={column.title}
                      aria-label={`Ver avaliações de ${column.title}`}
                      onClick={() => focusOffer(column.offerId)}
                      className="w-full whitespace-normal break-words text-center font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    >
                      {column.label}
                    </button>
                  ) : (
                    <span
                      title={column.title}
                      className="block w-full whitespace-normal break-words text-center font-semibold"
                    >
                      {column.label}
                    </span>
                  );
                return (
                  <Table.Column
                    id={header.id}
                    isRowHeader={header.id === 'student'}
                    defaultWidth={header.id === 'student' ? '1fr' : header.width}
                    minWidth={header.width}
                    className={`performance-grid__head py-1 ${header.id === 'student' ? 'px-2' : 'px-1'}${header.id === 'number' || header.id === 'status' ? ' performance-grid__fit' : ''}`}
                  >
                    {title}
                  </Table.Column>
                );
              }}
            </Table.Header>
            <Table.Body items={ordered} renderEmptyState={() => 'Nenhum aluno neste recorte.'}>
              {(row) => (
                <Table.Row id={row.id} columns={headers} className="performance-grid__row">
                  {(header) => {
                    const index = headers.indexOf(header) - FIXED_COLUMNS;
                    let content: ReactNode;
                    if (header.id === 'number') {
                      content = <span className="tabular-nums">{row.position}</span>;
                    } else if (header.id === 'status') {
                      content = (
                        <Chip
                          size="sm"
                          variant="soft"
                          title={row.student.statusLabel}
                          aria-label={row.student.statusLabel}
                          className={`performance-status-chip performance-status-chip--${row.student.status === null ? 'regular' : STATUS_TONE[row.student.status]}`}
                        >
                          <Chip.Label className="whitespace-nowrap">
                            {statusShort(row.student)}
                          </Chip.Label>
                        </Chip>
                      );
                    } else if (header.id === 'student') {
                      content = (
                        <span className="flex min-w-0 items-center gap-1.5">
                          {academicYear === null ? null : (
                            // 20px inside a 24px row: the photo never makes the line taller.
                            <LinkedStudentPhotoAvatarV1
                              decorative
                              size="sm"
                              className="pa-student-avatar size-5 shrink-0"
                              fallbackTone={row.student.id % 6}
                              subject={{
                                source: 'gradebook',
                                academicYear,
                                studentIds: [row.student.id],
                              }}
                            />
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-6 h-auto min-w-0 flex-1 justify-start whitespace-normal break-words px-1.5 py-0 text-left text-xs leading-4"
                            onPress={() => open(row.student.id)}
                          >
                            {row.student.name}
                          </Button>
                        </span>
                      );
                    } else if (header.id === 'annual') {
                      content = <span className="text-xs">{row.annual ?? '—'}</span>;
                    } else {
                      content = (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-6 h-auto w-full min-w-0 px-0 py-0 text-xs"
                          aria-label={`${row.student.name}, ${columns[index]!.title}`}
                          onPress={() => open(row.student.id, columns[index]!.offerId)}
                        >
                          {row.values[index]}
                        </Button>
                      );
                    }
                    return (
                      <Table.Cell
                        className={`performance-grid__cell py-0.5 ${header.id === 'student' ? 'pl-1 pr-2' : 'px-1'}${header.id === 'number' ? ' text-center' : ''}${header.id === 'number' || header.id === 'status' ? ' performance-grid__fit' : ''}`}
                      >
                        {content}
                      </Table.Cell>
                    );
                  }}
                </Table.Row>
              )}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}
