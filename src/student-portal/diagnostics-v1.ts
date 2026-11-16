import {
  FRONTEND_DIAGNOSTIC_ROUTE_V1,
  type FrontendDiagnosticCategoryV1,
} from '../../shared/frontend-diagnostic-v1';

let sink: ((category: FrontendDiagnosticCategoryV1) => void) | null = null;
const moduleErrors = new WeakSet<object>();
/** No startup request, persistent ID, original error, URL, session, or retry queue. */
export function enableStudentDiagnosticsV1(fetcher: typeof fetch = fetch): () => void {
  const sent = new Set<FrontendDiagnosticCategoryV1>();
  const active = new Set<AbortController>();
  const report = (category: FrontendDiagnosticCategoryV1) => {
    if (sent.has(category) || sent.size >= 3 || navigator.onLine === false) return;
    sent.add(category);
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), 2000);
    void Promise.resolve()
      .then(() =>
        fetcher(FRONTEND_DIAGNOSTIC_ROUTE_V1, {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            area: 'student-portal',
            category,
            release: 'portal-signals-v1',
            correlationId: crypto.randomUUID(),
          }),
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        active.delete(controller);
      });
  };
  sink = report;
  return () => {
    if (sink === report) sink = null;
    for (const controller of active) controller.abort();
    active.clear();
  };
}
export function reportStudentDiagnosticV1(category: FrontendDiagnosticCategoryV1): void {
  try {
    sink?.(category);
  } catch {
    /* Diagnostic failures must never affect the Portal. */
  }
}
export function markStudentModuleFailureV1(error: unknown): never {
  if (typeof error === 'object' && error !== null) moduleErrors.add(error);
  reportStudentDiagnosticV1('module-load');
  throw error;
}
export function isStudentModuleFailureV1(error: unknown): boolean {
  return typeof error === 'object' && error !== null && moduleErrors.has(error);
}
/** Uses the existing transport request exactly once and never inspects a body. */
export async function diagnosticStudentFetchV1(path: string, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(path, init);
    if (!init.signal?.aborted && response.status >= 500) reportStudentDiagnosticV1('read');
    return response;
  } catch (error) {
    if (!init.signal?.aborted) reportStudentDiagnosticV1('read');
    throw error;
  }
}
