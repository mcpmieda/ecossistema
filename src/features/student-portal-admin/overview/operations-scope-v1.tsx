import { usePanelScopeV1 } from '../shared/panel-scope-v1';
import type { ReactNode } from 'react';
import { settingsScopeLabelV1 } from '../settings/settings-values-v1';
import type { OperationsPropsV1 } from './operations-values-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import './student-operations-v1.css';

/** The Painel do Aluno chooses the class (tabs on top); each view reads the scope it is given. */
export function OperationsScopeV1({
  children,
  ...props
}: OperationsPropsV1 & {
  children: (
    scope: ScopeV1,
    label: string,
    onAuthorizationLost: NonNullable<OperationsPropsV1['onAuthorizationLost']>,
  ) => ReactNode;
}) {
  const managed = usePanelScopeV1();
  return (
    <>
      {children(
        props.scope,
        props.scopeLabel ?? managed?.label ?? settingsScopeLabelV1(props.scope),
        props.onAuthorizationLost ?? (() => {}),
      )}
    </>
  );
}
