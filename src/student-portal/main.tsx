import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StudentPortalApp, type StudentEntryV1 } from './app';
import { consumeStudentQrLocationV1 } from '../features/student-portal/auth/qr-input-v1';
import { StudentDiagnosticBoundaryV1 } from './diagnostic-boundary-v1';
import { enableStudentDiagnosticsV1 } from './diagnostics-v1';
import '../features/student-portal/shared/styles.css';

function routeOf(pathname: string): StudentEntryV1['route'] {
  if (pathname === '/') return 'root';
  return pathname === '/access' ? 'access' : 'unknown';
}

const root = document.getElementById('root');
if (!root) throw new Error('Portal root missing');
const entry: StudentEntryV1 = {
  qr: null,
  invalidQr: false,
  route: routeOf(location.pathname),
};
// Remove even malformed fragments before rendering or mounting the external risk widget.
try {
  entry.qr = consumeStudentQrLocationV1(location, history);
} catch {
  entry.invalidQr = true;
}
enableStudentDiagnosticsV1();
createRoot(root).render(
  <StrictMode>
    <StudentDiagnosticBoundaryV1><StudentPortalApp entry={entry} /></StudentDiagnosticBoundaryV1>
  </StrictMode>,
);
