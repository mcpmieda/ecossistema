import { OverviewDashboardV1 } from './overview-dashboard-v1';
import { InfoV1 } from '../shared/info-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertDialog, Button, Card, Chip } from '@heroui/react';
import { OperationsScopeV1 } from './operations-scope-v1';
import {
  operationDateV1,
  authorizationLostV1,
  useOperationalReadV1,
  type OperationsPropsV1,
} from './operations-values-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
const healthLabels = {
  normal: 'Operando normalmente',
  attention: 'Atenção',
  intervention: 'Intervenção necessária',
} as const;
export function StudentOverviewV1(props: Readonly<OperationsPropsV1>) {
  return (
    <OperationsScopeV1 {...props}>
      {(scope, label, onAuthorizationLost) => (
        <OverviewBodyV1
          key={props.identityKey + settingsScopeKeyV1(scope) + props.canWrite}
          {...props}
          scope={scope}
          scopeLabel={label}
          onAuthorizationLost={onAuthorizationLost}
        />
      )}
    </OperationsScopeV1>
  );
}
function OverviewBodyV1(props: Readonly<OperationsPropsV1>) {
  const [populationReview, setPopulationReview] = useState(false);
  const [populationBusy, setPopulationBusy] = useState(false);
  const [populationError, setPopulationError] = useState<PortalClientErrorV1 | null>(null);
  const populationCommand = useRef<ReturnType<
    OperationsPropsV1['client']['prepareCommand']
  > | null>(null);
  const populationAbort = useRef<AbortController | null>(null);
  const scopeKey = settingsScopeKeyV1(props.scope);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [overview, population] = await Promise.allSettled([
        props.reader.query(
          { contractVersion: 2, operation: 'overview', scope: props.scope, page: { limit: 100 } },
          signal,
        ),
        props.scope.kind === 'school'
          ? props.client.query(
              {
                contractVersion: 1,
                operation: 'population',
                scope: props.scope,
                page: { limit: 1 },
              },
              signal,
            )
          : Promise.resolve(null),
      ]);
      signal.throwIfAborted();
      for (const result of [overview, population])
        if (
          result.status === 'rejected' &&
          result.reason instanceof PortalClientErrorV1 &&
          (authorizationLostV1(result.reason) || result.reason.state === 'rate-limited')
        )
          throw result.reason;
      const summary =
        overview.status === 'fulfilled' && overview.value.state === 'overview'
          ? overview.value
          : null;
      let health = summary?.health ?? null;
      if (!summary) {
        // The fallback keeps health observable when the business summary is unavailable.
        try {
          const result = await props.client.query(
            { contractVersion: 1, operation: 'health', scope: props.scope, page: { limit: 1 } },
            signal,
          );
          if (result.state === 'health') health = result.status;
        } catch (error) {
          if (
            error instanceof PortalClientErrorV1 &&
            (authorizationLostV1(error) || error.state === 'rate-limited')
          )
            throw error;
        }
        signal.throwIfAborted();
      }
      return {
        overview: summary,
        health,
        population:
          population.status === 'fulfilled' && population.value?.state === 'population'
            ? population.value
            : null,
      };
    },
    [props.reader, props.client, scopeKey],
  );
  const read = useOperationalReadV1(load, props.onAuthorizationLost, true, false);
  const data = read.state.state === 'ready' ? read.state.data : null;
  useEffect(() => () => populationAbort.current?.abort(), []);
  const synchronizePopulation = async () => {
    if (!data?.population || populationBusy || props.scope.kind !== 'school') return;
    setPopulationBusy(true);
    setPopulationError(null);
    const controller = new AbortController();
    populationAbort.current = controller;
    try {
      populationCommand.current ??= props.client.prepareCommand({
        contractVersion: 1,
        operation: 'population-start',
        academicYear: 2026,
        expectedVersion: data.population.version,
        idempotencyKey: crypto.randomUUID(),
        clearOverrides: true,
        confirmed: true,
      });
      await populationCommand.current.execute(controller.signal);
      populationCommand.current = null;
      read.reload();
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure =
        error instanceof PortalClientErrorV1 ? error : new PortalClientErrorV1('network-error');
      if (authorizationLostV1(failure)) props.onAuthorizationLost?.(failure);
      else {
        setPopulationError(failure);
        if (
          !['network-error', 'invalid-response', 'unavailable', 'rate-limited'].includes(
            failure.state,
          )
        )
          populationCommand.current = null;
      }
    } finally {
      if (!controller.signal.aborted) setPopulationBusy(false);
      if (populationAbort.current === controller) populationAbort.current = null;
    }
  };
  return (
    <Card className="pa-operations-card pa-overview">
      <Card.Content>
        {read.state.state === 'loading' && (
          <>
            <p role="status" className="sr-only">
              Consultando operação…
            </p>
            <div className="pa-overview-skeleton" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
          </>
        )}
        {read.state.state === 'error' && (
          <AccountsErrorV1
            error={read.state.error}
            canReload={read.canReload}
            onReload={read.reload}
          />
        )}
        {data && (
          <>
            <section className="pa-overview-hero pa-rise" aria-label="Funcionamento">
              <div className="pa-overview-hero-main">
                <p className="pa-overview-scope">{props.scopeLabel} · 2026</p>
                <div className="pa-overview-health">
                  <h3>Funcionamento</h3>
                  {data.health ? (
                    <Chip
                      variant="soft"
                      color={
                        data.health === 'normal'
                          ? 'success'
                          : data.health === 'attention'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      <span className="pa-overview-pulse" aria-hidden="true" />
                      {healthLabels[data.health]}
                    </Chip>
                  ) : null}
                  <InfoV1 label="Sobre o funcionamento">
                    Situação do serviço e das tarefas automáticas, independente das permissões de
                    cada aluno.
                  </InfoV1>
                </div>
                {!data.health && (
                  <p role="alert">Saúde indisponível para consulta. Nenhum estado foi presumido.</p>
                )}
                {data.health === 'attention' && (
                  <p>
                    Há trabalho pendente além da janela esperada. Confira novamente após o
                    processamento.
                  </p>
                )}
                {data.health === 'intervention' && (
                  <p>
                    A operação requer investigação administrativa. A liberação de acesso depende das
                    verificações próprias.
                  </p>
                )}
              </div>
              <div className="pa-overview-hero-side">
                <LiveReadNoticeV1 failed={Boolean(read.refreshError)} />
                {data.overview && (
                  <p className="pa-operations-muted">
                    Resumo consultado em {operationDateV1(data.overview.observedAt)}.
                  </p>
                )}
              </div>
            </section>
            {data.overview ? (
              <>
                <OverviewDashboardV1 counts={data.overview.counts} />
                {data.overview.counts.accounts === 0 ? <p>Nenhuma conta neste recorte.</p> : null}
                {data.population && (
                  <section
                    className="pa-overview-population pa-rise"
                    aria-labelledby="pa-population-title"
                  >
                    <div className="pa-overview-population-head">
                      <h3 id="pa-population-title">Cadastro do Portal</h3>
                      <Chip variant="soft" color={data.population.enabled ? 'success' : 'warning'}>
                        {data.population.enabled
                          ? 'Cadastro automático ativo'
                          : 'Cadastro automático desativado'}
                      </Chip>
                    </div>
                    <dl className="pa-overview-facts">
                      {(
                        [
                          ['Turmas', data.population.classes],
                          ['Alunos com vínculo', data.population.eligibleSourceProfiles],
                          ['Vínculos de saída', data.population.exitSourceProfiles],
                          ['Contas existentes', data.population.accounts],
                          ['Cadastros pendentes', data.population.missingProfiles],
                          ['Opções personalizadas', data.population.overrideRows],
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value.toLocaleString('pt-BR')}</dd>
                        </div>
                      ))}
                    </dl>
                    {populationError && (
                      <p role="alert">
                        A sincronização não foi confirmada. Consulte novamente ou tente a mesma
                        ação.
                      </p>
                    )}
                    {!data.population.enabled && (
                      <Button
                        isDisabled={!props.canWrite || populationBusy}
                        isPending={populationBusy}
                        onPress={() =>
                          populationError ? void synchronizePopulation() : setPopulationReview(true)
                        }
                      >
                        {populationError
                          ? 'Tentar sincronização novamente'
                          : 'Ativar cadastro automático'}
                      </Button>
                    )}
                  </section>
                )}
              </>
            ) : (
              <p role="alert">
                Resumo indisponível para este escopo. Os totais não foram substituídos por zero.
                Tente uma turma ou uma conta.
              </p>
            )}
          </>
        )}
      </Card.Content>
      {data?.population && populationReview && (
        <AlertDialog.Backdrop
          isOpen
          isDismissable={false}
          isKeyboardDismissDisabled={populationBusy}
          onOpenChange={(open) => {
            if (!open && !populationBusy) setPopulationReview(false);
          }}
        >
          <AlertDialog.Container>
            <AlertDialog.Dialog className="pa-operations-dialog">
              <AlertDialog.Header>
                <AlertDialog.Heading>Ativar cadastro automático</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>
                  A operação criará até {data.population.missingProfiles} perfis para as{' '}
                  {data.population.classes} turmas do cadastro acadêmico e manterá vínculos
                  inelegíveis sem acesso.
                </p>
                <p>
                  {data.population.overrideRows} configurações individuais ou de turma serão
                  removidas para que todas as contas usem a política institucional.
                </p>
                <p>
                  Nenhum QR será emitido, nenhuma nota será publicada e nenhuma mensagem será
                  enviada.
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button autoFocus variant="secondary" onPress={() => setPopulationReview(false)}>
                  Cancelar
                </Button>
                <Button
                  isDisabled={populationBusy}
                  isPending={populationBusy}
                  onPress={() => {
                    setPopulationReview(false);
                    void synchronizePopulation();
                  }}
                >
                  Ativar e sincronizar
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      )}
    </Card>
  );
}
