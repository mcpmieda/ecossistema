import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import '../styles.css';
import { PLATFORM_CAPABILITIES } from '../../shared/platform-contract';
import {
  previewFetch,
  previewReconciliationV1,
} from '../student-portal-admin-preview/preview-fetch-v1';
import { previewAuditV1 } from './audit-preview-v1';
import { auditPendingSnapshotV1 } from '../platform/audit-pending-v1';
import { resumeGradebookYearV1 } from '../platform/gradebook-year-provider';
import { previewOneDriveSyncV1 } from './onedrive-sync-preview-v1';
import { previewGroupsV1 } from './groups-preview-v1';

/*
 * Local preview of the whole Centro de Administração: the real App over an offline, synthetic
 * API. Nothing here reaches a server. An endpoint without synthetic data answers 503, so its
 * page shows the same unavailable state it would show in production.
 */
const nativeFetch = window.fetch.bind(window);
const expiresAt = new Date(Date.now() + 8 * 3_600_000).toISOString();
const identity = {
  authenticated: true,
  identityKey: 'preview-local',
  name: 'Preview Local',
  email: 'preview@example.invalid',
  expiresAt,
  capabilities: [...PLATFORM_CAPABILITIES],
};
const unanswered = new Set<string>();
// The Portal client refuses an administrative answer that a cache could keep.
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function syntheticHealth() {
  const at = new Date().toISOString();
  const status = new URLSearchParams(window.location.search).get('saude');
  return {
    schemaVersion: 1,
    generatedAt: at,
    portalReadState: 'ok',
    portal: {
      schemaVersion: 1,
      observedAt: at,
      servingEnabled: true,
      credentialsConfigured: true,
      database: status === 'critical' ? 'unavailable' : 'ok',
      readDurationMs: 40,
      maintenance: {
        status: status === 'attention' ? 'attention' : 'normal',
        liveOutboxAvailable: true,
        expiredIp: 0,
        expiredAudit: 0,
        backlog: false,
        exhausted: false,
        publicationDue: 0,
        oldestPublicationDueMs: 0,
        liveBacklog: false,
        livePending: 0,
        liveRetrying: 0,
        oldestLiveDueMs: 0,
        waitingConnections: 0,
        oldestWaitingQueryMs: 0,
      },
    },
    publicEntry: { outcome: 'ok', status: 200, durationMs: 120, observedAt: at },
  };
}

type PreviewRequestV1 = {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
  readonly path: string;
  readonly search: string;
};

/** The account's last views, kept in this browser so another tab acts as another computer. */
function viewPreferencesV1(init: RequestInit | undefined): Response {
  const key = 'adm-preview.view-preferences';
  let views: Record<string, unknown>;
  try {
    views = JSON.parse(window.localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
  } catch {
    views = {};
  }
  if (init?.method === 'PUT' && typeof init.body === 'string') {
    views = { ...views, ...(JSON.parse(init.body) as { views: Record<string, unknown> }).views };
    try {
      window.localStorage.setItem(key, JSON.stringify(views));
    } catch {
      /* kept for this load */
    }
  }
  return json({ contractVersion: 1, state: 'ready', views });
}

/** The Banco's year, kept in this browser: reloading the preview returns to the year in use
 * instead of the newest one. The Centro itself keeps the year for the visit only. */
const YEAR_KEY_V1 = 'adm-preview.gradebook-year';
let yearRestoredV1 = false;
try {
  const remembered = Number(window.localStorage.getItem(YEAR_KEY_V1));
  if (Number.isSafeInteger(remembered) && remembered > 0) resumeGradebookYearV1(remembered);
} catch {
  /* opens on the newest year */
}
function rememberYearV1(): void {
  const year = auditPendingSnapshotV1().year;
  // Before the first catalogue is answered the year on screen is not the person's choice yet.
  if (!yearRestoredV1 || year === null) return;
  try {
    window.localStorage.setItem(YEAR_KEY_V1, String(year));
  } catch {
    /* kept for this load */
  }
}

/** The Painel lists its own synthetic classes; every other Banco read goes to the local
 * development backend, which runs the real handlers over a local database. */
function gradebookV1({ input, init, path }: PreviewRequestV1): Promise<Response> | Response {
  const workspace =
    path === '/api/gradebook/operational-workspace' && typeof init?.body === 'string';
  if (workspace && window.location.hash.startsWith('#/painel-do-aluno'))
    return previewFetch(path, init);
  rememberYearV1();
  const answer = nativeFetch(input, init);
  if (workspace && (init.body as string).includes('"operation":"bootstrap"'))
    void answer.finally(() => {
      yearRestoredV1 = true;
    });
  return answer;
}

/** The Coletor's automatic report with a difference and a row left out (synthetic names). */
const automaticReportV1 = () =>
  json({
    contractVersion: 1,
    state: 'ready',
    operation: 'automatic-report',
    report: {
      observedAt: new Date(Date.now() - 600_000).toISOString(),
      changedAt: new Date(Date.now() - 600_000).toISOString(),
      outcome: 'applied',
      rows: 391,
      counts: { rows: 390, linked: 388, pending: 2 },
      differences: ['1 origem(ns) não encontrada(s) no relatório.'],
      invalid: [
        {
          sourceRow: 57,
          name: 'ALUNA SINTETICA UM',
          classLabel: '6A 2026 - MATUTINO',
          field: 'birthDate',
          reason: 'nascimento ausente.',
        },
      ],
    },
  });

/** The Conciliação: rows waiting (`?pendencias=` changes the number), its records without a
 * class (the same accounts as the Painel) and the Coletor's report. */
function reconciliationV1(body: string): Response | null {
  if (body.includes('"operation":"pending-count"'))
    return json({
      contractVersion: 1,
      state: 'ready',
      operation: 'pending-count',
      pending: Math.min(
        51,
        Number(new URLSearchParams(window.location.search).get('pendencias') ?? 12),
      ),
    });
  const answer = previewReconciliationV1(body);
  if (answer) return json(answer);
  if (body.includes('"operation":"automatic-report"')) return automaticReportV1();
  return null;
}

function unansweredV1(path: string): Response {
  if (!unanswered.has(path)) {
    unanswered.add(path);
    console.info('[preview] sem dados sintéticos para', path);
  }
  return json({ state: 'unavailable' }, 503);
}

/** Configurações › Acessos (#1513), in memory, with one synthetic person. */
let previewGrantsV1: Array<{
  id: string;
  email: string;
  areas: string[];
  updatedAt: string;
  updatedBy: string;
}> = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    email: 'bibliotecaria@escola.example',
    areas: ['painel-do-aluno'],
    updatedAt: '2026-11-17T12:00:00.000Z',
    updatedBy: 'Administração sintética',
  },
];
const previewAccessHistoryV1: Array<{
  at: string;
  actor: string;
  email: string;
  before: string[];
  after: string[];
}> = [];
function previewAccessV1(init?: RequestInit): Response {
  if (init?.method === 'PUT' && typeof init.body === 'string') {
    const change = JSON.parse(init.body) as {
      id?: string;
      email: string;
      areas: string[];
      expectedUpdatedAt?: string;
    };
    // A grant shown is changed by its person; a new one by the e-mail typed.
    const before = change.id
      ? previewGrantsV1.find((grant) => grant.id === change.id)
      : previewGrantsV1.find((grant) => grant.email === change.email.trim().toLowerCase());
    if (
      change.id &&
      (!before || (change.expectedUpdatedAt && before.updatedAt !== change.expectedUpdatedAt))
    )
      return json({ state: 'changed' }, 409);
    const email = before?.email ?? change.email.trim().toLowerCase();
    // Only the synthetic school's accounts exist here.
    if (!change.id && !email.endsWith('@escola.example'))
      return json({ state: 'account-not-found' }, 404);
    previewGrantsV1 = previewGrantsV1.filter((grant) => grant !== before);
    if (change.areas.length > 0)
      previewGrantsV1.push({
        id: before?.id ?? crypto.randomUUID(),
        email,
        areas: change.areas,
        updatedAt: new Date().toISOString(),
        updatedBy: 'Administração sintética',
      });
    previewGrantsV1.sort((a, b) => a.email.localeCompare(b.email));
    previewAccessHistoryV1.unshift({
      at: new Date().toISOString(),
      actor: 'Administração sintética',
      email,
      before: before?.areas ?? [],
      after: change.areas,
    });
  }
  return json({ contractVersion: 1, grants: previewGrantsV1, history: previewAccessHistoryV1 });
}

/** The synthetic answer for an API path, or null when this preview has none. */
function answerV1(request: PreviewRequestV1): Promise<Response> | Response | null {
  const { input, init, path, search } = request;
  if (path === '/api/me') return json(identity);
  if (path === '/api/platform/access') return previewAccessV1(init);
  if (path === '/api/platform/groups' && typeof init?.body === 'string') {
    const answer = previewGroupsV1(init.body);
    return json(answer.value, answer.status);
  }
  // The platform summary and the Banco are answered by the local development backend.
  if (path === '/api/platform/bootstrap') return nativeFetch(input, init);
  if (path.startsWith('/api/student-portal/') || path.startsWith('/api/student-photos/'))
    return previewFetch(path + search, init ?? {});
  if (path === '/api/gradebook/view-preferences') return viewPreferencesV1(init);
  if (path === '/api/gradebook/onedrive-sync' && typeof init?.body === 'string')
    return json(previewOneDriveSyncV1(init.body));
  if (path === '/api/gradebook/import-diagnostics' && (init?.method ?? 'GET') === 'GET')
    return json(previewAuditV1());
  if (path.startsWith('/api/gradebook/')) return gradebookV1(request);
  // A healthy system; `?saude=attention` or `?saude=critical` in the address shows the others.
  if (path === '/api/platform/system-health') return json(syntheticHealth());
  if (path === '/api/student-reconciliation/v1' && typeof init?.body === 'string')
    return reconciliationV1(init.body);
  return null;
}

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    window.location.origin,
  );
  // Vite modules, styles and images are real local files.
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/'))
    return nativeFetch(input, init);
  return (
    (await answerV1({ input, init, path: url.pathname, search: url.search })) ??
    unansweredV1(url.pathname)
  );
}) as typeof window.fetch;

/** The live channel has no server here; a socket that never opens keeps the page on its reads. */
class SilentSocket extends EventTarget {
  readyState = 0;
  constructor(readonly url: string | URL) {
    super();
  }
  send() {
    // The preview socket never sends anything.
  }
  close() {
    this.readyState = 3;
  }
}
window.WebSocket = SilentSocket as unknown as typeof WebSocket;

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
