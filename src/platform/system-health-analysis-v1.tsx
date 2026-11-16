import { useState } from 'react';
import { ClassTabsV1 } from '../shared/ui/class-tabs-v1';
import { SystemHealthHistoryPanelV1 } from './system-health-history-panel-v1';
import { SystemHealthSignalsPanelV1 } from './system-health-signals-panel-v1';
import { SystemHealthCapacityPanelV1 } from './system-health-capacity-panel-v1';
import { SystemHealthReviewPanelV1 } from './system-health-review-panel-v1';
import { SystemHealthProvidersPanelV1 } from './system-health-providers-panel-v1';
const tabs = [
  { id: 1, label: 'Resumo 24h' },
  { id: 2, label: 'Histórico' },
  { id: 3, label: 'Entrada e telas' },
  { id: 4, label: 'Banco e conexões' },
  { id: 5, label: 'Fornecedores' },
];
/** The selected area alone is mounted; changing tabs cancels any pending read. */
export function SystemHealthAnalysisV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  const [selected, setSelected] = useState(1);
  const panels = [
    SystemHealthReviewPanelV1,
    SystemHealthHistoryPanelV1,
    SystemHealthSignalsPanelV1,
    SystemHealthCapacityPanelV1,
    SystemHealthProvidersPanelV1,
  ];
  const Panel = panels[selected - 1]!;
  return (
    <section className="mt-5 min-w-0" aria-label="Análises do monitoramento">
      <ClassTabsV1
        label="Análises do monitoramento"
        items={tabs}
        selectedId={selected}
        onChange={(id) => {
          if (id !== null) setSelected(id);
        }}
      >
        <Panel key={selected} onDenied={onDenied} />
      </ClassTabsV1>
    </section>
  );
}
