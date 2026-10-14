import type { ReactNode } from 'react';
import { Alert, Card, Spinner } from '@heroui/react';
import type { PlatformSnapshotV2 } from '../../shared/platform-snapshot-v2';
import type { PlatformAuxiliaryStateV2 } from './platform-data-v2';

/** Only the external block waits for Microsoft. Native settings remain mounted. */
export function MicrosoftSettingsSectionV1({
  title,
  section,
  snapshot,
  auxiliary,
  children,
}: {
  readonly title: string;
  readonly section: 'configurations' | 'migrations';
  readonly snapshot: PlatformSnapshotV2;
  readonly auxiliary: PlatformAuxiliaryStateV2;
  readonly children: ReactNode;
}) {
  const loading = auxiliary === 'loading';
  const unavailable =
    auxiliary === 'error' ||
    snapshot.unavailableSections?.some((item) => item === 'lists' || item === section);
  if (!loading && !unavailable) return children;
  return (
    <Card variant="default" className="mt-5 overflow-hidden">
      <Card.Header className="border-b border-border/60">
        <Card.Title>{title}</Card.Title>
      </Card.Header>
      <Card.Content className="p-5 sm:p-6">
        {loading ? (
          <output className="flex items-center gap-3 text-sm text-muted">
            <Spinner size="sm" />
            Consultando informações Microsoft…
          </output>
        ) : (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Informações Microsoft temporariamente indisponíveis</Alert.Title>
              <Alert.Description>
                Não foi possível confirmar os registros deste bloco. O ano letivo e os demais
                controles independentes continuam disponíveis. A consulta será refeita
                automaticamente.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Card.Content>
    </Card>
  );
}
