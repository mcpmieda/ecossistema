import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Button } from '@heroui/react';
import { Card } from '@heroui/react/card';
import { useStudentSessionV1 } from '../features/student-portal/auth/student-session-v1';
import {
  StudentPortalPageV1,
  StudentPortalShellV1,
} from '../features/student-portal/shell/student-shell-v1';
import {
  createPortalSelfClientV1,
  type PortalSelfClientV1,
} from '../features/student-portal/shared/self-client-v1';
import { useStudentPortraitV1 } from '../features/student-portal/photos/use-student-portrait-v1';
import {
  StudentEntryLayoutV1,
  StudentSplashV1,
} from '../features/student-portal/auth/student-entry-layout-v1';
import type { PortraitClientV1 } from '../features/student-portal/photos/portrait-client-v1';
import {
  createPortalStatusClientV1,
  PortalClosedNoticeV1,
  PortalSignedInNoticesV1,
  usePortalNoticesV1,
  type PortalStatusClientV1,
} from '../features/student-portal/shell/portal-notices-v1';
import { diagnosticStudentFetchV1, markStudentModuleFailureV1, reportStudentDiagnosticV1 } from './diagnostics-v1';

const StudentAuthenticationV1 = lazy(() => import('../features/student-portal/auth/student-auth-v1').then(
  (module) => ({ default: module.StudentAuthenticationV1 }),
).catch(markStudentModuleFailureV1));
export interface StudentEntryV1 {
  qr: string | null;
  invalidQr: boolean;
  route: 'root' | 'access' | 'unknown';
}
const PUBLIC_SITEKEY = '0x4AAAAAAExp0Fw2x5lR3luX';
const defaultClient = createPortalSelfClientV1({ respectRetryAfter: true, fetch: diagnosticStudentFetchV1 });
// Notices are optional: a failed read shows none and is not reported as a Portal failure.
const defaultStatusClient = createPortalStatusClientV1();
const defaultEntry: StudentEntryV1 = { qr: null, invalidQr: false, route: 'root' };

/** Entry is a private, disposable holder. It never becomes a URL, DOM attribute or storage item. */
export function StudentPortalApp({
  entry = defaultEntry,
  client = defaultClient,
  portraitClient,
  statusClient = defaultStatusClient,
}: Readonly<{
  entry?: StudentEntryV1;
  client?: PortalSelfClientV1;
  portraitClient?: PortraitClientV1;
  statusClient?: PortalStatusClientV1;
}>) {
  const [initialQr, setInitialQr] = useState(entry.qr);
  const [invalidQr, setInvalidQr] = useState(entry.invalidQr);
  const [access, setAccess] = useState(entry.route === 'access');
  // Right after a sign-in the opening screen says so ("Tudo certo!") while the marks load.
  const [entered, setEntered] = useState(false);
  const session = useStudentSessionV1(client);
  const portraitSrc = useStudentPortraitV1(
    session.load.state === 'ready' && !access && entry.route !== 'unknown'
      && !['pending', 'failed', 'done'].includes(session.logoutState) ? session.load.data : null,
    portraitClient,
  );
  useEffect(() => {
    if (session.load.state === 'error' && ['unavailable', 'invalid-response', 'network-error'].includes(session.load.error.state))
      reportStudentDiagnosticV1('read');
  }, [session.load]);
  const discardQr = () => {
    entry.qr = null;
    entry.invalidQr = false;
    setInitialQr(null);
    setInvalidQr(false);
  };
  useEffect(
    () => () => {
      entry.qr = null;
    },
    [entry],
  );
  const anonymous = session.load.state === 'error' && session.load.error.state === 'unauthenticated';
  // Access closed while signed in (e.g. the school scheduled a later opening): back to the login
  // page, which shows the closed notice with its countdown instead of a bare error.
  const accessClosed = session.load.state === 'error' && session.load.error.state === 'access-closed';
  const signingIn = access || session.logoutState === 'done' || anonymous || accessClosed;
  let noticesAudience: 'student' | 'anonymous' | null = null;
  if (signingIn) noticesAudience = 'anonymous';
  else if (session.load.state === 'ready') noticesAudience = 'student';
  const notices = usePortalNoticesV1(statusClient, noticesAudience)?.value;
  if (entry.route === 'unknown')
    return (
      <StudentPortalShellV1>
        <Alert status="warning">
          <Alert.Content>
            <Alert.Title>Página não encontrada</Alert.Title>
            <Button onPress={() => window.location.assign('/')}>Abrir Portal do Aluno</Button>
          </Alert.Content>
        </Alert>
      </StudentPortalShellV1>
    );
  if (session.logoutState === 'pending' || session.logoutState === 'failed')
    return (
      <StudentPortalShellV1>
        <Alert status={session.logoutState === 'failed' ? 'warning' : 'default'}>
          <Alert.Content>
            <Alert.Title>
              {session.logoutState === 'pending'
                ? 'Encerrando sua sessão…'
                : 'Não foi possível confirmar a saída'}
            </Alert.Title>
            <Alert.Description>Seus dados foram retirados desta tela.</Alert.Description>
            {session.logoutState === 'failed' && (
              <Button onPress={() => { void session.logout(); }}>Tentar sair novamente</Button>
            )}
          </Alert.Content>
        </Alert>
      </StudentPortalShellV1>
    );
  if (access && session.logoutState !== 'done') {
    if (session.load.state === 'idle' || session.load.state === 'loading')
      return <StudentSplashV1 />;
    if (session.load.state === 'ready')
      return (
        <StudentEntryLayoutV1>
          <Card className="pa-account-switch">
            <Card.Header>
              <Card.Title>Você já está conectado</Card.Title>
            </Card.Header>
            <Card.Content>
              <Card.Description>Para usar outro cartão, saia da conta atual.</Card.Description>
              <Button
                onPress={() => {
                  discardQr();
                  setAccess(false);
                  window.history.replaceState(null, '', '/');
                }}
              >
                Continuar nesta conta
              </Button>
              <Button variant="secondary" onPress={() => { void session.logout(); }}>
                Trocar de aluno
              </Button>
            </Card.Content>
          </Card>
        </StudentEntryLayoutV1>
      );
    if (!anonymous)
      return (
        <StudentPortalPageV1
          load={session.load}
          onRetry={() => { void session.refresh(); }}
          onLogout={() => { void session.logout(); }}
        />
      );
  }
  // Wait for the notices rather than flashing the card reader at a student who cannot enter.
  if (accessClosed && notices === undefined) return <StudentSplashV1 />;
  if (signingIn && notices?.access === 'closed')
    return (
      <StudentEntryLayoutV1>
        <PortalClosedNoticeV1 notices={notices} />
      </StudentEntryLayoutV1>
    );
  if (signingIn)
    return (
      <StudentEntryLayoutV1>
        {invalidQr && (
          <Alert status="warning">
            <Alert.Content>
              <Alert.Title>Este QR não é um acesso válido ao Portal.</Alert.Title>
              <Alert.Description>Leia novamente seu cartão de acesso.</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <Suspense fallback={<output>Preparando entrada segura…</output>}>
          <StudentAuthenticationV1 client={client} initialQr={initialQr} sitekey={PUBLIC_SITEKEY}
            onQrDiscarded={discardQr}
            onAuthenticated={() => {
              discardQr(); setAccess(false); setEntered(true); window.history.replaceState(null, '', '/');
              void session.authenticated();
            }}
          />
        </Suspense>
      </StudentEntryLayoutV1>
    );
  if (session.load.state === 'idle' || session.load.state === 'loading')
    return <StudentSplashV1 entered={entered} />;
  return (
    <StudentPortalPageV1 load={session.load} portraitSrc={portraitSrc}
      status={notices && session.load.state === 'ready' ? (
        <PortalSignedInNoticesV1 notices={notices}
          hasGrades={session.load.data.state !== 'no-publication' && session.load.data.subjects.length > 0} />
      ) : undefined}
      onRetry={() => { void session.refresh(); }}
      onLogin={() => { discardQr(); setAccess(true); }}
      onAuthenticationLost={() => { discardQr(); session.invalidateAuthorization(); setAccess(true); }}
      onLogout={session.load.state === 'ready' ? () => { discardQr(); void session.logout(); } : undefined}
    />
  );
}
