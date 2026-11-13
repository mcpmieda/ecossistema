import { Component, type ReactNode } from 'react';
import { Alert, Button } from '@heroui/react';
import { allowDraftNavigationV1 } from '../forms/draft-navigation-v1';
import {
  routeLoadFailureV1,
  shouldReloadFailedModuleV1,
  type RouteLoadFailureV1,
} from '../live-data/route-load-failure-v1';

type AreaErrorBoundaryPropsV1 = {
  readonly label: string;
  readonly children: ReactNode;
  /** The whole Centro: there is no rest of the Centro left on screen. */
  readonly whole?: boolean;
};
type AreaErrorBoundaryStateV1 = { readonly failure: RouteLoadFailureV1 | null };

/**
 * A failure of one area (a file missing after a deploy, an error on screen) stays in that area:
 * the menu and the rest of the Centro remain, with a way to reload. A missing file reloads the
 * page once by itself, as the Banco de notas does.
 */
export class AreaErrorBoundaryV1 extends Component<AreaErrorBoundaryPropsV1, AreaErrorBoundaryStateV1> {
  override state: AreaErrorBoundaryStateV1 = { failure: null };

  static getDerivedStateFromError(error: unknown): AreaErrorBoundaryStateV1 {
    return { failure: routeLoadFailureV1(error) };
  }

  override componentDidCatch(error: Error): void {
    try {
      if (allowDraftNavigationV1() && shouldReloadFailedModuleV1(error, window.history, Date.now()))
        window.location.reload();
    } catch {
      // The message below remains if the reload is blocked.
    }
  }

  override render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    const moduleFailure = this.state.failure === 'module-load';
    return (
      <Alert status="danger" role="alert" className={this.props.whole ? 'm-4' : undefined}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{this.props.label} indisponível</Alert.Title>
          <Alert.Description>
            {moduleFailure
              ? 'Não foi possível carregar esta área. Recarregue a página para obter a versão atual.'
              : this.props.whole
                ? 'Ocorreu um erro ao mostrar o Centro. Recarregue a página para continuar.'
                : 'Ocorreu um erro ao mostrar esta área. O restante do Centro continua disponível.'}
          </Alert.Description>
          <div className="mt-3">
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                if (allowDraftNavigationV1()) window.location.reload();
              }}
            >
              Recarregar
            </Button>
          </div>
        </Alert.Content>
      </Alert>
    );
  }
}
