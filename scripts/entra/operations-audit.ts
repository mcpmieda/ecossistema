import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { graphReadUrlV1 } from './graph-read-url-v1.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type GraphFetcher = typeof fetch;

type KeyCredential = {
  keyId?: string;
  type?: string;
  usage?: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  customKeyIdentifier?: string | null;
};

type PasswordCredential = {
  keyId?: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
};

type RequiredResourceAccess = {
  resourceAppId?: string;
  resourceAccess?: Array<{ id?: string; type?: string }>;
};

type ApplicationResponse = {
  id?: string;
  appId?: string;
  displayName?: string;
  signInAudience?: string;
  web?: { redirectUris?: string[] };
  spa?: { redirectUris?: string[] };
  publicClient?: { redirectUris?: string[] };
  keyCredentials?: KeyCredential[];
  passwordCredentials?: PasswordCredential[];
  requiredResourceAccess?: RequiredResourceAccess[];
};

type ServicePrincipalResponse = {
  id?: string;
  appId?: string;
  displayName?: string;
  accountEnabled?: boolean;
  servicePrincipalType?: string;
};

type AppRoleAssignmentResponse = {
  id?: string;
  appRoleId?: string;
  resourceId?: string;
  createdDateTime?: string | null;
};

type Collection<T> = { value?: T[] };

export type EntraApplicationAudit = {
  id: string;
  appId: string;
  displayName: string;
  signInAudience: string | null;
  redirectUris: {
    web: string[];
    spa: string[];
    publicClient: string[];
  };
  keyCredentials: Array<{
    keyId: string | null;
    type: string | null;
    usage: string | null;
    displayName: string | null;
    startDateTime: string | null;
    endDateTime: string | null;
    customKeyIdentifier: string | null;
  }>;
  passwordCredentials: Array<{
    keyId: string | null;
    displayName: string | null;
    startDateTime: string | null;
    endDateTime: string | null;
  }>;
  requiredResourceAccess: Array<{
    resourceAppId: string;
    resourceAccess: Array<{ id: string; type: string }>;
  }>;
  servicePrincipal: {
    id: string;
    appId: string;
    displayName: string;
    accountEnabled: boolean | null;
    servicePrincipalType: string | null;
    appRoleAssignments: Array<{
      id: string;
      appRoleId: string;
      resourceId: string;
      createdDateTime: string | null;
    }>;
  } | null;
};

export type EntraDriftFinding = {
  severity: 'warning' | 'critical';
  application: 'web' | 'graph' | 'operations' | 'sharepoint';
  code: string;
};

export type EntraDriftAudit = {
  status: 'ok' | 'warning' | 'critical';
  findings: EntraDriftFinding[];
};

export type EntraOperationsIdentityAudit = {
  id: string;
  appId: string;
  displayName: string;
  accountEnabled: boolean | null;
  servicePrincipalType: string | null;
  appRoleAssignments: Array<{
    id: string;
    appRoleId: string;
    resourceId: string;
    createdDateTime: string | null;
  }>;
};

export type EntraSharePointAudit = {
  enabled: boolean;
  status: 'disabled' | 'ok';
  siteId?: string;
  displayName?: string | null;
  webUrl?: string | null;
  visibleListCount?: number;
  isolationProbe: 'not-run' | 'denied';
};

export type EntraOperationsAudit = {
  generatedAt: string;
  applications: {
    web: EntraApplicationAudit;
    graph: EntraApplicationAudit;
  };
  operationsIdentity: EntraOperationsIdentityAudit;
  sharePoint: EntraSharePointAudit;
  drift: EntraDriftAudit;
};

export class EntraOperationsAuditError extends Error {
  readonly stage: string;
  readonly status?: number;

  constructor(stage: string, status?: number) {
    super(status ? `Entra operations audit failed at ${stage} (${status})` : `Entra operations audit failed at ${stage}`);
    this.name = 'EntraOperationsAuditError';
    this.stage = stage;
    this.status = status;
  }
}

const EXPECTED_APPLICATIONS = {
  web: {
    appId: '78185e20-c824-4acc-9ccd-41b9f7509a6f',
    displayName: 'Ecossistema Escolar - Web',
    signInAudience: 'AzureADMyOrg',
    redirectUris: {
      web: ['https://admin.escolaieda.com/auth/callback'],
      spa: [],
      publicClient: [],
    },
  },
  graph: {
    appId: '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
    displayName: 'Ecossistema Escolar - Graph Backend',
    signInAudience: 'AzureADMyOrg',
    redirectUris: {
      web: [],
      spa: [],
      publicClient: [],
    },
  },
} as const;

const EXPECTED_OPERATIONS_DISPLAY_NAME = 'Ecossistema Operations - GitHub OIDC';
const APPLICATION_READ_ALL_ROLE_ID = '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30';
const SITES_SELECTED_ROLE_ID = '883ea226-0bf2-4a8f-9f9d-92c9162a727d';

const EXPECTED_SHAREPOINT_SITE_ID =
  'eduieda.sharepoint.com,d8cb46fa-e401-40a9-9f81-876d59e8cbb0,89a47a04-34fa-4877-8a3c-00d35d246c56';
const SHAREPOINT_ISOLATION_PROBE_SITE_ID =
  'eduieda.sharepoint.com,bc1489eb-2358-475f-a3b6-674e42eb7e53,f3e8239e-3ed7-4eb1-8774-e14743bc0d45';

const BROAD_APPLICATION_PERMISSIONS = new Set([
  '7ab1d382-f21e-4acd-a863-ba3e13f7da61', // Directory.Read.All
  '332a536c-c7ef-4017-ab91-336970924f0d', // Sites.Read.All
  '9492366f-7969-46a4-8d15-ed1a20078fff', // Sites.ReadWrite.All
  'a82116e5-55eb-4c41-a434-62fe8a61c773', // Sites.FullControl.All
  '0c0bf378-bf22-4481-8f81-9e89a9b4960a', // Sites.Manage.All
  '01d4889c-1287-42c6-ac1f-5d1e02578ef6', // Files.Read.All
  '75359482-378d-4052-8f01-80520e7db3cd', // Files.ReadWrite.All
]);

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function auditDrift(
  applications: { web: EntraApplicationAudit; graph: EntraApplicationAudit },
  operationsIdentity: EntraOperationsIdentityAudit,
  sharePointAuditEnabled: boolean,
  now: Date,
): EntraDriftAudit {
  const findings: EntraDriftFinding[] = [];
  const add = (
    application: EntraDriftFinding['application'],
    severity: EntraDriftFinding['severity'],
    code: string,
  ) => findings.push({ application, severity, code });

  for (const label of ['web', 'graph'] as const) {
    const actual = applications[label];
    const expected = EXPECTED_APPLICATIONS[label];

    if (actual.appId !== expected.appId) add(label, 'critical', 'app-id-mismatch');
    if (actual.displayName !== expected.displayName) add(label, 'warning', 'display-name-drift');
    if (actual.signInAudience !== expected.signInAudience)
      add(label, 'critical', 'sign-in-audience-drift');

    for (const surface of ['web', 'spa', 'publicClient'] as const) {
      if (!sameStrings(actual.redirectUris[surface], expected.redirectUris[surface]))
        add(label, 'critical', `redirect-uri-${surface}-drift`);
    }

    if (!actual.servicePrincipal) add(label, 'critical', 'service-principal-missing');
    else if (actual.servicePrincipal.accountEnabled === false)
      add(label, 'critical', 'service-principal-disabled');

    if (actual.passwordCredentials.length > 0)
      add(label, 'warning', 'password-credential-present');
    if (actual.keyCredentials.length === 0)
      add(label, 'critical', 'certificate-credential-missing');

    for (const credential of actual.keyCredentials) {
      if (!credential.endDateTime) continue;
      const remaining = new Date(credential.endDateTime).getTime() - now.getTime();
      if (!Number.isFinite(remaining)) {
        add(label, 'warning', 'certificate-expiry-invalid');
        continue;
      }
      if (remaining <= 0) add(label, 'critical', 'certificate-expired');
      else if (remaining <= 45 * 24 * 60 * 60 * 1000)
        add(label, 'warning', 'certificate-expiring-soon');
    }

    for (const assignment of actual.servicePrincipal?.appRoleAssignments ?? []) {
      if (BROAD_APPLICATION_PERMISSIONS.has(assignment.appRoleId))
        add(label, 'warning', 'broad-application-permission-present');
    }
  }

  if (operationsIdentity.displayName !== EXPECTED_OPERATIONS_DISPLAY_NAME)
    add('operations', 'warning', 'display-name-drift');
  if (operationsIdentity.accountEnabled === false)
    add('operations', 'critical', 'service-principal-disabled');

  const operationsRoles = new Set(
    operationsIdentity.appRoleAssignments.map((assignment) => assignment.appRoleId),
  );
  if (!operationsRoles.has(APPLICATION_READ_ALL_ROLE_ID))
    add('operations', 'critical', 'application-read-all-missing');
  if (sharePointAuditEnabled && !operationsRoles.has(SITES_SELECTED_ROLE_ID))
    add('operations', 'critical', 'sites-selected-missing');

  const allowedOperationsRoles = new Set([
    APPLICATION_READ_ALL_ROLE_ID,
    SITES_SELECTED_ROLE_ID,
  ]);
  for (const roleId of operationsRoles) {
    if (!allowedOperationsRoles.has(roleId))
      add('operations', 'critical', 'unexpected-application-permission');
  }

  const status = findings.some((finding) => finding.severity === 'critical')
    ? 'critical'
    : findings.some((finding) => finding.severity === 'warning')
      ? 'warning'
      : 'ok';
  return { status, findings };
}

function requiredUuid(value: string, name: string): string {
  const normalized = value.trim();
  if (!UUID.test(normalized)) throw new EntraOperationsAuditError(`invalid-${name}`);
  return normalized;
}

async function graphJson<T>(
  fetcher: GraphFetcher,
  token: string,
  path: string,
  stage: string,
): Promise<T> {
  // graphReadUrlV1 allows only fixed Graph read paths on the Graph origin.
  const response = await fetcher(graphReadUrlV1(path), { // NOSONAR
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new EntraOperationsAuditError(stage, response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new EntraOperationsAuditError(`${stage}-invalid-json`);
  }
}

async function graphStatus(
  fetcher: GraphFetcher,
  token: string,
  path: string,
  stage: string,
): Promise<number> {
  let response: Response;
  try {
    response = await fetcher(graphReadUrlV1(path), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EntraOperationsAuditError(`${stage}-transport`);
  }
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

function sanitizedAssignments(
  assignments: AppRoleAssignmentResponse[],
): EntraOperationsIdentityAudit['appRoleAssignments'] {
  return assignments.flatMap((assignment) =>
    assignment.id && assignment.appRoleId && assignment.resourceId
      ? [{
          id: assignment.id,
          appRoleId: assignment.appRoleId,
          resourceId: assignment.resourceId,
          createdDateTime: assignment.createdDateTime ?? null,
        }]
      : [],
  );
}

async function readOperationsIdentity(
  fetcher: GraphFetcher,
  token: string,
  appId: string,
): Promise<EntraOperationsIdentityAudit> {
  const select = 'id,appId,displayName,accountEnabled,servicePrincipalType';
  const filter = `appId eq '${appId.replaceAll("'", "''")}'`;
  const principals = await graphJson<Collection<ServicePrincipalResponse>>(
    fetcher,
    token,
    `/servicePrincipals?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$top=2`,
    'operations-service-principal',
  );
  const values = principals.value ?? [];
  if (values.length !== 1)
    throw new EntraOperationsAuditError(
      values.length === 0
        ? 'operations-service-principal-missing'
        : 'operations-service-principal-ambiguous',
    );
  const principal = values[0]!;
  if (!principal.id || !principal.appId || !principal.displayName)
    throw new EntraOperationsAuditError('operations-service-principal-invalid');

  const assignments = await graphJson<Collection<AppRoleAssignmentResponse>>(
    fetcher,
    token,
    `/servicePrincipals/${encodeURIComponent(principal.id)}/appRoleAssignments?$select=id,appRoleId,resourceId,createdDateTime&$top=100`,
    'operations-app-role-assignments',
  );

  return {
    id: principal.id,
    appId: principal.appId,
    displayName: principal.displayName,
    accountEnabled:
      typeof principal.accountEnabled === 'boolean' ? principal.accountEnabled : null,
    servicePrincipalType: principal.servicePrincipalType ?? null,
    appRoleAssignments: sanitizedAssignments(assignments.value ?? []),
  };
}

async function auditSharePoint(
  fetcher: GraphFetcher,
  token: string,
  enabled: boolean,
): Promise<EntraSharePointAudit> {
  if (!enabled) {
    return { enabled: false, status: 'disabled', isolationProbe: 'not-run' };
  }

  const select = encodeURIComponent('id,displayName,webUrl');
  const site = await graphJson<{ id?: string; displayName?: string; webUrl?: string }>(
    fetcher,
    token,
    `/sites/${encodeURIComponent(EXPECTED_SHAREPOINT_SITE_ID)}?$select=${select}`,
    'sharepoint-selected-site',
  );
  if (site.id !== EXPECTED_SHAREPOINT_SITE_ID)
    throw new EntraOperationsAuditError('sharepoint-selected-site-mismatch');

  const lists = await graphJson<Collection<{ id?: string }>>(
    fetcher,
    token,
    `/sites/${encodeURIComponent(EXPECTED_SHAREPOINT_SITE_ID)}/lists?$select=id&$top=20`,
    'sharepoint-selected-site-lists',
  );
  if (!Array.isArray(lists.value))
    throw new EntraOperationsAuditError('sharepoint-selected-site-lists-invalid');

  const isolationStatus = await graphStatus(
    fetcher,
    token,
    `/sites/${encodeURIComponent(SHAREPOINT_ISOLATION_PROBE_SITE_ID)}?$select=id`,
    'sharepoint-isolation-probe',
  );
  if (isolationStatus >= 200 && isolationStatus < 300)
    throw new EntraOperationsAuditError('sharepoint-broad-access-detected');
  if (isolationStatus !== 403 && isolationStatus !== 404)
    throw new EntraOperationsAuditError('sharepoint-isolation-probe', isolationStatus);

  return {
    enabled: true,
    status: 'ok',
    siteId: site.id,
    displayName: site.displayName ?? null,
    webUrl: site.webUrl ?? null,
    visibleListCount: lists.value.length,
    isolationProbe: 'denied',
  };
}

function sanitizeApplication(
  app: ApplicationResponse,
  servicePrincipal: ServicePrincipalResponse | null,
  appRoleAssignments: AppRoleAssignmentResponse[],
): EntraApplicationAudit {
  if (!app.id || !app.appId || !app.displayName) throw new EntraOperationsAuditError('invalid-application-response');
  return {
    id: app.id,
    appId: app.appId,
    displayName: app.displayName,
    signInAudience: app.signInAudience ?? null,
    redirectUris: {
      web: [...(app.web?.redirectUris ?? [])],
      spa: [...(app.spa?.redirectUris ?? [])],
      publicClient: [...(app.publicClient?.redirectUris ?? [])],
    },
    keyCredentials: (app.keyCredentials ?? []).map((credential) => ({
      keyId: credential.keyId ?? null,
      type: credential.type ?? null,
      usage: credential.usage ?? null,
      displayName: credential.displayName ?? null,
      startDateTime: credential.startDateTime ?? null,
      endDateTime: credential.endDateTime ?? null,
      customKeyIdentifier: credential.customKeyIdentifier ?? null,
    })),
    passwordCredentials: (app.passwordCredentials ?? []).map((credential) => ({
      keyId: credential.keyId ?? null,
      displayName: credential.displayName ?? null,
      startDateTime: credential.startDateTime ?? null,
      endDateTime: credential.endDateTime ?? null,
    })),
    requiredResourceAccess: (app.requiredResourceAccess ?? []).flatMap((entry) =>
      entry.resourceAppId
        ? [{
            resourceAppId: entry.resourceAppId,
            resourceAccess: (entry.resourceAccess ?? []).flatMap((permission) =>
              permission.id && permission.type ? [{ id: permission.id, type: permission.type }] : [],
            ),
          }]
        : [],
    ),
    servicePrincipal:
      servicePrincipal?.id && servicePrincipal.appId && servicePrincipal.displayName
        ? {
            id: servicePrincipal.id,
            appId: servicePrincipal.appId,
            displayName: servicePrincipal.displayName,
            accountEnabled:
              typeof servicePrincipal.accountEnabled === 'boolean' ? servicePrincipal.accountEnabled : null,
            servicePrincipalType: servicePrincipal.servicePrincipalType ?? null,
            appRoleAssignments: sanitizedAssignments(appRoleAssignments),
          }
        : null,
  };
}

async function readExactApplication(
  fetcher: GraphFetcher,
  token: string,
  objectId: string,
  label: 'web' | 'graph',
): Promise<EntraApplicationAudit> {
  const select = [
    'id',
    'appId',
    'displayName',
    'signInAudience',
    'web',
    'spa',
    'publicClient',
    'keyCredentials',
    'passwordCredentials',
    'requiredResourceAccess',
  ].join(',');
  const app = await graphJson<ApplicationResponse>(
    fetcher,
    token,
    `/applications/${encodeURIComponent(objectId)}?$select=${encodeURIComponent(select)}`,
    `${label}-application`,
  );
  if (!app.appId) throw new EntraOperationsAuditError(`${label}-application-invalid`);

  const spSelect = 'id,appId,displayName,accountEnabled,servicePrincipalType';
  const filter = `appId eq '${app.appId.replaceAll("'", "''")}'`;
  const principals = await graphJson<Collection<ServicePrincipalResponse>>(
    fetcher,
    token,
    `/servicePrincipals?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(spSelect)}&$top=2`,
    `${label}-service-principal`,
  );
  const values = principals.value ?? [];
  if (values.length > 1) throw new EntraOperationsAuditError(`${label}-service-principal-ambiguous`);
  const servicePrincipal = values[0] ?? null;
  const assignments = servicePrincipal?.id
    ? await graphJson<Collection<AppRoleAssignmentResponse>>(
        fetcher,
        token,
        `/servicePrincipals/${encodeURIComponent(servicePrincipal.id)}/appRoleAssignments?$select=id,appRoleId,resourceId,createdDateTime&$top=100`,
        `${label}-app-role-assignments`,
      )
    : { value: [] };
  return sanitizeApplication(app, servicePrincipal, assignments.value ?? []);
}

export async function auditEntraOperations(input: {
  accessToken: string;
  webApplicationObjectId: string;
  graphApplicationObjectId: string;
  operationsClientId: string;
  sharePointAuditEnabled?: boolean;
  fetcher?: GraphFetcher;
  now?: () => Date;
}): Promise<EntraOperationsAudit> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) throw new EntraOperationsAuditError('missing-access-token');
  const webObjectId = requiredUuid(input.webApplicationObjectId, 'web-object-id');
  const graphObjectId = requiredUuid(input.graphApplicationObjectId, 'graph-object-id');
  const operationsClientId = requiredUuid(input.operationsClientId, 'operations-client-id');
  if (webObjectId === graphObjectId) throw new EntraOperationsAuditError('duplicate-object-id');

  const fetcher = input.fetcher ?? fetch;
  const sharePointAuditEnabled = input.sharePointAuditEnabled === true;
  const [web, graph, operationsIdentity, sharePoint] = await Promise.all([
    readExactApplication(fetcher, accessToken, webObjectId, 'web'),
    readExactApplication(fetcher, accessToken, graphObjectId, 'graph'),
    readOperationsIdentity(fetcher, accessToken, operationsClientId),
    auditSharePoint(fetcher, accessToken, sharePointAuditEnabled),
  ]);

  const now = (input.now ?? (() => new Date()))();
  const applications = { web, graph };
  return {
    generatedAt: now.toISOString(),
    applications,
    operationsIdentity,
    sharePoint,
    drift: auditDrift(applications, operationsIdentity, sharePointAuditEnabled, now),
  };
}

async function main(): Promise<void> {
  const accessToken = process.env.GRAPH_ACCESS_TOKEN ?? '';
  const webApplicationObjectId = process.env.WEB_APPLICATION_OBJECT_ID ?? '';
  const graphApplicationObjectId = process.env.GRAPH_APPLICATION_OBJECT_ID ?? '';
  const operationsClientId = process.env.ENTRA_OPERATIONS_CLIENT_ID ?? '';
  const sharePointAuditEnabled = process.env.ENTRA_SHAREPOINT_AUDIT_ENABLED === 'true';
  const result = await auditEntraOperations({
    accessToken,
    webApplicationObjectId,
    graphApplicationObjectId,
    operationsClientId,
    sharePointAuditEnabled,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const safe =
      error instanceof EntraOperationsAuditError
        ? error.message
        : 'Entra operations audit failed unexpectedly';
    console.error(safe);
    process.exitCode = 1;
  });
}
