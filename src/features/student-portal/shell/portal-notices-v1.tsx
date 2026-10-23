import { useEffect, useRef, useState } from 'react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { CalendarClock, Lock, RefreshCw } from 'lucide-react';
import {
  portalStatusResponseV1,
  type PortalNoticesV1,
} from '../../../../shared/student-portal-contracts/notices-v1';
import { createPortalTransportV1, type PortalTransportOptionsV1 } from '../shared/transport-v1';
import './portal-notices-v1.css';
import { usePortalPreferenceKeyV1 } from './preference-scope-v1';

export function createPortalStatusClientV1(options: PortalTransportOptionsV1 = {}) {
  const send = createPortalTransportV1(options);
  return (signal?: AbortSignal) => send('/api/student/status', portalStatusResponseV1, signal);
}
export type PortalStatusClientV1 = ReturnType<typeof createPortalStatusClientV1>;

// Server clock minus this device's clock, learned from the last status read. A phone set to the
// wrong time would otherwise open (or never open) the countdown at the wrong moment.
let clockOffsetMsV1 = 0;
/** Now on the server's clock (the last status or frequency read), never only the phone's. */
export const portalNowV1 = () => Date.now() + clockOffsetMsV1;
/** The server's clock from another answer (the frequency's, from the database): countdowns follow it. */
export function syncPortalClockV1(serverNow: string) {
  const at = Date.parse(serverNow);
  if (Number.isFinite(at)) clockOffsetMsV1 = at - Date.now();
}

/** Reads the notices once per `key` (anonymous / signed in). A failure shows no notice at all. */
export function usePortalNoticesV1(read: PortalStatusClientV1, key: string | null) {
  const [notices, setNotices] = useState<{ key: string; value: PortalNoticesV1 | null } | null>(
    null,
  );
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    read(controller.signal).then(
      (response) => {
        clockOffsetMsV1 = Date.parse(response.serverNow) - Date.now();
        setNotices({ key, value: response.notices });
      },
      () => {
        if (!controller.signal.aborted) setNotices({ key, value: null });
      },
    );
    return () => controller.abort();
  }, [read, key]);
  return notices && notices.key === key ? notices : null;
}

const periodNames = {
  T1: 'do 1º trimestre',
  T2: 'do 2º trimestre',
  T3: 'do 3º trimestre',
  REC1: 'da recuperação do 1º trimestre',
  REC2: 'da recuperação do 2º trimestre',
  REC3: 'da recuperação do 3º trimestre',
} as const;

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
function whenV1(at: string) {
  const parts = dateFormat.formatToParts(new Date(at));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')} às ${part('hour')}:${part('minute')}`;
}

function useNowV1(until: number) {
  const [now, setNow] = useState(portalNowV1);
  useEffect(() => {
    if (until <= portalNowV1()) return;
    const timer = setInterval(() => {
      const next = portalNowV1();
      setNow(next);
      if (next >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

const countV1 = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'}`;

/**
 * Split-flap card: the old number's top half folds down onto the new number's bottom half.
 * Keyed by value so each change replays the flip; reduced motion shows the number at once.
 */
function FlipCardV1({ value }: { value: string }) {
  // The value on screen before this render (updated after commit, so safe under StrictMode).
  const shown = useRef(value);
  const previous = shown.current;
  useEffect(() => {
    shown.current = value;
  }, [value]);
  const half = (part: 'top' | 'bottom', text: string, flap?: boolean) => (
    <span className={`pa-flip__half pa-flip__half--${part}${flap ? ' pa-flip__flap' : ''}`}>
      <span>{text}</span>
    </span>
  );
  return (
    <span className="pa-flip">
      {half('top', value)}
      {half('bottom', previous)}
      <span key={value} className="pa-flip__turn" data-turning={previous !== value || undefined}>
        {half('top', previous, true)}
        {half('bottom', value, true)}
      </span>
    </span>
  );
}

/** Days/hours/minutes/seconds to `at`; at zero it asks the student to refresh the page. */
export function PortalCountdownV1({
  at,
  title,
  done,
  when,
}: {
  at: string;
  title: string;
  done: string;
  /** What follows the title instead of "dd/mm às hh:mm" (the school year's end says only the day). */
  when?: string;
}) {
  const target = Date.parse(at);
  const now = useNowV1(target);
  const left = Math.max(0, Math.ceil((target - now) / 1000));
  if (left === 0)
    return (
      <div className="pa-countdown pa-countdown--done" role="status">
        <b>{done}</b>
        <span>Atualize a página para ver.</span>
        <Button size="sm" onPress={() => window.location.reload()}>
          <RefreshCw size={16} aria-hidden="true" />
          Atualizar página
        </Button>
      </div>
    );
  const units = [
    [Math.floor(left / 86400), 'dias'],
    [Math.floor((left % 86400) / 3600), 'horas'],
    [Math.floor((left % 3600) / 60), 'min'],
    [left % 60, 'seg'],
  ] as const;
  return (
    <div className="pa-countdown">
      <span className="pa-countdown__title">
        <CalendarClock size={16} aria-hidden="true" />
        {title} {when ?? whenV1(at)}
      </span>
      <div
        className="pa-countdown__clock"
        role="timer"
        aria-label={`Faltam ${countV1(units[0][0], 'dia')}, ${countV1(units[1][0], 'hora')} e ${countV1(units[2][0], 'minuto')}`}
      >
        {units.map(([value, label]) => (
          <span key={label} className="pa-countdown__unit" aria-hidden="true">
            <FlipCardV1 value={String(value).padStart(2, '0')} />
            <small>{label}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The same split-flap clock, short (owner decision 23/10/2026: "Intervalo em", "Saída em" on the
 * Horário): minutes and seconds, hours only when there is at least one. The caller counts.
 */
export function PortalTimerV1({ seconds, label }: { seconds: number; label: string }) {
  const left = Math.max(0, Math.floor(seconds));
  const days = Math.floor(left / 86400);
  const hours = Math.floor((left % 86400) / 3600);
  // Days only when there is at least one (the next lessons after a weekend).
  const units = [
    ...(days ? ([[days, 'dias']] as const) : []),
    ...(days || hours ? ([[hours, 'h']] as const) : []),
    [Math.floor((left % 3600) / 60), 'min'],
    [left % 60, 'seg'],
  ] as const;
  const minutes = Math.ceil(left / 60);
  return (
    <div
      className="pa-countdown__clock"
      role="timer"
      aria-label={`${label} ${days ? `${countV1(days, 'dia')}, ` : ''}${days || hours ? `${countV1(hours, 'hora')} e ` : ''}${countV1(days || hours ? Math.floor((left % 3600) / 60) : minutes, 'minuto')}`}
    >
      {units.map(([value, unit]) => (
        <span key={unit} className="pa-countdown__unit" aria-hidden="true">
          <FlipCardV1 value={String(value).padStart(2, '0')} />
          <small>{unit}</small>
        </span>
      ))}
    </div>
  );
}

/** Login page while access is closed: no sign-in, only when it opens or when grades come out. */
export function PortalClosedNoticeV1({ notices }: { notices: PortalNoticesV1 }) {
  return (
    <Card className="pa-auth-card pa-closed-card">
      <Card.Header className="pa-auth-header">
        <span className="pa-closed-card__icon" aria-hidden="true">
          <Lock size={26} />
        </span>
        <Card.Title className="pa-auth-title">Portal fechado no momento</Card.Title>
        <Card.Description>
          O acesso às notas ainda não foi liberado pela escola. Não é preciso ler o cartão agora.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {notices.gradesReleaseAt ? (
          <PortalCountdownV1
            at={notices.gradesReleaseAt}
            title="Notas liberadas em"
            done="As notas foram liberadas!"
          />
        ) : notices.accessOpensAt ? (
          <PortalCountdownV1
            at={notices.accessOpensAt}
            title="O Portal abre em"
            done="O Portal já abriu!"
          />
        ) : null}
      </Card.Content>
    </Card>
  );
}

function storageKeyV1(ended: NonNullable<PortalNoticesV1['disclosureEnded']>) {
  return `pa-notice:disclosure-ended:${ended.period ?? 'all'}:${ended.at}`;
}
function dismissedV1(key: string) {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Signed in: grades countdown and, once, that grades stopped being shown (per device). */
export function PortalSignedInNoticesV1({
  notices,
  hasGrades,
}: {
  notices: PortalNoticesV1;
  hasGrades: boolean;
}) {
  const ended = notices.disclosureEnded;
  const scopedKey = usePortalPreferenceKeyV1(ended ? storageKeyV1(ended) : '');
  const key = ended ? scopedKey : null;
  const [dismissed, setDismissed] = useState(() => (key ? dismissedV1(key) : true));
  useEffect(() => setDismissed(key ? dismissedV1(key) : true), [key]);
  return (
    <>
      {notices.gradesReleaseAt && !hasGrades ? (
        <Card className="pa-release-card">
          <Card.Content>
            <PortalCountdownV1
              at={notices.gradesReleaseAt}
              title="Notas liberadas em"
              done="As notas foram liberadas!"
            />
          </Card.Content>
        </Card>
      ) : null}
      {ended && key && !dismissed ? (
        <Alert status="warning" className="pa-shell-alert pa-ended-alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Lançamento de notas encerrado</Alert.Title>
            <Alert.Description>
              A consulta das notas {ended.period ? periodNames[ended.period] : 'do período'} foi
              encerrada em {whenV1(ended.at)}.
            </Alert.Description>
            <Button
              size="sm"
              variant="secondary"
              className="pa-state-action"
              onPress={() => {
                try {
                  globalThis.localStorage?.setItem(key, '1');
                } catch {
                  // Without storage the notice still closes for this visit.
                }
                setDismissed(true);
              }}
            >
              Entendi
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}
    </>
  );
}
