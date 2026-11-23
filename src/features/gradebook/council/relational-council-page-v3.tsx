import './council-v3.css';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Chip, Spinner } from '@heroui/react';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDot,
  Clock3,
  RefreshCw,
  Scale,
  Users,
  X,
} from 'lucide-react';
import type {
  RelationalCouncilFailureV3,
  RelationalCouncilStudentV3,
  RelationalCouncilTallyV3,
  RelationalCouncilWorkspaceV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';
import { gradeText } from '../performance/performance-display-v2';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import '../../student-portal-admin/shared/student-avatar-v1.css';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useRelationalCouncilV3, type CouncilClassViewV3 } from './use-relational-council-v3';

const FAILURE: Record<RelationalCouncilFailureV3, string> = {
  'invalid-request': 'A operação não pôde ser concluída. Atualize a tela e tente de novo.',
  'not-authorized': 'Sua sessão não possui autorização para operar o Conselho.',
  'not-found': 'A turma não foi encontrada neste ano letivo.',
  unavailable: 'O Conselho está temporariamente indisponível. Nada foi alterado.',
  'scope-too-large': 'A turma é grande demais para ser lida de uma vez.',
};
type CouncilComponentV3 = RelationalCouncilStudentV3['components'][number];
type CouncilGradeV3 = CouncilComponentV3['annual'];
/** The year's end as the card shows it: not approved until the Conselho says otherwise. */
const SITUATION_V3 = {
  1: ['Aprovado pelo Conselho', 'success'],
  2: ['Reprovado pelo Conselho', 'danger'],
  3: ['Reprovado por falta', 'danger'],
} as const;
const TERM_LABELS_V3 = ['1º tri.', '2º tri.', '3º tri.'] as const;

/** One or many, in words: the counts are read aloud and label the summary. */
const countedV3 = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const TALLY_KINDS = [
  ['approved', 'aprovado', 'aprovados', <Check key="approved" size={11} strokeWidth={3.5} />],
  ['rejected', 'reprovado', 'reprovados', <X key="rejected" size={11} strokeWidth={3.5} />],
  ['pending', 'pendente', 'pendentes', <Circle key="pending" size={7} fill="currentColor" />],
] as const;

/** Where the class stands, inside its button: a mark and a count for each outcome, no words.
 * Each outcome has its own shape, so the colour is never the only difference. */
function ClassTallyV3({ tally }: Readonly<{ tally: RelationalCouncilTallyV3 | null }>) {
  if (tally === null)
    return (
      <span
        className="council-tally"
        data-unavailable
        role="img"
        aria-label="Contagem indisponível"
      >
        <CircleAlert size={12} />
      </span>
    );
  const shown = TALLY_KINDS.filter(([kind]) => tally[kind] > 0);
  return (
    <span
      className="council-tally"
      role="img"
      aria-label={shown.map(([kind, one, many]) => countedV3(tally[kind], one, many)).join(', ')}
    >
      {shown.map(([kind, , , mark]) => (
        <span key={kind} data-kind={kind} aria-hidden="true">
          {mark}
          {tally[kind]}
        </span>
      ))}
    </span>
  );
}

/** The classes with eligible students, each one its own button. */
function CouncilClassesV3({
  classes,
  selectedId,
  disabled,
  onSelect,
}: Readonly<{
  classes: readonly CouncilClassViewV3[];
  selectedId: number | null;
  disabled: boolean;
  onSelect: (id: number) => void;
}>) {
  return (
    <div className="council-classes" role="group" aria-label="Turmas do Conselho">
      {classes.map((item) => (
        <button
          key={item.id}
          type="button"
          className="council-class"
          data-selected={item.id === selectedId || undefined}
          aria-pressed={item.id === selectedId}
          disabled={disabled}
          onClick={() => {
            if (item.id !== selectedId) onSelect(item.id);
          }}
        >
          {item.label}
          <ClassTallyV3 tally={item.tally} />
        </button>
      ))}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = 'accent',
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: number;
  readonly tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className={`council-kpi council-kpi--${tone}`}>
      <span className="council-kpi__icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function QueueCard({
  student,
  selected,
  onSelect,
}: {
  readonly student: RelationalCouncilStudentV3;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="council-queue-card"
      data-selected={selected || undefined}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="council-queue-card__number">{student.number}</span>
      <span className="min-w-0">
        <strong className="line-clamp-2 break-words text-sm">{student.name}</strong>
        <span className="block truncate text-xs text-muted">
          {student.decision?.label ??
            `${countedV3(student.eligibility.failedComponentCount, 'componente', 'componentes')} abaixo`}
        </span>
      </span>
      {student.decision ? (
        <CheckCircle2 size={17} className="text-success" aria-label="Decidido" />
      ) : (
        <Clock3 size={17} className="text-warning" aria-label="A deliberar" />
      )}
    </button>
  );
}

/** A mark of the report card: its value, N/C or R/R, a dash while a REC is still to come and
 * nothing where there is no mark to show. */
function reportMarkV3(grade: CouncilGradeV3): string {
  if (grade.state === 'no-show') return 'N/C';
  if (grade.state === 'repeat-failure') return 'R/R';
  if (grade.state === 'recovery-pending') return '—';
  return grade.valueMilli === null ? '' : gradeText(grade.valueMilli);
}
/** The year's total of a component: with the recovery once it is complete; until then, and
 * when the student did not take it, the total of the marks as they are. */
const finalGradeV3 = (component: CouncilComponentV3): CouncilGradeV3 =>
  component.recovery.state === 'complete' ? component.recovery : component.annual;

/** One mark of the report card, on its own background: at or above the minimum, or below it. */
function ReportCellV3({ grade }: { readonly grade: CouncilGradeV3 }) {
  const mark = reportMarkV3(grade);
  return <td>{mark ? <span data-level={grade.level}>{mark}</span> : null}</td>;
}

/** The student's year as the school's report card lays it out: a column for each component, a
 * row for each term's mark and REC, and the year's total. */
function StudentReportV3({ student }: { readonly student: RelationalCouncilStudentV3 }) {
  return (
    <div className="council-report__scroll">
      <table className="council-report" aria-label={`Notas do ano de ${student.name}`}>
        <thead>
          <tr>
            <td colSpan={2} />
            {student.components.map((component) => (
              <th key={component.offerId} scope="col">
                <span>{component.subject.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TERM_LABELS_V3.map((label, term) => (
            <Fragment key={label}>
              <tr>
                <th scope="rowgroup" rowSpan={2}>
                  {label}
                </th>
                <th scope="row">Nota</th>
                {student.components.map((component) => (
                  <ReportCellV3 key={component.offerId} grade={component.terms[term]!} />
                ))}
              </tr>
              <tr data-rec>
                <th scope="row">REC</th>
                {student.components.map((component) => (
                  <ReportCellV3 key={component.offerId} grade={component.termRecoveries[term]!} />
                ))}
              </tr>
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Nota final
            </th>
            {student.components.map((component) => (
              <ReportCellV3 key={component.offerId} grade={finalGradeV3(component)} />
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** The eligible student under discussion, as the card on top of the pile: the photo, the year's
 * end and the report card. The arrows bring the next student of the queue to the top. */
function StudentPanel({
  student,
  year,
  before,
  after,
  onPrevious,
  onNext,
}: Readonly<{
  student: RelationalCouncilStudentV3;
  year: number;
  /** How many students of the queue come before and after this one: the pile shows up to two
   * cards on each side. */
  before: number;
  after: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}>) {
  const [situation, tone] = student.decision
    ? SITUATION_V3[student.decision.code]
    : (['Reprovado', 'danger'] as const);
  return (
    <div className="council-deck">
      {[2, 1].flatMap((depth) => [
        before >= depth ? (
          <span key={`previous-${depth}`} data-side="previous" data-depth={depth} />
        ) : null,
        after >= depth ? <span key={`next-${depth}`} data-side="next" data-depth={depth} /> : null,
      ])}
      <article className="council-card" aria-label={student.name}>
        <header className="council-card__header">
          <LinkedStudentPhotoAvatarV1
            decorative
            size="lg"
            loading="eager"
            className="pa-student-avatar council-card__photo"
            fallbackTone={student.id % 6}
            subject={{ source: 'gradebook', academicYear: year, studentIds: [student.id] }}
          />
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-base font-bold tracking-tight sm:text-lg">
              {student.name}
            </h3>
            <p className="text-sm text-muted">Nº {student.number}</p>
          </div>
          <Chip color={tone} variant="soft">
            <Chip.Label>{situation}</Chip.Label>
          </Chip>
        </header>
        <StudentReportV3 student={student} />
      </article>
      {onPrevious ? (
        <button
          type="button"
          className="council-deck__arrow"
          data-side="previous"
          aria-label="Aluno anterior"
          onClick={onPrevious}
        >
          <ChevronLeft size={18} />
        </button>
      ) : null}
      {onNext ? (
        <button
          type="button"
          className="council-deck__arrow"
          data-side="next"
          aria-label="Próximo aluno"
          onClick={onNext}
        >
          <ChevronRight size={18} />
        </button>
      ) : null}
    </div>
  );
}

/** The reads in progress, the last failure and a stale live read. */
function CouncilStatusV3({
  busy,
  failure,
  stale,
}: Readonly<{
  busy: { classes: boolean; workspace: boolean };
  failure: RelationalCouncilFailureV3 | null;
  stale: boolean;
}>) {
  return (
    // Empty, it stays in the page for the announcements but out of the flow: no row and no gap.
    <div className="empty:absolute" aria-live="polite">
      {busy.classes || busy.workspace ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <output className="contents">
            <Spinner size="sm" />
            Carregando…
          </output>
        </p>
      ) : null}
      {failure ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Operação não concluída</Alert.Title>
            <Alert.Description>{FAILURE[failure]}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <LiveReadNoticeV1 failed={stale} />
    </div>
  );
}

/** The meeting of the class: not started, open, or concluded once every eligible student has a
 * decision. It opens once and is never closed. */
function CouncilSessionV3({
  workspace,
  busy,
  onOpen,
}: Readonly<{
  workspace: RelationalCouncilWorkspaceV3;
  busy: boolean;
  onOpen: () => void;
}>) {
  const opened = workspace.session.state === 'open';
  const concluded = opened && workspace.summary.pending === 0;
  let state = 'Ainda não iniciada';
  if (concluded) state = 'Concluída';
  else if (opened) state = 'Aberta';
  return (
    <div className="council-session" role="group" aria-label="Reunião da turma">
      <Chip color={concluded ? 'success' : opened ? 'accent' : 'default'} variant="soft">
        <Chip.Label>{state}</Chip.Label>
      </Chip>
      {opened ? null : (
        <Button variant="primary" className="ml-auto" isDisabled={busy} onPress={onOpen}>
          <CircleDot size={17} />
          Abrir reunião
        </Button>
      )}
    </div>
  );
}

export function RelationalCouncilPageV3() {
  const state = useRelationalCouncilV3();
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const workspace = state.workspace;
  const eligible = useMemo(
    () => workspace?.students.filter((student) => student.eligibility.eligible) ?? [],
    [workspace],
  );
  const pending = eligible.filter((student) => !student.decision);
  const decided = eligible.filter((student) => student.decision);
  const selected =
    eligible.find((student) => student.id === selectedStudentId) ?? eligible[0] ?? null;
  // The pile follows the queue: who is still to be discussed, then who already has a decision.
  const queue = [...pending, ...decided];
  const position = Math.max(
    queue.findIndex((student) => student.id === selected?.id),
    0,
  );
  const step = (by: -1 | 1) => {
    const next = queue[position + by];
    return next ? () => setSelectedStudentId(next.id) : null;
  };
  useEffect(() => {
    if (!workspace) {
      setSelectedStudentId(null);
      return;
    }
    setSelectedStudentId((current) =>
      eligible.some((student) => student.id === current)
        ? current
        : ((pending[0] ?? eligible[0])?.id ?? null),
    );
  }, [workspace?.classGroup.id]);

  return (
    <section aria-label="Conselho de Classe relacional" className="grid min-w-0 gap-4">
      <h2 className="sr-only">Conselho de Classe</h2>
      {state.classes.length ? (
        <CouncilClassesV3
          classes={state.classes}
          selectedId={state.classId}
          disabled={state.busy.command}
          onSelect={(id) => void state.selectClass(id)}
        />
      ) : null}
      {state.failure ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          isDisabled={state.busy.classes || state.busy.workspace || state.busy.command}
          onPress={() => void state.retry()}
        >
          <RefreshCw size={16} />
          Tentar novamente
        </Button>
      ) : null}
      <CouncilStatusV3 busy={state.busy} failure={state.failure} stale={state.stale} />
      {!workspace && !state.busy.workspace && !state.busy.classes && !state.failure ? (
        <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-separator bg-surface-secondary/40 p-8 text-center">
          <div>
            <Scale className="mx-auto mb-3 text-muted" />
            <strong className="text-sm">
              {state.classes.length
                ? 'Escolha uma turma para abrir a pauta'
                : 'Nenhuma turma com alunos elegíveis'}
            </strong>
          </div>
        </div>
      ) : null}
      {workspace ? (
        <>
          <div className="council-kpi-group" aria-label="Resumo do Conselho">
            <Metric
              icon={<Users size={19} />}
              label={workspace.summary.total === 1 ? 'aluno' : 'alunos'}
              value={workspace.summary.total}
            />
            <Metric
              icon={<Scale size={19} />}
              label={workspace.summary.eligible === 1 ? 'elegível' : 'elegíveis'}
              value={workspace.summary.eligible}
            />
            <Metric
              icon={<Clock3 size={19} />}
              label="a deliberar"
              value={workspace.summary.pending}
              tone="warning"
            />
            <Metric
              icon={<CheckCircle2 size={19} />}
              label={workspace.summary.decided === 1 ? 'decidido' : 'decididos'}
              value={workspace.summary.decided}
              tone="success"
            />
          </div>
          <CouncilSessionV3
            workspace={workspace}
            busy={state.busy.command}
            onOpen={() => void state.openSession()}
          />
          <div className="council-layout">
            <aside className="min-w-0">
              <div className="council-board" aria-label="Fluxo dos alunos elegíveis">
                <section className="council-board__column">
                  <header>
                    <span className="size-2 rounded-full bg-warning" />
                    <strong>A deliberar</strong>
                    <span>{pending.length}</span>
                  </header>
                  <div className="council-board__cards">
                    {pending.map((student) => (
                      <QueueCard
                        key={student.id}
                        student={student}
                        selected={selected?.id === student.id}
                        onSelect={() => setSelectedStudentId(student.id)}
                      />
                    ))}
                    {!pending.length ? (
                      <p className="council-board__empty">
                        <Check size={16} />
                        Fila concluída
                      </p>
                    ) : null}
                  </div>
                </section>
                {decided.length ? (
                  <section className="council-board__column">
                    <header>
                      <span className="size-2 rounded-full bg-success" />
                      <strong>Decididos</strong>
                      <span>{decided.length}</span>
                    </header>
                    <div className="council-board__cards">
                      {decided.map((student) => (
                        <QueueCard
                          key={student.id}
                          student={student}
                          selected={selected?.id === student.id}
                          onSelect={() => setSelectedStudentId(student.id)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            </aside>
            <main className="min-w-0">
              {selected ? (
                <StudentPanel
                  key={selected.id}
                  student={selected}
                  year={workspace.context.year}
                  before={position}
                  after={queue.length - 1 - position}
                  onPrevious={step(-1)}
                  onNext={step(1)}
                />
              ) : null}
            </main>
          </div>
        </>
      ) : null}
    </section>
  );
}
