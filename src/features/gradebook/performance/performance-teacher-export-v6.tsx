import { useState } from 'react';
import { Alert, Button } from '@heroui/react';
import { FileDown } from 'lucide-react';
import type { PerformanceAnalyticsV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';

/** Exports the analytical snapshot selected in Desempenho. */
export function PerformanceTeacherExportV6({
  value,
  teacherId,
}: Readonly<{
  value: PerformanceAnalyticsV6;
  teacherId: number;
}>) {
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  async function download(detailed: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const { downloadPerformanceTeacherReportV6 } = await import('./performance-analytics-pdf-v6');
      await downloadPerformanceTeacherReportV6(value, teacherId, detailed);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          isDisabled={busy}
          onPress={() => void download(false)}
        >
          <FileDown size={16} />
          PDF resumido
        </Button>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void download(true)}>
          PDF detalhado
        </Button>
      </div>
      {failed ? (
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>Não foi possível gerar o relatório.</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
    </div>
  );
}
