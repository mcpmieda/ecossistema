import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEventV1, type SyntheticEvent as ReactSyntheticEventV1 } from 'react';
import { flushSync } from 'react-dom';
import {
  Button,
  Card,
  Chip,
  Description,
  Label,
  ListBox,
  Surface,
  Tabs,
} from '@heroui/react';
import {
  Atom,
  BookOpenCheck,
  CircleAlert,
  CircleCheck,
  BookOpenText,
  Calculator,
  ChevronLeft,
  ChevronRight,
  Dumbbell,
  FlaskConical,
  Globe2,
  HandHeart,
  Landmark,
  Languages,
  LayoutDashboard,
  Monitor,
  MoveRight,
  Music2,
  Palette,
  PenLine,
  Scale,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import { StudentMarkV1 } from '../grades/student-mark-v1';
import { earnsAssessmentSealV1, earnsSealV1 } from '../grades/brilliant-seal-v1';
import { BrilliantSealBadgeV1 } from '../grades/brilliant-seal-badge-v1';
import { GranularStatusV1 } from '../../../shared/grades/granular-status-v1';
import './student-workspace-v1.css';
import { TermClosingCardV1, TermClosingSummaryCardV1 } from './term-closing-v1';
import { AnnualGoalCardV1, annualGoalV1 } from './annual-goal-v1';

type SubjectV1 = SelfResponseV1['subjects'][number];
type PeriodV1 = SubjectV1['periods'][number];
type PeriodIdV1 = PeriodV1['period'];
type ScoreMarkV1 = Extract<PeriodV1['final'], { kind: 'score' }>;
type WorkspaceAreaV1 = 'summary' | 'subject';

const MAIN_PERIODS_V1: readonly PeriodIdV1[] = ['T1', 'T2', 'T3'];
const PERIOD_LABELS_V1: Record<PeriodIdV1, string> = {
  T1: '1º Trimestre',
  T2: '2º Trimestre',
  T3: '3º Trimestre',
  REC1: 'REC 1º Trimestre',
  REC2: 'REC 2º Trimestre',
  REC3: 'REC 3º Trimestre',
};
/*
 * What each trimester is worth and its passing mark, under its Boletim tab only ("vale 30 · 18
 * passa"; "vale 30 pontos" from 27/09/2026 to 20/10/2026); inside a discipline the header already reads "de 30 pontos".
 * A published mark carries its own maximum; this fallback mirrors the engine's term maxima
 * (SIMPLIFIED_TERM_MAXIMUM_MILLI_V1), which the UI bundle may not import.
 */
const TERM_VALUE_V1: Partial<Record<PeriodIdV1, number>> = { T1: 30, T2: 30, T3: 40 };
function termValueV1(subjects: readonly SubjectV1[], period: PeriodIdV1): number | null {
  // Trimesters only: a recovery tab is not "worth" points of its own.
  if (!MAIN_PERIODS_V1.includes(period)) return null;
  for (const subject of subjects) {
    const final = subjectPeriodV1(subject, period)?.final;
    if (final?.kind === 'score' && final.maximum) return final.maximum;
  }
  return TERM_VALUE_V1[period] ?? null;
}
/**
 * The school's minimum is the server's (`meetsMinimum`), not a constant here. The 60% line is only
 * stated while every published trimester mark agrees with it; one that does not (a school with
 * another minimum) hides "passa" rather than give a wrong passing mark (PR 1317 review).
 */
function minimumIsSixtyPercentV1(subjects: readonly SubjectV1[], period: PeriodIdV1): boolean {
  return subjects.every((subject) => {
    const final = subjectPeriodV1(subject, period)?.final;
    if (final?.kind !== 'score' || !final.maximum || final.meetsMinimum === null) return true;
    const reaches = final.value * 100 >= final.maximum * METER_MINIMUM_PERCENT_V1 - 1e-9;
    return reaches === final.meetsMinimum;
  });
}
function TermValueV1({ subjects, period }: { subjects: readonly SubjectV1[]; period: PeriodIdV1 }) {
  const value = termValueV1(subjects, period);
  if (value === null) return null;
  // "vale 30 · 18 passa" (owner request 20/10/2026): what the trimester is worth and the
  // minimum to pass it, the same 60% line the discipline's meter marks.
  const passing = (value * METER_MINIMUM_PERCENT_V1) / 100;
  return (
    <span className="pa-term-value">
      {`vale ${number.format(value)}${minimumIsSixtyPercentV1(subjects, period) ? ` · ${number.format(passing)} passa` : ''}`}
    </span>
  );
}
const BULLETIN_PERIOD_LABELS_V1: Partial<Record<PeriodIdV1, string>> = {
  T1: '1º Trimestre',
  T2: '2º Trimestre',
  T3: '3º Trimestre',
};
const resultLabels = {
  approved: 'Aprovado',
  failed: 'Reprovado',
  'failed-attendance': 'Reprovado por falta',
} as const;
// 'failed' is a darker red than the 'danger' of Em recuperação (owner review 27/09/2026).
type ToneV1 = 'default' | 'success' | 'danger' | 'failed';
const chipColorV1 = (tone: ToneV1) => (tone === 'failed' ? 'danger' : tone);
const chipToneClassV1 = (tone: ToneV1) => (tone === 'failed' ? 'pa-chip-failed' : undefined);
/** Official BN/Council wording; the coarse `result` is only a fallback for legacy payloads. */
const ANNUAL_SITUATION_LABELS_V1: Record<
  NonNullable<SelfResponseV1['profile']['annualSituation']>,
  { label: string; tone: ToneV1 }
> = {
  'in-recovery': { label: 'Em recuperação', tone: 'danger' },
  // Not emitted any more (owner decision 2026-09-23); older payloads read as EM RECUPERAÇÃO.
  'awaiting-council': { label: 'Em recuperação', tone: 'danger' },
  'approved-direct': { label: 'Aprovado direto', tone: 'success' },
  'approved-after-recovery': { label: 'Aprovado pela recuperação', tone: 'success' },
  'approved-special': { label: 'Aprovado', tone: 'success' },
  'approved-by-council': { label: 'Aprovado pelo Conselho', tone: 'success' },
  'failed-after-recovery': { label: 'Reprovado após recuperação', tone: 'failed' },
  'failed-no-show': { label: 'Reprovado por não comparecimento', tone: 'failed' },
  'failed-repeat': { label: 'Reprovado', tone: 'failed' },
  'failed-by-council': { label: 'Reprovado pelo Conselho', tone: 'failed' },
  'failed-by-absence': { label: 'Reprovado por falta', tone: 'failed' },
};
const SUBJECT_SITUATION_LABELS_V1: Record<
  NonNullable<SubjectV1['annualSituation']>,
  { label: string; tone: ToneV1 }
> = {
  'recovery-pending': { label: 'Em recuperação', tone: 'danger' },
  'approved-direct': { label: 'Aprovado direto', tone: 'success' },
  'approved-after-recovery': { label: 'Aprovado pela recuperação', tone: 'success' },
  'not-approved': { label: 'Não aprovado', tone: 'failed' },
  'failed-no-show': { label: 'Reprovado por não comparecimento', tone: 'failed' },
  'failed-repeat': { label: 'Reprovado', tone: 'failed' },
};
const finalResultLabelsV1 = {
  approved: { label: 'Aprovado', tone: 'success' },
  failed: { label: 'Reprovado', tone: 'failed' },
  'failed-attendance': { label: 'Reprovado por falta', tone: 'failed' },
} as const;

function subjectSituationV1(subject: SubjectV1): { label: string; tone: ToneV1 } | null {
  if (subject.annualSituation) return SUBJECT_SITUATION_LABELS_V1[subject.annualSituation];
  if (subject.officialOutcome)
    return {
      label: resultLabels[subject.officialOutcome],
      tone: subject.officialOutcome === 'approved' ? 'success' : 'failed',
    };
  return null;
}
type SummaryKeyV1 = PeriodIdV1 | 'REC';
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 20 });
// Trimester marks read with one decimal at least: "27,0" (owner review 27/09/2026).
const trimesterNumber = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 20,
});
const WORKSPACE_HISTORY_KEY_V1 = '__studentPortalWorkspaceV1';

function subjectPeriodV1(subject: SubjectV1, period: PeriodIdV1) {
  return subject.periods.find((item) => item.period === period);
}
function scoreOfV1(period?: PeriodV1): ScoreMarkV1 | null {
  return period?.final.kind === 'score' ? period.final : null;
}
function visibleMainPeriodsV1(subjects: readonly SubjectV1[]) {
  return MAIN_PERIODS_V1.filter((period) =>
    subjects.some((subject) => subject.periods.some((item) => item.period === period)),
  );
}
const ALL_PERIODS_V1: readonly PeriodIdV1[] = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'];
function closingOfV1(subject: SubjectV1, period: PeriodIdV1) {
  return subject.closings?.find((closing) => closing.period === period);
}
/**
 * Released periods only: a trimester's closing shows together with its marks, never alone
 * (owner decision 2026-09-24, replacing #1132 R2).
 */
/** The period a discipline shows: the one chosen if it has it, else its first. */
function shownPeriodV1(subject: SubjectV1, selected: PeriodIdV1 | undefined): PeriodIdV1 {
  const available = subjectPeriodsV1(subject);
  return selected && available.includes(selected) ? selected : (available[0] ?? 'T1');
}
function subjectPeriodsV1(subject: SubjectV1): PeriodIdV1[] {
  return ALL_PERIODS_V1.filter((period) => subjectPeriodV1(subject, period) !== undefined);
}
function scoreToneV1(mark: ScoreMarkV1 | null) {
  if (mark?.meetsMinimum === true) return 'positive' as const;
  if (mark?.meetsMinimum === false) return 'negative' as const;
  return 'neutral' as const;
}

/*
 * Descriptive trend against the previous trimester, following the gradebook term comparison
 * (docs/gradebook/TERM_COMPARISON_2026_V4.md): percentages via exact cross-multiplication in
 * milli units, so T3 (max 40) is fairly compared with T2 (max 30). Only two numeric marks with
 * a positive maximum are comparable; anything else shows no indicator.
 */
const TREND_REFERENCE_V1: Partial<Record<PeriodIdV1, PeriodIdV1>> = { T2: 'T1', T3: 'T2' };
const RECOVERY_OF_V1: Partial<Record<PeriodIdV1, string>> = {
  REC1: '1º trimestre',
  REC2: '2º trimestre',
  REC3: '3º trimestre',
};
const RECOVERY_PERIODS_V1: readonly PeriodIdV1[] = ['REC1', 'REC2', 'REC3'];
type TrendV1 = 'higher' | 'equal' | 'lower';
function trendV1(current: ScoreMarkV1 | null, reference: ScoreMarkV1 | null): TrendV1 | null {
  if (!current?.maximum || !reference?.maximum) return null;
  const milli = (value: number) => BigInt(Math.round(value * 1000));
  const left = milli(current.value) * milli(reference.maximum);
  const right = milli(reference.value) * milli(current.maximum);
  return left > right ? 'higher' : left < right ? 'lower' : 'equal';
}

/**
 * The comparison with the previous trimester as a short line (owner rules, 27/09/2026). Gentle with
 * a student who reached the minimum, plain with one below it:
 * - reached it: "Subiu em relação ao 1º" / "Porém caiu em relação ao 1º" / "Se manteve igual ao 1º";
 * - below it: "Subiu, mas ainda precisa melhorar" / "Caiu em relação ao 1º" /
 *   "Se manteve igual ao 1º, mas precisa melhorar";
 * - "consideravelmente" only for a drop that worries: from the minimum to below it, or 10
 *   percentage points or more (`drop`, in points of the trimester's maximum).
 * The 3rd trimester is worth 40, so trends compare percentages, never raw marks.
 */
export function trendTextV1(
  trend: TrendV1,
  reference: PeriodIdV1,
  current: boolean | null,
  previous: boolean | null,
  drop = 0,
): string {
  const ref = reference === 'T1' ? '1º' : '2º';
  if (trend === 'higher')
    return current === false ? 'Subiu, mas ainda precisa melhorar' : `Subiu em relação ao ${ref}`;
  if (trend === 'equal')
    return current === false
      ? `Se manteve igual ao ${ref}, mas precisa melhorar`
      : `Se manteve igual ao ${ref}`;
  if (current === true) return `Porém caiu em relação ao ${ref}`;
  const worrying = (current === false && previous === true) || drop >= 10;
  return worrying ? `Caiu consideravelmente em relação ao ${ref}` : `Caiu em relação ao ${ref}`;
}

/** Percentage points lost from one trimester to the next (0 when it did not fall). */
function trendDropV1(current: ScoreMarkV1 | null, reference: ScoreMarkV1 | null): number {
  if (!current?.maximum || !reference?.maximum) return 0;
  return Math.max(0, (reference.value / reference.maximum - current.value / current.maximum) * 100);
}

function TrendLineV1({
  trend,
  reference,
  current,
  previous,
  drop,
}: {
  trend: TrendV1;
  reference: PeriodIdV1;
  current: boolean | null;
  previous: boolean | null;
  drop: number;
}) {
  const Icon = trend === 'higher' ? TrendingUp : trend === 'lower' ? TrendingDown : MoveRight;
  const text = trendTextV1(trend, reference, current, previous, drop);
  const line = useFitLineV1<HTMLSpanElement>(text, 10);
  return (
    <span ref={line} className={'pa-score-head-trend pa-score-head-trend--' + trend}>
      <Icon size={15} strokeWidth={2.4} aria-hidden="true" />
      {text}
    </span>
  );
}

type SubjectMotionV1 =
  | 'press'
  | 'page'
  | 'rise'
  | 'spin'
  | 'chat'
  | 'lift'
  | 'write'
  | 'beat'
  | 'balance'
  | 'swirl'
  | 'bounce'
  | 'glow'
  | 'orbit'
  | 'shake'
  | 'pop';

function subjectIconOfV1(label: string): { Icon: typeof BookOpenCheck; motion: SubjectMotionV1 } {
  const normalized = label
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('pt-BR');

  if (normalized.includes('matematica')) return { Icon: Calculator, motion: 'press' };
  if (normalized.includes('portugues')) return { Icon: BookOpenText, motion: 'page' };
  if (normalized.includes('historia')) return { Icon: Landmark, motion: 'rise' };
  if (normalized.includes('geografia')) return { Icon: Globe2, motion: 'spin' };
  if (normalized.includes('ingles')) return { Icon: Languages, motion: 'chat' };
  // Production labels are upper-case abbreviations (ED. FÍSICA, COMPUTAÇÃO, REDAÇÃO...).
  if (normalized.includes('educacao fisica') || normalized.startsWith('ed. fisica'))
    return { Icon: Dumbbell, motion: 'lift' };
  if (normalized.includes('redacao')) return { Icon: PenLine, motion: 'write' };
  if (normalized.includes('religiao') || normalized.includes('ensino religioso'))
    return { Icon: HandHeart, motion: 'beat' };
  if (normalized.includes('etica')) return { Icon: Scale, motion: 'balance' };
  if (normalized.includes('arte')) return { Icon: Palette, motion: 'swirl' };
  if (normalized.includes('musica')) return { Icon: Music2, motion: 'bounce' };
  if (
    normalized.includes('informatica') ||
    normalized.includes('computacao') ||
    normalized.includes('tecnologia')
  )
    return { Icon: Monitor, motion: 'glow' };
  if (normalized === 'fisica' || normalized.includes('fisica ')) return { Icon: Atom, motion: 'orbit' };
  if (
    normalized.includes('ciencia') ||
    normalized.includes('quimica') ||
    normalized.includes('biologia')
  )
    return { Icon: FlaskConical, motion: 'shake' };
  return { Icon: BookOpenCheck, motion: 'pop' };
}

/** `animated` plays the subject's own motion once on mount (the discipline view remounts per subject). */
function SubjectIconV1({ label, size = 18, animated = false }: { label: string; size?: number; animated?: boolean }) {
  const { Icon, motion } = subjectIconOfV1(label);
  return (
    <span
      className={'pa-subject-icon' + (animated ? ' pa-subject-icon--animated' : '')}
      data-motion={motion}
      aria-hidden="true"
    >
      <Icon size={size} strokeWidth={1.8} />
    </span>
  );
}

function SummaryV1({
  data,
  profile,
  selected,
  onSelect,
  onOpenSubject,
}: {
  data: SelfResponseV1;
  profile: ReactNode;
  selected: SummaryKeyV1 | undefined;
  onSelect: (key: SummaryKeyV1) => void;
  onOpenSubject: (subjectId: number, period?: PeriodIdV1) => void;
}) {
  const subjects = useMemo(() => [...data.subjects].sort((a, b) => a.order - b.order), [data.subjects]);
  // Only periods present in the payload get a tab: the server already dropped what the admin
  // has not released. Recoveries share one tab, shown only when any REC was released.
  const hasRecovery = subjects.some((subject) =>
    subject.periods.some((period) => RECOVERY_PERIODS_V1.includes(period.period)),
  );
  const available: SummaryKeyV1[] = [
    ...visibleMainPeriodsV1(subjects),
    ...(hasRecovery ? (['REC'] as const) : []),
  ];
  const active = selected && available.includes(selected) ? selected : (available[0] ?? 'T1');
  // Null until the first switch, so the list does not animate twice on mount; 'still' after a
  // drag, which already moved the new list into place.
  const [listMotion, setListMotion] = useState<SlideV1 | 'still' | null>(null);
  const listStage = useSlideStageV1(':scope > .pa-swipe-track > [data-slide-live]');
  /** Tabs and swipes alike: the old list leaves to one side, the new one comes from the other. */
  const choosePeriod = (next: SummaryKeyV1) => {
    if (next === active) return;
    const direction = available.indexOf(next) < available.indexOf(active) ? 'back' : 'forward';
    listStage.leave(direction);
    setListMotion(direction);
    onSelect(next);
  };
  const neighbourPeriod = (step: DragStepV1) => available[available.indexOf(active) + step];
  const periodDrag = useDragSwipeV1(
    (step) => neighbourPeriod(step) !== undefined,
    (step) => {
      setListMotion('still');
      onSelect(neighbourPeriod(step)!);
    },
  );
  const peekPeriod = periodDrag.peek === null ? undefined : neighbourPeriod(periodDrag.peek);
  const situation =
    data.profile.annualSituation === 'awaiting-council' ? 'in-recovery' : data.profile.annualSituation;
  const finalResult = situation
    ? ANNUAL_SITUATION_LABELS_V1[situation]
    : data.profile.result in finalResultLabelsV1
      ? finalResultLabelsV1[data.profile.result as keyof typeof finalResultLabelsV1]
      : null;
  const inRecovery = subjects.filter((subject) => subject.annualSituation === 'recovery-pending');
  // Each trimester tab shows its own summary, never another trimester's.
  const activeSummary =
    data.closingSummaries?.find((summary) => summary.period === active) ??
    (data.closingSummary?.period === active ? data.closingSummary : undefined);

  return (
    <div className="pa-workspace-view">
      {profile}
      <section className="pa-boletim-section" aria-labelledby="pa-summary-title">
        {/* Present only when the server releases it: EM RECUPERAÇÃO with T3, every other
            situation with the final disclosure. Assisted students never receive one. */}
        {finalResult ? (
          <Card className={'pa-final-result pa-final-result--' + finalResult.tone}>
            <Card.Content className="pa-final-result-content">
              <div>
                <p className="pa-workspace-eyebrow">
                  {situation === 'in-recovery' ? 'Situação' : 'Resultado final'}{' '}
                  {data.profile.link.academicYear}
                </p>
                <p className="pa-final-result-label">{finalResult.label}</p>
                {situation === 'in-recovery' && inRecovery.length ? (
                  <p className="pa-final-result-detail">
                    Recuperação em {inRecovery.map((subject) => subject.label).join(', ')}
                  </p>
                ) : null}
              </div>
              <Chip
                size="sm"
                variant="soft"
                color={chipColorV1(finalResult.tone)}
                className={chipToneClassV1(finalResult.tone)}
              >
                Oficial
              </Chip>
            </Card.Content>
          </Card>
        ) : null}

        {/* One period only (e.g. just the 1º Trimestre released): no bar to choose from; the
            heading names it instead. */}
        {available.length > 1 ? (
          <Tabs
            className="pa-boletim-period-tabs"
            selectedKey={active}
            onSelectionChange={(key) => choosePeriod(String(key) as SummaryKeyV1)}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Período das notas">
                {available.map((period) => (
                  <Tabs.Tab id={period} key={period} className="pa-boletim-period-tab">
                    <span>
                      {period === 'REC'
                        ? 'Recuperação'
                        : (BULLETIN_PERIOD_LABELS_V1[period] ?? PERIOD_LABELS_V1[period])}
                    </span>
                    {period === 'REC' ? null : <TermValueV1 subjects={subjects} period={period} />}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        ) : null}

        {/* Column labels over the list (owner review 27/09/2026): "Disciplinas" over the names,
            "Notas" over the marks. The section heading stays for screen readers. With a single
            period there is no tab bar, so the marks' label names it. */}
        <h2 id="pa-summary-title" className="pa-visually-hidden">
          Minhas notas
        </h2>
        <div className="pa-list-columns" aria-hidden="true">
          <span>Disciplinas</span>
          <span>
            {available.length === 1
              ? `Notas · ${active === 'REC' ? 'Recuperação' : (BULLETIN_PERIOD_LABELS_V1[active] ?? PERIOD_LABELS_V1[active])}`
              : 'Notas'}
          </span>
        </div>

        {/* Keyed by period so the list slides in from the side of the tab that was chosen. */}
        {/* Entering the Boletim: the subjects rise in one after another; switching trimesters
            keeps the sideways slide. */}
        {/* With more than one period, a sideways swipe on the list moves between them. */}
        <div
          className={'pa-slide-stage' + (available.length > 1 ? ' pa-swipe-area' : '')}
          ref={listStage.stage}
          {...(available.length > 1 ? periodDrag.handlers : {})}
        >
        <div className="pa-slide-ghosts" ref={listStage.ghostLayer} aria-hidden="true" />
        <div className="pa-swipe-track" ref={periodDrag.track}>
        <div
          key={active}
          data-slide-live=""
          className={
            listMotion === 'still'
              ? undefined
              : listMotion
                ? 'pa-slide-in pa-slide-in--' + listMotion
                : 'pa-list-enter'
          }
        >
        <BulletinListV1 subjects={subjects} period={active} onOpenSubject={onOpenSubject} />
        </div>
        {/* The neighbouring trimester, drawn beside the list only while a finger drags it. */}
        {peekPeriod ? (
          <div
            className={'pa-swipe-peek pa-swipe-peek--' + (periodDrag.peek === 1 ? 'next' : 'prev')}
            aria-hidden="true"
            inert
          >
            <BulletinListV1 subjects={subjects} period={peekPeriod} onOpenSubject={() => undefined} />
          </div>
        ) : null}
        </div>
        </div>
        {/* Below the marks, like the subject closing under its breakdown. */}
        {activeSummary ? (
          <TermClosingSummaryCardV1
            summary={activeSummary}
            subjects={subjects}
            accountId={data.profile.accountId}
          />
        ) : null}
      </section>
    </div>
  );
}

/** The Boletim list of one period: the live one, or the neighbour seen while dragging. */
function BulletinListV1({
  subjects,
  period: active,
  onOpenSubject,
}: {
  subjects: readonly SubjectV1[];
  period: SummaryKeyV1;
  onOpenSubject: (subjectId: number, period?: PeriodIdV1) => void;
}) {
  const recoveryPeriodsOf = (subject: SubjectV1) =>
    subject.periods.filter((period) => RECOVERY_PERIODS_V1.includes(period.period));
  const published = subjects.filter((subject) =>
    active === 'REC'
      ? recoveryPeriodsOf(subject).length > 0
      : subjectPeriodV1(subject, active),
  );
  return (
    <ListBox
      aria-label="Disciplinas publicadas"
      selectionMode="none"
      onAction={(key) => {
        // Open the discipline on the period being browsed (first recovery for the REC tab).
        const subject = published.find((item) => item.subjectId === Number(key));
        const period =
          active === 'REC' ? (subject && recoveryPeriodsOf(subject)[0]?.period) : active;
        onOpenSubject(Number(key), period);
      }}
      className="pa-workspace-list"
    >
      {published.map((subject) => {
        const outcome = subjectSituationV1(subject);
        // Below the minimum on this trimester: a soft red band runs from the icon to the mark.
        const below =
          active !== 'REC' && scoreOfV1(subjectPeriodV1(subject, active))?.meetsMinimum === false;
        // A Brilhante trimester (90%+) earns a gold seal in the Boletim, to collect, unless
        // any subject is red in that trimester; a missing seal is simply not shown.
        const brilliant = active !== 'REC' && earnsSealV1(subjects, subject, active);
        return (
          <ListBox.Item
            id={String(subject.subjectId)}
            key={subject.subjectId}
            textValue={subject.label}
          >
            <span
              className={
                'pa-list-band' +
                (below ? ' pa-list-band--below' : '') +
                (brilliant ? ' pa-list-band--brilliant' : '') +
                (active === 'REC' && recoveryPeriodsOf(subject).length > 1 ? ' pa-list-band--recovery' : '')
              }
            >
            <SubjectIconV1 label={subject.label} />
            <div className="pa-workspace-list-copy">
              <Label>{subject.label}</Label>
              {outcome ? (
                <Chip
                  size="sm"
                  variant="soft"
                  color={chipColorV1(outcome.tone)}
                  className={['pa-list-outcome', chipToneClassV1(outcome.tone)].filter(Boolean).join(' ')}
                >
                  <span className="pa-visually-hidden">Resultado oficial: </span>
                  {outcome.label}
                </Chip>
              ) : null}
            </div>
            {active === 'REC' ? (
              <span className="pa-recovery-marks">
                {recoveryPeriodsOf(subject).map((period) => (
                  <span key={period.period} className="pa-recovery-mark">
                    <span className="pa-recovery-mark-label">
                      {PERIOD_LABELS_V1[period.period].replace('REC ', '')}
                    </span>
                    <strong><StudentMarkV1 mark={period.final} oneDecimal /></strong>
                  </span>
                ))}
              </span>
            ) : (
              <>
                {brilliant ? (
                  <BrilliantSealBadgeV1 />
                ) : null}
                <strong>
                  <StudentMarkV1
                    mark={subjectPeriodV1(subject, active)?.final ?? { kind: 'absent' }}
                    oneDecimal
                  />
                </strong>
              </>
            )}
            {/* Each row opens its discipline. Inside the band, so a red or gold row runs to the
                arrow (owner review 27/09/2026). */}
            <ChevronRight className="pa-list-chevron" size={18} aria-hidden="true" />
            </span>
          </ListBox.Item>
        );
      })}
    </ListBox>
  );
}

type PartialV1 = NonNullable<PeriodV1['partials']>[number];

/**
 * Activity descriptions reach 120 characters. Show two lines and offer "Ver tudo" only when the
 * text really overflows at the current width (measured, not guessed from its length), so a wide
 * screen that fits the whole description shows no toggle. Nothing is ever permanently hidden.
 */
function PartialLabelV1({ label, feedback }: { label: string; feedback?: ReactNode }) {
  const text = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [label, expanded]);
  return (
    <div className="pa-workspace-list-copy">
      <span ref={text} className={'pa-partial-label' + (expanded ? ' is-expanded' : '')}>
        {label}
      </span>
      {overflowing || expanded ? (
        <button
          type="button"
          className="pa-partial-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Ver menos' : 'Ver tudo'}
        </button>
      ) : null}
      {feedback}
    </div>
  );
}

/*
 * Tag under each activity, in four bands of the activity's own maximum (owner decision
 * 2026-09-27): below 40% Precisa melhorar, 40–59% Não foi muito bem, 60–79% Foi bem,
 * 80–100% Excelente, and from 90% Brilhante (95% until 28/09/2026) — only for a trimester's mark and its two
 * assessments (columns R and S), since other activities get full marks too often (42% in
 * 2026) for it to mean anything. The 60% line is the server's `meetsMinimum`, so a tag never contradicts the
 * mark's colour; only the split inside each side is computed here, by exact cross-multiplication.
 * Não fez / Tirou zero already speak for themselves on the right, and a mark without a
 * classification or maximum gets nothing.
 */
type PartialBandV1 = 'needs-work' | 'below' | 'good' | 'excellent' | 'brilliant';
const PARTIAL_BANDS_V1: Record<PartialBandV1, { label: string }> = {
  'needs-work': { label: 'Precisa melhorar' },
  below: { label: 'Não foi muito bem' },
  good: { label: 'Foi bem' },
  excellent: { label: 'Excelente' },
  brilliant: { label: 'Brilhante' },
};
/** The band of any score: an activity, a trimester or a recovery. None without a classification. */
function markBandV1(mark: PeriodV1['final'], brilliantAllowed = false): PartialBandV1 | null {
  if (mark.kind !== 'score') return null;
  const { value, maximum, meetsMinimum } = mark;
  if (meetsMinimum === null || !maximum) return null;
  const milli = (amount: number) => Math.round(amount * 1000);
  // ≥ 90% ⇔ 10·value ≥ 9·maximum; ≥ 80% ⇔ 5·value ≥ 4·maximum; < 40% ⇔ 5·value < 2·maximum.
  if (meetsMinimum && brilliantAllowed && milli(value) * 10 >= milli(maximum) * 9) return 'brilliant';
  if (meetsMinimum) return milli(value) * 5 >= milli(maximum) * 4 ? 'excellent' : 'good';
  return milli(value) * 5 < milli(maximum) * 2 ? 'needs-work' : 'below';
}
function partialBandV1(partial: PartialV1): PartialBandV1 | null {
  if (partial.notDone || (partial.mark.kind === 'score' && partial.mark.value === 0)) return null;
  return markBandV1(partial.mark, partial.assessment === true);
}

/**
 * `calm`: the trimester mark is below the minimum, so an Excelente stays still — the celebration
 * is kept for a trimester that went well (owner decision 2026-09-27). Brilhante always shines.
 */
function PartialFeedbackV1({ partial, calm, sealed = false }: { partial: PartialV1; calm: boolean; sealed?: boolean }) {
  const band = partialBandV1(partial);
  if (!band) return null;
  // An assessment that earned a seal reads "selo Brilhante"; a Brilhante that did not (a red
  // mark in the trimester, or the trimester not over yet) keeps "Brilhante" (owner request 20/10/2026).
  const label = band === 'brilliant' && sealed ? 'selo Brilhante' : PARTIAL_BANDS_V1[band].label;
  return (
    <Chip
      size="sm"
      variant="soft"
      className={
        'pa-partial-feedback pa-partial-feedback--' + band + (calm && band === 'excellent' ? ' is-calm' : '')
      }
      data-band={band}
    >
      {band === 'brilliant' ? (
        <Star className="pa-brilliant-star" size={11} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
      ) : band === 'excellent' ? (
        <Sparkles className="pa-excellent-star" size={11} strokeWidth={2.4} aria-hidden="true" />
      ) : null}
      {label}
    </Chip>
  );
}

/**
 * Status copy restates the server's mark kind and classification in the same four bands as the
 * activities (owner decision 2026-09-27); it never infers a result.
 */
/*
 * Header status, a touch richer without more words (owner review 28/09/2026): a small emblem in
 * the band's colour before the reading (the star stays Brilhante's), and under it a slim meter of
 * the mark with a notch at the minimum and the share of the points, so even the 1º trimestre,
 * which has no trend line, says at a glance how far above or below the minimum it is.
 */
function StatusEmblemV1({ band }: { band: PartialBandV1 | null }) {
  if (band === 'brilliant')
    return <Star className="pa-brilliant-star" size={16} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />;
  if (band === 'excellent') return <Sparkles className="pa-status-emblem" size={17} strokeWidth={2.3} aria-hidden="true" />;
  if (band === 'good') return <CircleCheck className="pa-status-emblem" size={17} strokeWidth={2.4} aria-hidden="true" />;
  if (band === 'below' || band === 'needs-work')
    return <CircleAlert className="pa-status-emblem" size={17} strokeWidth={2.4} aria-hidden="true" />;
  return null;
}
/** The minimum line of the meter: 60% (the server's meetsMinimum decides the colours). */
const METER_MINIMUM_PERCENT_V1 = 60;
function ScoreMeterV1({ mark }: { mark: ScoreMarkV1 }) {
  if (!mark.maximum || mark.meetsMinimum === null) return null;
  // Floor, never round: 59,8% must not read as the minimum's 60%.
  const percent = Math.max(0, Math.min(100, Math.floor((mark.value / mark.maximum) * 100)));
  // The minimum in points, named under the notch: 18,0 of 30, 24,0 of 40 (owner review 28/09/2026).
  const minimum = trimesterNumber.format((mark.maximum * METER_MINIMUM_PERCENT_V1) / 100);
  return (
    <span className="pa-score-meter" role="img" aria-label={`${percent}% dos pontos; o mínimo é ${minimum}`}>
      <span className="pa-score-meter-track" aria-hidden="true">
        <span className="pa-score-meter-fill" style={{ width: `${percent}%` }} />
        {/* The notch at the minimum, named right under it so no parent has to guess. */}
        <span className="pa-score-meter-minimum" style={{ left: `${METER_MINIMUM_PERCENT_V1}%` }} />
        <span className="pa-score-meter-minimum-label" style={{ left: `${METER_MINIMUM_PERCENT_V1}%` }}>
          mínimo {minimum}
        </span>
      </span>
      <span className="pa-score-meter-value" aria-hidden="true">
        {percent}%
      </span>
    </span>
  );
}

function periodStatusV1(period: PeriodV1 | undefined) {
  const final = period?.final;
  if (!final || final.kind === 'absent') return { label: 'Ainda não lançada', band: null };
  if (final.kind === 'recovery-pending') return { label: 'Aguardando nota', band: null };
  const band = markBandV1(final, true);
  if (!band) return { label: 'Nota em análise', band: null };
  return { label: PARTIAL_BANDS_V1[band].label, band };
}

/*
 * Drag to switch (owner requests 27/09 and 20/10/2026): on the Boletim a sideways drag moves
 * between trimesters; on a discipline, between disciplines in the order of the subject bar, with no
 * wrap. The content follows the finger and the neighbour comes in from the side while dragging, so
 * nothing appears only after the gesture. Releasing past a third of the width, or with a quick
 * flick, finishes the move; otherwise the content springs back. Ignored when the gesture starts on
 * a tab bar or a control, near the screen edges (the browser's own back gesture), and when the
 * finger moves mostly vertically (the page scrolls).
 */
const DRAG_LOCK_PX_V1 = 8;
const DRAG_EDGE_PX_V1 = 24;
const DRAG_COMMIT_RATIO_V1 = 0.3;
const DRAG_FLICK_PX_PER_MS_V1 = 0.45;
/** How long after a real drag its own tap is swallowed (the press that ended it). */
const DRAG_SWALLOW_MS_V1 = 400;
/**
 * The air between the two pages: .pa-swipe-peek sits at calc(100% + 0.75rem), so it follows the
 * root font size (a reader's larger text included), read when the gesture ends.
 */
const dragGapPxV1 = () => 0.75 * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
type DragStepV1 = 1 | -1;
type DragSampleV1 = { x: number; at: number };
type DragGestureV1 = { id: number; x: number; y: number; dx: number; locked: boolean | null; samples: DragSampleV1[] };
function useDragSwipeV1(canStep: (step: DragStepV1) => boolean, onCommit: (step: DragStepV1) => void) {
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<DragGestureV1 | null>(null);
  const busy = useRef(false);
  const running = useRef<Animation | null>(null);
  // A drag is not a tap: the one press that ends a real drag must not open the row it started on.
  // Armed only by a horizontal drag, and spent by the first click, so a new tap goes through.
  const swallowUntil = useRef(0);
  const shown = useRef<DragStepV1 | null>(null);
  const [peek, setPeek] = useState<DragStepV1 | null>(null);
  const showPeek = (step: DragStepV1 | null) => {
    if (shown.current === step) return;
    shown.current = step;
    setPeek(step);
  };
  const clipping = (on: boolean) => track.current?.parentElement?.classList.toggle('is-sliding', on);
  const place = (px: number) => {
    if (track.current) track.current.style.transform = px ? `translate3d(${px}px, 0, 0)` : '';
  };
  const restore = () => {
    showPeek(null);
    place(0);
    clipping(false);
  };
  // Leaving the page mid-move: stop it; its end never navigates (see settle).
  useEffect(() => () => running.current?.cancel(), []);
  /**
   * Glides from where the finger left the content to its resting place, then runs `done`. A move
   * cut short (cancelled) never runs `done`: the content goes back in place without navigating.
   * Reduced motion: no glide, straight to the end.
   */
  const settle = (from: number, to: number, done: () => void) => {
    const element = track.current;
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!element || typeof element.animate !== 'function' || from === to || reduced) {
      done();
      swallowUntil.current = performance.now() + DRAG_SWALLOW_MS_V1;
      return;
    }
    busy.current = true;
    const duration = Math.round(Math.max(140, Math.min(300, Math.abs(to - from) * 0.9)));
    const animation = element.animate(
      [{ transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${to}px, 0, 0)` }],
      { duration, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)', fill: 'forwards' },
    );
    running.current = animation;
    const release = () => {
      running.current = null;
      busy.current = false;
      // Counted from the end of the move: a slow swap must not let the tap through afterwards.
      swallowUntil.current = performance.now() + DRAG_SWALLOW_MS_V1;
    };
    animation.finished.then(
      () => {
        // `done` swaps the content and resets the offset before the animation's hold is released,
        // all in this task, so no frame ever shows the content out of place.
        done();
        animation.cancel();
        release();
      },
      () => {
        if (track.current) restore();
        release();
      },
    );
  };
  const swallow = (event: ReactSyntheticEventV1, spend: boolean) => {
    if (performance.now() > swallowUntil.current) return;
    event.stopPropagation();
    event.preventDefault();
    if (spend) swallowUntil.current = 0;
  };
  const springBack = (from: number) => settle(from, 0, restore);
  /** The gesture stops being a drag (a second finger, a cancelled touch): back in place, no step. */
  const abandon = () => {
    const drag = gesture.current;
    gesture.current = null;
    if (!drag?.locked) return;
    swallowUntil.current = performance.now() + DRAG_SWALLOW_MS_V1;
    springBack(drag.dx);
  };
  const handlers = {
    onTouchStart: (event: ReactTouchEventV1) => {
      if (event.touches.length !== 1) {
        abandon();
        return;
      }
      const touch = event.touches[0];
      const target = event.target as HTMLElement;
      gesture.current =
        !busy.current &&
        touch &&
        touch.clientX > DRAG_EDGE_PX_V1 &&
        touch.clientX < window.innerWidth - DRAG_EDGE_PX_V1 &&
        !target.closest('[role="tablist"], button, a, input, label, select, summary, [role="switch"]')
          ? {
              id: touch.identifier,
              x: touch.clientX,
              y: touch.clientY,
              dx: 0,
              locked: null,
              samples: [{ x: touch.clientX, at: event.timeStamp }],
            }
          : null;
    },
    onTouchMove: (event: ReactTouchEventV1) => {
      const drag = gesture.current;
      if (!drag) return;
      // A second finger (pinch to zoom) is never a drag.
      if (event.touches.length !== 1) {
        abandon();
        return;
      }
      const touch = Array.from(event.touches).find((item) => item.identifier === drag.id);
      if (!touch) return;
      const dx = touch.clientX - drag.x;
      const dy = touch.clientY - drag.y;
      if (drag.locked === null) {
        if (Math.abs(dx) < DRAG_LOCK_PX_V1 && Math.abs(dy) < DRAG_LOCK_PX_V1) return;
        drag.locked = Math.abs(dx) > Math.abs(dy) * 1.2;
        if (!drag.locked) {
          gesture.current = null;
          return;
        }
        swallowUntil.current = Number.POSITIVE_INFINITY;
        clipping(true);
      }
      const step: DragStepV1 = dx < 0 ? 1 : -1;
      const open = canStep(step);
      // The neighbour shown always matches the side the finger moves to; none past the last item.
      showPeek(open ? step : null);
      // At the first or last item the content gives a little and comes back: nothing is there.
      drag.dx = open ? dx : dx * 0.25;
      drag.samples = [...drag.samples.slice(-5), { x: touch.clientX, at: event.timeStamp }];
      place(drag.dx);
    },
    onTouchEnd: (event: ReactTouchEventV1) => {
      const drag = gesture.current;
      gesture.current = null;
      if (!drag?.locked) return;
      swallowUntil.current = performance.now() + DRAG_SWALLOW_MS_V1;
      // Where the finger really lifted: it may have gone on after the last move event arrived.
      const lifted = Array.from(event.changedTouches).find((item) => item.identifier === drag.id);
      if (lifted) {
        const rawDx = lifted.clientX - drag.x;
        drag.dx = canStep(rawDx < 0 ? 1 : -1) ? rawDx : rawDx * 0.25;
        drag.samples = [...drag.samples.slice(-5), { x: lifted.clientX, at: event.timeStamp }];
        place(drag.dx);
      }
      const width = (track.current?.offsetWidth ?? window.innerWidth) + dragGapPxV1();
      const step: DragStepV1 = drag.dx < 0 ? 1 : -1;
      const last = drag.samples.at(-1)!;
      const first = drag.samples.find((sample) => last.at - sample.at <= 100) ?? last;
      const velocity = (last.x - first.x) / Math.max(1, last.at - first.at);
      const flick = Math.abs(velocity) > DRAG_FLICK_PX_PER_MS_V1 && Math.sign(velocity) === Math.sign(drag.dx);
      if (canStep(step) && (Math.abs(drag.dx) > width * DRAG_COMMIT_RATIO_V1 || flick)) {
        showPeek(step);
        settle(drag.dx, -step * width, () => {
          flushSync(() => {
            onCommit(step);
            showPeek(null);
          });
          place(0);
          clipping(false);
        });
      } else springBack(drag.dx);
    },
    // Only a drag already under way arms the swallow; a cancelled scroll or tap blocks nothing.
    onTouchCancel: () => abandon(),
    onPointerUpCapture: (event: ReactSyntheticEventV1) => swallow(event, false),
    onClickCapture: (event: ReactSyntheticEventV1) => swallow(event, true),
  };
  return { track, peek, handlers };
}

/*
 * Sideways slide (owner review 27/09/2026): when the student swipes or picks the next discipline or
 * trimester, the old content visibly leaves to one side while the new one comes in from the other,
 * so the change is obvious. The old content is a static, inert copy of the DOM (never React), laid
 * over the stage and animated out with the Web Animations API; without it (reduced motion, or a
 * browser/jsdom lacking element.animate) only the new content slides in.
 */
type SlideV1 = 'forward' | 'back';
function useSlideStageV1(liveSelector = ':scope > [data-slide-live]') {
  const stage = useRef<HTMLDivElement>(null);
  const ghostLayer = useRef<HTMLDivElement>(null);
  const leave = (direction: SlideV1) => {
    const live = stage.current?.querySelector<HTMLElement>(liveSelector);
    const layer = ghostLayer.current;
    const frame = stage.current;
    if (!live || !layer || !frame || typeof live.animate !== 'function') return;
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // Clip sideways only while sliding: at rest nothing is cut (e.g. the round back button, which
    // sits a little outside the view's edge).
    frame.classList.add('is-sliding');
    clearTimeout(Number(frame.dataset.slideTimer));
    frame.dataset.slideTimer = String(setTimeout(() => frame.classList.remove('is-sliding'), 450));
    const ghost = live.cloneNode(true) as HTMLElement;
    delete ghost.dataset.slideLive;
    delete ghost.dataset.areaLive;
    ghost.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    ghost.setAttribute('inert', '');
    // A still frame of what was on screen: no entrance motion of its own replays while it leaves.
    // Its other classes stay (e.g. the tab panel's padding), or the copy would sit a few pixels
    // off the original and jump before sliding (owner review 20/10/2026).
    ghost.className = [...live.classList]
      .filter((name) => !/^pa-(slide-in|list-enter|tab-motion)/u.test(name))
      .concat('pa-slide-ghost')
      .join(' ');
    // Exactly where the content was: the live element may sit inside a padded panel, and any offset
    // here shows as a jump before the slide (owner review 28/09/2026).
    const from = live.getBoundingClientRect();
    const origin = layer.getBoundingClientRect();
    Object.assign(ghost.style, {
      position: 'absolute',
      left: `${from.left - origin.left}px`,
      top: `${from.top - origin.top}px`,
      width: `${from.width}px`,
    });
    layer.replaceChildren(ghost);
    // Safety net: never leave the copy behind, even if the animation never reports its end.
    setTimeout(() => ghost.remove(), 1000);
    const to = direction === 'forward' ? '-100%' : '100%';
    ghost
      .animate(
        [
          { transform: 'translateX(0)', opacity: 1 },
          { transform: `translateX(${to})`, opacity: 0.2 },
        ],
        { duration: 340, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      )
      .finished.then(
        () => ghost.remove(),
        () => ghost.remove(),
      );
  };
  return { stage, ghostLayer, leave };
}

/*
 * One line when it fits (owner review 28/09/2026): a header line that would wrap first shrinks,
 * down to `minPx`; if it would need to get smaller than that, it keeps its size and wraps.
 * Layout-only (jsdom skips).
 */
function useFitLineV1<T extends HTMLElement>(key: string, minPx: number) {
  const line = useRef<T>(null);
  useLayoutEffect(() => {
    const element = line.current;
    const room = element?.parentElement;
    if (!element || !room) return;
    const fit = () => {
      element.style.fontSize = '';
      element.style.whiteSpace = 'nowrap';
      const available = room.clientWidth;
      const needed = element.scrollWidth;
      if (!available || !needed || needed <= available) return;
      const size = (Number.parseFloat(getComputedStyle(element).fontSize) * available) / needed;
      // Too small to read on one line: keep the normal size and let it wrap instead.
      if (size >= minPx) element.style.fontSize = `${size}px`;
      else element.style.whiteSpace = 'normal';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [key, minPx]);
  return line;
}

/*
 * "de 30 pontos" as wide as the mark above it (owner review 27/09/2026): the caption's font size is
 * scaled so its text spans exactly the number's width. Layout-only; jsdom (no layout) skips it.
 */
function useCaptionFitV1(key: string) {
  const block = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const figure = block.current?.querySelector('strong');
    const caption = block.current?.querySelector<HTMLElement>(':scope > span');
    if (!figure || !caption) return;
    caption.style.fontSize = '';
    const target = figure.getBoundingClientRect().width;
    const natural = caption.scrollWidth;
    if (!target || !natural) return;
    const base = Number.parseFloat(getComputedStyle(caption).fontSize);
    caption.style.fontSize = `${Math.min(15, Math.max(9, (base * target) / natural))}px`;
  }, [key]);
  return block;
}

/*
 * The discipline's header stays put while its body slides (owner review 28/09/2026): back button,
 * title and the subject bar. The bar is one persistent Tabs, so its white pill glides to the
 * discipline chosen; the icon replays its own motion for each discipline.
 */
/*
 * Discipline header (owner review 20/10/2026): one line with Back and the bar of disciplines, so a
 * parent sees at once that there are others and changes with one tap. The chosen one is the
 * highlighted tab (with its icon), centred in the bar; the next ones peek in at the edge. Only
 * the chosen tab has an icon and the tabs are compact, so a phone shows as many as before. The big title above the bar, which repeated the name, is gone;
 * the heading stays for screen readers.
 */
function SubjectHeaderV1({
  subject,
  subjects,
  onSubjectChange,
  onBack,
}: {
  subject: SubjectV1;
  subjects: readonly SubjectV1[];
  period?: PeriodIdV1;
  onSubjectChange: (id: number) => void;
  onBack: () => void;
}) {
  // Keep the chosen discipline in view inside the bar (inline only, so the page itself never
  // scrolls). On mount the panel is still being revealed and HeroUI's scroll shadow measures after
  // paint, so the first reveal waits a frame and retries after the slide-in; later ones glide.
  const subjectTabs = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    const smooth =
      mounted.current && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    mounted.current = true;
    const reveal = () => {
      const tab = subjectTabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const scroller = tab?.closest<HTMLElement>('.scroll-shadow') ?? tab?.parentElement?.parentElement;
      if (!tab || !scroller) return;
      const offset = tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2;
      const left = Math.max(0, Math.min(offset, scroller.scrollWidth - scroller.clientWidth));
      if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
      else scroller.scrollLeft = left;
    };
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(reveal);
    });
    const settled = setTimeout(reveal, 260);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
    };
  }, [subject.subjectId]);
  // Only an official result earns a chip here; "Em curso" lives under the class in the hero.
  const official = subjectSituationV1(subject);
  return (
    <div className="pa-subject-head">
      <h2 className="pa-visually-hidden">{subject.label}</h2>
      <div className="pa-subject-head-row">
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          className="pa-workspace-back"
          aria-label="Voltar para o boletim"
          onPress={onBack}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </Button>
        <div ref={subjectTabs} className="pa-subject-bar">
          <Tabs
            selectedKey={String(subject.subjectId)}
            onSelectionChange={(key) => onSubjectChange(Number(key))}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Trocar disciplina">
                {subjects.map((item) => (
                  <Tabs.Tab id={String(item.subjectId)} key={item.subjectId}>
                    {/* Only the chosen tab carries its icon: the others stay narrow, so more fit. */}
                    {item.subjectId === subject.subjectId ? (
                      <span className="pa-subject-tab-icon" aria-hidden="true">
                        {/* Mounted afresh on each discipline, so the subject's own motion plays once. */}
                        <SubjectIconV1 label={item.label} size={15} animated />
                      </span>
                    ) : null}
                    {item.label}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </div>
      </div>
      {official ? (
        <Chip
          size="sm"
          variant="soft"
          color={chipColorV1(official.tone)}
          className={'pa-subject-official ' + (chipToneClassV1(official.tone) ?? '')}
        >
          <span className="pa-visually-hidden">Resultado oficial: </span>
          {official.label}
        </Chip>
      ) : null}
    </div>
  );
}

function SubjectV1View({
  subject,
  selected,
  onSelect,
  accountId,
  academicState,
  sealed,
  assessmentSealed,
  preview = false,
}: {
  subject: SubjectV1;
  /** The neighbour drawn beside a drag: nothing in it may record that it was seen. */
  preview?: boolean;
  /** Whether the student holds the selo brilhante of the trimester being read. */
  sealed: (period: PeriodIdV1) => boolean;
  /** Whether that activity (AV1/AV2) earned its own seal (see earnsAssessmentSealV1). */
  assessmentSealed: (period: PeriodIdV1, partial: PartialV1) => boolean;
  /** Chosen period, kept across subjects; a subject without it falls back to its first one. */
  selected: PeriodIdV1 | undefined;
  onSelect: (period: PeriodIdV1) => void;
  accountId: string;
  academicState: SelfResponseV1['profile']['academicState'];
}) {
  const active = shownPeriodV1(subject, selected);
  const available = subjectPeriodsV1(subject);
  // Direction follows tab order (3º → 1º slides back); null until the first switch, since the
  // whole view already slides in when it opens.
  const [periodMotion, setPeriodMotion] = useState<SlideV1 | null>(null);
  // Trimester cards slide like the Boletim lists: the old card leaves while the new one comes in.
  const periodStage = useSlideStageV1(':scope > [role="tabpanel"]');
  const period = subjectPeriodV1(subject, active);
  const mark = scoreOfV1(period);
  const recoveryOf = RECOVERY_OF_V1[active];
  const trendReference = TREND_REFERENCE_V1[active];
  const trend = trendReference
    ? trendV1(mark, scoreOfV1(subjectPeriodV1(subject, trendReference)))
    : null;
  // Meta do ano lives only on the 2º tri tab (owner request, phase 4).
  const annualGoal = active === 'T2' ? annualGoalV1(subject, academicState) : null;
  const markBlock = useCaptionFitV1(`${subject.subjectId}:${active}:${mark?.value}:${mark?.maximum}`);
  const statusLine = useFitLineV1<HTMLSpanElement>(`${subject.subjectId}:${active}:${periodStatusV1(period).label}`, 15);

  return (
    <div className="pa-subject-body">

      <Tabs
        className="pa-period-tabs"
        selectedKey={active}
        onSelectionChange={(key) => {
          const next = String(key) as PeriodIdV1;
          const direction = available.indexOf(next) < available.indexOf(active) ? 'back' : 'forward';
          periodStage.leave(direction);
          setPeriodMotion(direction);
          onSelect(next);
        }}
      >
        <Tabs.ListContainer className={available.length > 1 ? undefined : 'pa-visually-hidden'}>
          <Tabs.List aria-label={'Períodos de ' + subject.label}>
            {/* Each period tab carries its own final mark, so the evolution reads at a glance. */}
            {available.map((item) => (
              <Tabs.Tab
                id={item}
                key={item}
                className="pa-period-tab"
                // Each card wears its trimester's band (owner review 28/09/2026); gold shines.
                data-tone={periodStatusV1(subjectPeriodV1(subject, item)).band ?? undefined}
              >
                {/* Always the full name, as in production ("1º Trimestre"); when six cards do not
                    fit a phone, the row scrolls sideways instead (owner decision 20/10/2026). */}
                <span className="pa-period-tab-label">{PERIOD_LABELS_V1[item]}</span>
                {/* The chosen trimester's mark heads the card below; the others stay here so a
                    parent can compare (owner review 27/09/2026). */}
                {item === active ? null : (
                  <span className="pa-period-tab-mark">
                    <StudentMarkV1
                      mark={subjectPeriodV1(subject, item)?.final ?? { kind: 'absent' }}
                      oneDecimal
                    />
                  </span>
                )}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        <div className="pa-slide-stage" ref={periodStage.stage}>
        <div className="pa-slide-ghosts" ref={periodStage.ghostLayer} aria-hidden="true" />
        <Tabs.Panel
          id={active}
          key={active}
          className={periodMotion ? 'pa-slide-in pa-slide-in--' + periodMotion : undefined}
        >
          {/* One card per trimester: the final mark heads it and partials follow, so it is never repeated.
              The closing follows the marks and never shows without them. */}
          {period ? (
          <Card
            className={
              'pa-score-card pa-score-card--' + scoreToneV1(mark)
            }
          >
            <Card.Content
              className={
                'pa-score-head' + (periodStatusV1(period).band === 'brilliant' ? ' pa-score-head--brilliant' : '')
              }
            >
              {periodStatusV1(period).band === 'brilliant' ? (
                // Crisp white sparkles, each twinkling in its own time (owner request 27/09/2026).
                <span className="pa-head-sparkles" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
              ) : null}
              <span className="pa-score-head-label">
                {recoveryOf
                  ? `Recuperação do ${recoveryOf}`
                  : `Sua nota do ${PERIOD_LABELS_V1[active].replace(' Trimestre', ' trimestre')}`}
              </span>
              <div className="pa-score-head-row">
                <div className="pa-score-head-mark" aria-label="Nota do período" ref={markBlock}>
                  {mark ? (
                    <>
                      <strong>{trimesterNumber.format(mark.value)}</strong>
                      {mark.maximum !== null && mark.maximum !== undefined ? (
                        <span>de {number.format(mark.maximum)} pontos</span>
                      ) : null}
                    </>
                  ) : (
                    <strong>
                      <StudentMarkV1 mark={period?.final ?? { kind: 'absent' }} />
                    </strong>
                  )}
                </div>
                <div className="pa-score-head-copy">
                  <span
                    ref={statusLine}
                    className="pa-score-head-status"
                    data-band={periodStatusV1(period).band ?? undefined}
                  >
                    <StatusEmblemV1 band={periodStatusV1(period).band} />
                    <span className="pa-status-word">
                      {/* "selo" rides small above the word when the seal was earned (owner request
                          28/09/2026); a Brilhante without the seal reads Brilhante alone. */}
                      {sealed(active) ? (
                        <span className="pa-status-seal" aria-hidden="true">
                          selo
                        </span>
                      ) : null}
                      {sealed(active) ? <span className="pa-visually-hidden">Selo </span> : null}
                      {periodStatusV1(period).label}
                    </span>
                  </span>
                  {mark ? <ScoreMeterV1 mark={mark} /> : null}
                  {trend && trendReference ? (
                    <TrendLineV1
                      trend={trend}
                      reference={trendReference}
                      current={mark?.meetsMinimum ?? null}
                      previous={scoreOfV1(subjectPeriodV1(subject, trendReference))?.meetsMinimum ?? null}
                      drop={trendDropV1(mark, scoreOfV1(subjectPeriodV1(subject, trendReference)))}
                    />
                  ) : null}
                </div>
              </div>
            </Card.Content>
            {/* No `partials` key means the admin did not release the breakdown (showPartials off):
                render nothing rather than claiming there are no activities. */}
            {period?.partials === undefined ? null : (
            <div className="pa-score-card-partials">
              {period.partials.length ? (
                <>
                  <p className="pa-score-card-partials-title">Como o aluno foi em cada atividade</p>
                  {/* A plain list: nothing here is selectable, and each row may hold a toggle. */}
                  <ul aria-label="Avaliações publicadas" className="pa-partials-list">
                    {period.partials.map((partial) => {
                      // Same rule as the bulletin table: observed blank → Não fez, numeric 0 → Tirou zero.
                      const zero = partial.mark.kind === 'score' && partial.mark.value === 0;
                      return (
                        <li key={partial.assessmentId}>
                          {/* The description leads, its status chip right under it reads as its subtitle,
                              and the mark sits on the description's line (owner review 27/09/2026). */}
                          <PartialLabelV1
                            label={partial.label}
                            feedback={
                              <>
                                <PartialFeedbackV1
                                  partial={partial}
                                  calm={mark?.meetsMinimum === false}
                                  sealed={assessmentSealed(active, partial)}
                                />
                                {/* A taken parallel exam (a score, zero included) was a second chance. */}
                                {partial.parallel && partial.mark.kind === 'score' ? (
                                  <span className="pa-partial-second-chance">
                                    <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" />
                                    Foi uma segunda chance
                                  </span>
                                ) : null}
                              </>
                            }
                          />
                          <strong
                            className={
                              partial.notDone
                                ? 'pa-partial-status pa-partial-status--not-done'
                                : zero
                                  ? 'pa-partial-status pa-partial-status--zero'
                                  : undefined
                            }
                          >
                            {partial.notDone || zero ? (
                              <GranularStatusV1 notDone={partial.notDone} zero={zero} />
                            ) : (
                              // The mark pill wears its band colour, like the tag under the description.
                              <span className="pa-mark-band" data-band={partialBandV1(partial) ?? undefined}>
                                <StudentMarkV1 mark={partial.mark} showMaximum oneDecimal />
                              </span>
                            )}
                          </strong>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                <Description className="pa-score-card-empty">
                  Nenhuma avaliação parcial publicada.
                </Description>
              )}
            </div>
            )}
          </Card>
          ) : null}
          {annualGoal ? <AnnualGoalCardV1 goal={annualGoal} subjectLabel={subject.label} /> : null}
          {period && closingOfV1(subject, active) ? (
            <TermClosingCardV1
              closing={closingOfV1(subject, active)!}
              subjectId={subject.subjectId}
              accountId={accountId}
              preview={preview}
            />
          ) : null}
        </Tabs.Panel>
        </div>
      </Tabs>
    </div>
  );
}

type WorkspaceEntryV1 = {
  area: WorkspaceAreaV1;
  subjectId: number;
  period?: PeriodIdV1;
  summary?: SummaryKeyV1;
};
const SUMMARY_KEYS_V1: readonly SummaryKeyV1[] = [...ALL_PERIODS_V1, 'REC'];

/** Reads a workspace entry from history; anything unknown is dropped, never trusted. */
function readWorkspaceEntryV1(state: unknown): WorkspaceEntryV1 | null {
  const entry =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)[WORKSPACE_HISTORY_KEY_V1]
      : undefined;
  if (!entry || typeof entry !== 'object') return null;
  const { area, subjectId, period, summary } = entry as Record<string, unknown>;
  if (area !== 'summary' && area !== 'subject') return null;
  return {
    area,
    subjectId: Number(subjectId),
    period: ALL_PERIODS_V1.includes(period as PeriodIdV1) ? (period as PeriodIdV1) : undefined,
    summary: SUMMARY_KEYS_V1.includes(summary as SummaryKeyV1) ? (summary as SummaryKeyV1) : undefined,
  };
}

export function StudentPortalWorkspaceV1({
  data,
  profile,
}: {
  data: SelfResponseV1;
  profile: ReactNode;
}) {
  const subjects = useMemo(() => [...data.subjects].sort((a, b) => a.order - b.order), [data.subjects]);
  const firstSubjectId = subjects[0]?.subjectId ?? 0;
  // Everything the student chose lives here and in the history entry, so it survives moving
  // between Boletim and Disciplina, switching subjects, Back/Forward and a page reload.
  const [area, setArea] = useState<WorkspaceAreaV1>('summary');
  const [selectedSubjectId, setSelectedSubjectId] = useState(firstSubjectId);
  const [subjectPeriod, setSubjectPeriod] = useState<PeriodIdV1 | undefined>();
  const [summaryTab, setSummaryTab] = useState<SummaryKeyV1 | undefined>();
  const [motionDirection, setMotionDirection] = useState<'forward' | 'back'>('forward');
  // Set only while moving from one discipline to another: then the view slides across.
  const [subjectSlide, setSubjectSlide] = useState<SlideV1 | null>(null);
  const subjectStage = useSlideStageV1(':scope > .pa-swipe-track > [data-slide-live]');
  // Boletim ⇄ Disciplina slide across too (owner review 27/09/2026): opening a discipline pushes the
  // Boletim out to the left; going back brings it in from the left.
  // 'still': the area stays as it is (switching disciplines moves only the body below the header).
  const [areaSlide, setAreaSlide] = useState<SlideV1 | 'still' | null>(null);
  const areaStage = useSlideStageV1(':scope > [role="tabpanel"] [data-area-live]');
  const goArea = (patch: Partial<WorkspaceEntryV1> & { area: WorkspaceAreaV1 }) => {
    const slide: SlideV1 = patch.area === 'subject' ? 'forward' : 'back';
    areaStage.leave(slide);
    go(patch, slide, null, slide);
  };
  const previousArea = useRef<WorkspaceAreaV1>('summary');
  const selectedSubject =
    subjects.find((subject) => subject.subjectId === selectedSubjectId) ?? subjects[0];
  const current = { area, subjectId: selectedSubjectId, period: subjectPeriod, summary: summaryTab };

  const validSubjectIdV1 = (subjectId: number) =>
    subjects.some((subject) => subject.subjectId === subjectId) ? subjectId : firstSubjectId;
  // The entry on screen. Another part of the page (the Notas ⇄ Frequência menu) keeps its own key
  // in the same history entry: its Back/Forward carries this entry unchanged, and replaying it
  // would restart the area's entrance animation inside a page that is already sliding.
  const shownEntry = useRef<WorkspaceEntryV1 | null>(null);

  const applyEntry = (
    entry: WorkspaceEntryV1,
    direction?: 'forward' | 'back',
    slide: SlideV1 | null = null,
    areaChange: SlideV1 | 'still' | null = null,
  ) => {
    shownEntry.current = entry;
    setSubjectSlide(slide);
    setAreaSlide(areaChange);
    const resolvedDirection =
      direction ?? (previousArea.current === 'subject' && entry.area === 'summary' ? 'back' : 'forward');
    previousArea.current = entry.area;
    setMotionDirection(resolvedDirection);
    setSelectedSubjectId(validSubjectIdV1(entry.subjectId));
    setSubjectPeriod(entry.period);
    setSummaryTab(entry.summary);
    setArea(entry.area);
  };

  const writeEntry = (entry: WorkspaceEntryV1, mode: 'push' | 'replace') => {
    if (typeof window === 'undefined') return;
    const state = window.history.state && typeof window.history.state === 'object'
      ? window.history.state
      : {};
    const next = { ...state, [WORKSPACE_HISTORY_KEY_V1]: entry };
    if (mode === 'push') window.history.pushState(next, '');
    else window.history.replaceState(next, '');
  };

  /** A new place (area or subject) gets its own Back step. */
  const go = (
    patch: Partial<WorkspaceEntryV1>,
    direction?: 'forward' | 'back',
    slide: SlideV1 | null = null,
    areaChange: SlideV1 | 'still' | null = null,
  ) => {
    const entry = { ...current, ...patch };
    writeEntry(entry, 'push');
    applyEntry(entry, direction, slide, areaChange);
  };
  /** Another discipline slides in from the side it sits on in the subject bar. */
  const orderOf = (subjectId: number) => subjects.findIndex((subject) => subject.subjectId === subjectId);
  const changeSubject = (subjectId: number) => {
    if (!selectedSubject || subjectId === selectedSubject.subjectId) return;
    const slide = orderOf(subjectId) < orderOf(selectedSubject.subjectId) ? 'back' : 'forward';
    subjectStage.leave(slide);
    // Only the body slides; the view around it must not replay its own entrance.
    go({ area: 'subject', subjectId }, slide, slide, 'still');
  };
  const neighbourSubject = (step: DragStepV1) =>
    selectedSubject ? subjects[orderOf(selectedSubject.subjectId) + step] : undefined;
  const subjectDrag = useDragSwipeV1(
    (step) => neighbourSubject(step) !== undefined,
    (step) => {
      const next = neighbourSubject(step)!;
      // The drag already brought the new discipline into place: no slide on top of it.
      go({ area: 'subject', subjectId: next.subjectId }, step === 1 ? 'forward' : 'back', null, 'still');
    },
  );
  const peekSubject = subjectDrag.peek === null ? undefined : neighbourSubject(subjectDrag.peek);
  /** A tab inside the same place only updates the current step. */
  const remember = (patch: Partial<WorkspaceEntryV1>) => {
    const entry = { ...current, ...patch };
    writeEntry(entry, 'replace');
    shownEntry.current = entry;
    if (patch.period !== undefined) setSubjectPeriod(patch.period);
    if (patch.summary !== undefined) setSummaryTab(patch.summary);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const initial = readWorkspaceEntryV1(window.history.state);
    if (initial) applyEntry(initial);
    else {
      writeEntry({ area: 'summary', subjectId: firstSubjectId }, 'replace');
      shownEntry.current = { area: 'summary', subjectId: firstSubjectId };
    }

    const restore = (event: PopStateEvent) => {
      const entry = readWorkspaceEntryV1(event.state);
      const shown = shownEntry.current;
      const same =
        !!entry &&
        !!shown &&
        entry.area === shown.area &&
        entry.subjectId === shown.subjectId &&
        entry.period === shown.period &&
        entry.summary === shown.summary;
      if (entry && !same) applyEntry(entry, entry.area === 'summary' ? 'back' : 'forward');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [firstSubjectId, subjects]);

  return (
    <Tabs
      className="pa-student-workspace"
      selectedKey={area}
      onSelectionChange={(key) => {
        const nextArea = String(key) as WorkspaceAreaV1;
        if (nextArea !== area) goArea({ area: nextArea, subjectId: selectedSubject?.subjectId ?? firstSubjectId });
      }}
    >
      <Surface variant="default" className="pa-workspace-nav-surface">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Áreas do Portal do Aluno">
            <Tabs.Tab id="summary">
              <LayoutDashboard size={17} aria-hidden="true" />
              Boletim
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="subject" isDisabled={!selectedSubject}>
              <BookOpenCheck size={17} aria-hidden="true" />
              Disciplina
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Surface>

      <div className="pa-slide-stage" ref={areaStage.stage}>
      <div className="pa-slide-ghosts" ref={areaStage.ghostLayer} aria-hidden="true" />
      <Tabs.Panel id="summary">
        <div
          key={'summary-' + area}
          data-area-live=""
          className={
            areaSlide === 'still'
              ? undefined
              : areaSlide
                ? 'pa-slide-in pa-slide-in--' + areaSlide
                : 'pa-tab-motion pa-tab-motion--' + motionDirection
          }
        >
          <SummaryV1
            data={data}
            profile={profile}
            selected={summaryTab}
            onSelect={(summary) => remember({ summary })}
            // Opening from a trimester tab lands on that trimester (first recovery for REC).
            onOpenSubject={(subjectId, period) => goArea({ area: 'subject', subjectId, period })}
          />
        </div>
      </Tabs.Panel>
      <Tabs.Panel id="subject">
        {selectedSubject ? (
          <div
            data-area-live=""
            className={
              'pa-workspace-view pa-swipe-area' +
              (areaSlide === 'still'
                ? ''
                : areaSlide
                  ? ' pa-slide-in pa-slide-in--' + areaSlide
                  : ' pa-tab-motion pa-tab-motion--' + motionDirection)
            }
            {...subjectDrag.handlers}
          >
            <SubjectHeaderV1
              subject={selectedSubject}
              subjects={subjects}
              period={subjectPeriod}
              // Switching subjects keeps the trimester being read.
              onSubjectChange={changeSubject}
              onBack={() => goArea({ area: 'summary', subjectId: selectedSubject.subjectId })}
            />
            {/* Only the body slides between disciplines; the header above stays. */}
            <div className="pa-slide-stage" ref={subjectStage.stage}>
              <div className="pa-slide-ghosts" ref={subjectStage.ghostLayer} aria-hidden="true" />
              <div className="pa-swipe-track" ref={subjectDrag.track}>
              <div
                key={'subject-' + selectedSubject.subjectId}
                data-slide-live=""
                className={subjectSlide ? 'pa-slide-in pa-slide-in--' + subjectSlide : undefined}
              >
                <SubjectV1View
                  subject={selectedSubject}
                  selected={subjectPeriod}
                  onSelect={(period) => remember({ period })}
                  accountId={data.profile.accountId}
                  academicState={data.profile.academicState}
                  sealed={(period) => earnsSealV1(subjects, selectedSubject, period)}
                  assessmentSealed={(period, partial) =>
                    earnsAssessmentSealV1(subjects, selectedSubject, period, partial, data.endedPeriods)
                  }
                />
              </div>
              {/* The neighbouring discipline, beside this one only while a finger drags it. */}
              {peekSubject ? (
                <div
                  className={'pa-swipe-peek pa-swipe-peek--' + (subjectDrag.peek === 1 ? 'next' : 'prev')}
                  aria-hidden="true"
                  inert
                >
                  <SubjectV1View
                    preview
                    subject={peekSubject}
                    selected={subjectPeriod}
                    onSelect={() => undefined}
                    accountId={data.profile.accountId}
                    academicState={data.profile.academicState}
                    sealed={(period) => earnsSealV1(subjects, peekSubject, period)}
                    assessmentSealed={(period, partial) =>
                      earnsAssessmentSealV1(subjects, peekSubject, period, partial, data.endedPeriods)
                    }
                  />
                </div>
              ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </Tabs.Panel>
      </div>
    </Tabs>
  );
}
