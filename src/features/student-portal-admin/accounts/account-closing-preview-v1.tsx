import { useEffect, useState } from 'react';
import type { AdminReadResponseV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import {
  renderTermClosingMessageV1,
  termClosingLabelV1,
  type TermClosingMessageV1,
  type TermClosingV1,
} from '../../../../shared/student-portal-contracts/term-closing-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';

type PreviewV1 = Extract<AdminReadResponseV2, { state: 'closing-preview' }>;
type StateV1 = { state: 'loading' } | { state: 'ready'; value: PreviewV1 } | { state: 'error'; message: string };

const LEVEL_LABEL_V1: Record<TermClosingV1['level'], string> = {
  attention: 'Pede atenção',
  point: 'Foi bem, com um ponto a cuidar',
  good: 'Fechou bem',
};

/** Exact message and variant for support: the school can say precisely what the student read. */
function MessageLineV1({ message, closing }: Readonly<{ message?: TermClosingMessageV1; closing: TermClosingV1 }>) {
  if (!message) return null;
  return (
    <li>
      {renderTermClosingMessageV1(message, { period: closing.period })}{' '}
      <code className="text-xs text-muted">
        {message.code} · versão {message.variant + 1}
      </code>
    </li>
  );
}

/**
 * Fechamento do trimestre preview (#1132 D12, R7): the same engine and phrase variants the student
 * receives, shown even while the `showTermClosing` policy is off so it can be reviewed first.
 */
export function AccountClosingPreviewV1({
  reader,
  scope,
}: Readonly<{
  reader: PortalAdminReadClientV2;
  scope: Extract<ScopeV1, { kind: 'account' }>;
}>) {
  const [state, setState] = useState<StateV1>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: 'loading' });
    reader
      .query({ contractVersion: 2, operation: 'closing-preview', scope, page: {} }, controller.signal)
      .then((value) => {
        if (value.state === 'closing-preview') setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          state: 'error',
          message:
            error instanceof PortalClientErrorV1 && error.state === 'forbidden'
              ? 'Sem permissão para esta consulta.'
              : 'Prévia indisponível. Tente novamente.',
        });
      });
    return () => controller.abort();
  }, [reader, scope]);

  if (state.state === 'loading') return <p><output className="contents">Carregando prévia do fechamento…</output></p>;
  if (state.state === 'error') return <p role="alert">{state.message}</p>;
  const preview = state.value;
  if (!preview.available)
    return <p>Prévia indisponível: o vínculo deste aluno não está ativo ou elegível.</p>;
  if (preview.closedPeriods.length === 0)
    return (
      <p>
        {preview.mode === 'progress'
          ? 'Nenhum trimestre em andamento pelas datas configuradas nas políticas.'
          : 'Nenhum trimestre encerrado ainda. O fechamento aparece a partir da data de encerramento configurada nas políticas.'}{' '}
        Alunos assistidos ou especiais não recebem esta leitura.
      </p>
    );
  const names = new Map(preview.subjects.map((subject) => [subject.subjectId, subject.label]));
  return (
    <div className="grid gap-3">
      <p><output className="contents">
        {preview.visibleToStudent
          ? 'O aluno já vê este fechamento no Portal.'
          : 'Prévia: o aluno ainda não vê este fechamento (política "Fechamento do trimestre" desligada ou acesso fechado).'}
      </output></p>
      {preview.summary ? (
        <section aria-label="Resumo no Boletim">
          <h4 className="font-semibold">Resumo no Boletim · {termClosingLabelV1(preview.summary.period, preview.summary.mode)}</h4>
          <p>
            {renderTermClosingMessageV1(preview.summary.message, {
              period: preview.summary.period,
              subjects: preview.summary.attentionSubjectIds
                .map((id) => names.get(id))
                .filter((label): label is string => Boolean(label)),
            })}
          </p>
        </section>
      ) : null}
      {preview.subjects.map((subject) => (
        <section key={subject.subjectId} aria-label={subject.label}>
          <h4 className="font-semibold">{subject.label}</h4>
          {subject.closings.map((closing) => (
            <div key={closing.period}>
              <p className="text-sm text-muted">
                {termClosingLabelV1(closing.period, closing.mode)} · {LEVEL_LABEL_V1[closing.level]}
              </p>
              <ul className="list-disc pl-5">
                <MessageLineV1 message={closing.conclusion} closing={closing} />
                <MessageLineV1 message={closing.weight} closing={closing} />
                <MessageLineV1 message={closing.strength} closing={closing} />
                <MessageLineV1 message={closing.action} closing={closing} />
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
