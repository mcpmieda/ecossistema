import { usePanelScopeV1 } from '../shared/panel-scope-v1';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Label, ListBox, Select } from '@heroui/react';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import { ClassFilterV1 } from '../accounts/class-filter-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { accountPageMatchesV1 } from '../accounts/accounts-values-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { settingsScopeKeyV1, settingsScopeLabelV1 } from '../settings/settings-values-v1';
import {
  authorizationLostV1,
  useOperationalReadV1,
  type OperationsPropsV1,
} from './operations-values-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import './student-operations-v1.css';

/** Reuse the full BN class catalog and bounded V2 account reads; identity is never a name. */
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
  if (managed)
    return (
      <>
        {children(
          props.scope,
          props.scopeLabel ?? managed.label,
          props.onAuthorizationLost ?? (() => {}),
        )}
      </>
    );
  return (
    <ScopeBodyV1
      key={props.identityKey + settingsScopeKeyV1(props.scope) + props.canWrite}
      {...props}
    >
      {children}
    </ScopeBodyV1>
  );
}
function ScopeBodyV1({
  children,
  ...props
}: OperationsPropsV1 & {
  children: (
    scope: ScopeV1,
    label: string,
    onAuthorizationLost: NonNullable<OperationsPropsV1['onAuthorizationLost']>,
  ) => ReactNode;
}) {
  const [selectedClass, setClass] = useState<{ id: number; label: string } | null>(null);
  const [selectedAccount, setAccount] = useState<{ id: string; label: string } | null>(null);
  const [denied, setDenied] = useState<PortalClientErrorV1 | null>(null);
  const [paused, setPaused] = useState(false);
  const report = useCallback(
    (error: PortalClientErrorV1) => {
      setAccount(null);
      setClass(null);
      setDenied(error);
      props.onAuthorizationLost?.(error);
    },
    [props.onAuthorizationLost],
  );
  const safeCatalog = useCallback(
    async (offset: number, search: string, signal?: AbortSignal) => {
      if (!props.catalog) throw new PortalClientErrorV1('unavailable');
      try {
        return await props.catalog(offset, search, signal);
      } catch (error) {
        if (!signal?.aborted && error instanceof PortalClientErrorV1 && authorizationLostV1(error))
          report(error);
        throw error;
      }
    },
    [props.catalog, report],
  );
  useEffect(() => {
    const clear = () => {
      setAccount(null);
      setClass(null);
      setPaused(true);
    };
    const resume = () => setPaused(false);
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', resume);
    return () => {
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', resume);
    };
  }, []);
  const scope: ScopeV1 =
    props.scope.kind === 'school' && selectedClass
      ? { kind: 'class', academicYear: 2026, classId: selectedClass.id }
      : props.scope;
  const label = selectedClass?.label || props.scopeLabel || settingsScopeLabelV1(scope);
  const effective: ScopeV1 = selectedAccount
    ? { kind: 'account', academicYear: 2026, accountId: selectedAccount.id }
    : scope;
  if (denied) return <AccountsErrorV1 error={denied} onReload={() => setDenied(null)} />;
  if (paused)
    return (
      <Button variant="secondary" onPress={() => setPaused(false)}>
        Retomar consulta
      </Button>
    );
  return (
    <section className="pa-operations">
      <div className="pa-context-controls">
        {props.scope.kind === 'school' && props.catalog && (
          <ClassFilterV1
            catalog={safeCatalog}
            selected={selectedClass}
            onChange={(value) => {
              if (!allowDraftNavigationV1()) return;
              setClass(value);
              setAccount(null);
            }}
          />
        )}
        {scope.kind === 'class' && (
          <AccountScopeV1
            key={settingsScopeKeyV1(scope)}
            {...props}
            onAuthorizationLost={report}
            scope={scope}
            selected={selectedAccount}
            onChange={setAccount}
          />
        )}
      </div>
      {children(effective, selectedAccount?.label || label, report)}
    </section>
  );
}
function AccountScopeV1({
  selected,
  onChange,
  ...props
}: OperationsPropsV1 & {
  selected: { id: string; label: string } | null;
  onChange: (value: { id: string; label: string } | null) => void;
}) {
  const scopeKey = settingsScopeKeyV1(props.scope);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const scope = props.scope;
      const rows: { id: string; label: string }[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        signal.throwIfAborted();
        const result = await props.reader.query(
          {
            contractVersion: 2,
            operation: 'accounts-read',
            scope,
            page: { limit: 100, ...(cursor ? { cursor } : {}) },
          },
          signal,
        );
        if (result.state !== 'accounts-read' || !accountPageMatchesV1(result, scope))
          throw new PortalClientErrorV1('invalid-response');
        for (const item of result.items) {
          if (seen.has(item.accountId)) throw new PortalClientErrorV1('invalid-response');
          seen.add(item.accountId);
          rows.push({ id: item.accountId, label: item.name || 'Nome indisponível' });
        }
        if (!result.nextCursor) return rows;
        if (cursors.has(result.nextCursor)) throw new PortalClientErrorV1('invalid-response');
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new PortalClientErrorV1('unavailable');
      // scopeKey captures the complete validated scope identity.
    },
    [props.reader, scopeKey],
  );
  const read = useOperationalReadV1(load, props.onAuthorizationLost);
  const rows = read.state.state === 'ready' ? read.state.data : [];
  const options = [
    ...new Map([...(selected ? [selected] : []), ...rows].map((a) => [a.id, a])).values(),
  ];
  return (
    <div className="pa-operations-filters">
      <Select
        selectedKey={selected?.id || 'all'}
        onSelectionChange={(key) => {
          if (allowDraftNavigationV1())
            onChange(key === 'all' ? null : options.find((a) => a.id === key) || null);
        }}
      >
        <Label>Aluno</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            <ListBox.Item id="all" textValue="Todos da turma">
              Todos da turma
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {options.map((a) => (
              <ListBox.Item id={a.id} key={a.id} textValue={a.label}>
                {a.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      {read.state.state === 'error' && (
        <AccountsErrorV1
          error={read.state.error}
          canReload={read.canReload}
          onReload={read.reload}
        />
      )}
      {read.state.state === 'loading' && (
        <p>
          <output className="contents">Consultando alunos…</output>
        </p>
      )}
      {read.state.state === 'ready' && rows.length === 0 && <p>Nenhum aluno encontrado.</p>}
    </div>
  );
}
