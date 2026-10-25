import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { graphReadUrlV1 } from './graph-read-url-v1.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const APPLICATION_READWRITE_OWNED_BY = '18a4783c-866b-4cc7-a460-3d5e5662c884';
const EXPECTED_MAINTENANCE_NAME = 'Ecossistema Maintenance - GitHub OIDC';

const EXPECTED_TARGETS = {
  web: {
    appId: '78185e20-c824-4acc-9ccd-41b9f7509a6f',
    displayName: 'Ecossistema Escolar - Web',
  },
  graph: {
    appId: '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
    displayName: 'Ecossistema Escolar - Graph Backend',
  },
} as const;

type GraphFetcher = typeof fetch;
type Collection<T> = { value?: T[]; '@odata.nextLink'?: string };

type ServicePrincipal = {
  id?: string;
  appId?: string;
  displayName?: string;
  accountEnabled?: boolean;
  servicePrincipalType?: string;
};

type AppRoleAssignment = {
  id?: string;
  appRoleId?: string;
  resourceId?: string;
};

type OwnedObject = {
  id?: string;
};

type KeyCredential = {
  keyId?: string;
  type?: string;
  usage?: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  customKeyIdentifier?: string | null;
  key?: string | null;
};

type Application = {
  id?: string;
  appId?: string;
  displayName?: string;
  keyCredentials?: KeyCredential[];
  passwordCredentials?: unknown[];
};

export type MaintenanceTargetPlan = {
  objectId: string;
  appId: string;
  displayName: string;
  keyCredentials: Array<{
    keyId: string | null;
    type: string | null;
    usage: string | null;
    displayName: string | null;
    startDateTime: string | null;
    endDateTime: string | null;
    customKeyIdentifier: string | null;
  }>;
  passwordCredentialCount: number;
  certificateMaterialReadableCount: number;
  allCertificateMaterialReadable: boolean;
};

export type EntraMaintenancePlan = {
  generatedAt: string;
  status: 'ready';
  identity: {
    clientId: string;
    servicePrincipalId: string;
    displayName: string;
    applicationPermissions: ['Application.ReadWrite.OwnedBy'];
    ownedApplicationObjectIds: string[];
  };
  targets: {
    web: MaintenanceTargetPlan;
    graph: MaintenanceTargetPlan;
  };
};

export class EntraMaintenancePlanError extends Error {
  readonly stage: string;
  readonly status?: number;

  constructor(stage: string, status?: number) {
    super(status ? `Entra maintenance dry-run failed at ${stage} (${status})` : `Entra maintenance dry-run failed at ${stage}`);
    this.name = 'EntraMaintenancePlanError';
    this.stage = stage;
    this.status = status;
  }
}

function requiredUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!UUID.test(normalized)) throw new EntraMaintenancePlanError(`invalid-${name}`);
  return normalized;
}

async function graphJson<T>(
  fetcher: GraphFetcher,
  token: string,
  path: string,
  stage: string,
): Promise<T> {
  let response: Response;
  try {
    // graphReadUrlV1 allows only fixed Graph read paths on the Graph origin.
    response = await fetcher(graphReadUrlV1(path), { // NOSONAR
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EntraMaintenancePlanError(`${stage}-transport`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EntraMaintenancePlanError(stage, response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new EntraMaintenancePlanError(`${stage}-invalid-json`);
  }
}

async function readMaintenanceIdentity(
  fetcher: GraphFetcher,
  token: string,
  clientId: string,
): Promise<{
  servicePrincipalId: string;
  displayName: string;
  assignments: AppRoleAssignment[];
}> {
  const filter = `appId eq '${clientId.replaceAll("'", "''")}'`;
  const select = 'id,appId,displayName,accountEnabled,servicePrincipalType';
  const principals = await graphJson<Collection<ServicePrincipal>>(
    fetcher,
    token,
    `/servicePrincipals?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$top=2`,
    'maintenance-service-principal',
  );
  const values = principals.value ?? [];
  if (values.length !== 1) {
    throw new EntraMaintenancePlanError(
      values.length === 0
        ? 'maintenance-service-principal-missing'
        : 'maintenance-service-principal-ambiguous',
    );
  }
  const principal = values[0]!;
  if (
    !principal.id ||
    principal.appId !== clientId ||
    principal.displayName !== EXPECTED_MAINTENANCE_NAME ||
    principal.accountEnabled === false
  ) {
    throw new EntraMaintenancePlanError('maintenance-service-principal-invalid');
  }

  const assignments = await graphJson<Collection<AppRoleAssignment>>(
    fetcher,
    token,
    `/servicePrincipals/${encodeURIComponent(principal.id)}/appRoleAssignments?$select=id,appRoleId,resourceId&$top=100`,
    'maintenance-app-role-assignments',
  );
  if (assignments['@odata.nextLink']) {
    throw new EntraMaintenancePlanError('maintenance-app-role-assignments-capacity');
  }
  return {
    servicePrincipalId: principal.id,
    displayName: principal.displayName,
    assignments: assignments.value ?? [],
  };
}

function proveMinimalPermission(assignments: AppRoleAssignment[]): void {
  if (
    assignments.length !== 1 ||
    assignments[0]?.appRoleId !== APPLICATION_READWRITE_OWNED_BY ||
    !assignments[0]?.resourceId
  ) {
    throw new EntraMaintenancePlanError('maintenance-permission-drift');
  }
}

async function proveExactOwnership(
  fetcher: GraphFetcher,
  token: string,
  servicePrincipalId: string,
  expectedObjectIds: readonly string[],
): Promise<string[]> {
  const owned = await graphJson<Collection<OwnedObject>>(
    fetcher,
    token,
    `/servicePrincipals/${encodeURIComponent(servicePrincipalId)}/ownedObjects?$select=id&$top=100`,
    'maintenance-owned-objects',
  );
  if (owned['@odata.nextLink']) {
    throw new EntraMaintenancePlanError('maintenance-owned-objects-capacity');
  }
  const actual = (owned.value ?? []).map((value) => value.id ?? '');
  if (actual.some((id) => !UUID.test(id))) {
    throw new EntraMaintenancePlanError('maintenance-owned-objects-invalid');
  }
  const sortedActual = [...actual].sort((left, right) => left.localeCompare(right));
  const sortedExpected = [...expectedObjectIds].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new EntraMaintenancePlanError('maintenance-ownership-mismatch');
  }
  return sortedActual;
}

async function readTarget(
  fetcher: GraphFetcher,
  token: string,
  objectId: string,
  label: keyof typeof EXPECTED_TARGETS,
): Promise<MaintenanceTargetPlan> {
  const select = 'id,appId,displayName,keyCredentials,passwordCredentials';
  const app = await graphJson<Application>(
    fetcher,
    token,
    `/applications/${encodeURIComponent(objectId)}?$select=${encodeURIComponent(select)}`,
    `${label}-application`,
  );
  const expected = EXPECTED_TARGETS[label];
  if (
    app.id !== objectId ||
    app.appId !== expected.appId ||
    app.displayName !== expected.displayName
  ) {
    throw new EntraMaintenancePlanError(`${label}-application-mismatch`);
  }
  const rawKeyCredentials = app.keyCredentials ?? [];
  const keyCredentials = rawKeyCredentials.map((credential) => ({
    keyId: credential.keyId ?? null,
    type: credential.type ?? null,
    usage: credential.usage ?? null,
    displayName: credential.displayName ?? null,
    startDateTime: credential.startDateTime ?? null,
    endDateTime: credential.endDateTime ?? null,
    customKeyIdentifier: credential.customKeyIdentifier ?? null,
  }));
  if (keyCredentials.length === 0) {
    throw new EntraMaintenancePlanError(`${label}-certificate-missing`);
  }
  const certificateMaterialReadableCount = rawKeyCredentials.filter(
    (credential) => typeof credential.key === 'string' && credential.key.length > 0,
  ).length;
  return {
    objectId,
    appId: app.appId,
    displayName: app.displayName,
    keyCredentials,
    passwordCredentialCount: (app.passwordCredentials ?? []).length,
    certificateMaterialReadableCount,
    allCertificateMaterialReadable:
      certificateMaterialReadableCount === rawKeyCredentials.length,
  };
}

export async function buildMaintenancePlan(input: {
  accessToken: string;
  maintenanceClientId: string;
  webApplicationObjectId: string;
  graphApplicationObjectId: string;
  fetcher?: GraphFetcher;
  now?: () => Date;
}): Promise<EntraMaintenancePlan> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) throw new EntraMaintenancePlanError('missing-access-token');
  const maintenanceClientId = requiredUuid(input.maintenanceClientId, 'maintenance-client-id');
  const webObjectId = requiredUuid(input.webApplicationObjectId, 'web-object-id');
  const graphObjectId = requiredUuid(input.graphApplicationObjectId, 'graph-object-id');
  if (webObjectId === graphObjectId) throw new EntraMaintenancePlanError('duplicate-target-object-id');

  const fetcher = input.fetcher ?? fetch;
  const identity = await readMaintenanceIdentity(fetcher, accessToken, maintenanceClientId);
  proveMinimalPermission(identity.assignments);
  const ownedApplicationObjectIds = await proveExactOwnership(
    fetcher,
    accessToken,
    identity.servicePrincipalId,
    [webObjectId, graphObjectId],
  );
  const [web, graph] = await Promise.all([
    readTarget(fetcher, accessToken, webObjectId, 'web'),
    readTarget(fetcher, accessToken, graphObjectId, 'graph'),
  ]);

  return {
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    status: 'ready',
    identity: {
      clientId: maintenanceClientId,
      servicePrincipalId: identity.servicePrincipalId,
      displayName: identity.displayName,
      applicationPermissions: ['Application.ReadWrite.OwnedBy'],
      ownedApplicationObjectIds,
    },
    targets: { web, graph },
  };
}

async function main(): Promise<void> {
  const result = await buildMaintenancePlan({
    accessToken: process.env.GRAPH_ACCESS_TOKEN ?? '',
    maintenanceClientId: process.env.ENTRA_MAINTENANCE_CLIENT_ID ?? '',
    webApplicationObjectId: process.env.WEB_APPLICATION_OBJECT_ID ?? '',
    graphApplicationObjectId: process.env.GRAPH_APPLICATION_OBJECT_ID ?? '',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error: unknown) {
    const safe =
      error instanceof EntraMaintenancePlanError
        ? error.message
        : 'Entra maintenance dry-run failed unexpectedly';
    console.error(safe);
    process.exitCode = 1;
  }
}
