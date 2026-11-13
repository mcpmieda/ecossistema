import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Chip, Spinner, Surface, Tabs } from '@heroui/react';
import { FileSpreadsheet, ShieldAlert } from 'lucide-react';
import type { GradebookImportDiagnosticsAuditRecordV1 } from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { listGradebookImportDiagnosticsAuditV1 } from '../import/import-diagnostics-client-v1';

type LoadState = 'loading' | 'ready' | 'empty' | 'not-authorized' | 'unavailable';
type Finding = GradebookImportDiagnosticsAuditRecordV1;

/** One page of the API; the screen reads every page so each tab shows its real count. */
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
/** Rows drawn per tab before "Mostrar mais". */
const ROWS_STEP = 100;

/** Tab name and the one line that says how the teacher fixes it. Unknown codes fall back to their message. */
const PROBLEMS: Readonly<Record<string, readonly [label: string, hint: string]>> = {
  'wrong-year': ['Ano errado', 'Planilha com outro ano em CONFIGURAÇÃO. Nada foi lançado.'],
  'header-mismatch': ['Cabeçalho trocado', 'O cabeçalho da guia não bate com o nome da guia. A turma não foi lançada.'],
  'student-name-mismatch': ['Aluno trocado', 'O nome na planilha não bate com a Relação. As notas do aluno não foram lançadas.'],
  'activity-without-description': ['Atividade sem descrição', 'Notas numa coluna sem descrição. A coluna não foi lançada.'],
  'activity-without-maximum': ['Atividade sem máximo', 'Notas numa coluna sem máximo. A coluna não foi lançada.'],
  'above-maximum': ['Nota acima do máximo', 'A nota e o resultado do aluno não foram lançados.'],
  'qualitative-maxima-over-ceiling': ['Máximos acima do qualitativo', 'A soma dos máximos passa do qualitativo. Os resultados não foram lançados.'],
  'qualitative-over-ceiling': ['Qualitativo estourado', 'A soma das atividades do aluno passa do qualitativo. O resultado não foi lançado.'],
  'recovery-above-maximum': ['Recuperação acima do máximo', 'A recuperação e o resultado final não foram lançados.'],
  'work-without-weight': ['Trabalho sem peso', 'Nota de trabalho com o bloco desligado. O resultado não foi lançado.'],
  'one-assessment-mode': ['AV2 em modo 1 avaliação', 'Nota na AV2 com a guia em 1 avaliação. O resultado não foi lançado.'],
  'manual-term-result': ['Média digitada', 'Média digitada à mão no lugar da fórmula. Não foi lançada.'],
  'invalid-text': ['Texto no lugar de nota', 'A nota e o resultado do aluno não foram lançados.'],
  'negative-grade': ['Nota negativa', 'A nota e o resultado do aluno não foram lançados.'],
  'invalid-precision': ['Casas decimais', 'A nota e o resultado do aluno não foram lançados.'],
  'invalid-maximum': ['Máximo inválido', 'O máximo da atividade está vazio ou errado.'],
  'duplicate-student-number': ['Número repetido', 'Dois alunos com o mesmo número na guia.'],
  'grade-without-student': ['Nota sem aluno', 'Nota numa linha sem aluno. Só aviso.'],
  'source-unavailable': ['Valor indisponível', 'A planilha não guardou o valor. O anterior foi mantido.'],
};

function problem(code: string): readonly [string, string | null] {
  return PROBLEMS[code] ?? [code, null];
}

function where(value: Finding): string {
  const student =
    value.studentNumber === undefined
      ? null
      : `${value.studentNumber}. ${value.studentName ?? 'Aluno não identificado'}`;
  return [value.classCode, value.subject, value.period, student, value.fieldLabel]
    .filter(Boolean)
    .join(' · ');
}

function teacher(fileName: string): string {
  return fileName.replace(/\.(xlsb|xlsx|xlsm|xls)$/iu, '');
}

interface ProblemTab {
  readonly code: string;
  readonly label: string;
  readonly hint: string | null;
  readonly blocking: boolean;
  readonly items: readonly Finding[];
}

/** Blocking problems first, then the larger groups. */
function groupByProblem(items: readonly Finding[]): readonly ProblemTab[] {
  const groups = new Map<string, Finding[]>();
  for (const item of items) {
    const list = groups.get(item.code);
    if (list) list.push(item);
    else groups.set(item.code, [item]);
  }
  return [...groups.entries()]
    .map(([code, list]) => {
      const [label, hint] = problem(code);
      const sorted = [...list].sort(
        (left, right) =>
          left.fileName.localeCompare(right.fileName, 'pt-BR') ||
          where(left).localeCompare(where(right), 'pt-BR', { numeric: true }),
      );
      return {
        code,
        label,
        hint: hint ?? list[0]?.message ?? null,
        blocking: list.some((item) => item.severity === 'blocking-error'),
        items: sorted,
      };
    })
    .sort(
      (left, right) =>
        Number(right.blocking) - Number(left.blocking) || right.items.length - left.items.length,
    );
}

function StateAlert({ state, year }: { readonly state: 'empty' | 'not-authorized' | 'unavailable'; readonly year: number | null }) {
  const [status, title, text] =
    state === 'not-authorized'
      ? (['warning', 'Acesso não autorizado', 'Sua sessão não pode consultar a Auditoria.'] as const)
      : state === 'unavailable'
        ? (['danger', 'Auditoria indisponível', 'Não foi possível ler os problemas agora.'] as const)
        : (['success', 'Nenhum problema', `As planilhas de ${year ?? 'este ano'} estão sem pendências.`] as const);
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{text}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

function ProblemList({ tab }: { readonly tab: ProblemTab }) {
  const [shown, setShown] = useState(ROWS_STEP);
  const visible = tab.items.slice(0, shown);
  let lastFile: string | null = null;
  return (
    <div className="grid gap-3">
      {tab.hint && <p className="text-sm text-muted">{tab.hint}</p>}
      <Surface variant="secondary" className="overflow-hidden rounded-2xl border border-border/60">
        <ul className="divide-y divide-border/60">
          {visible.map((item) => {
            const header = item.fileName !== lastFile;
            lastFile = item.fileName;
            return (
              <li key={item.id}>
                {header && (
                  <p className="flex items-center gap-2 bg-surface px-4 pb-1.5 pt-3 text-xs font-semibold text-muted">
                    <FileSpreadsheet className="size-3.5 shrink-0" />
                    <span className="truncate">{teacher(item.fileName)}</span>
                  </p>
                )}
                <div className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${item.severity === 'blocking-error' ? 'bg-danger' : 'bg-warning'}`}
                  />
                  <span className="min-w-0 flex-1 break-words">{where(item) || item.message}</span>
                  {item.foundValue && (
                    <span className="shrink-0 rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-muted">
                      {item.foundValue}
                    </span>
                  )}
                  {(item.sheetName || item.cellAddress) && (
                    <span className="hidden shrink-0 text-xs text-muted sm:inline">
                      {[item.sheetName, item.cellAddress].filter(Boolean).join('!')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Surface>
      {tab.items.length > shown && (
        <div className="flex justify-center">
          <Button size="sm" variant="secondary" onPress={() => setShown((value) => value + ROWS_STEP)}>
            Mostrar mais ({tab.items.length - shown})
          </Button>
        </div>
      )}
    </div>
  );
}

const aborted = (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError';

/**
 * The current problems of the year's spreadsheets, one tab per problem. Read only: the teacher
 * fixes the spreadsheet and the next import (automatic or manual) clears the problem.
 */
export function RelationalCurrentAuditPageV2() {
  const year = useGradebookYear()?.year ?? null;
  const [state, setState] = useState<LoadState>('loading');
  const [items, setItems] = useState<readonly Finding[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (background = false) => {
      requestRef.current?.abort();
      if (year === null) {
        setState('loading');
        return;
      }
      const controller = new AbortController();
      requestRef.current = controller;
      if (!background) setState('loading');
      const fail = () => {
        if (background) setStale(true);
        else setState('unavailable');
        return false;
      };
      try {
        const all: Finding[] = [];
        let offset: number | null = 0;
        let pages = 0;
        while (offset !== null && pages < MAX_PAGES) {
          const response = await listGradebookImportDiagnosticsAuditV1(
            { academicYear: year, limit: PAGE_SIZE, offset },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (response.state === 'not-authorized') {
            setItems([]);
            setState('not-authorized');
            return false;
          }
          if (response.state !== 'ready') return fail();
          all.push(...response.items);
          offset = response.nextOffset;
          pages += 1;
        }
        setItems(all);
        setTruncated(offset !== null);
        setState(all.length === 0 ? 'empty' : 'ready');
        setStale(false);
        return true;
      } catch (cause) {
        if (!aborted(cause)) return fail();
      }
    },
    [year],
  );

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  useLiveRefreshV1(() => load(true), {
    domains: ['gradebook'],
    enabled: year !== null,
    canRefresh: () => state !== 'loading',
  });

  const tabs = useMemo(() => groupByProblem(items), [items]);
  const active = tabs.find((tab) => tab.code === selected) ?? tabs[0] ?? null;
  const blocking = items.filter((item) => item.severity === 'blocking-error').length;
  const files = new Set(items.map((item) => item.fileName)).size;

  return (
    <div className="grid min-w-0 gap-5" aria-busy={state === 'loading'}>
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
            <ShieldAlert className="size-4" /> Auditoria
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">Problemas nas planilhas</h2>
        </div>
        {state === 'ready' && (
          <>
            <Chip size="lg" color="danger" variant="soft">
              {blocking} não lançado(s)
            </Chip>
            {items.length > blocking && (
              <Chip size="lg" color="warning" variant="soft">
                {items.length - blocking} aviso(s)
              </Chip>
            )}
            <Chip size="lg" variant="soft">
              {files} planilha(s)
            </Chip>
          </>
        )}
        <Chip size="lg" variant="soft">
          Ano letivo {year ?? '—'}
        </Chip>
      </header>

      {state === 'loading' && (
        <output className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted">
          <Spinner size="sm" /> Lendo problemas…
        </output>
      )}
      {(state === 'empty' || state === 'not-authorized' || state === 'unavailable') && (
        <StateAlert state={state} year={year} />
      )}
      <LiveReadNoticeV1 failed={stale} />

      {state === 'ready' && active && (
        <>
          <Tabs
            className="min-w-0"
            selectedKey={active.code}
            onSelectionChange={(key) => setSelected(String(key))}
          >
            <Tabs.ListContainer className="min-w-0">
              <Tabs.List aria-label="Tipos de problema" className="h-auto w-full flex-wrap justify-start">
                {tabs.map((tab) => (
                  <Tabs.Tab key={tab.code} id={tab.code} className="w-auto gap-1.5 whitespace-nowrap">
                    <span
                      aria-hidden="true"
                      className={`size-2 rounded-full ${tab.blocking ? 'bg-danger' : 'bg-warning'}`}
                    />
                    {tab.label}
                    <span className="rounded-full bg-default px-1.5 text-xs font-semibold tabular-nums">
                      {tab.items.length}
                    </span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            {tabs.map((tab) => (
              <Tabs.Panel key={tab.code} id={tab.code} className="pt-4">
                <ProblemList key={tab.code} tab={tab} />
              </Tabs.Panel>
            ))}
          </Tabs>
          <p className="text-xs text-muted">
            Corrija na planilha: a próxima importação tira o problema da lista.
            {truncated && ' Mostrando os primeiros 5.000 problemas.'}
          </p>
        </>
      )}
    </div>
  );
}
