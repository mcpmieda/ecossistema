import { Chip } from '@heroui/react/chip';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import './student-grades-v1.css';

type SubjectV1 = SelfResponseV1['subjects'][number];
type PeriodV1 = SubjectV1['periods'][number];
type MarkV1 = PeriodV1['final'];
type StudentMarkPropsV1 = Readonly<{
  mark: MarkV1;
  showMaximum?: boolean;
  /** Trimester marks: whole numbers read "27,0". */
  oneDecimal?: boolean;
}>;

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 20 });
const oneDecimalNumber = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 20,
});

function classificationV1(meetsMinimum: boolean | null) {
  if (meetsMinimum === true) return 'Atinge o mínimo institucional';
  if (meetsMinimum === false) return 'Abaixo do mínimo institucional';
  return 'Classificação indisponível';
}

function minimumStateV1(meetsMinimum: boolean | null) {
  if (meetsMinimum === null) return 'unknown';
  return meetsMinimum ? 'met' : 'below';
}

/** Text/colour mapping only. It never derives a threshold, average, result or new mark. */
export function StudentMarkV1({ mark, showMaximum = false, oneDecimal = false }: StudentMarkPropsV1) {
  if (mark.kind === 'recovery-pending')
    return (
      // Red: a pending recovery is the below-minimum side of the portal's two colours.
      <Chip size="sm" color="danger" variant="soft" aria-label="Recuperação pendente de nota">
        REC
      </Chip>
    );
  if (mark.kind !== 'score') {
    const label = { absent: 'Ainda não lançado', nc: 'N/C', rr: 'R/R' }[mark.kind];
    return (
      <span className="pa-mark-neutral" aria-label={label}>
        {mark.kind === 'absent' ? '—' : label}
      </span>
    );
  }
  const classification = classificationV1(mark.meetsMinimum);
  const value = (oneDecimal ? oneDecimalNumber : number).format(mark.value);
  const total = showMaximum && mark.maximum !== null ? number.format(mark.maximum) : null;
  const maximumLabel = total === null ? '' : ` de ${total}`;
  const ariaLabel = `${value}${maximumLabel}. ${classification}`;
  return (
    <span
      className="pa-mark"
      data-minimum={minimumStateV1(mark.meetsMinimum)}
      aria-label={ariaLabel}
    >
      <span className="pa-mark-value">{value}</span>
      {/* "8 de 10" reads as a sentence; same size and colour as before. */}
      {total === null ? null : <span className="pa-mark-maximum"> de {total}</span>}
    </span>
  );
}
