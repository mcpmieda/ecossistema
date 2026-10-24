import { useCallback, useState } from 'react';
import { Button } from '@heroui/react';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import { useOperationalReadV1 } from '../overview/operations-values-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import { CustomizationResetV1 } from '../settings/customization-reset-v1';
import {
  publicationDifferenceV1,
  publicationResetChoiceV1,
  type CustomizationResetChoiceV1,
} from '../settings/customization-values-v1';
import { StudentPublicationV1, type StudentPublicationPropsV1 } from './student-publication-v1';

type Props = StudentPublicationPropsV1 & { reader: PortalAdminReadClientV2 };
function ScopedPersonalizedPublicationV1(props: Props) {
  const { reader, client, scope, canWrite } = props;
  const key = settingsScopeKeyV1(scope);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await reader.query(
        { contractVersion: 2, operation: 'customizations-read', scope, page: { limit: 100 } },
        signal,
      );
      if (
        result.state !== 'customizations-read' ||
        settingsScopeKeyV1(result.scope) !== key ||
        !result.context
      )
        throw new PortalClientErrorV1('invalid-response');
      return result;
    },
    [reader, key],
  );
  const read = useOperationalReadV1(load);
  const [reset, setReset] = useState<CustomizationResetChoiceV1[] | null>(null);
  const data = read.state.state === 'ready' ? read.state.data : null;
  const context = data?.context;
  const differences =
    context?.publications.filter(
      (item) =>
        item.customized ||
        (item.current.source?.kind === 'class' && item.current.revision !== item.school.revision),
    ) ?? [];
  const finish = () => {
    setReset(null);
    read.reload();
  };
  if (
    read.state.state === 'error' &&
    ['unauthenticated', 'forbidden'].includes(read.state.error.state)
  )
    return (
      <AccountsErrorV1 error={read.state.error} canReload={read.canReload} onReload={read.reload} />
    );
  return (
    <div className="grid min-w-0 gap-3">
      {read.state.state === 'error' ? (
        <AccountsErrorV1
          error={read.state.error}
          canReload={read.canReload}
          onReload={read.reload}
        />
      ) : null}
      {context?.resolved && (!props.embedded || differences.length > 0) ? (
        <div
          aria-label="Diferenças do padrão de publicação"
          className="grid gap-2 rounded-xl border border-separator p-3 text-sm"
        >
          {differences.length === 0 ? (
            <p className="text-muted">
              Sem diferença individual de publicação em relação ao padrão aplicável.
            </p>
          ) : (
            differences.map((item) => {
              const choice =
                scope.kind !== 'school'
                  ? publicationResetChoiceV1(scope, item, data!.publicationVersion)
                  : null;
              return (
                <div
                  key={item.period}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <strong>
                      {item.customized ? 'Publicação própria' : 'Publicação da turma'}
                    </strong>
                    <p>
                      {publicationDifferenceV1(
                        item,
                        item.customized ? scope : (item.current.source ?? scope),
                      )}
                    </p>
                    {item.customized && item.inherited.source?.kind === 'class' ? (
                      <p className="text-xs text-muted">
                        Ao voltar ao padrão, será aplicada a regra vigente da turma.
                      </p>
                    ) : null}
                  </div>
                  {choice && canWrite ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={read.refreshing}
                      onPress={() => setReset([choice])}
                    >
                      Voltar ao padrão
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
          <p className="text-xs text-muted">
            A visualização continua sujeita ao acesso, às datas e aos períodos permitidos.
          </p>
        </div>
      ) : null}
      {context && !context.resolved ? (
        <p role="status">Não foi possível resolver o padrão para este vínculo.</p>
      ) : null}
      <StudentPublicationV1 {...props} />
      {reset && data && canWrite ? (
        <CustomizationResetV1
          client={client}
          label={props.scopeLabel ?? 'Escopo selecionado'}
          choices={reset}
          canWrite={canWrite}
          onClose={finish}
          onCommitted={finish}
        />
      ) : null}
    </div>
  );
}
/** Reuses the original publication editor in every entry path. The school is the default,
 * not a customization target; individual/class comparisons are one scoped read, not N+1. */
export function PersonalizedPublicationV1(props: Props) {
  return props.scope.kind === 'school' ? (
    <StudentPublicationV1 {...props} />
  ) : (
    <ScopedPersonalizedPublicationV1
      key={settingsScopeKeyV1(props.scope) + ':' + props.canWrite}
      {...props}
    />
  );
}
