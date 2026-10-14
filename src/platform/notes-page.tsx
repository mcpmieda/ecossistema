import { Component, Suspense, type ReactNode } from 'react';
import { Alert, Button, Spinner, Surface } from '@heroui/react';
import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import { routeLoadFailureV1, type RouteLoadFailureV1 } from '../shared/live-data/route-load-failure-v1';
import { normalizePlatformRoute } from '../../shared/platform-contract';
import { preloadedSectionV1 } from '../shared/ui/preloaded-section-v1';

const GradebookWorkspacePage = preloadedSectionV1(() =>
  import('./gradebook-workspace-page').then((module) => module.GradebookWorkspacePage),
);
// Opened directly on the Banco de notas: its bundle is asked for while the session is checked.
if (
  typeof window !== 'undefined' &&
  normalizePlatformRoute(window.location.hash.replace(/^#\/?/u, '')) === 'banco-de-notas'
)
  GradebookWorkspacePage.preload();

type GradebookRouteBoundaryState = { readonly failure: RouteLoadFailureV1 | null };

class GradebookRouteBoundary extends Component<{ readonly children: ReactNode }, GradebookRouteBoundaryState> {
  override state: GradebookRouteBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): GradebookRouteBoundaryState {
    return { failure: routeLoadFailureV1(error) };
  }

  override render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    const moduleFailure = this.state.failure === 'module-load';
    return (
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Banco de notas indisponível</Alert.Title>
          <Alert.Description>
            O carregamento desta área falhou isoladamente. O restante do Centro continua disponível.
          </Alert.Description>
          <p className="mt-2 text-sm text-muted">
            {moduleFailure
              ? 'Não foi possível carregar os arquivos desta área. Recarregue a página para tentar obter a versão atual do aplicativo.'
              : 'Ocorreu um erro ao exibir esta área. Isso, por si só, não confirma uma falha no banco de dados.'}
          </p>
          <p className="mt-2 text-xs text-muted">
            Código: {moduleFailure ? 'BN-CARGA' : 'BN-TELA'}. A página não será recarregada automaticamente.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onPress={() => {
              if (allowDraftNavigationV1()) window.location.assign('#/operacao');
            }}>
              Ir para Saúde do Sistema
            </Button>
            <Button size="sm" variant="secondary" onPress={() => {
              if (allowDraftNavigationV1()) window.location.reload();
            }}>
              Recarregar
            </Button>
          </div>
        </Alert.Content>
      </Alert>
    );
  }
}

export function NotesPage() {
  return (
    <GradebookRouteBoundary>
      <Suspense
        fallback={
          <Surface
            variant="secondary"
            className="grid min-h-48 place-items-center rounded-3xl border border-border/60 p-6"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-3 text-sm text-muted">
              <Spinner size="sm" />
              Carregando Banco de notas…
            </div>
          </Surface>
        }
      >
        <GradebookWorkspacePage />
      </Suspense>
    </GradebookRouteBoundary>
  );
}
