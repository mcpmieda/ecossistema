import { usePanelScopeV1 } from '../shared/panel-scope-v1';
import { ClassTabsV1 } from '../../../shared/ui/class-tabs-v1';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import { useCallback } from 'react';
import type { PortalClassCatalogV2, ClassCatalogPageV2 } from './accounts-client-v2';
import { useAccountsReadV1 } from './accounts-read-v1';
import { AccountsErrorV1 } from './accounts-presentation-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';

/** Complete, bounded catalog. Repeated cursors and silent truncation are rejected. */
export async function readClassOptionsV1(catalog: PortalClassCatalogV2, signal: AbortSignal) {
  const items: ClassCatalogPageV2['items'] = [],
    seen = new Set<number>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    const result = await catalog(offset, '', signal);
    for (const item of result.items) {
      if (seen.has(item.id)) throw new PortalClientErrorV1('invalid-response');
      seen.add(item.id);
      items.push(item);
    }
    if (result.nextOffset === null) return items;
    if (result.nextOffset <= offset || !Number.isSafeInteger(result.nextOffset))
      throw new PortalClientErrorV1('invalid-response');
    offset = result.nextOffset;
  }
  throw new PortalClientErrorV1('unavailable');
}

function LocalClassTabsV1({
  catalog,
  selected,
  onChange,
  disabled = false,
  allLabel = 'Todas as turmas',
}: Readonly<{
  catalog: PortalClassCatalogV2;
  disabled?: boolean;
  allLabel?: string;
  selected: { id: number; label: string } | null;
  onChange: (item: { id: number; label: string } | null) => void;
}>) {
  const load = useCallback((signal: AbortSignal) => readClassOptionsV1(catalog, signal), [catalog]);
  const read = useAccountsReadV1(load);
  const data = read.state.state === 'ready' ? read.state.data : [];
  const items =
    selected && !data.some((item) => item.id === selected.id) ? [selected, ...data] : data;
  return (
    <div className="pa-account-class-filter">
      <ClassTabsV1
        items={items}
        selectedId={selected?.id ?? null}
        allLabel={allLabel}
        disabled={disabled}
        onChange={(id) => {
          if (allowDraftNavigationV1()) onChange(items.find((item) => item.id === id) ?? null);
        }}
      />
      {read.state.state === 'error' ? (
        <AccountsErrorV1
          error={read.state.error}
          canReload={read.canReload}
          onReload={read.reload}
        />
      ) : null}
      {read.state.state === 'loading' || read.state.state === 'idle' ? (
        <span role="status" className="text-xs text-muted">
          Carregando turmas…
        </span>
      ) : null}
    </div>
  );
}

export function ClassFilterV1(props: Parameters<typeof LocalClassTabsV1>[0]) {
  const managed = usePanelScopeV1();
  return managed ? null : <LocalClassTabsV1 {...props} />;
}
