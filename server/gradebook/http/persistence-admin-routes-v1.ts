import { requireAuth } from '../../auth/session';
import type { RuntimeEnv } from '../../env';
import { enforceOfficialOrigin, enforceWriteOrigin, HttpError } from '../../http/security';
import type { GradebookPostgresReadPortV1 } from '../persistence/postgres/postgres-database-v1';
import { authorizeGradebookRuntimeV1, GRADEBOOK_ADMIN_CAPABILITY } from '../authorization-v1';
import { withOfficialGradebookDatabaseV1 } from '../persistence/postgres/official-gradebook-database-v1';

export const GRADEBOOK_PERSISTENCE_STATUS_ROUTE = '/api/gradebook/admin/persistence/status';
export const GRADEBOOK_PERSISTENCE_MIGRATIONS_ROUTE = '/api/gradebook/admin/persistence/migrations';
function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private', Expires: '0', Pragma: 'no-cache',
  } });
}
function unavailable(provider: 'postgres' | 'unconfigured'): Response {
  // Do not log driver errors, connection strings, SQL or student values.
  console.error(JSON.stringify({ message: 'gradebook_persistence_unavailable', provider }));
  return noStoreJson({ state: 'unavailable', provider, error: 'Academic persistence unavailable' }, 503);
}
function requireMethod(request: Request, expected: 'GET' | 'POST'): void {
  if (request.method !== expected) throw new HttpError(405, 'Method not allowed');
}
export async function handleGradebookPersistenceAdminRequestV1(request: Request, env: RuntimeEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== GRADEBOOK_PERSISTENCE_STATUS_ROUTE && pathname !== GRADEBOOK_PERSISTENCE_MIGRATIONS_ROUTE) return null;
  enforceOfficialOrigin(request, env);
  if (pathname === GRADEBOOK_PERSISTENCE_STATUS_ROUTE) requireMethod(request, 'GET');
  else {
    requireMethod(request, 'POST'); enforceWriteOrigin(request, env);
    if (request.body !== null) throw new HttpError(400, 'Request body not allowed');
  }
  const session = await requireAuth(request, env);
  authorizeGradebookRuntimeV1(session);
  if (pathname === GRADEBOOK_PERSISTENCE_MIGRATIONS_ROUTE)
    return noStoreJson({ state: 'retired', provider: 'postgres', message: 'Production migrations use the reviewed deployment process.' }, 410);
  const production = (env.RUNTIME_ENVIRONMENT ?? 'production') === 'production';
  if (env.GRADEBOOK_STORAGE_PROVIDER !== 'postgres' || (production && env.GRADEBOOK_PRODUCTION_ENABLED !== 'true')) {
    return unavailable('unconfigured');
  }
    try {
      return await withOfficialGradebookDatabaseV1(env, async (execution) => {
        const database = execution.GRADEBOOK_DATABASE as GradebookPostgresReadPortV1;
        const started = performance.now();
        const [probe] = await database.query<{ role: string; ready: unknown }>(`SELECT current_user AS role,
          to_regclass('gradebook.nota') IS NOT NULL AND to_regclass('gradebook.fechamento') IS NOT NULL
          AND to_regclass('gradebook.vinculo') IS NOT NULL AS ready`, []);
        const ready = probe?.role === 'gradebook_app' && (probe.ready === true || probe.ready === 1);
        if (!ready) return unavailable('postgres');
        return noStoreJson({ version: '2.0', provider: 'postgres', capability: GRADEBOOK_ADMIN_CAPABILITY,
          environment: env.RUNTIME_ENVIRONMENT ?? 'production', schema: { status: 'ready' },
          observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) });
      });
    } catch { return unavailable('postgres'); }
}
