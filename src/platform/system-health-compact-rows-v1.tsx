import { useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
const HEALTH_VISIBLE_ROWS_V1 = 6;
/** Page only the bounded response already in memory; never fetch or recompute chronology. */
export function HealthCompactRowsV1<T>({ rows, label, children }: Readonly<{
  rows: readonly T[]; label: string; children: (visible: readonly T[]) => ReactNode;
}>) {
  const [selected, setSelected] = useState(0);
  const last = Math.max(0, Math.ceil(rows.length / HEALTH_VISIBLE_ROWS_V1) - 1), page = Math.min(selected, last);
  const start = page * HEALTH_VISIBLE_ROWS_V1;
  if (!rows.length) return <p className="px-4 py-3 text-sm text-muted">Nenhum registro corresponde ao filtro nesta consulta.</p>;
  return <>{children(rows.slice(start, start + HEALTH_VISIBLE_ROWS_V1))}
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <p className="text-xs text-muted">{start + 1}–{Math.min(rows.length, start + HEALTH_VISIBLE_ROWS_V1)} de {rows.length} nesta consulta</p>
      {last > 0 ? <div className="flex gap-2"><Button size="sm" variant="secondary" isDisabled={page === 0} onPress={() => setSelected(page - 1)}>Página anterior</Button>
        <Button size="sm" variant="secondary" isDisabled={page === last} onPress={() => setSelected(page + 1)}>Próxima página</Button></div> : null}
    </nav>
  </>;
}
