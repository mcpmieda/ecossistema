import { useMemo, useState } from 'react';
import { Button, Chip, Popover, Surface } from '@heroui/react';
import { ChevronDown, CircleAlert, CircleDashed, ListChecks, Table2 } from 'lucide-react';
import type {
  PerformanceMatrixV2,
  PerformanceStatusV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { FilterTagsV1 } from '../../../shared/ui/filter-tags-v1';
import { GradeValue, subjectText } from './performance-display-v2';
import { PerformanceGridV2 } from './performance-grid-v2';

const statusKey = (status: PerformanceStatusV2) =>
  status === null ? 'status-current' : `status-${status}`;
type InvestigationV2 = 'all' | 'below' | 'incomplete';
const INVESTIGATIONS_V2 = [
  { id: 'all', label: 'Todos', icon: <ListChecks size={13} aria-hidden /> },
  { id: 'below', label: 'Abaixo do limite', icon: <CircleAlert size={13} aria-hidden /> },
  { id: 'incomplete', label: 'Incompletos', icon: <CircleDashed size={13} aria-hidden /> },
] as const;

export function PerformanceResultMatrixV2({
  value,
  open,
  allowedIds,
  focusOffer,
  statusOptions,
  statuses,
  onStatusesChange,
}: {
  readonly value: PerformanceMatrixV2;
  readonly open: (studentId: number, offerId?: number) => void;
  readonly allowedIds: ReadonlySet<number> | null;
  readonly focusOffer: (offerId: number) => void;
  readonly statusOptions: readonly {
    readonly value: PerformanceStatusV2;
    readonly label: string;
  }[];
  readonly statuses: readonly PerformanceStatusV2[];
  readonly onStatusesChange: (statuses: PerformanceStatusV2[]) => void;
}) {
  const [investigation, setInvestigation] = useState<InvestigationV2>('all');
  const rows = value.rows
    .filter((row) => statuses.includes(row.student.status))
    .filter((row) => allowedIds === null || allowedIds.has(row.student.id))
    .filter(
      (row) =>
        investigation === 'all' ||
        (row.student.indicatorEligible &&
          row.cells.some((cell) =>
            investigation === 'below'
              ? cell.level === 'below'
              : cell.state !== 'complete' &&
                cell.state !== 'no-show' &&
                cell.state !== 'repeat-failure' &&
                (value.mode === 'regular' || cell.recoveryApplicable === true),
          )),
    );
  const statusTags = useMemo(
    () => statusOptions.map((option) => ({ id: statusKey(option.value), label: option.label })),
    [statusOptions],
  );
  const selectedStatuses = useMemo(() => new Set(statuses.map(statusKey)), [statuses]);
  const selectedInvestigation = useMemo(() => new Set<string>([investigation]), [investigation]);
  // The situations live behind one button, so the title and filters share a single line.
  const shown = statusOptions.filter((option) => statuses.includes(option.value));
  const statusSummary =
    shown.length === statusOptions.length
      ? 'Todas'
      : `${shown[0]?.label ?? ''}${shown.length > 1 ? ` +${shown.length - 1}` : ''}`;
  return (
    <Surface variant="default" className="performance-widget grid min-w-0 gap-3">
      <header className="performance-widget__header performance-matrix-header">
        <span className="performance-widget__icon performance-widget__icon--accent">
          <Table2 size={18} />
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <h3 className="text-sm font-semibold">Matriz de resultados</h3>
          <Chip size="sm" variant="soft">
            {rows.length}
          </Chip>
        </span>
        <div className="performance-matrix-filters">
          <FilterTagsV1
            inline
            single
            label="Filtros rápidos"
            selected={selectedInvestigation}
            options={INVESTIGATIONS_V2}
            onChange={(keys) => {
              const next = INVESTIGATIONS_V2.find((item) => keys.has(item.id));
              if (next) setInvestigation(next.id);
            }}
          />
          <Popover>
            <Button size="sm" variant="secondary" aria-label={`Situações exibidas: ${statusSummary}`}>
              Situações: {statusSummary}
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
            <Popover.Content placement="bottom end">
              <Popover.Dialog aria-label="Situações exibidas" className="performance-matrix-statuses">
                <FilterTagsV1
                  label="Situações exibidas"
                  selected={selectedStatuses}
                  options={statusTags}
                  onChange={(keys) => {
                    // At least one situation stays shown; an emptied group keeps the last reading.
                    const selected = statusOptions
                      .filter((option) => keys.has(statusKey(option.value)))
                      .map((option) => option.value);
                    if (selected.length > 0) onStatusesChange(selected);
                  }}
                />
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
      </header>
      <PerformanceGridV2
        label="Matriz de Desempenho"
        columns={value.offers.map((offer) => ({
          key: String(offer.id),
          label: subjectText(offer),
          title: offer.subject.label,
          offerId: offer.id,
        }))}
        rows={rows.map((row) => ({
          student: row.student,
          values: row.cells.map((cell) => (
            <GradeValue key={cell.offerId} cell={cell} partialAsMarker />
          )),
          below: row.cells.map((cell) => cell.level === 'below'),
          annual: row.calculatedAnnual?.label,
        }))}
        showAnnual={value.period === 'annual' || value.period === 3 || value.mode === 'recovery'}
        open={open}
        focusOffer={focusOffer}
      />
    </Surface>
  );
}
