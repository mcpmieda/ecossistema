import { useEffect, useState } from 'react';
import { Chip } from '@heroui/react/chip';
import { CircleCheck, Compass, Sparkles } from 'lucide-react';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import {
  renderTermClosingMessageV1,
  termClosingLabelV1,
  type TermClosingSummaryV1,
  type TermClosingV1,
} from '../../../../shared/student-portal-contracts/term-closing-v1';
import './term-closing-v1.css';
import { usePortalPreferenceKeyV1 } from '../shell/preference-scope-v1';

/*
 * Fechamento do trimestre (#1132). The server sends codes only; wording comes from the shared,
 * versioned catalog. Nothing here computes or shows a number (R1).
 */
const SEEN_KEY_V1 = 'studentPortalTermClosingSeenV1';

function readSeenV1(storageKey: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

/** "Novo" until first opened on this browser (D13, R8). No server state or personal data. */
/** `record: false` (a drag preview of a neighbour) shows the badge without marking it as seen. */
export function useTermClosingNewV1(key: string, record = true): boolean {
  const storageKey = usePortalPreferenceKeyV1(SEEN_KEY_V1);
  const [isNew] = useState(() => !readSeenV1(storageKey).has(key));
  useEffect(() => {
    if (!record) return;
    try {
      const seen = readSeenV1(storageKey);
      if (seen.has(key)) return;
      seen.add(key);
      globalThis.localStorage?.setItem(storageKey, JSON.stringify([...seen].slice(-200)));
    } catch {
      /* Private mode or blocked storage: the badge may simply show again. */
    }
  }, [key, storageKey, record]);
  return isNew;
}

function NewBadgeV1() {
  return (
    <Chip size="sm" variant="soft" color="accent" className="pa-closing-new">
      Novo
    </Chip>
  );
}

/** Subject closing inside its trimester tab (D10, D11). `good` is a single recognition line (D5). */
export function TermClosingCardV1({
  closing,
  subjectId,
  accountId,
  preview = false,
}: {
  closing: TermClosingV1;
  subjectId: number;
  accountId: string;
  /** Drawn only as the neighbour beside a drag: the student has not opened it, so not "seen". */
  preview?: boolean;
}) {
  const isNew = useTermClosingNewV1(`${accountId}|${subjectId}|${closing.period}|${closing.mode}`, !preview);
  const label = termClosingLabelV1(closing.period, closing.mode);
  const text = (message: TermClosingV1['conclusion'] | undefined) =>
    message ? renderTermClosingMessageV1(message, { period: closing.period }) : null;
  if (closing.level === 'good')
    return (
      <section className="pa-closing pa-closing--good" aria-label={label}>
        <CircleCheck className="pa-closing-line-icon" size={18} aria-hidden="true" />
        <div>
          <p className="pa-closing-eyebrow">{label}</p>
          <p className="pa-closing-line">{text(closing.conclusion)}</p>
        </div>
        {isNew ? <NewBadgeV1 /> : null}
      </section>
    );
  const action = text(closing.action);
  return (
    <section
      className={'pa-closing pa-closing--' + closing.level}
      aria-label={label}
    >
      <header className="pa-closing-header">
        <p className="pa-closing-eyebrow">{label}</p>
        {isNew ? <NewBadgeV1 /> : null}
      </header>
      <h3 className="pa-closing-title">{text(closing.conclusion)}</h3>
      <ul className="pa-closing-pieces">
        <li>
          <svg
            className="pa-closing-flag"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 22V4" />
            <path
              className="pa-closing-flag-cloth"
              d="M4 4 C7 2 9 2 12 3.5 C15 5 17 5 20 3.5 L20 13.5 C17 15.5 15 15.5 12 14 C9 12.5 7 12.5 4 15"
            />
          </svg>
          <span>{text(closing.weight)}</span>
        </li>
        {closing.strength ? (
          <li>
            <Sparkles className="pa-closing-sparkles" size={16} aria-hidden="true" />
            <span>{text(closing.strength)}</span>
          </li>
        ) : null}
      </ul>
      {action ? (
        <p className="pa-closing-action">
          <Compass className="pa-closing-compass" size={16} aria-hidden="true" />
          <span>
            <strong>Agora:</strong> {action.replace(/^Agora:\s*/u, '').replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase('pt-BR'))}
          </span>
        </p>
      ) : null}
    </section>
  );
}

/** Boletim summary of the most recent closed trimester (D4). */
export function TermClosingSummaryCardV1({
  summary,
  subjects,
  accountId,
}: {
  summary: TermClosingSummaryV1;
  subjects: readonly SelfResponseV1['subjects'][number][];
  accountId: string;
}) {
  const isNew = useTermClosingNewV1(`${accountId}|summary|${summary.period}|${summary.mode}`);
  const label = termClosingLabelV1(summary.period, summary.mode);
  const names = summary.attentionSubjectIds
    .map((id) => subjects.find((subject) => subject.subjectId === id)?.label)
    .filter((label): label is string => Boolean(label));
  const attention = summary.attentionSubjectIds.length > 0;
  return (
    <section
      className={'pa-closing-summary pa-closing-summary--' + (attention ? 'attention' : 'good')}
      aria-label={label}
    >
      <header className="pa-closing-header">
        <p className="pa-closing-eyebrow">{label}</p>
        {isNew ? <NewBadgeV1 /> : null}
      </header>
      <p className="pa-closing-summary-text">
        {renderTermClosingMessageV1(summary.message, { period: summary.period, subjects: names })}
      </p>
    </section>
  );
}
