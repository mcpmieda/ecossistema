import { useDraftNavigationGuardV1 } from '../../../shared/forms/draft-navigation-v1';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Input, Label, Skeleton, TextField, Tooltip } from '@heroui/react';
import { Info } from 'lucide-react';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { useLiveRefreshV1 } from '../../../shared/live-data/use-live-refresh-v1';
import { notifyLiveChangeV1 } from '../../../shared/live-data/live-refresh-v1';
import {
  createAssessmentNamesEditorV1,
  emptyAssessmentNamesEditorV1,
} from './assessment-names-editor-v1';

const messages = {
  'invalid-request': 'Use nomes de até 80 caracteres.',
  'not-authorized': 'Sessão sem autorização.',
  'not-found': 'Ano não encontrado.',
  conflict: 'Os nomes foram alterados em outra sessão.',
  unavailable: 'Não foi possível salvar. O que você digitou foi mantido.',
};
/** Red on a failure, amber while there is something to save, green when saved. */
function statusColor(state: { failure: unknown; dirty: boolean; phase: string }) {
  if (state.failure) return 'danger';
  return state.dirty || state.phase === 'saving' ? 'warning' : 'success';
}

export function AssessmentNamesV1({ isActive = true }: Readonly<{ isActive?: boolean }>) {
  const scope = useGradebookYear();
  if (!scope?.year) return null;
  return (
    <NamesEditorV1
      key={`${scope.epoch}:${scope.year}`}
      year={scope.year}
      isActive={isActive}
      onAuthorizationLost={scope.clearAuthorization}
    />
  );
}
function NamesEditorV1({
  year,
  isActive,
  onAuthorizationLost,
}: Readonly<{
  year: number;
  isActive: boolean;
  onAuthorizationLost: () => void;
}>) {
  const [state, setState] = useState(emptyAssessmentNamesEditorV1);
  useDraftNavigationGuardV1(state.dirty || state.phase === 'saving');
  const editor = useRef<ReturnType<typeof createAssessmentNamesEditorV1> | null>(null);
  const auth = useRef(onAuthorizationLost);
  useEffect(() => {
    auth.current = onAuthorizationLost;
  }, [onAuthorizationLost]);
  useEffect(() => {
    const current = createAssessmentNamesEditorV1({
      year,
      publish: setState,
      onAuthorizationLost: () => auth.current(),
      onChanged: () => {
        notifyLiveChangeV1('gradebook');
        notifyLiveChangeV1('portal');
      },
    });
    editor.current = current;
    return () => {
      current.dispose();
      editor.current = null;
    };
  }, [year]);
  useEffect(() => {
    if (isActive) void editor.current?.load();
  }, [isActive, year]);
  useLiveRefreshV1(() => editor.current?.refresh(), {
    enabled: isActive,
    domains: ['gradebook'],
    canRefresh: () => editor.current?.canRefresh() ?? false,
  });
  let label: 'Salvando…' | 'Não salvo' | 'Editando' | 'Salvo';
  if (state.phase === 'saving') {
    label = 'Salvando…';
  } else if (state.failure) {
    label = 'Não salvo';
  } else if (state.dirty) {
    label = 'Editando';
  } else {
    label = 'Salvo';
  }
  return (
    <Card aria-label="Nomear avaliações">
      <Card.Header className="flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Card.Title>Nomear avaliações</Card.Title>
          <Tooltip>
            <Tooltip.Trigger aria-label="Sobre os nomes das avaliações" className="text-muted">
              <Info size={15} />
            </Tooltip.Trigger>
            <Tooltip.Content>
              Os nomes valem para todas as turmas de {year}. Deixe vazio para usar o nome padrão.
            </Tooltip.Content>
          </Tooltip>
        </div>
        {state.base ? (
          <Chip size="sm" color={statusColor(state)} variant="soft">
            <Chip.Label aria-live="polite">{label}</Chip.Label>
          </Chip>
        ) : null}
      </Card.Header>
      <Card.Content>
        {!state.base && state.failure ? <p role="alert">{messages[state.failure]}</p> : null}
        {!state.base && !state.failure ? <Skeleton className="h-28 rounded-xl" /> : null}
        {state.base ? (
          <div className="grid gap-4 md:grid-cols-3">
            {([1, 2, 3] as const).map((term) => (
              <fieldset className="min-w-0" key={term}>
                <legend className="mb-2 text-sm font-semibold">{term}º trimestre</legend>
                <div className="grid gap-2">
                  {([1, 2] as const).map((slot) => {
                    const key = `${term}:${slot}` as const;
                    return (
                      <TextField
                        key={key}
                        value={state.draft[key] ?? ''}
                        onChange={(value) => editor.current?.edit(key, value)}
                      >
                        <Label className="text-xs text-muted">
                          <span aria-hidden="true">Avaliação {slot}</span>
                          <span className="sr-only">{`Avaliação ${slot} do ${term}º trimestre`}</span>
                        </Label>
                        <Input
                          maxLength={80}
                          onBlur={() => {
                            void editor.current?.save();
                          }}
                          placeholder={slot === 1 ? 'Avaliação 1' : 'Avaliação 2'}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void editor.current?.save();
                            }
                          }}
                        />
                      </TextField>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        ) : null}
        {state.failure ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {state.base ? <span className="text-danger">{messages[state.failure]}</span> : null}
            {state.failure !== 'not-authorized' ? (
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  void (state.failure === 'conflict' || !state.base
                    ? editor.current?.reload()
                    : editor.current?.save());
                }}
              >
                {state.failure === 'conflict' ? 'Usar versão salva' : 'Tentar novamente'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}
