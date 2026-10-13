import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Input,
  Label,
  Spinner,
  Surface,
  TextField,
} from '@heroui/react';
import { CheckCircle2, Database, RefreshCcw, ShieldAlert } from 'lucide-react';
import type { YearResetResponseV1 } from '../../../../shared/gradebook-contracts/settings/year-reset-contract-v1';
import { useGradebookYear } from '../../../platform/gradebook-year-context';
import { AssessmentNamesV1 } from './assessment-names-v1';
import { requestYearResetV1 } from './year-reset-client-v1';

type Preview = Extract<YearResetResponseV1, { state: 'ready'; operation: 'preview' }>;

const COUNT_ITEMS = [
  ['students', 'Alunos'],
  ['classes', 'Turmas'],
  ['teachers', 'Professores'],
  ['subjects', 'Disciplinas'],
  ['bindings', 'Vínculos'],
  ['offers', 'Ofertas'],
  ['assessments', 'Instrumentos'],
  ['grades', 'Notas'],
  ['closures', 'Fechamentos'],
  ['imports', 'Importações'],
  ['diagnostics', 'Diagnósticos atuais'],
  ['auditTrail', 'Trilha de auditoria'],
  ['council', 'Registros de Conselho'],
  ['bulletins', 'Boletins emitidos'],
  ['histories', 'Demais históricos'],
  ['reconciliation', 'Conciliação e relatórios cadastrais'],
] as const;

function failureMessage(state: Exclude<YearResetResponseV1['state'], 'ready'>): string {
  if (state === 'not-authorized') return 'Sua sessão não possui autorização para esta operação.';
  if (state === 'not-found') return 'Não há dados desse ano para resetar.';
  if (state === 'portal-linked-accounts') {
    return 'Existem contas do Portal vinculadas a este ano. Encerre os vínculos nas Configurações do Portal e gere uma nova prévia antes de resetar.';
  }
  if (state === 'preview-changed') {
    return 'Os dados mudaram depois da prévia. Gere uma nova conferência antes de continuar.';
  }
  if (state === 'invalid-request') return 'A confirmação não corresponde ao ano selecionado.';
  return 'Não foi possível concluir a operação com segurança. Nenhum reset foi confirmado.';
}

export function GradebookSettingsPageV1({ isActive = true }: { isActive?: boolean } = {}) {
  const scope = useGradebookYear();
  const year = scope?.year ?? (scope && !scope.loading && !scope.failure ? 2026 : null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'execute' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{ year: number; deletedRows: number } | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    setPreview(null);
    setConfirmation('');
    setUnderstood(false);
    setMessage(null);
    setBusy(null);
  }, [year]);

  async function prepareReset() {
    if (year === null) return;
    const ticket = ++sequence.current;
    setBusy('preview');
    setMessage(null);
    setCompleted(null);
    const response = await requestYearResetV1({ contractVersion: 1, operation: 'preview', year });
    if (ticket !== sequence.current) return;
    setBusy(null);
    if (response.state !== 'ready' || response.operation !== 'preview') {
      setPreview(null);
      setMessage(failureMessage(response.state === 'ready' ? 'unavailable' : response.state));
      return;
    }
    setPreview(response);
    setConfirmation('');
    setUnderstood(false);
  }

  async function executeReset() {
    if (
      year === null ||
      preview === null ||
      preview.year !== year ||
      confirmation !== preview.confirmationPhrase ||
      !understood
    ) {
      return;
    }
    const ticket = ++sequence.current;
    setBusy('execute');
    setMessage(null);
    const response = await requestYearResetV1({
      contractVersion: 1,
      operation: 'execute',
      year,
      previewRevision: preview.previewRevision,
      confirmationPhrase: confirmation,
      understandsIrreversible: true,
    });
    if (ticket !== sequence.current) return;
    if (response.state !== 'ready' || response.operation !== 'execute') {
      setBusy(null);
      setMessage(failureMessage(response.state === 'ready' ? 'unavailable' : response.state));
      if (
        response.state === 'preview-changed' ||
        response.state === 'not-found' ||
        response.state === 'portal-linked-accounts'
      ) {
        setPreview(null);
        setConfirmation('');
        setUnderstood(false);
      }
      return;
    }
    setPreview(null);
    setConfirmation('');
    setUnderstood(false);
    setCompleted({ year: response.year, deletedRows: response.deletedRows });
    await scope?.refreshYears();
    if (ticket === sequence.current) setBusy(null);
  }

  if (!scope) return null;

  return (
    <div className="grid gap-4">
      <AssessmentNamesV1 isActive={isActive} />
      <Surface className="overflow-hidden rounded-2xl border border-danger/25 bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-danger/20 bg-danger/5 p-5">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
              <ShieldAlert className="size-5" aria-hidden="true" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">Resetar o sistema</h3>
                <Chip size="sm" color="danger" variant="soft">
                  <Chip.Label>Zona crítica</Chip.Label>
                </Chip>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted">
                Limpa por completo um único ano letivo para que ele seja lançado novamente pelas
                planilhas. Estrutura, regras e outros anos permanecem intactos.
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface px-4 py-2 text-right">
            <span className="block text-xs text-muted">Ano global selecionado</span>
            <strong className="text-lg tabular-nums">{year ?? 'Nenhum'}</strong>
          </div>
        </div>

        <div className="grid gap-4 p-5">
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Esta ação não possui desfazer automático</Alert.Title>
              <Alert.Description>
                Ainda não há backup gerenciado. A prévia precisa ser refeita se qualquer dado mudar
                antes da confirmação.
              </Alert.Description>
            </Alert.Content>
          </Alert>

          {year === null ? (
            <div className="rounded-xl border border-dashed border-border p-5 text-sm text-muted">
              Nenhum ano está materializado. Importe primeiro uma planilha de Relação para iniciar
              um novo ano letivo.
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="danger-soft"
                isDisabled={busy !== null}
                isPending={busy === 'preview'}
                onPress={() => void prepareReset()}
              >
                {busy !== 'preview' ? <Database className="size-4" aria-hidden="true" /> : null}
                Conferir dados de {year}
              </Button>
              <p className="text-xs text-muted">
                A conferência não altera os dados acadêmicos e vale por cinco minutos.
              </p>
            </div>
          )}

          {preview ? (
            <div className="grid gap-4 rounded-2xl border border-danger/25 bg-danger/3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="font-semibold">Prévia do reset de {preview.year}</h4>
                  <p className="text-xs text-muted">
                    {preview.counts.totalRows.toLocaleString('pt-BR')} registros serão removidos.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={busy !== null}
                  onPress={() => void prepareReset()}
                >
                  <RefreshCcw className="size-4" aria-hidden="true" />
                  Atualizar prévia
                </Button>
              </div>

              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {COUNT_ITEMS.map(([key, label]) => (
                  <div key={key} className="rounded-xl border border-border/70 bg-surface p-3">
                    <dt className="text-[0.7rem] text-muted">{label}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {preview.counts[key].toLocaleString('pt-BR')}
                    </dd>
                  </div>
                ))}
              </dl>

              <TextField fullWidth>
                <Label className="text-sm font-medium">
                  Digite <strong>{preview.confirmationPhrase}</strong> para confirmar
                </Label>
                <Input
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={preview.confirmationPhrase}
                />
              </TextField>

              <Checkbox isSelected={understood} onChange={setUnderstood}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>Entendo que todos os dados e históricos deste ano serão removidos.</Label>
                </Checkbox.Content>
              </Checkbox>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-danger/20 pt-4">
                <span className="text-xs text-muted">
                  O ano sairá do seletor e só voltará com uma nova importação da Relação.
                </span>
                <Button
                  variant="danger"
                  isDisabled={
                    busy !== null || !understood || confirmation !== preview.confirmationPhrase
                  }
                  isPending={busy === 'execute'}
                  onPress={() => void executeReset()}
                >
                  {busy !== 'execute' ? (
                    <ShieldAlert className="size-4" aria-hidden="true" />
                  ) : null}
                  Resetar {preview.year}
                </Button>
              </div>
            </div>
          ) : null}

          {busy === 'execute' ? (
            <p className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
              <Spinner size="sm" /> Executando transação protegida…
            </p>
          ) : null}
          {message ? (
            <Alert status="danger" role="alert">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Reset não concluído</Alert.Title>
                <Alert.Description>{message}</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
          {completed ? (
            <Alert status="success" role="status">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              <Alert.Content>
                <Alert.Title>Ano {completed.year} limpo</Alert.Title>
                <Alert.Description>
                  {completed.deletedRows.toLocaleString('pt-BR')} registros foram removidos e o
                  catálogo global foi atualizado.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}
        </div>
      </Surface>
    </div>
  );
}
