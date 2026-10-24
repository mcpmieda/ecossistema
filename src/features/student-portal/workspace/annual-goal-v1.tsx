import { Flag, PartyPopper, Target } from 'lucide-react';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import './annual-goal-v1.css';

type SubjectV1 = SelfResponseV1['subjects'][number];
type PeriodV1 = SubjectV1['periods'][number];
type ScoreMarkV1 = Extract<PeriodV1['final'], { kind: 'score' }>;

/*
 * Meta do ano (2º trimestre only). Same rule as the gradebook engine
 * (resolve-simplified-academic-engine-v1): a subject is approved directly when T1 + T2 + T3 reach
 * 60 of 100 (30 + 30 + 40). Only marks already on the student's screen are used, so no text can
 * reveal an undisplayed mark (#1132 R1). Recovery happens only after T3, so it never enters here.
 */
const ANNUAL_MINIMUM_MILLI_V1 = 60_000;
const TERM_MAXIMUM_MILLI_V1 = { T1: 30_000, T2: 30_000, T3: 40_000 } as const;
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

export type AnnualGoalV1 =
  | { state: 'reached'; soFarMilli: number; t1Milli: number; t2Milli: number }
  | { state: 'reachable' | 'beyond'; soFarMilli: number; t1Milli: number; t2Milli: number; neededMilli: number };

const milli = (value: number) => Math.round(value * 1000);
function scoreOf(subject: SubjectV1, period: PeriodV1['period']): ScoreMarkV1 | null {
  const final = subject.periods.find((item) => item.period === period)?.final;
  return final?.kind === 'score' ? final : null;
}

/** The T2 target remains visible during T3; it is based only on the published T1 + T2 marks. */
export function annualGoalV1(
  subject: SubjectV1,
  academicState: SelfResponseV1['profile']['academicState'],
): AnnualGoalV1 | null {
  if (academicState !== 'regular' || subject.annualSituation || subject.officialOutcome) return null;
  const t1 = scoreOf(subject, 'T1');
  const t2 = scoreOf(subject, 'T2');
  if (!t1 || !t2) return null;
  if (t1.maximum === null || t2.maximum === null) return null;
  if (milli(t1.maximum) !== TERM_MAXIMUM_MILLI_V1.T1 || milli(t2.maximum) !== TERM_MAXIMUM_MILLI_V1.T2) return null;
  const t1Milli = milli(t1.value);
  const t2Milli = milli(t2.value);
  const soFarMilli = t1Milli + t2Milli;
  const neededMilli = ANNUAL_MINIMUM_MILLI_V1 - soFarMilli;
  if (neededMilli <= 0) return { state: 'reached', soFarMilli, t1Milli, t2Milli };
  return {
    state: neededMilli <= TERM_MAXIMUM_MILLI_V1.T3 ? 'reachable' : 'beyond',
    soFarMilli,
    t1Milli,
    t2Milli,
    neededMilli,
  };
}

const points = (value: number) => number.format(value / 1000);
/**
 * Subject names are published in capitals ("MATEMÁTICA", "ED. FÍSICA"); inside a sentence they
 * read with only the first letter of each word capitalised. Mixed-case names stay as they are.
 */
export function subjectInSentenceV1(label: string): string {
  if (label !== label.toLocaleUpperCase('pt-BR')) return label;
  return label
    .toLocaleLowerCase('pt-BR')
    .replace(/(^|[\s.(/-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toLocaleUpperCase('pt-BR'));
}
const percentOfYear = (value: number) => `${value / 1000}%`;
// A label centred on a point of the track, kept inside it near the ends.
const labelAt = (milli: number) => `${Math.min(92, Math.max(8, milli / 1000))}%`;

export function AnnualGoalCardV1({ goal, subjectLabel }: Readonly<{ goal: AnnualGoalV1; subjectLabel: string }>) {
  const needed = goal.state === 'reached' ? 0 : Math.min(goal.neededMilli, TERM_MAXIMUM_MILLI_V1.T3);
  const Icon = goal.state === 'reached' ? PartyPopper : goal.state === 'reachable' ? Target : Flag;
  return (
    <section className={'pa-annual-goal pa-annual-goal--' + goal.state} aria-labelledby="pa-annual-goal-title">
      <header className="pa-annual-goal-header">
        <span className="pa-annual-goal-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2.2} />
        </span>
        <div>
          <p className="pa-annual-goal-eyebrow">Meta do ano · 60 pontos</p>
          <h3 id="pa-annual-goal-title" className="pa-annual-goal-title">
            {goal.state === 'reached' ? (
              'Você já alcançou os 60 pontos'
            ) : (
              <>
                Faltam <strong>{points(goal.neededMilli)}</strong>{' '}
                {goal.neededMilli === 1000 ? 'ponto' : 'pontos'}
              </>
            )}
          </h3>
        </div>
      </header>

      {/* How much is missing sits above the remaining part it refers to. */}
      <div className="pa-annual-goal-above" aria-hidden="true">
        {goal.state === 'reached' ? null : (
          <span className="pa-annual-goal-label pa-annual-goal-label--need" style={{ left: labelAt(goal.soFarMilli + needed / 2) }}>
            <small>faltam</small>
            <b>{points(goal.neededMilli)}</b>
          </span>
        )}
      </div>
      {/* Earned points move toward the goal; the points still needed remain lighter. */}
      <div className="pa-annual-goal-track" aria-hidden="true">
        <span className="pa-annual-goal-fill pa-annual-goal-fill--have" style={{ width: percentOfYear(goal.soFarMilli) }} />
        {needed > 0 ? (
          <span className="pa-annual-goal-fill pa-annual-goal-fill--needed" style={{ width: percentOfYear(needed) }} />
        ) : null}
        <span className="pa-annual-goal-marker" />
      </div>
      <div className="pa-annual-goal-scale" aria-hidden="true">
        <span className="pa-annual-goal-label pa-annual-goal-label--have" style={{ left: labelAt(goal.soFarMilli / 2) }}>
          <b>{points(goal.soFarMilli)}</b>
          <small>você tem</small>
        </span>
        <span className="pa-annual-goal-label pa-annual-goal-scale-goal">
          <b>60</b>
          <small>meta</small>
        </span>
        <span className="pa-annual-goal-label pa-annual-goal-scale-end">
          <b>100</b>
          <small>total</small>
        </span>
      </div>

      <p className="pa-annual-goal-text">
        {goal.state === 'reached'
          ? 'O 3º trimestre continua valendo para o seu boletim.'
          : goal.state === 'reachable'
            ? `${points(goal.neededMilli)} ${goal.neededMilli === 1000 ? 'ponto é' : 'pontos é'} o que você precisa no 3º trimestre para fechar o ano em ${subjectInSentenceV1(subjectLabel)}.`
            : `O 3º trimestre vale 40 pontos. Cada ponto dele conta, e a recuperação do fim do ano é a chance de completar o que faltar.`}
      </p>
    </section>
  );
}
