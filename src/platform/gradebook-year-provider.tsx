import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Label, ListBox, Select, Spinner } from '@heroui/react';
import type { WorkspaceYearV2 } from '../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2';
import { requestOperationalWorkspaceV2 } from '../features/gradebook/operational-workspace/operational-workspace-client-v2';
import {
  GradebookYearContext,
  useGradebookYear,
  type GradebookYearContextValue,
} from './gradebook-year-context';

/**
 * The effective year, kept for this visit only (no browser storage), so the settings and the
 * Banco de notas reopen in the same year. Each screen still reads the catalogue by itself.
 */
let chosenYearV1: number | null = null;

/** Forgets the year of this visit; tests use it to start each case from the catalogue. */
export function forgetGradebookYearV1() {
  chosenYearV1 = null;
}

export function GradebookYearProvider({ children }: { readonly children: ReactNode }) {
  const [year, setYear] = useState<number | null>(null);
  const [years, setYears] = useState<readonly WorkspaceYearV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const yearRef = useRef<number | null>(null);
  const clearAuthorization = useCallback(() => {
    // A denial from an academic consumer keeps the year on screen, as before, but invalidates any
    // older catalogue request: its delayed success must not dismiss this failure.
    requestSequence.current += 1;
    setLoading(false);
    setFailure('A sessão não possui autorização. Entre novamente com uma conta autorizada.');
  }, []);
  const forgetAuthorization = useCallback(() => {
    // The catalogue itself denied access: nothing of the previous choice survives.
    chosenYearV1 = null;
    yearRef.current = null;
    setYears([]);
    setYear(null);
    setLoading(false);
    setFailure('A sessão não possui autorização. Entre novamente com uma conta autorizada.');
  }, []);
  const retryAuthorization = useCallback(() => {
    setFailure(null);
    setEpoch((current) => current + 1);
  }, []);
  const applyYear = useCallback((nextYear: number | null) => {
    const previous = yearRef.current;
    // Every accepted transition, including import follow-up and catalogue fallback, must
    // update the visit memory before another page can mount its provider.
    chosenYearV1 = nextYear;
    yearRef.current = nextYear;
    setYear(nextYear);
    if (nextYear !== previous) setEpoch((value) => value + 1);
  }, []);
  const selectYear = useCallback(
    (nextYear: number) => {
      // Reject a stale selection callback once access was withdrawn, before the next render.
      if (yearRef.current === null || !allowDraftNavigationV1()) return;
      if (!years.some((item) => item.year === nextYear)) return;
      if (yearRef.current === nextYear) return;
      applyYear(nextYear);
    },
    [years, applyYear],
  );
  const refreshYears = useCallback(async (preferredYear?: number) => {
    const ticket = ++requestSequence.current;
    setLoading(true);
    let response;
    try {
      response = await requestOperationalWorkspaceV2({
        contractVersion: 2,
        operation: 'bootstrap',
      });
    } catch {
      if (ticket === requestSequence.current) {
        setFailure('Não foi possível carregar os anos letivos disponíveis.');
        setLoading(false);
      }
      return;
    }
    if (ticket !== requestSequence.current) return;
    if (response.state === 'not-authorized') {
      forgetAuthorization();
      return;
    }
    if (response.state !== 'ready' || response.operation !== 'bootstrap') {
      setFailure('Não foi possível carregar os anos letivos disponíveis.');
      setLoading(false);
      return;
    }
    setFailure(null);
    setYears(response.years);
    const current = yearRef.current ?? chosenYearV1;
    let next;
    if (preferredYear !== undefined && response.years.some((item) => item.year === preferredYear)) {
      next = preferredYear;
    } else if (current !== null && response.years.some((item) => item.year === current)) {
      next = current;
    } else {
      next = response.years[0]?.year ?? null;
    }
    applyYear(next);
    setLoading(false);
  }, [applyYear, forgetAuthorization]);
  useEffect(() => {
    void refreshYears();
    return () => {
      requestSequence.current += 1;
    };
  }, [refreshYears]);
  const value = useMemo(
    () => ({
      year,
      years,
      loading,
      epoch,
      failure,
      clearAuthorization,
      retryAuthorization,
      selectYear,
      refreshYears,
    }),
    [
      year,
      years,
      loading,
      epoch,
      failure,
      clearAuthorization,
      retryAuthorization,
      selectYear,
      refreshYears,
    ],
  );
  return <GradebookYearContext.Provider value={value}>{children}</GradebookYearContext.Provider>;
}

function YearFailureV1({ scope }: { readonly scope: GradebookYearContextValue }) {
  if (!scope.failure) return null;
  return (
    <Alert status="warning" className="basis-full">
      <Alert.Content>
        <Alert.Title>Contexto indisponível</Alert.Title>
        <Alert.Description>{scope.failure}</Alert.Description>
      </Alert.Content>
      <Button
        size="sm"
        variant="secondary"
        onPress={() => {
          scope.retryAuthorization();
          void scope.refreshYears();
        }}
      >
        Tentar novamente
      </Button>
    </Alert>
  );
}

/**
 * The school year in use, read-only: it is chosen in the settings of the Centro (owner request of
 * 13/10/2026). With `failureOnly` nothing shows unless the year could not be read.
 */
export function GradebookYearContextBanner({
  failureOnly = false,
}: Readonly<{
  failureOnly?: boolean;
}>) {
  const scope = useGradebookYear();
  if (!scope || (failureOnly && !scope.failure)) return null;
  return (
    <div
      aria-label="Contexto acadêmico atual"
      className="gradebook-year-current flex min-w-0 flex-wrap items-center justify-end gap-2"
    >
      {failureOnly ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          Ano letivo
          {scope.loading ? (
            <Spinner size="sm" />
          ) : (
            <strong className="text-sm font-semibold text-foreground">{scope.year ?? '—'}</strong>
          )}
        </p>
      )}
      <YearFailureV1 scope={scope} />
    </div>
  );
}

/** The selector of the global school year, in the settings of the Centro. */
export function GradebookYearSelectV1() {
  const scope = useGradebookYear();
  if (!scope) return null;
  return (
    <div className="grid min-w-0 gap-3">
      <Select
        className="max-w-xs"
        selectedKey={scope.year === null ? null : String(scope.year)}
        isDisabled={scope.loading || scope.years.length === 0}
        onSelectionChange={(key) => {
          if (key !== null) scope.selectYear(Number(key));
        }}
      >
        <Label>Ano letivo global</Label>
        <Select.Trigger className="min-h-11 w-full">
          <Select.Value />
          {scope.loading ? <Spinner size="sm" /> : <Select.Indicator />}
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {scope.years.map((item) => (
              <ListBox.Item key={item.year} id={String(item.year)} textValue={String(item.year)}>
                {item.year}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <YearFailureV1 scope={scope} />
    </div>
  );
}
