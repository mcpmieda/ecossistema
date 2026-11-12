import { ClassTabsV1 } from '../../../shared/ui/class-tabs-v1';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Label, ListBox, Select, Skeleton, Tabs } from '@heroui/react';
import { usePerformanceAnalyticsV6 } from './use-performance-analytics-v6';
import {
  PERFORMANCE_PERSPECTIVES_V6,
  PerformanceAnalyticsWorkspaceV6,
  type PerformancePerspectiveV6,
  type PerformanceSelectionV6,
} from './performance-analytics-workspace-v6';
import { PerformanceStudentDetailV2 } from './performance-student-detail-v2';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import { PerformanceResultMatrixV2 } from './performance-result-matrix-v2';
import { PerformanceGridYearV2 } from './performance-grid-v2';
import { PerformanceAnalysisPanelV3 } from './performance-analysis-panel-v3';
import { PerformanceTermComparisonPanelV4 } from './performance-term-comparison-panel-v4';
import {
  PERFORMANCE_LENSES_V3,
  type PerformanceLensV3,
} from '../../../../shared/gradebook-contracts/performance/performance-analysis-v3';
import type {
  PerformanceFailureV2,
  PerformancePeriodV2,
  PerformanceModeV2,
  PerformanceStatusV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { useRelationalPerformanceV2 } from './use-relational-performance-v2';
import { ArrowLeft, ChartColumn } from 'lucide-react';
import { GradebookYearContextBanner } from '../../../platform/gradebook-year-provider';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { readSessionViewV1, writeSessionViewV1 } from '../../../shared/ui/session-view-v1';
import { useHistoryStepV1 } from '../../../shared/ui/history-step-v1';

/** The perspective and what was picked inside it, kept for the tab across a reload. */
const VIEW_KEY_V2 = 'gradebook-performance-view';
type StoredViewV2 = {
  perspective: PerformancePerspectiveV6;
  selection: PerformanceSelectionV6;
  year: number | null;
};
const idOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
function parseViewV2(value: unknown): StoredViewV2 | null {
  if (value === null || typeof value !== 'object') return null;
  const stored = value as Record<string, unknown>;
  const perspective = PERFORMANCE_PERSPECTIVES_V6.find((item) => item.id === stored.perspective);
  if (!perspective) return null;
  const selection = (stored.selection ?? {}) as Record<string, unknown>;
  return {
    perspective: perspective.id,
    selection: {
      studentId: idOrNull(selection.studentId),
      offerId: idOrNull(selection.offerId),
      teacherId: idOrNull(selection.teacherId),
    },
    year: idOrNull(stored.year),
  };
}
function readStoredViewV2(): StoredViewV2 | null {
  return readSessionViewV1(VIEW_KEY_V2, parseViewV2);
}

const failures: Record<PerformanceFailureV2, string> = {
  'not-authorized': 'Sua sessão não possui autorização. Entre novamente com uma conta autorizada.',
  'not-found':
    'A turma ou o aluno não foi encontrado neste ano e nesta posição atual. Atualize a consulta.',
  'invalid-request':
    'Não foi possível interpretar os filtros. Selecione novamente a turma e o período.',
  unavailable:
    'Não foi possível concluir a consulta. A atualização será tentada novamente; nenhuma nota foi alterada.',
  'scope-too-large':
    'Esta turma ultrapassa o limite de uma consulta completa. A matriz não foi truncada; o recorte precisa ser ampliado no sistema.',
  'ambiguous-offers':
    'Há mais de uma oferta para o mesmo componente nesta turma. Confira as atribuições antes de consultar o resultado.',
};

interface FilterItem {
  readonly id: string;
  readonly label: string;
}
type PerformanceSelectId = 'period' | 'mode' | 'comparison' | 'assessment-component';
const PERIOD_TABS = [
  { id: '1', label: '1º tri' },
  { id: '2', label: '2º tri' },
  { id: '3', label: '3º tri' },
  { id: 'annual', label: 'Ano' },
] as const;

function PerformanceSelect({
  id,
  label,
  value,
  items,
  disabled = false,
  isOpen,
  onOpenChange,
  onChange,
}: {
  readonly id: PerformanceSelectId;
  readonly label: string;
  readonly value: string;
  readonly items: readonly FilterItem[];
  readonly disabled?: boolean;
  readonly isOpen: boolean;
  readonly onOpenChange: (id: PerformanceSelectId, isOpen: boolean) => void;
  readonly onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        root.current?.contains(target) ||
        target.closest(`[data-performance-select-popover="${id}"]`)
      )
        return;
      const nextSelect = target.closest<HTMLElement>('[data-performance-select]')?.dataset
        .performanceSelect as PerformanceSelectId | undefined;
      if (nextSelect !== undefined && event.pointerType !== 'touch') {
        onOpenChange(nextSelect, true);
        return;
      }
      onOpenChange(id, false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [id, isOpen, onOpenChange]);
  return (
    <Select
      ref={root}
      data-performance-select={id}
      selectedKey={value}
      isDisabled={disabled}
      isOpen={isOpen}
      onOpenChange={(open) => onOpenChange(id, open)}
      onSelectionChange={(key) => {
        if (key !== null && key !== value) onChange(String(key));
      }}
    >
      <Label className="mb-1.5 block text-xs font-medium text-muted">{label}</Label>
      <Select.Trigger className="min-h-10 w-full">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover isNonModal data-performance-select-popover={id}>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

type AnalyticsReadV2 = ReturnType<typeof usePerformanceAnalyticsV6>;
type AnalyticsWorkspacePropsV2 = Parameters<typeof PerformanceAnalyticsWorkspaceV6>[0];

/** Earlier trimesters to compare with: the 1st, and the 2nd from the 3rd on. */
function comparisonItemsV2(period: unknown): FilterItem[] {
  const items: FilterItem[] = [
    { id: 'none', label: 'Sem comparação' },
    { id: '1', label: '1º trimestre' },
  ];
  if (period === 3) items.push({ id: '2', label: '2º trimestre' });
  return items;
}

const studentCountTextV2 = (matrix: { rows: readonly unknown[] } | null | undefined) =>
  matrix ? ` · ${matrix.rows.length} estudantes` : '';

/** The year still loading, or the year selector saying why it cannot be read. */
function YearPendingV2({ loading }: Readonly<{ loading: boolean }>) {
  return loading ? (
    <div className="grid gap-3" aria-busy="true" aria-label="Carregando Desempenho">
      <Skeleton className="h-28 rounded-2xl" />
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  ) : (
    <div className="rounded-xl border border-separator p-5">
      <GradebookYearContextBanner />
    </div>
  );
}

/** The name of the student being opened, from whichever reading already shows it. */
function openingNameV2(
  openingId: number | null,
  matrix: { rows: readonly { student: { id: number; name: string } }[] } | null | undefined,
  analytics: { students: readonly { student: { id: number; name: string } }[] } | null | undefined,
) {
  if (openingId === null) return undefined;
  return (
    matrix?.rows.find((row) => row.student.id === openingId)?.student.name ??
    analytics?.students.find((item) => item.student.id === openingId)?.student.name
  );
}

/** One analytics tab: the last failure (keeping the last reading), the workspace, or its loading. */
function AnalyticsPanelV2({
  analytics,
  tab,
  selection,
  onSelection,
  onNavigate,
  onPeriod,
  onCell,
  onNotes,
  classChosen,
}: Readonly<{
  analytics: AnalyticsReadV2;
  tab: AnalyticsWorkspacePropsV2['tab'];
  selection: AnalyticsWorkspacePropsV2['selection'];
  onSelection: AnalyticsWorkspacePropsV2['onSelection'];
  onNavigate: AnalyticsWorkspacePropsV2['onNavigate'];
  onPeriod: AnalyticsWorkspacePropsV2['onPeriod'];
  onCell: AnalyticsWorkspacePropsV2['onCell'];
  onNotes: AnalyticsWorkspacePropsV2['onNotes'];
  classChosen: boolean;
}>) {
  return (
    <>
      {analytics.failure ? (
        <Alert status="warning" className="mb-3">
          <Alert.Content>
            <Alert.Title>
              {analytics.data ? 'Exibindo a última leitura' : 'Consulta indisponível'}
            </Alert.Title>
            <Alert.Description>
              {analytics.failure === 'not-authorized'
                ? 'Entre novamente com uma conta autorizada.'
                : 'A atualização automática tentará novamente.'}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {analytics.data ? (
        <PerformanceAnalyticsWorkspaceV6
          value={analytics.data}
          tab={tab}
          selection={selection}
          onSelection={onSelection}
          onNavigate={onNavigate}
          onPeriod={onPeriod}
          onCell={onCell}
          onNotes={onNotes}
        />
      ) : null}
      {!analytics.data && analytics.busy ? (
        <output aria-label="Carregando indicadores" className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[1, 2, 3, 4].map((id) => (
              <Skeleton key={id} className="h-32 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-2xl" />
        </output>
      ) : null}
      {!analytics.data && !analytics.busy ? (
        <div className="grid min-h-64 place-items-center text-center">
          <p className="text-sm text-muted">
            {classChosen ? 'Nenhuma leitura disponível.' : 'Escolha uma turma para começar.'}
          </p>
        </div>
      ) : null}
    </>
  );
}

/** The detail drawer before the student's data arrives: the name already on screen, or a title. */
function DetailPlaceholderV2({
  openingId,
  openingName,
  year,
  busy,
  failure,
}: Readonly<{
  openingId: number | null;
  openingName: string | undefined;
  year: number;
  busy: boolean;
  failure: keyof typeof failures | null;
}>) {
  return (
    <>
      {openingId !== null && openingName ? (
        <Drawer.Header className="border-b border-separator pb-5 pr-10">
          <div className="flex min-w-0 items-center gap-4">
            <LinkedStudentPhotoAvatarV1
              decorative
              size="lg"
              className="pa-student-avatar size-16 shrink-0"
              fallbackTone={openingId % 6}
              subject={{
                source: 'gradebook',
                academicYear: year,
                studentIds: [openingId],
              }}
            />
            <Drawer.Heading className="min-w-0 break-words text-2xl font-bold tracking-tight">
              {openingName}
            </Drawer.Heading>
          </div>
        </Drawer.Header>
      ) : (
        <Drawer.Header>
          <Drawer.Heading>Detalhe do aluno</Drawer.Heading>
        </Drawer.Header>
      )}
      <Drawer.Body>
        {busy ? (
          <p>
            <output className="contents">Carregando detalhe…</output>
          </p>
        ) : null}
        {failure ? <p role="alert">{failures[failure]}</p> : null}
      </Drawer.Body>
    </>
  );
}

type DetailStepV2 = { studentId: number; offerId?: number; term?: 1 | 2 | 3 };

/** What "Voltar" says: back to the year notes, to the previous detail, to the indicator list it
 * came from, or nothing when the first step was opened from the page itself. */
function backLabelV2(previous: DetailStepV2 | undefined, hasOrigin: boolean) {
  if (previous) return previous.offerId === undefined ? 'Voltar às notas do ano' : 'Voltar';
  return hasOrigin ? 'Voltar à lista' : null;
}

/** The steps opened inside the student side panel, so "Voltar" walks back one step at a time
 * (a mark's breakdown → the student's year notes) and closing clears them all. */
function useDetailStepsV2(detail: {
  isOpen: boolean;
  open: (studentId: number, offerId?: number) => void;
  close: () => void;
}) {
  const lastFocus = useRef<HTMLElement | null>(null);
  // The student whose detail was asked for: the name already on screen heads the drawer at once.
  const [openingId, setOpeningId] = useState<number | null>(null);
  // A mark clicked inside the student detail opens its breakdown on that trimester.
  const [focusTerm, setFocusTerm] = useState<1 | 2 | 3 | null>(null);
  const current = useRef<DetailStepV2 | null>(null);
  const [history, setHistory] = useState<DetailStepV2[]>([]);
  // Where the detail was opened from, when that place can be reopened (the overview's list).
  const [origin, setOrigin] = useState<(() => void) | null>(null);
  const show = (step: DetailStepV2) => {
    current.current = step;
    setOpeningId(step.studentId);
    setFocusTerm(step.term ?? null);
    detail.open(step.studentId, step.offerId);
  };
  const open = (studentId: number, offerId?: number, term?: 1 | 2 | 3) => {
    const previous = current.current;
    if (!detail.isOpen) {
      lastFocus.current = document.activeElement as HTMLElement;
      setHistory([]);
      setOrigin(null);
    } else if (previous) {
      setHistory((steps) => [...steps, previous]);
    }
    show({ studentId, offerId, term });
  };
  const openFromAnalytics = (studentId: number, offerId?: number, from?: () => void) => {
    open(studentId, offerId);
    setOrigin(() => from ?? null);
  };
  const close = () => {
    setOrigin(null);
    setHistory([]);
    current.current = null;
    setFocusTerm(null);
    detail.close();
    lastFocus.current?.focus();
  };
  const previous = history.at(-1);
  const goBack = () => {
    if (previous) {
      setHistory((steps) => steps.slice(0, -1));
      show(previous);
      return;
    }
    const from = origin;
    close();
    from?.();
  };
  return {
    openingId,
    focusTerm,
    open,
    openFromAnalytics,
    close,
    goBack,
    backLabel: backLabelV2(previous, origin !== null),
    /** Steps open inside the panel; each one is an entry the phone's back takes away. */
    depth: history.length,
  };
}

export function RelationalPerformancePageV2({
  isActive = true,
}: { readonly isActive?: boolean } = {}) {
  const [storedView] = useState(readStoredViewV2);
  const [perspective, setPerspective] = useState<PerformancePerspectiveV6>(
    storedView?.perspective ?? 'overview',
  );
  const [selection, setSelection] = useState<PerformanceSelectionV6>(
    storedView?.selection ?? { studentId: null, offerId: null, teacherId: null },
  );
  const state = useRelationalPerformanceV2(perspective === 'notes', isActive);
  const viewYear = state.year;
  useEffect(() => {
    // What was picked belongs to its year: another year starts clean.
    if (viewYear !== null && storedView && storedView.year !== viewYear)
      setSelection({ studentId: null, offerId: null, teacherId: null });
  }, [viewYear, storedView]);
  useEffect(() => {
    writeSessionViewV1(VIEW_KEY_V2, { perspective, selection, year: viewYear });
  }, [perspective, selection, viewYear]);
  const analytics = usePerformanceAnalyticsV6(
    state.filters.classId,
    state.filters.period,
    isActive && perspective !== 'notes',
  );
  // The phone's back button returns to the perspective and the selection seen before.
  useHistoryStepV1(
    'gradebook-performance-view',
    { perspective, selection, year: viewYear },
    (restored) => {
      state.closeDetail();
      setPerspective(restored.perspective);
      setSelection(restored.selection);
      if (restored.perspective === 'notes') void state.refresh(true);
    },
    parseViewV2,
  );
  function navigate(tab: PerformancePerspectiveV6) {
    if (tab === perspective) return;
    state.closeDetail();
    setPerspective(tab);
    if (tab === 'notes') void state.refresh(true);
  }
  function openAssessmentNotes(offerId: number) {
    setPerspective('notes');
    void state.select({ lens: 'assessments', offerId, mode: 'regular', statuses: [null, 7] }, true);
  }
  const [openSelect, setOpenSelect] = useState<PerformanceSelectId | null>(null);
  const changeOpenSelect = useCallback((id: PerformanceSelectId, isOpen: boolean) => {
    setOpenSelect((current) => {
      if (isOpen) {
        return id;
      }
      if (current === id) {
        return null;
      }
      return current;
    });
  }, []);
  const {
    openingId,
    focusTerm,
    open,
    openFromAnalytics,
    close,
    goBack,
    backLabel,
    depth,
  } = useDetailStepsV2({
    isOpen: state.detailOpen,
    open: (studentId, offerId) => void state.open(studentId, offerId),
    close: state.closeDetail,
  });
  const lensLabel: Record<PerformanceLensV3, string> = {
    result: 'Resultado',
    quantitative: 'Quantitativo',
    qualitative: 'Qualitativo',
    assessments: 'Avaliações',
  };
  const sharedYear = useGradebookYear();
  useEffect(() => {
    const next = state.classes?.nextOffset;
    if (next != null && !state.busy.classes && !state.failure) void state.loadClasses(next);
  }, [state.classes, state.busy.classes, state.failure]);
  if (state.year === null)
    // The year is still being read right after the page opens or reloads: that is loading, not
    // a lost session. When it cannot be read, the year selector says why and offers to retry.
    return <YearPendingV2 loading={!!sharedYear?.loading} />;
  const detail = state.detail;
  // Everything but the situations shown: changing those keeps the panels, and what was typed
  // or picked inside them, in place while the same reading is refreshed.
  const scopeKey = JSON.stringify({ ...state.filters, statuses: null });
  const openingName = openingNameV2(openingId, state.matrix, analytics.data);
  const comparisonDisabled =
    state.filters.lens === 'assessments' ||
    state.filters.period === 1 ||
    state.filters.period === 'annual';
  const selectedClass = state.classes?.classes.find((item) => item.id === state.filters.classId);
  const comparisonItems = comparisonItemsV2(state.filters.period);
  return (
    <section
      aria-label="Desempenho relacional"
      className="performance-workspace grid min-w-0 grid-cols-1 gap-4"
    >
      <header className="performance-head">
        <span className="performance-head__icon" aria-hidden="true">
          <ChartColumn size={18} />
        </span>
        <div className="performance-head__title">
          <h2>Desempenho</h2>
          {selectedClass ? (
            <p>
              {selectedClass.label}
              {studentCountTextV2(state.matrix)}
            </p>
          ) : null}
        </div>
        <Tabs
          className="performance-period-tabs"
          selectedKey={String(state.filters.period)}
          onSelectionChange={(key) => {
            if (key === String(state.filters.period)) return;
            void state.select({
              period: key === 'annual' ? 'annual' : (Number(key) as PerformancePeriodV2),
            });
          }}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Período">
              {PERIOD_TABS.map((item) => (
                <Tabs.Tab key={item.id} id={item.id}>
                  {item.label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <GradebookYearContextBanner />
      </header>
      <ClassTabsV1
        items={state.classes?.classes ?? []}
        selectedId={state.filters.classId}
        onChange={(classId) => void state.select({ classId })}
        label="Turmas de Desempenho"
      >
        <Tabs
          selectedKey={perspective}
          onSelectionChange={(key) => {
            if (PERFORMANCE_PERSPECTIVES_V6.some((item) => item.id === key))
              navigate(key as PerformancePerspectiveV6);
          }}
          className="min-w-0"
        >
          <Tabs.ListContainer className="performance-perspectives">
            <Tabs.List aria-label="Perspectivas de Desempenho">
              {PERFORMANCE_PERSPECTIVES_V6.map((item) => (
                <Tabs.Tab id={item.id} key={item.id}>
                  {item.label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="notes" className="grid min-w-0 gap-4">
            {state.filters.classId !== null ? (
              <PerformanceGridYearV2.Provider value={state.year}>
                <Tabs
                  selectedKey={state.filters.lens}
                  className="performance-lens-tabs min-w-0"
                  onSelectionChange={(key) => {
                    if (key !== state.filters.lens && PERFORMANCE_LENSES_V3.includes(key as PerformanceLensV3))
                      void state.select({ lens: key as PerformanceLensV3 });
                  }}
                >
                  <div className="performance-notes-bar">
                    <Tabs.ListContainer className="h-10 max-w-full self-start">
                      <Tabs.List aria-label="Lentes de Desempenho">
                        {PERFORMANCE_LENSES_V3.map((lens) => (
                          <Tabs.Tab key={lens} id={lens} className="min-w-28">
                            {lensLabel[lens]}
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <div className="performance-notes-bar__selects">
                      <PerformanceSelect
                        id="mode"
                        label="Modo"
                        value={state.filters.mode}
                        isOpen={openSelect === 'mode'}
                        onOpenChange={changeOpenSelect}
                        items={[
                          { id: 'regular', label: 'Regular' },
                          { id: 'recovery', label: 'Recuperação' },
                        ]}
                        onChange={(value) =>
                          void state.select({ mode: value as PerformanceModeV2 })
                        }
                      />
                      <PerformanceSelect
                        id="comparison"
                        label="Comparar com"
                        value={
                          state.filters.referencePeriod === null
                            ? 'none'
                            : String(state.filters.referencePeriod)
                        }
                        items={comparisonItems}
                        disabled={comparisonDisabled}
                        isOpen={openSelect === 'comparison'}
                        onOpenChange={changeOpenSelect}
                        onChange={(value) =>
                          void state.select({
                            referencePeriod: value === 'none' ? null : (Number(value) as 1 | 2),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="performance-lens-status" aria-live="polite">
                    {state.failure ? (
                      <Alert status="warning">
                        <Alert.Content>
                          <Alert.Title>Consulta não concluída</Alert.Title>
                          <Alert.Description>{failures[state.failure]}</Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : null}
                  </div>
                  {PERFORMANCE_LENSES_V3.map((lens) => (
                    <Tabs.Panel
                      key={lens}
                      id={lens}
                      className="performance-lens-panel grid min-w-0 gap-4"
                    >
                      {state.filters.lens === lens ? (
                        <>
                          {lens === 'assessments' ? (
                            <div className="max-w-xl">
                              <PerformanceSelect
                                id="assessment-component"
                                label="Componente das avaliações"
                                value={
                                  state.filters.offerId === null
                                    ? 'none'
                                    : String(state.filters.offerId)
                                }
                                isOpen={openSelect === 'assessment-component'}
                                onOpenChange={changeOpenSelect}
                                items={[
                                  { id: 'none', label: 'Selecione o componente' },
                                  ...state.offers.map((offer) => ({
                                    id: String(offer.id),
                                    label: `${offer.subject.label} · ${offer.teacher.label}`,
                                  })),
                                ]}
                                onChange={(value) =>
                                  void state.select({
                                    offerId: value === 'none' ? null : Number(value),
                                  })
                                }
                              />
                            </div>
                          ) : null}
                          {state.comparison ? (
                            <PerformanceTermComparisonPanelV4
                              key={`comparison:${scopeKey}`}
                              value={state.comparison}
                              open={open}
                            />
                          ) : null}
                          {state.analysis && state.dashboard ? (
                            <PerformanceAnalysisPanelV3
                              key={scopeKey}
                              value={state.analysis}
                              dashboard={state.dashboard}
                              previous={state.previousDashboard}
                              open={open}
                              statuses={state.filters.statuses}
                              focusOffer={(offerId) =>
                                void state.select({ lens: 'assessments', offerId })
                              }
                              renderResult={(ids) => (
                                <PerformanceResultMatrixV2
                                  value={state.analysis!.matrix}
                                  open={open}
                                  allowedIds={ids}
                                  focusOffer={(offerId) =>
                                    void state.select({ lens: 'assessments', offerId })
                                  }
                                  statusOptions={state.classes?.statusOptions ?? []}
                                  statuses={state.filters.statuses}
                                  onStatusesChange={(statuses: PerformanceStatusV2[]) =>
                                    void state.select({ statuses })
                                  }
                                />
                              )}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </Tabs.Panel>
                  ))}
                </Tabs>
              </PerformanceGridYearV2.Provider>
            ) : (
              <p className="py-16 text-center text-sm text-muted">Escolha uma turma.</p>
            )}
          </Tabs.Panel>
          {PERFORMANCE_PERSPECTIVES_V6.filter((item) => item.id !== 'notes').map((item) => (
            <Tabs.Panel key={item.id} id={item.id} className="min-w-0">
              {perspective === item.id && perspective !== 'notes' ? (
                <AnalyticsPanelV2
                  analytics={analytics}
                  tab={perspective}
                  selection={selection}
                  onSelection={(next) => setSelection((previous) => ({ ...previous, ...next }))}
                  onNavigate={navigate}
                  onPeriod={(period) => void state.select({ period })}
                  onCell={openFromAnalytics}
                  onNotes={openAssessmentNotes}
                  classChosen={state.filters.classId !== null}
                />
              ) : null}
            </Tabs.Panel>
          ))}
        </Tabs>
      </ClassTabsV1>
      {!state.classes && !state.busy.classes ? (
        <Button
          variant="secondary"
          className="justify-self-start"
          onPress={() => void state.loadClasses()}
        >
          Tentar carregar turmas
        </Button>
      ) : null}
      <Drawer.Backdrop
        isOpen={state.detailOpen}
        onOpenChange={(isOpen) => {
          if (!isOpen) close();
        }}
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-full max-w-full sm:w-[min(52rem,90vw)]">
            <Drawer.CloseTrigger aria-label="Fechar detalhe" className="performance-detail-close" />
            {/* Back to the screen behind (or to the indicator list it came from), at the top so it is
                always in reach without scrolling the detail. */}
            {backLabel ? (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mb-1 self-start"
                onPress={goBack}
                data-back-step={String(depth)}
              >
                <ArrowLeft size={16} aria-hidden="true" />
                {backLabel}
              </Button>
            ) : null}
            {detail ? (
              <PerformanceStudentDetailV2
                detail={detail}
                focusPeriod={focusTerm ?? state.filters.period}
                openComponent={open}
              />
            ) : (
              <DetailPlaceholderV2
                openingId={openingId}
                openingName={openingName}
                year={state.year}
                busy={state.busy.detail}
                failure={state.detailFailure}
              />
            )}
            {detail && state.detailFailure ? (
              <p>
                <output className="contents">{failures[state.detailFailure]}</output>
              </p>
            ) : null}
            <Drawer.Footer>
              {/* The same step back, where the thumb is on a phone. */}
              {backLabel ? (
                <Button isIconOnly variant="secondary" aria-label={backLabel} onPress={goBack}>
                  <ArrowLeft size={18} aria-hidden="true" />
                </Button>
              ) : null}
              <Button variant="secondary" onPress={close}>
                Fechar
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </section>
  );
}
