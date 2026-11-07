import type { RuntimeEnv } from '../../../env';
import { createGradebookPostgresDatabaseV1, type GradebookPostgresFailureDiagnosticV1,
  type GradebookPostgresDatabaseV1 } from './postgres-database-v1';
import { lazyGradebookDatabaseV1 } from './lazy-gradebook-database-v1';

type GradebookStorageProviderV1 = 'postgres';
type HyperdriveBindingV1 = { readonly connectionString: string };
type OfficialGradebookDatabaseDependenciesV1 = {
  readonly createPostgresDatabase?: (connectionString: string) => Promise<GradebookPostgresDatabaseV1>;
};
function requireHyperdriveConnectionString(env: RuntimeEnv): string {
  const binding = env.PROD_DB as Partial<HyperdriveBindingV1> | undefined;
  if (!binding || typeof binding.connectionString !== 'string' || binding.connectionString === '')
    throw new Error('gradebook-official-postgres-binding-missing');
  return binding.connectionString;
}
export const GRADEBOOK_POSTGRES_FAILURE_HEADER_V1 = 'X-Gradebook-Postgres-Failure';
function withProviderHeader(response: Response, provider: GradebookStorageProviderV1 | 'unconfigured',
  diagnostic: GradebookPostgresFailureDiagnosticV1 | null = null): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Gradebook-Storage-Provider', provider);
  if (diagnostic !== null) headers.set(GRADEBOOK_POSTGRES_FAILURE_HEADER_V1, JSON.stringify(diagnostic));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** PostgreSQL is the only supported provider in every environment.
 * Invalid configuration never exposes the historical binding, but also never bypasses
 * the handler's authentication, input validation or operation-specific failure DTO.
 */
export async function withOfficialGradebookDatabaseV1(env: RuntimeEnv,
  operation: (executionEnv: RuntimeEnv) => Promise<Response | null>,
  dependencies: OfficialGradebookDatabaseDependenciesV1 = {}): Promise<Response | null> {
  const provider = env.GRADEBOOK_STORAGE_PROVIDER;
  const configured = provider === 'postgres';
  const database = lazyGradebookDatabaseV1(async () => {
    if (!configured) throw new Error('gradebook-official-postgres-provider-required');
    const create = dependencies.createPostgresDatabase ?? createGradebookPostgresDatabaseV1;
    return create(requireHyperdriveConnectionString(env));
  });
  // Copy descriptors rather than evaluating a potentially live legacy-binding getter.
  const execution = Object.create(Object.getPrototypeOf(env), {
    ...Object.getOwnPropertyDescriptors(env),
    GRADEBOOK_DATABASE: { value: database, enumerable: true, configurable: true },
    GRADEBOOK_D1: { value: undefined, enumerable: true, configurable: true },
  }) as RuntimeEnv;
  try {
    const response = await operation(execution);
    if (!response) return null;
    if (!configured && response.ok) return Response.json({ state: 'unavailable',
      error: 'Academic PostgreSQL configuration required' }, { status: 503,
      headers: { 'Cache-Control': 'no-store', 'X-Gradebook-Storage-Provider': 'unconfigured' } });
    return withProviderHeader(response, configured ? 'postgres' : 'unconfigured',
      response.status >= 500 ? database.lastFailure() : null);
  } finally { await database.close(); }
}
