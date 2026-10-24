import { useState } from 'react';
import { Tabs } from '@heroui/react';
import { StudentAuditV1 } from './student-audit-v1';
import { PersonalizedPublicationV1 } from '../publication/personalized-publication-v1';
import type { OperationsPropsV1 } from '../overview/operations-values-v1';
export function AuditWorkspaceV1(props: Readonly<OperationsPropsV1>) {
  const [area, setArea] = useState('publications');
  return (
    <section aria-label="Publicações e auditoria" className="grid min-w-0 gap-3">
      <Tabs selectedKey={area} onSelectionChange={(key) => setArea(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Consultar auditoria">
            <Tabs.Tab id="publications">
              Notas publicadas
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="events">
              Eventos
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="publications">
          <PersonalizedPublicationV1
            client={props.client}
            reader={props.reader}
            scope={props.scope}
            scopeLabel={props.scopeLabel}
            canWrite={false}
          />
        </Tabs.Panel>
        <Tabs.Panel id="events">
          <StudentAuditV1 {...props} />
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
