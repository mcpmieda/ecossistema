import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StudentPortalAdminPage } from '../features/student-portal-admin/student-portal-admin-page';
import { localStudents, previewFetch } from './preview-fetch-v1';
import { scalarTextV1 } from '../../shared/scalar-text-v1';

// The class catalog and other browser reads use fetch directly; keep this preview offline.
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  previewFetch(scalarTextV1(input), init ?? {})) as typeof window.fetch;

if (!window.location.hash) window.history.replaceState(null, '', '#/painel-do-aluno');
const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
createRoot(root).render(
  <StrictMode>
    <main className="w-full px-3 py-3">
      <p className="mb-5 text-xs font-medium text-muted">
        Preview local ·{' '}
        {localStudents
          ? 'nomes, anos de nascimento e fotos reais locais; demais dados sintéticos'
          : 'dados sintéticos'}{' '}
        · QR sintético; alterações bloqueadas
      </p>
      <StudentPortalAdminPage fetcher={previewFetch} />
    </main>
  </StrictMode>,
);
