import { Component, type ReactNode } from 'react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { isStudentModuleFailureV1, reportStudentDiagnosticV1 } from './diagnostics-v1';

export class StudentDiagnosticBoundaryV1 extends Component<Readonly<{ children: ReactNode }>, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error): void {
    if (!isStudentModuleFailureV1(error)) reportStudentDiagnosticV1('render');
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <main className="pa-access-check"><Alert status="warning"><Alert.Content>
      <Alert.Title>Não foi possível carregar esta área.</Alert.Title>
      <Button onPress={() => window.location.reload()}>Recarregar página</Button>
    </Alert.Content></Alert></main>;
  }
}
