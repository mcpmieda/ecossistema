import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { PhotoAdminSubjectV1 } from '../../../shared/student-photos/admin-http-v1';
import {
  backfillAvatarsV1,
  type AvatarBackfillPortsV1,
  type AvatarBackfillSummaryV1,
} from './avatar-backfill-v1';
import { refreshPhotoMemoryV1 } from './photo-memory-v1';

type BackfillStateV1 =
  | { state: 'idle' }
  | { state: 'running' | 'done' | 'stopped'; summary: AvatarBackfillSummaryV1 | null }
  | { state: 'denied' };

/** Maintenance of saved photos. Shown only when the address asks for it; it reads and writes
 * through the same boundaries as a student's sheet, one operator and one explicit request. */
export function AvatarBackfillPanelV1({
  subjects,
  ready,
  ports,
}: Readonly<{
  subjects: readonly PhotoAdminSubjectV1[];
  ready: boolean;
  ports?: AvatarBackfillPortsV1;
}>) {
  const [run, setRun] = useState<BackfillStateV1>({ state: 'idle' });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const running = run.state === 'running';
  function start() {
    if (active.current || !ready) return;
    const controller = new AbortController();
    active.current = controller;
    setRun({ state: 'running', summary: null });
    void backfillAvatarsV1(subjects, {
      signal: controller.signal,
      ports,
      onProgress: (summary) => {
        if (!controller.signal.aborted) setRun({ state: 'running', summary });
      },
    })
      .then(
        (summary) => setRun({ state: 'done', summary }),
        () =>
          setRun((current) =>
            controller.signal.aborted
              ? { state: 'stopped', summary: 'summary' in current ? current.summary : null }
              : { state: 'denied' },
          ),
      )
      .finally(() => {
        active.current = null;
        // What is on screen now has its own small image.
        refreshPhotoMemoryV1();
      });
  }
  const summary = 'summary' in run ? run.summary : null;
  const open = summary ? summary.pending + summary.failed : 0;
  return (
    <section className="pa-account-notice" aria-label="Miniaturas das fotos">
      <h3 className="text-sm font-semibold">Miniaturas das fotos</h3>
      {running ? (
        <Button size="sm" variant="secondary" onPress={() => active.current?.abort()}>
          Interromper
        </Button>
      ) : (
        <Button size="sm" isDisabled={!ready || subjects.length === 0} onPress={start}>
          Gerar miniaturas que faltam
        </Button>
      )}
      {summary && (
        <p>
          <output className="contents">
            {`${summary.done} de ${summary.total} alunos · ${summary.created} criadas · ${summary.present} já existiam · ${summary['no-portrait']} sem foto`}
            {open > 0 ? ` · ${open} não concluídas` : ''}
          </output>
        </p>
      )}
      {run.state === 'done' && open > 0 && (
        <p>
          <output className="contents">
            Gere novamente para tentar as que não foram concluídas.
          </output>
        </p>
      )}
      {run.state === 'denied' && (
        <p role="alert">Sessão ou permissão indisponível. Entre novamente e gere outra vez.</p>
      )}
    </section>
  );
}
