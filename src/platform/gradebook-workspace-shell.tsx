import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import { LiveRefreshScopeV1 } from '../shared/live-data/live-refresh-scope-v1';
import {
  Component,
  Suspense,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Alert, Button, Spinner, Surface } from '@heroui/react';
import { GradebookYearContextBanner, GradebookYearProvider } from './gradebook-year-provider';
import { useGradebookYear } from './gradebook-year-context';
import { NotesImportPanel } from '../features/gradebook/import/import-panel';
import { preloadedSectionV1, usePreloadedSectionsV1 } from '../shared/ui/preloaded-section-v1';

export const GRADEBOOK_WORKSPACE_SURFACES = [
  {
    id: 'importacao',
    label: 'Importação',
    description: 'Importe e reconheça planilhas sem persistir dados acadêmicos no navegador.',
  },
  {
    id: 'performance',
    label: 'Desempenho',
    description: 'Explore as lentes oficiais de desempenho sem recalcular resultados na interface.',
  },
  {
    id: 'bulletins',
    label: 'Boletins',
    description:
      'Consulte preview, emissão, PDF e histórico baseados no modelo canônico existente.',
  },
  {
    id: 'council',
    label: 'Conselho',
    description:
      'Abra a fila oficial, registre decisões humanas e feche a turma institucionalmente.',
  },
  {
    id: 'audit',
    label: 'Auditoria',
    description:
      'Entenda pendências atuais da fonte e as ações sugeridas, sem correção automática.',
  },
  {
    id: 'settings',
    label: 'Configurações',
    description: 'Administre com segurança o ciclo de vida dos anos letivos materializados.',
  },
] as const;

export type GradebookWorkspaceSurfaceId = (typeof GRADEBOOK_WORKSPACE_SURFACES)[number]['id'];
const NOTES_TABS_V1 = GRADEBOOK_WORKSPACE_SURFACES.filter((surface) => surface.id !== 'importacao');

const DEFAULT_SURFACE: GradebookWorkspaceSurfaceId = 'importacao';

function workspaceSurfaceFromHash(): GradebookWorkspaceSurfaceId {
  const query = window.location.hash.split('?')[1] ?? '';
  const requested = new URLSearchParams(query).get('area');
  return GRADEBOOK_WORKSPACE_SURFACES.some((surface) => surface.id === requested)
    ? (requested as GradebookWorkspaceSurfaceId)
    : DEFAULT_SURFACE;
}

function workspaceSurfaceHash(surfaceId: GradebookWorkspaceSurfaceId): string {
  return surfaceId === DEFAULT_SURFACE
    ? '#/banco-de-notas'
    : `#/banco-de-notas?area=${encodeURIComponent(surfaceId)}`;
}

function replaceWorkspaceSurfaceHash(surfaceId: GradebookWorkspaceSurfaceId): void {
  const nextHash = workspaceSurfaceHash(surfaceId);
  if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash);
}

function normalizeRetiredWorkspaceSurfaceHash(): void {
  if (!/^#\/?banco-de-notas$/u.test(window.location.hash.split('?')[0] ?? '')) return;
  const query = window.location.hash.split('?')[1] ?? '';
  if (['operational', 'reports'].includes(new URLSearchParams(query).get('area') ?? '')) {
    replaceWorkspaceSurfaceHash(DEFAULT_SURFACE);
  }
}

const GradebookAuditSurface = preloadedSectionV1(() =>
  import('../features/gradebook/audit-workspace/gradebook-audit-surface').then(
    (module) => module.GradebookAuditSurface,
  ),
);

const PerformancePage = preloadedSectionV1<{ isActive?: boolean }>(() =>
  import('../features/gradebook/performance/relational-performance-page-v2').then(
    (module) => module.RelationalPerformancePageV2,
  ),
);

const BulletinPage = preloadedSectionV1(() =>
  import('../features/gradebook/bulletins/bulletin-page').then((module) => module.BulletinPage),
);

const CouncilWorkspaceSurface = preloadedSectionV1(() =>
  import('./gradebook-council-surface').then((module) => module.GradebookCouncilSurface),
);

const SettingsPage = preloadedSectionV1<{ isActive?: boolean }>(() =>
  import('../features/gradebook/settings/gradebook-settings-page-v1').then(
    (module) => module.GradebookSettingsPageV1,
  ),
);

// The area in the address is the first one shown: ask for it at once.
if (typeof window !== 'undefined') {
  const opened = workspaceSurfaceFromHash();
  if (opened === 'audit') GradebookAuditSurface.preload();
  else if (opened === 'performance') PerformancePage.preload();
  else if (opened === 'bulletins') BulletinPage.preload();
  else if (opened === 'council') CouncilWorkspaceSurface.preload();
  else if (opened === 'settings') SettingsPage.preload();
}

const WORKSPACE_SECTIONS_V1 = [
  GradebookAuditSurface,
  PerformancePage,
  BulletinPage,
  CouncilWorkspaceSurface,
  SettingsPage,
];
const SURFACE_COMPONENTS: Record<
  Exclude<GradebookWorkspaceSurfaceId, 'importacao'>,
  ComponentType
> = {
  audit: GradebookAuditSurface,
  performance: PerformancePage,
  bulletins: BulletinPage,
  council: CouncilWorkspaceSurface,
  settings: SettingsPage,
};

type SurfaceBoundaryProps = {
  readonly label: string;
  readonly onLeave: () => void;
  readonly children: ReactNode;
};

type SurfaceBoundaryState = { readonly failed: boolean };

const STALE_MODULE_RELOAD_KEY = '__gradebookStaleModuleReloadAt';
const STALE_MODULE_RELOAD_WINDOW_MS = 60_000;

export function shouldReloadFailedModuleV1(
  error: unknown,
  navigation: Pick<History, 'state' | 'replaceState'>,
  now: number,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    !/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
      message,
    )
  )
    return false;
  try {
    const previousState = navigation.state;
    const state: Record<string, unknown> =
      previousState && typeof previousState === 'object' && !Array.isArray(previousState)
        ? (previousState as Record<string, unknown>)
        : {};
    const last = Number(state[STALE_MODULE_RELOAD_KEY]);
    if (last > 0 && now - last >= 0 && now - last < STALE_MODULE_RELOAD_WINDOW_MS) return false;
    navigation.replaceState({ ...state, [STALE_MODULE_RELOAD_KEY]: now }, '');
    return true;
  } catch {
    return false;
  }
}

class GradebookSurfaceBoundary extends Component<SurfaceBoundaryProps, SurfaceBoundaryState> {
  override state: SurfaceBoundaryState = { failed: false };

  static getDerivedStateFromError(): SurfaceBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    try {
      if (shouldReloadFailedModuleV1(error, window.history, Date.now())) window.location.reload();
    } catch {
      // The existing area error remains available if navigation is blocked.
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{this.props.label} indisponível</Alert.Title>
          <Alert.Description>
            Esta experiência falhou isoladamente. As demais áreas do Banco continuam disponíveis.
          </Alert.Description>
          <div className="mt-3">
            <Button size="sm" variant="outline" onPress={this.props.onLeave}>
              Voltar à Importação
            </Button>
          </div>
        </Alert.Content>
      </Alert>
    );
  }
}

function SurfaceLoading({ label }: { readonly label: string }) {
  return (
    <Surface
      variant="secondary"
      className="rounded-2xl border border-border/60 p-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3 text-sm text-muted">
        <Spinner size="sm" />
        Carregando {label}…
      </div>
    </Surface>
  );
}

function nextSurfaceFromKey(
  current: GradebookWorkspaceSurfaceId,
  event: KeyboardEvent<HTMLButtonElement>,
): GradebookWorkspaceSurfaceId | null {
  const index = NOTES_TABS_V1.findIndex((surface) => surface.id === current);
  if (index < 0) return null;
  if (event.key === 'Home') return NOTES_TABS_V1[0]?.id ?? null;
  if (event.key === 'End') return NOTES_TABS_V1.at(-1)?.id ?? null;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return null;
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const nextIndex = (index + direction + NOTES_TABS_V1.length) % NOTES_TABS_V1.length;
  return NOTES_TABS_V1[nextIndex]?.id ?? null;
}

export function GradebookWorkspaceShell() {
  return (
    <GradebookYearProvider>
      <GradebookWorkspaceShellContent />
    </GradebookYearProvider>
  );
}

function GradebookWorkspaceShellContent() {
  const scope = useGradebookYear();
  usePreloadedSectionsV1(WORKSPACE_SECTIONS_V1);
  const [activeSurface, setActiveSurface] = useState<GradebookWorkspaceSurfaceId>(() =>
    workspaceSurfaceFromHash(),
  );
  const epoch = scope?.epoch ?? 0;
  const [visits, setVisits] = useState<{
    epoch: number;
    surfaces: ReadonlySet<GradebookWorkspaceSurfaceId>;
  }>(() => ({ epoch, surfaces: new Set([workspaceSurfaceFromHash()]) }));
  let visitedSurfaces = visits.surfaces;
  if (visits.epoch !== epoch) {
    visitedSurfaces = new Set<GradebookWorkspaceSurfaceId>([
      activeSurface,
      ...(visits.surfaces.has('importacao') ? ['importacao' as const] : []),
    ]);
    // Reset before children render: hidden readers must not load the new year.
    // Importation is independent of the selected year and can still be running.
    setVisits({ epoch, surfaces: visitedSurfaces });
  }
  const tabRefs = useRef(new Map<GradebookWorkspaceSurfaceId, HTMLButtonElement>());

  const activateSurface = (surfaceId: GradebookWorkspaceSurfaceId) => {
    if (!allowDraftNavigationV1()) return;
    setVisits((current) => {
      if (current.surfaces.has(surfaceId)) return current;
      const next = new Set(current.surfaces);
      next.add(surfaceId);
      return { ...current, surfaces: next };
    });
    setActiveSurface(surfaceId);
    replaceWorkspaceSurfaceHash(surfaceId);
  };

  useEffect(() => {
    const onHashChange = () => {
      const requested = workspaceSurfaceFromHash();
      normalizeRetiredWorkspaceSurfaceHash();
      setVisits((current) => {
        if (current.surfaces.has(requested)) return current;
        const next = new Set(current.surfaces);
        next.add(requested);
        return { ...current, surfaces: next };
      });
      setActiveSurface(requested);
    };
    normalizeRetiredWorkspaceSurfaceHash();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabKeyDown = (
    surfaceId: GradebookWorkspaceSurfaceId,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const next = nextSurfaceFromKey(surfaceId, event);
    if (next === null) return;
    event.preventDefault();
    activateSurface(next);
    window.requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
  };

  return (
    <section
      aria-labelledby="gradebook-workspace-heading"
      className="gradebook-workspace grid min-w-0 grid-cols-1 gap-4"
    >
      <h2 id="gradebook-workspace-heading" className="sr-only">
        {activeSurface === 'importacao' ? 'Importação' : 'Banco de notas'}
      </h2>
      <div className="gradebook-area-nav">
        {activeSurface !== 'importacao' && (
          <div
            role="tablist"
            aria-label="Áreas do Banco de notas"
            className="gradebook-area-tabs max-w-full overflow-x-auto"
          >
            {NOTES_TABS_V1.map((surface) => {
              const selected = surface.id === activeSurface;
              return (
                <button
                  key={surface.id}
                  ref={(element) => {
                    if (element) tabRefs.current.set(surface.id, element);
                    else tabRefs.current.delete(surface.id);
                  }}
                  id={`gradebook-tab-${surface.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`gradebook-panel-${surface.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`gradebook-area-tab ${selected ? 'gradebook-area-tab--selected' : ''}`}
                  onClick={() => activateSurface(surface.id)}
                  onKeyDown={(event) => handleTabKeyDown(surface.id, event)}
                >
                  {surface.label}
                </button>
              );
            })}
          </div>
        )}
        {/* Desempenho carries the year in its own header. */}
        {activeSurface === 'performance' ? null : <GradebookYearContextBanner failureOnly />}
      </div>

      <p className="sr-only" aria-live="polite">
        {GRADEBOOK_WORKSPACE_SURFACES.find((surface) => surface.id === activeSurface)?.label} ativa.
      </p>

      {GRADEBOOK_WORKSPACE_SURFACES.map((surface) => {
        if (!visitedSurfaces.has(surface.id)) return null;
        const active = surface.id === activeSurface;
        return (
          <div
            key={surface.id}
            id={`gradebook-panel-${surface.id}`}
            role={surface.id === 'importacao' ? undefined : 'tabpanel'}
            aria-labelledby={
              surface.id === 'importacao' ? undefined : `gradebook-tab-${surface.id}`
            }
            hidden={!active}
            className="min-w-0"
          >
            <LiveRefreshScopeV1 active={active}>
              <p className="sr-only">{surface.description}</p>
              {surface.id === 'importacao' ? (
                <NotesImportPanel />
              ) : (
                <GradebookSurfaceBoundary
                  label={surface.label}
                  onLeave={() => activateSurface(DEFAULT_SURFACE)}
                >
                  <Suspense fallback={<SurfaceLoading label={surface.label} />}>
                    {(() => {
                      const SurfaceComponent = SURFACE_COMPONENTS[surface.id];
                      const scopeKey = scope?.epoch;
                      if (surface.id === 'performance')
                        return <PerformancePage key={scopeKey} isActive={active} />;
                      if (surface.id === 'settings')
                        return <SettingsPage key={scopeKey} isActive={active} />;
                      return <SurfaceComponent key={scopeKey} />;
                    })()}
                  </Suspense>
                </GradebookSurfaceBoundary>
              )}
            </LiveRefreshScopeV1>
          </div>
        );
      })}
    </section>
  );
}
