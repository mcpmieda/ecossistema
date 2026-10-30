import { useCallback, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { Spinner } from '@heroui/react/spinner';
import type { StudentIncidentV1, StudentIncidentsClientV1 } from '../incidents/client-v1';
import { FrequencyClientErrorV2 } from '../frequency/client-v2';
import { usePortalPageActiveV3, useReportOpenIncidentsV3 } from './portal-pages-v3';
import { useCachedReadV3 } from './use-cached-read-v3';

/*
 * Ocorrências in a page of its own (owner decisions 29/10/2026): the student's records of the year
 * as the Smecel has them (advertência, suspensão, outras), read by the collector, newest first, each
 * with its whole description: the family needs to know. Under each one, "Toque aqui para
 * confirmar que leu" (plain words for every family, owner request 30/10/2026; on the right, where a
 * thumb reaches on a large phone): after a confirmation it becomes a check with the day and time,
 * kept for good (no undo), and the open count on the menu goes down. An incident the school edits in the Smecel is
 * open again.
 *
 * Data: GET /api/student/incidents and POST /api/student/incidents/acknowledge
 * (createStudentIncidentsClientV1), read with the sign-in and kept (useCachedReadV3); shown only when
 * the self response says `showIncidents === true`.
 */
const DATE = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
const READ_DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Bahia',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const READ_TIME = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' });
/** "30/10/2026, às 10:03", in the school's time. */
const readMomentV3 = (value: string) => `${READ_DATE.format(new Date(value))}, às ${READ_TIME.format(new Date(value))}`;
const civil = (value: string) => DATE.format(new Date(`${value}T00:00:00Z`));

/** The Smecel's kind in plain words and its colour: a suspension red, a warning amber. */
function kindOfV3(kind: string): { label: string; color: 'danger' | 'warning' | 'default' } {
  const key = kind.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
  if (key === 'SUSPENSAO') return { label: 'Suspensão', color: 'danger' };
  if (key === 'ADVERTENCIA') return { label: 'Advertência', color: 'warning' };
  return { label: kind.charAt(0) + kind.slice(1).toLowerCase(), color: 'default' };
}

/** The leave's dates, with only the parts the Smecel shows. */
function leavePeriodV3({ from, to }: NonNullable<StudentIncidentV1['leave']>): string {
  if (from && to) return `De ${civil(from)} a ${civil(to)}`;
  if (from) return `A partir de ${civil(from)}`;
  if (to) return `Até ${civil(to)}`;
  return '';
}
/** "De 22/10/2026 a 28/10/2026 · 3 dias", with only the parts the Smecel shows. */
function leaveTextV3(leave: NonNullable<StudentIncidentV1['leave']>): string {
  const period = leavePeriodV3(leave);
  if (leave.days === null) return period;
  const days = `${leave.days} ${leave.days === 1 ? 'dia' : 'dias'}`;
  return [period, days].filter(Boolean).join(' · ');
}

/** Under a record: the check once confirmed, the confirmation asked, or the button. */
function AcknowledgementV3({
  acknowledgedAt,
  confirming,
  saving,
  onAsk,
  onConfirm,
  onCancel,
}: Readonly<{
  acknowledgedAt: string | null;
  confirming: boolean;
  saving: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}>) {
  if (acknowledgedAt)
    return (
      <p className="pa3-incident-seen">
        <CheckCircle2 size={18} aria-hidden="true" /> Você confirmou a leitura em {readMomentV3(acknowledgedAt)}
      </p>
    );
  if (confirming)
    return (
      <fieldset className="pa3-incident-confirm">
        <legend>Você leu e entendeu esta ocorrência? Depois de confirmar, não dá para desfazer.</legend>
        {/* The answer last, at the right edge, under the thumb. */}
        <div className="pa3-incident-actions">
          <Button size="sm" variant="tertiary" isDisabled={saving} onPress={onCancel}>
            Voltar
          </Button>
          <Button size="sm" variant="primary" isPending={saving} onPress={onConfirm}>
            Sim, li
          </Button>
        </div>
      </fieldset>
    );
  return (
    <Button size="sm" variant="secondary" className="pa3-incident-ack" onPress={onAsk}>
      Toque aqui para confirmar que leu
    </Button>
  );
}

function IncidentCardV3({
  incident,
  onAcknowledge,
}: Readonly<{ incident: StudentIncidentV1; onAcknowledge: (id: string) => Promise<void> }>) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const kind = kindOfV3(incident.kind);
  const confirm = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await onAcknowledge(incident.id);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };
  return (
    <Card className={'pa3-card pa3-incident' + (incident.acknowledgedAt ? ' pa3-incident--seen' : '')}>
      <div className="pa3-card-head">
        <Chip size="sm" variant="soft" color={kind.color}>
          {kind.label}
        </Chip>
        <span className="pa3-incident-date">{civil(incident.date)}</span>
      </div>
      {incident.leave ? (
        <p className="pa3-incident-leave">
          <strong>Afastamento:</strong> {leaveTextV3(incident.leave)}
        </p>
      ) : null}
      <p className="pa3-incident-text">{incident.description}</p>
      <AcknowledgementV3
        acknowledgedAt={incident.acknowledgedAt}
        confirming={confirming}
        saving={saving}
        onAsk={() => setConfirming(true)}
        onConfirm={() => void confirm()}
        onCancel={() => setConfirming(false)}
      />
      {failed ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>Não foi possível registrar agora. Tente de novo em instantes.</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </Card>
  );
}

export function IncidentsPageV3({
  client,
  onAuthenticationLost,
}: Readonly<{ client: StudentIncidentsClientV1; onAuthenticationLost?: () => void }>) {
  const read = useCallback((signal: AbortSignal) => client.read(signal), [client]);
  const load = useCachedReadV3(read, usePortalPageActiveV3(), onAuthenticationLost);
  // Confirmed here since the last read: shown at once, without reading everything again.
  const [seen, setSeen] = useState<Record<string, string>>({});
  // The school edited or removed a record while it was on screen: read again and say so.
  const [changed, setChanged] = useState(false);
  const incidents = (load.data?.incidents ?? [])
    .map((item) => ({ ...item, acknowledgedAt: item.acknowledgedAt ?? seen[item.id] ?? null }))
    .sort((a, b) => b.date.localeCompare(a.date));
  useReportOpenIncidentsV3(load.data ? incidents.filter((item) => !item.acknowledgedAt).length : null);
  const acknowledge = async (id: string) => {
    try {
      const { acknowledgedAt } = await client.acknowledge(id);
      setSeen((current) => ({ ...current, [id]: acknowledgedAt }));
    } catch (reason) {
      const state = reason instanceof FrequencyClientErrorV2 ? reason.state : null;
      if (state === 'unauthenticated') onAuthenticationLost?.();
      else if (state === 'changed') {
        setChanged(true);
        load.retry();
      } else throw reason;
    }
  };
  return (
    <div className="pa3-incidents">
      <h2 className="pa3-page-title">Ocorrências</h2>
      {changed ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              A escola alterou uma ocorrência. Confira o texto atualizado antes de confirmar.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {load.data && incidents.length
        ? incidents.map((item) => <IncidentCardV3 key={item.id} incident={item} onAcknowledge={acknowledge} />)
        : null}
      {load.data && !incidents.length ? (
        <Card className="pa3-card pa3-status">
          <p className="pa3-incidents-empty">Nenhuma ocorrência registrada neste ano.</p>
        </Card>
      ) : null}
      {load.data ? null : (
        <Card className="pa3-card pa3-status" role={load.error ? 'alert' : undefined}>
          {load.error ? (
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>Não foi possível carregar as ocorrências agora.</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            <output className="pa3-status-loading">
              <Spinner size="sm" /> Carregando as ocorrências…
            </output>
          )}
          {load.error ? (
            <Button size="sm" variant="secondary" className="pa3-status-action" onPress={load.retry}>
              Tentar de novo
            </Button>
          ) : null}
        </Card>
      )}
    </div>
  );
}
