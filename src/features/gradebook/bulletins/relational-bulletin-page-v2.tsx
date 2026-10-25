import { GranularStatusV1 } from '../../../shared/grades/granular-status-v1';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  Spinner,
  Surface,
  Table,
} from '@heroui/react';
import {
  Download,
  FileClock,
  FileText,
  History,
  Printer,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  RELATIONAL_BULLETIN_LIMITS_V2,
  type RelationalBulletinDetailV2,
  type RelationalBulletinFailureV2,
  type RelationalBulletinHistoryItemV2,
  type RelationalBulletinModelV2,
  type RelationalBulletinPeriodV2,
  type RelationalBulletinSnapshotV2,
} from '../../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { readSessionRecordV1, storedIdV1, writeSessionViewV1 } from '../../../shared/ui/session-view-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import {
  RelationalBulletinClientErrorV2,
  requestRelationalBulletinV2,
} from './relational-bulletin-client-v2';
import {
  RelationalBulletinPdfActionErrorV2,
  runRelationalBulletinPdfActionV2,
  type RelationalBulletinPdfActionV2,
} from './pdf/bulletin-pdf-actions-v2';

type Catalog = Extract<
  Awaited<ReturnType<typeof requestRelationalBulletinV2>>,
  { operation: 'catalog'; state: 'ready' }
>;
type Students = Extract<
  Awaited<ReturnType<typeof requestRelationalBulletinV2>>,
  { operation: 'students'; state: 'ready' }
>;
type Artifact =
  | { readonly mode: 'preview'; readonly model: RelationalBulletinModelV2 }
  | { readonly mode: 'emission' | 'reprint'; readonly snapshot: RelationalBulletinSnapshotV2 };
type Busy = 'catalog' | 'students' | 'artifact' | 'batch' | 'history' | null;
/** Class, period and detail kept for the tab across a reload. */
const VIEW_KEY_V2 = 'gradebook-bulletins-view';
function readStoredViewV2() {
  const stored = readSessionRecordV1(VIEW_KEY_V2);
  if (!stored) return null;
  const term = ([1, 2, 3] as const).find((item) => item === stored.term);
  let period: RelationalBulletinPeriodV2 | null;
  if (stored.term === 'annual') {
    period = { kind: 'annual' };
  } else if (term) {
    period = { kind: 'term', term };
  } else {
    period = null;
  }
  const detail = (['summary', 'detailed'] as const).find((item) => item === stored.detail);
  if (!period || !detail) return null;
  return { year: storedIdV1(stored.year), classId: storedIdV1(stored.classId), period, detail };
}
type PdfState = RelationalBulletinPdfActionV2 | null;

const FAILURE: Record<RelationalBulletinFailureV2, string> = {
  'invalid-request': 'Os filtros do boletim ficaram inconsistentes. Selecione novamente o recorte.',
  'not-authorized': 'Sua sessão não possui autorização para consultar ou emitir boletins.',
  'not-found': 'A turma, o aluno ou o snapshot não existe mais no contexto acadêmico atual.',
  'scope-too-large': 'O recorte ultrapassa o limite seguro e não foi truncado.',
  'ambiguous-offers': 'Há mais de uma oferta atual para a mesma disciplina nesta turma.',
  'insufficient-data':
    'Ainda faltam valores oficiais para esta emissão. A prévia calculada continua disponível.',
  'version-conflict':
    'Outra emissão avançou este histórico. O estado atual foi preservado; tente novamente.',
  unavailable: 'Boletins estão temporariamente indisponíveis; nenhuma emissão parcial foi mantida.',
};
const CLASSIFICATION: Record<
  NonNullable<RelationalBulletinModelV2['subjects'][number]['annual']>['classification'],
  string
> = {
  'in-progress': 'Em curso',
  'approved-direct': 'Aprovado direto',
  'recovery-pending': 'Recuperação pendente',
  'approved-after-recovery': 'Aprovado pela recuperação',
  'not-approved': 'Não aprovado',
  'failed-no-show': 'Não compareceu',
  'failed-repeat': 'Reprovado (R/R)',
};

type ClassificationV2 = keyof typeof CLASSIFICATION;
/** The annual result's colour. As before: "not-approved" contains "approved", so it is green too. */
function classificationColor(classification: ClassificationV2) {
  if (classification.includes('approved')) return 'success';
  if (
    classification === 'not-approved' ||
    classification === 'failed-no-show' ||
    classification === 'failed-repeat'
  )
    return 'danger';
  return 'default';
}

/** What is loading while the page waits. */
function busyText(busy: Busy) {
  if (busy === 'catalog') return 'Carregando turmas…';
  if (busy === 'students') return 'Carregando alunos…';
  return 'Concluindo operação…';
}

function grade(value: number | null): string {
  return value === null
    ? '—'
    : (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}
function recoveryGrade(value: number | 'NC' | 'RR' | null): string {
  if (value === 'NC') return 'N/C';
  if (value === 'RR') return 'R/R';
  return grade(value);
}
function periodLabel(period: RelationalBulletinPeriodV2): string {
  return period.kind === 'annual' ? 'Anual' : `${period.term}º trimestre`;
}
function readinessLabel(reason: string): string {
  if (reason.startsWith('missing-official-am:')) return 'AM oficial ainda não disponível';
  if (reason.startsWith('missing-official-u:')) return 'U oficial ainda não disponível';
  if (reason.startsWith('incomplete-calculation:')) return 'Composição ainda incompleta';
  if (reason.startsWith('final-recovery-pending:')) return 'Recuperação final pendente';
  if (reason.startsWith('annual-in-progress:') || reason === 'annual-result-in-progress')
    return 'Ano ainda em curso';
  if (reason === 'annual-recovery-pending') return 'Recuperação anual pendente';
  if (reason === 'council-decision-pending') return 'Decisão de Conselho pendente';
  if (reason === 'no-current-offers') return 'Turma sem ofertas atuais';
  return reason;
}
function ComparisonChip({ value }: { readonly value: 'match' | 'mismatch' | 'unavailable' }) {
  let label: 'Confere' | 'Diverge' | 'Sem comparação';
  if (value === 'match') {
    label = 'Confere';
  } else if (value === 'mismatch') {
    label = 'Diverge';
  } else {
    label = 'Sem comparação';
  }
  let color: 'success' | 'danger' | 'default';
  if (value === 'match') {
    color = 'success';
  } else if (value === 'mismatch') {
    color = 'danger';
  } else {
    color = 'default';
  }
  return (
    <Chip size="sm" variant="soft" color={color}>
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}
function BulletinSelect({
  label,
  value,
  items,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key) => {
        if (key !== null) onChange(String(key));
      }}
    >
      <Label className="mb-1.5 block text-xs font-medium text-muted">{label}</Label>
      <Select.Trigger className="min-h-11 w-full">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              <span className="font-medium">{item.label}</span>
              {item.description ? (
                <span className="ml-2 text-xs text-muted">{item.description}</span>
              ) : null}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
function Metric({
  icon,
  value,
  label,
  tone,
}: {
  readonly icon: React.ReactNode;
  readonly value: string | number;
  readonly label: string;
  readonly tone: 'accent' | 'success' | 'warning';
}) {
  return (
    <div className={`bulletin-kpi bulletin-kpi--${tone}`}>
      <span className="bulletin-kpi__icon">{icon}</span>
      <span>
        <strong>{value}</strong>
        <small>{label}</small>
      </span>
    </div>
  );
}
function TermCell({
  subject,
  term,
}: {
  readonly subject: RelationalBulletinModelV2['subjects'][number];
  readonly term: 1 | 2 | 3;
}) {
  const value = subject.terms.find((item) => item.term === term);
  const recovery = subject.annual?.recoveryTerms.find((item) => item.term === term);
  if (!value) return <span className="text-muted">—</span>;
  return (
    <div className="grid min-w-[7rem] gap-1">
      <span className="font-semibold tabular-nums">AM {grade(value.sourceAmMilli)}</span>
      <span className="text-xs text-muted">Calculado {grade(value.calculatedAmMilli)}</span>
      {recovery?.applicable ? (
        <span
          className={
            recovery.source === 'NC' || recovery.source === 'RR'
              ? 'text-xs font-semibold text-danger'
              : 'text-xs text-accent'
          }
        >
          REC {recoveryGrade(recovery.source)}
        </span>
      ) : null}
      <ComparisonChip value={value.comparison} />
    </div>
  );
}
function SubjectDetails({ model }: { readonly model: RelationalBulletinModelV2 }) {
  const instruments = model.subjects.flatMap((subject) =>
    subject.terms.flatMap((term) =>
      term.instruments.map((instrument) => ({ subject, term, instrument })),
    ),
  );
  if (model.detail !== 'detailed' || instruments.length === 0) return null;
  return (
    <Card>
      <Card.Header>
        <div>
          <Card.Title>Composição detalhada</Card.Title>
          <Card.Description>
            Instrumentos exibidos como fatos; nenhum total é recalculado no navegador.
          </Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {instruments.map(({ subject, term, instrument }) => (
          <div
            key={`${subject.offerId}:${instrument.id}`}
            className="rounded-2xl border border-separator bg-surface-secondary/50 p-4"
          >
            <div className="flex items-center gap-2">
              <Chip size="sm" color="accent" variant="soft">
                <Chip.Label>{subject.subject.abbreviation ?? subject.subject.label}</Chip.Label>
              </Chip>
              <span className="text-xs text-muted">
                {term.term}º tri. · slot {instrument.slot}
              </span>
            </div>
            <strong className="mt-2 block text-sm">{instrument.label}</strong>
            <p className="mt-1 text-sm tabular-nums">
              {instrument.notDone || instrument.valueMilli === 0 ? (
                <GranularStatusV1 notDone={instrument.notDone} zero={instrument.valueMilli === 0} />
              ) : (
                <>Nota {grade(instrument.valueMilli)}</>
              )}{' '}
              <span className="text-muted">/ {grade(instrument.maximumMilli)}</span>
            </p>
          </div>
        ))}
      </Card.Content>
    </Card>
  );
}
function BulletinArtifact({ artifact }: { readonly artifact: Artifact }) {
  const model = artifact.mode === 'preview' ? artifact.model : artifact.snapshot.model;
  return (
    <section
      className="grid gap-4"
      aria-label={`${artifact.mode === 'preview' ? 'Prévia' : 'Snapshot'} do boletim`}
    >
      <Card className="overflow-hidden">
        <Card.Header className="bulletin-artifact-header">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
              <FileText size={23} />
            </span>
            <div className="min-w-0">
              <Card.Title className="truncate">{model.student.name}</Card.Title>
              <Card.Description>
                {model.classGroup.name} · nº {model.student.number} · {periodLabel(model.period)}
              </Card.Description>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Chip color={artifact.mode === 'preview' ? 'warning' : 'success'} variant="soft">
              <Chip.Label>
                {artifact.mode === 'preview'
                  ? 'Prévia'
                  : `Emitido · v${artifact.snapshot.snapshotVersion}`}
              </Chip.Label>
            </Chip>
            <Chip color="accent" variant="soft">
              <Chip.Label>Fonte importada</Chip.Label>
            </Chip>
          </div>
        </Card.Header>
        <Card.Content className="grid gap-4 pt-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={<FileText size={18} />}
              value={model.subjects.length}
              label="disciplinas"
              tone="accent"
            />
            <Metric
              icon={<ShieldCheck size={18} />}
              value={model.emissionReadiness.ready ? 'Pronto' : 'Prévia'}
              label="estado oficial"
              tone={model.emissionReadiness.ready ? 'success' : 'warning'}
            />
            <Metric
              icon={<Sparkles size={18} />}
              value={model.overall.visibleResult ?? 'SEM RESULTADO'}
              label="resultado visível"
              tone="accent"
            />
          </div>
          {!model.emissionReadiness.ready ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Prévia disponível; emissão protegida</Alert.Title>
                <Alert.Description>
                  <ul className="mt-1 list-disc pl-4">
                    {model.emissionReadiness.reasons.map((reason) => (
                      <li key={reason}>{readinessLabel(reason)}</li>
                    ))}
                  </ul>
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
          <Table>
            <Table.ScrollContainer className="max-w-full overflow-x-auto">
              <Table.Content
                aria-label={`Boletim de ${model.student.name}`}
                className="min-w-[760px]"
              >
                <Table.Header>
                  <Table.Column id="subject" isRowHeader>
                    Disciplina
                  </Table.Column>
                  {model.period.kind === 'annual' ? (
                    <>
                      <Table.Column id="t1">1º trimestre</Table.Column>
                      <Table.Column id="t2">2º trimestre</Table.Column>
                      <Table.Column id="t3">3º trimestre</Table.Column>
                      <Table.Column id="annual">Resultado anual</Table.Column>
                    </>
                  ) : (
                    <>
                      <Table.Column id="official">AM oficial</Table.Column>
                      <Table.Column id="calculated">Calculado</Table.Column>
                      <Table.Column id="composition">Composição</Table.Column>
                      <Table.Column id="comparison">Conferência</Table.Column>
                    </>
                  )}
                </Table.Header>
                <Table.Body
                  items={model.subjects}
                  renderEmptyState={() => 'Nenhuma oferta atual nesta turma.'}
                >
                  {(subject) => {
                    const current = subject.terms[0];
                    return (
                      <Table.Row id={subject.offerId}>
                        <Table.Cell>
                          <span className="font-semibold">
                            {subject.subject.abbreviation ?? subject.subject.label}
                          </span>
                          <span className="ml-2 text-xs text-muted">{subject.subject.label}</span>
                        </Table.Cell>
                        {model.period.kind === 'annual' ? (
                          <>
                            <Table.Cell>
                              <TermCell subject={subject} term={1} />
                            </Table.Cell>
                            <Table.Cell>
                              <TermCell subject={subject} term={2} />
                            </Table.Cell>
                            <Table.Cell>
                              <TermCell subject={subject} term={3} />
                            </Table.Cell>
                            <Table.Cell>
                              {subject.annual ? (
                                <div className="grid min-w-[9rem] gap-1">
                                  <span className="font-semibold tabular-nums">
                                    U {grade(subject.annual.sourceUMilli)}
                                  </span>
                                  <span className="text-xs text-muted">
                                    Calculado {grade(subject.annual.calculatedPostRecoveryMilli)}
                                  </span>
                                  <Chip
                                    size="sm"
                                    variant="soft"
                                    color={classificationColor(subject.annual.classification)}
                                  >
                                    <Chip.Label>
                                      {CLASSIFICATION[subject.annual.classification]}
                                    </Chip.Label>
                                  </Chip>
                                </div>
                              ) : (
                                '—'
                              )}
                            </Table.Cell>
                          </>
                        ) : (
                          <>
                            <Table.Cell>
                              <strong className="tabular-nums">
                                {grade(current?.sourceAmMilli ?? null)}
                              </strong>
                            </Table.Cell>
                            <Table.Cell>
                              <strong className="tabular-nums">
                                {grade(current?.calculatedAmMilli ?? null)}
                              </strong>
                            </Table.Cell>
                            <Table.Cell>
                              {current ? (
                                <span className="text-xs">
                                  Q {grade(current.quantitative.consideredMilli)} + Quali{' '}
                                  {grade(current.qualitativeMilli)}
                                </span>
                              ) : (
                                '—'
                              )}
                            </Table.Cell>
                            <Table.Cell>
                              {current ? <ComparisonChip value={current.comparison} /> : null}
                            </Table.Cell>
                          </>
                        )}
                      </Table.Row>
                    );
                  }}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card.Content>
      </Card>
      <SubjectDetails model={model} />
    </section>
  );
}

/** What the page is reading, the last failure with its reasons, a notice and a stale live read. */
function BulletinStatusV2({
  busy,
  failure,
  failureReasons,
  notice,
  stale,
}: Readonly<{
  busy: Busy;
  failure: RelationalBulletinFailureV2 | null;
  failureReasons: readonly string[];
  notice: string;
  stale: boolean;
}>) {
  return (
    <div className="min-h-10" aria-live="polite">
      {busy ? (
        <p className="flex items-center gap-2 text-sm text-muted"><output className="contents">
          <Spinner size="sm" />
          {busyText(busy)}
        </output></p>
      ) : null}
      {failure ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Operação não concluída</Alert.Title>
            <Alert.Description>
              {FAILURE[failure]}
              {failureReasons.length > 0 ? (
                <ul className="mt-1 list-disc pl-4">
                  {failureReasons.map((reason) => (
                    <li key={reason}>{readinessLabel(reason)}</li>
                  ))}
                </ul>
              ) : null}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {notice ? (
        <p className="text-sm text-muted"><output className="contents">
          {notice}
        </output></p>
      ) : null}
      <LiveReadNoticeV1 failed={stale} />
    </div>
  );
}

/** Download or print the official PDF of the emitted snapshot. */
function OfficialPdfCardV2({
  pdfState,
  pdfNotice,
  onDownload,
  onPrint,
}: Readonly<{
  pdfState: PdfState;
  pdfNotice: string;
  onDownload: () => void;
  onPrint: () => void;
}>) {
  return (
    <Card>
      <Card.Header>
        <div>
          <Card.Title>Documento oficial deste snapshot</Card.Title>
          <Card.Description>
            O PDF usa somente a versão emitida acima e é gerado localmente, um documento por
            vez.
          </Card.Description>
        </div>
      </Card.Header>
      <Card.Footer className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          isDisabled={pdfState !== null}
          onPress={onDownload}
        >
          {pdfState === 'download' ? <Spinner size="sm" /> : <Download size={17} />}
          Baixar PDF oficial
        </Button>
        <Button
          variant="secondary"
          isDisabled={pdfState !== null}
          onPress={onPrint}
        >
          {pdfState === 'print' ? <Spinner size="sm" /> : <Printer size={17} />}
          Imprimir PDF oficial
        </Button>
        {pdfNotice ? (
          <span className="text-xs text-muted"><output className="contents">
            {pdfNotice}
          </output></span>
        ) : null}
      </Card.Footer>
    </Card>
  );
}

/** The emitted snapshots of the current selection, each reprinted from its preserved version. */
function BulletinHistoryCardV2({
  busy,
  history,
  onReprint,
}: Readonly<{
  busy: Busy;
  history: readonly RelationalBulletinHistoryItemV2[];
  onReprint: (item: RelationalBulletinHistoryItemV2) => void;
}>) {
  return (
    <Card>
      <Card.Header>
        <div>
          <Card.Title>Histórico de emissões</Card.Title>
          <Card.Description>
            Reimpressão lê somente a versão preservada; alterações atuais não mudam o documento
            anterior.
          </Card.Description>
        </div>
        <FileClock className="text-accent" />
      </Card.Header>
      <Card.Content className="grid gap-2">
        {busy === 'history' ? <Spinner size="sm" /> : null}
        {busy !== 'history' && history.length === 0 ? (
          <p className="text-sm text-muted">Nenhum snapshot carregado para este recorte.</p>
        ) : null}
        {busy === 'history'
          ? null
          : history.map((item) => (
            <div
              key={`${item.snapshotId}:${item.snapshotVersion}`}
              className="flex flex-col gap-3 rounded-2xl border border-separator p-4 sm:flex-row sm:items-center"
            >
              <div className="min-w-0">
                <strong className="block truncate text-sm">
                  {item.studentName} · {periodLabel(item.period)}
                </strong>
                <span className="text-xs text-muted">
                  {new Date(item.emittedAt).toLocaleString('pt-BR')} · versão{' '}
                  {item.snapshotVersion} · {item.detail === 'detailed' ? 'detalhado' : 'resumo'}
                </span>
              </div>
              <Button
                className="sm:ml-auto"
                size="sm"
                variant="secondary"
                isDisabled={busy !== null}
                onPress={() => onReprint(item)}
              >
                <History size={15} />
                Reimprimir versão
              </Button>
            </div>
          ))}
      </Card.Content>
    </Card>
  );
}

export function RelationalBulletinPageV2() {
  const sharedYear = useGradebookYear();
  const year = sharedYear?.year ?? null;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [students, setStudents] = useState<Students | null>(null);
  const [classId, setClassId] = useState<number | null>(null);
  const [storedView] = useState(readStoredViewV2);
  const restoreClass = useRef(storedView?.classId ?? null);
  const [period, setPeriod] = useState<RelationalBulletinPeriodV2>(
    storedView?.period ?? { kind: 'term', term: 1 },
  );
  const [detail, setDetail] = useState<RelationalBulletinDetailV2>(storedView?.detail ?? 'summary');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [previewStudentId, setPreviewStudentId] = useState<number | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [history, setHistory] = useState<RelationalBulletinHistoryItemV2[]>([]);
  const [busy, setBusy] = useState<Busy>('catalog');
  const [failure, setFailure] = useState<RelationalBulletinFailureV2 | null>(null);
  const [failureReasons, setFailureReasons] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState('');
  const [pdfState, setPdfState] = useState<PdfState>(null);
  const [pdfNotice, setPdfNotice] = useState('');
  const [historyRead, setHistoryRead] = useState(false);
  const [stale, setStale] = useState(false);
  const sequence = useRef(0);
  const artifactHeading = useRef<HTMLHeadingElement | null>(null);
  const safely = async <T,>(operation: () => Promise<T>, background = false): Promise<T | null> => {
    if (!background) {
      setFailure(null);
      setFailureReasons([]);
    }
    try {
      return await operation();
    } catch (cause) {
      if (background) setStale(true);
      else {
        setFailure(cause instanceof RelationalBulletinClientErrorV2 ? cause.code : 'unavailable');
        setFailureReasons(cause instanceof RelationalBulletinClientErrorV2 ? cause.reasons : []);
      }
      return null;
    }
  };
  useEffect(() => {
    sequence.current += 1;
    setCatalog(null);
    setStudents(null);
    setClassId(null);
    setSelectedIds([]);
    setPreviewStudentId(null);
    setArtifact(null);
    setHistory([]);
    setHistoryRead(false);
    setStale(false);
    if (year === null) return;
    const controller = new AbortController();
    const ticket = ++sequence.current;
    setBusy('catalog');
    setFailure(null);
    setFailureReasons([]);
    void requestRelationalBulletinV2(
      { contractVersion: 2, operation: 'catalog', year },
      controller.signal,
    )
      .then((response) => {
        if (
          ticket === sequence.current &&
          response.state === 'ready' &&
          response.operation === 'catalog'
        )
          setCatalog(response);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || ticket !== sequence.current) return;
        setFailure(cause instanceof RelationalBulletinClientErrorV2 ? cause.code : 'unavailable');
        setFailureReasons(cause instanceof RelationalBulletinClientErrorV2 ? cause.reasons : []);
      })
      .finally(() => {
        if (!controller.signal.aborted && ticket === sequence.current) setBusy(null);
      });
    return () => controller.abort();
  }, [year]);
  const loadStudents = async (nextClassId: number) => {
    const ticket = ++sequence.current;
    setClassId(nextClassId);
    setStudents(null);
    setSelectedIds([]);
    setPreviewStudentId(null);
    setArtifact(null);
    setHistory([]);
    setHistoryRead(false);
    setBusy('students');
    const response = await safely(() =>
      requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'students',
        year: year!,
        classId: nextClassId,
      }),
    );
    if (ticket === sequence.current) {
      if (response?.state === 'ready' && response.operation === 'students') {
        setStudents(response);
        await loadHistory(nextClassId, false, []);
      }
      setBusy(null);
    }
  };
  useEffect(() => {
    const target = restoreClass.current;
    if (!catalog || target === null) return;
    restoreClass.current = null;
    if (storedView?.year === year && catalog.classes.some((item) => item.id === target))
      void loadStudents(target);
    // Runs once, when the catalog of the restored year arrives.
  }, [catalog]);
  useEffect(() => {
    if (year !== null && catalog && restoreClass.current === null)
      writeSessionViewV1(VIEW_KEY_V2, {
        year,
        classId,
        term: period.kind === 'annual' ? 'annual' : period.term,
        detail,
      });
  }, [year, catalog, classId, period, detail]);
  const selection = (studentId: number) => ({
    year: year!,
    classId: classId!,
    studentId,
    period,
    detail,
    presentation: { locale: 'pt-BR', dateStyle: 'long' as const },
  });
  const show = (next: Artifact, message: string) => {
    setArtifact(next);
    setNotice(message);
    queueMicrotask(() => artifactHeading.current?.focus());
  };
  const preview = async () => {
    if (classId === null || previewStudentId === null) return;
    setBusy('artifact');
    const response = await safely(() =>
      requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'preview',
        selection: selection(previewStudentId),
      }),
    );
    if (response?.state === 'ready' && response.operation === 'preview')
      show(
        { mode: 'preview', model: response.model },
        'Prévia atualizada no mesmo snapshot relacional.',
      );
    setBusy(null);
  };
  const emit = async () => {
    if (classId === null || previewStudentId === null) return;
    setBusy('artifact');
    const response = await safely(() =>
      requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'emit',
        selection: selection(previewStudentId),
      }),
    );
    if (response?.state === 'ready' && response.operation === 'emit')
      show(
        { mode: 'emission', snapshot: response.snapshot },
        `Emissão preservada no snapshot ${response.snapshot.snapshotId} · versão ${response.snapshot.snapshotVersion}.`,
      );
    setBusy(null);
  };
  const emitBatch = async () => {
    if (classId === null || selectedIds.length === 0) return;
    setBusy('batch');
    const response = await safely(() =>
      requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'emit-batch',
        selection: {
          year: year!,
          classId,
          studentIds: selectedIds,
          period,
          detail,
          presentation: { locale: 'pt-BR', dateStyle: 'long' },
        },
      }),
    );
    if (response?.state === 'ready' && response.operation === 'emit-batch') {
      setNotice(
        `${response.ready.length} boletim(ns) emitido(s); ${response.blocked.length} protegido(s) por dados insuficientes.`,
      );
      if (response.ready[0])
        setArtifact({ mode: 'emission', snapshot: response.ready[0].snapshot });
    }
    setBusy(null);
  };
  const loadHistory = async (
    targetClassId = classId,
    background = false,
    filterIds = selectedIds,
  ) => {
    if (targetClassId === null) return;
    if (!background) setBusy('history');
    const response = await safely(
      () =>
        requestRelationalBulletinV2({
          contractVersion: 2,
          operation: 'history',
          year: year!,
          classId: targetClassId,
          ...(filterIds.length ? { studentIds: filterIds } : {}),
        }),
      background,
    );
    if (response?.state === 'ready' && response.operation === 'history') {
      setHistory(response.items);
      setHistoryRead(true);
      setStale(false);
    } else if (background) setStale(true);
    if (!background) setBusy(null);
    return response?.state === 'ready' && response.operation === 'history';
  };

  /** A refused catalog: without authorization everything read is dropped; otherwise it is stale. */
  const catalogRefused = (notAuthorized: boolean) => {
    if (notAuthorized) {
      setCatalog(null);
      setStudents(null);
      setClassId(null);
      setSelectedIds([]);
      setPreviewStudentId(null);
      setArtifact(null);
      setHistory([]);
      setFailure('not-authorized');
    } else setStale(true);
    return false;
  };

  /** A refresh that failed: a lost authorization drops what was read; anything else is stale. */
  const refreshFailed = (cause: unknown) => {
    if (cause instanceof RelationalBulletinClientErrorV2 && cause.code === 'not-authorized') {
      setCatalog(null);
      setStudents(null);
      setArtifact(null);
      setHistory([]);
      setFailure(cause.code);
    } else setStale(true);
    return false;
  };

  /** The open preview follows the refreshed list: it closes with its student, or is read again. */
  const refreshPreview = async (ticket: number, valid: ReadonlySet<number>) => {
    if (previewStudentId !== null && !valid.has(previewStudentId)) {
      setPreviewStudentId(null);
      if (artifact?.mode === 'preview') setArtifact(null);
      return true;
    }
    if (artifact?.mode !== 'preview' || previewStudentId === null) return true;
    const latestPreview = await requestRelationalBulletinV2({
      contractVersion: 2,
      operation: 'preview',
      selection: selection(previewStudentId),
    });
    if (ticket !== sequence.current) return undefined;
    if (latestPreview.state === 'ready' && latestPreview.operation === 'preview') {
      setArtifact({ mode: 'preview', model: latestPreview.model });
      return true;
    }
    setStale(true);
    return false;
  };

  const refresh = async () => {
    if (year === null || busy !== null) return;
    const ticket = ++sequence.current;
    try {
      const latestCatalog = await requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'catalog',
        year,
      });
      if (ticket !== sequence.current) return;
      if (latestCatalog.state !== 'ready' || latestCatalog.operation !== 'catalog')
        return catalogRefused(latestCatalog.state === 'not-authorized');
      setCatalog(latestCatalog);
      if (classId === null) {
        setStale(false);
        return true;
      }
      if (!latestCatalog.classes.some((item) => item.id === classId)) {
        setClassId(null);
        setStudents(null);
        setSelectedIds([]);
        setPreviewStudentId(null);
        setArtifact(null);
        setHistory([]);
        setHistoryRead(false);
        return;
      }
      const latestStudents = await requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'students',
        year,
        classId,
      });
      if (ticket !== sequence.current) return;
      if (latestStudents.state !== 'ready' || latestStudents.operation !== 'students') {
        setStale(true);
        return false;
      }
      const valid = new Set(latestStudents.students.map((student) => student.id));
      setStudents(latestStudents);
      setSelectedIds((current) => current.filter((id) => valid.has(id)));
      const previewed = await refreshPreview(ticket, valid);
      if (previewed !== true) return previewed;
      if (historyRead && await loadHistory(classId, true) === false) return false;
      if (ticket === sequence.current) setStale(false);
      return true;
    } catch (cause) {
      if (ticket !== sequence.current) return;
      return refreshFailed(cause);
    }
  };
  useLiveRefreshV1(refresh, {
    domains: ['gradebook'],
    enabled: year !== null,
    canRefresh: () => busy === null && pdfState === null,
  });
  const reprint = async (item: RelationalBulletinHistoryItemV2) => {
    setBusy('artifact');
    const response = await safely(() =>
      requestRelationalBulletinV2({
        contractVersion: 2,
        operation: 'reprint',
        snapshotId: item.snapshotId,
        snapshotVersion: item.snapshotVersion,
      }),
    );
    if (response?.state === 'ready' && response.operation === 'reprint')
      show(
        { mode: 'reprint', snapshot: response.snapshot },
        'Reimpressão carregada exclusivamente do snapshot histórico; nenhuma nota atual foi consultada.',
      );
    setBusy(null);
  };
  const runPdf = async (action: RelationalBulletinPdfActionV2) => {
    if (artifact === null || artifact.mode === 'preview' || pdfState !== null) return;
    setPdfState(action);
    setPdfNotice('');
    try {
      const result = await runRelationalBulletinPdfActionV2(action, artifact.snapshot);
      setPdfNotice(
        `${action === 'download' ? 'Download' : 'Impressão'} preparado: ${result.filename} · ${result.pageCount} página(s).`,
      );
    } catch (cause) {
      const detail = cause instanceof RelationalBulletinPdfActionErrorV2 ? ` (${cause.code})` : '';
      setPdfNotice(`PDF indisponível${detail}. O snapshot permanece legível na tela.`);
    } finally {
      setPdfState(null);
    }
  };
  const selectedStudents = useMemo(
    () => students?.students.filter((student) => selectedIds.includes(student.id)) ?? [],
    [students, selectedIds],
  );
  // Right after the page opens or reloads the year is still being read: loading, not missing.
  if (year === null && sharedYear?.loading)
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-muted" aria-busy="true">
        <Spinner size="sm" />
        Carregando…
      </div>
    );
  if (year === null)
    return (
      <Alert status="warning">
        <Alert.Content>
          <Alert.Title>Contexto indisponível</Alert.Title>
          <Alert.Description>
            Selecione ou importe uma Relação para ativar um ano letivo.
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  return (
    <section aria-label="Boletins relacionais" className="grid min-w-0 gap-4">
      <header className="flex min-h-12 flex-wrap items-center gap-3">
        <div>
          <h2 className="sr-only">Boletins</h2>
          <p className="text-xs text-muted">
            AM/U oficiais da fonte, cálculo comparativo e histórico imutável.
          </p>
        </div>
        <Chip className="ml-auto" color="accent" variant="soft">
          <Chip.Label>Relacional · {year}</Chip.Label>
        </Chip>
      </header>
      <div className="bulletin-filterbar" aria-label="Filtros de Boletins">
        <BulletinSelect
          label="Turma"
          value={classId === null ? 'none' : String(classId)}
          disabled={busy === 'catalog'}
          items={[
            { id: 'none', label: 'Selecione a turma' },
            ...(catalog?.classes.map((item) => ({
              id: String(item.id),
              label: item.name,
              description: `${item.code} · ${item.studentCount} alunos`,
            })) ?? []),
          ]}
          onChange={(value) => {
            if (value !== 'none') void loadStudents(Number(value));
          }}
        />
        <BulletinSelect
          label="Período"
          value={period.kind === 'annual' ? 'annual' : String(period.term)}
          items={[
            { id: '1', label: '1º trimestre' },
            { id: '2', label: '2º trimestre' },
            { id: '3', label: '3º trimestre' },
            { id: 'annual', label: 'Anual + REC' },
          ]}
          onChange={(value) => {
            setPeriod(
              value === 'annual'
                ? { kind: 'annual' }
                : { kind: 'term', term: Number(value) as 1 | 2 | 3 },
            );
            setArtifact(null);
          }}
        />
        <BulletinSelect
          label="Detalhamento"
          value={detail}
          items={[
            { id: 'summary', label: 'Resumo institucional' },
            { id: 'detailed', label: 'Com instrumentos' },
          ]}
          onChange={(value) => {
            setDetail(value as RelationalBulletinDetailV2);
            setArtifact(null);
          }}
        />
        <BulletinSelect
          label="Aluno da prévia"
          value={previewStudentId === null ? 'none' : String(previewStudentId)}
          disabled={!students || busy === 'students'}
          items={[
            { id: 'none', label: 'Selecione um aluno' },
            ...(students?.students.map((item) => ({
              id: String(item.id),
              label: item.name,
              description: `nº ${item.number}`,
            })) ?? []),
          ]}
          onChange={(value) => {
            const id = value === 'none' ? null : Number(value);
            setPreviewStudentId(id);
            setArtifact(null);
          }}
        />
        <Button
          variant="primary"
          className="min-h-11"
          isDisabled={previewStudentId === null || busy !== null}
          onPress={() => void preview()}
        >
          <Sparkles size={17} />
          Gerar prévia
        </Button>
      </div>
      <BulletinStatusV2
        busy={busy}
        failure={failure}
        failureReasons={failureReasons}
        notice={notice}
        stale={stale}
      />
      {students ? (
        <Card>
          <Card.Header>
            <div>
              <Card.Title>Selecionar lote</Card.Title>
              <Card.Description>
                {students.classGroup.name}: escolha alunos para emissão agregada ou filtro do
                histórico.
              </Card.Description>
            </div>
            <Chip variant="soft">
              <Chip.Label>{selectedStudents.length} selecionado(s)</Chip.Label>
            </Chip>
          </Card.Header>
          <Card.Content className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
            {students.students.map((student) => (
              <label key={student.id} className="bulletin-student-card">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(student.id)}
                  disabled={
                    !selectedIds.includes(student.id) &&
                    selectedIds.length >= RELATIONAL_BULLETIN_LIMITS_V2.batchStudents
                  }
                  onChange={(event) => {
                    setSelectedIds((current) =>
                      event.currentTarget.checked
                        ? [...new Set([...current, student.id])].slice(
                            0,
                            RELATIONAL_BULLETIN_LIMITS_V2.batchStudents,
                          )
                        : current.filter((id) => id !== student.id),
                    );
                    if (event.currentTarget.checked && previewStudentId === null)
                      setPreviewStudentId(student.id);
                  }}
                />
                <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-sm font-semibold text-accent">
                  {student.number}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm">{student.name}</strong>
                  <small className="text-muted">{student.statusLabel}</small>
                </span>
              </label>
            ))}
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              isDisabled={previewStudentId === null || busy !== null}
              onPress={() => void emit()}
            >
              <ShieldCheck size={17} />
              Emitir individual
            </Button>
            <Button
              variant="secondary"
              isDisabled={selectedIds.length === 0 || busy !== null}
              onPress={() => void emitBatch()}
            >
              <Users size={17} />
              Emitir lote ({selectedIds.length})
            </Button>
            {failure && historyRead ? (
              <Button
                variant="tertiary"
                isDisabled={busy !== null}
                onPress={() => void loadHistory()}
              >
                <History size={17} />
                Tentar histórico novamente
              </Button>
            ) : null}
          </Card.Footer>
        </Card>
      ) : null}
      {!students && classId === null && busy !== 'catalog' ? (
        <Surface className="grid min-h-52 place-items-center rounded-2xl border border-dashed border-separator bg-surface-secondary/40 p-8 text-center">
          <div>
            <FileText className="mx-auto mb-3 text-accent" />
            <strong>Escolha uma turma para começar</strong>
            <p className="mt-1 text-xs text-muted">
              A seleção fica estável enquanto o catálogo e os alunos carregam.
            </p>
          </div>
        </Surface>
      ) : null}
      {artifact ? (
        <div className="grid gap-3">
          <h3 ref={artifactHeading} tabIndex={-1} className="sr-only">
            Boletim carregado
          </h3>
          <BulletinArtifact artifact={artifact} />
          {artifact.mode !== 'preview' ? (
            <OfficialPdfCardV2
              pdfState={pdfState}
              pdfNotice={pdfNotice}
              onDownload={() => void runPdf('download')}
              onPrint={() => void runPdf('print')}
            />
          ) : null}
        </div>
      ) : null}
      <BulletinHistoryCardV2 busy={busy} history={history} onReprint={(item) => void reprint(item)} />
    </section>
  );
}
