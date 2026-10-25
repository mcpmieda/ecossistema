import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export type CloudflareTokenKindV1 = 'deploy' | 'hyperdrive';
export type CloudflareCapabilityStateV1 =
  | 'accessible'
  | 'permission-required'
  | 'inconclusive'
  | 'unavailable'
  | 'credential-missing';
export type CloudflareResourceStateV1 = CloudflareCapabilityStateV1 | 'not-found';

export type CloudflareCapabilityV1 = {
  id:
    | 'workers.scripts.read'
    | 'pages.projects.read'
    | 'hyperdrive.configs.read'
    | 'zones.read'
    | 'analytics.workers.read';
  label: string;
  state: CloudflareCapabilityStateV1;
};

export type CloudflareProbeResultV1 = {
  contractVersion: 1;
  tokenKind: CloudflareTokenKindV1;
  checkedAt: string;
  capabilities: CloudflareCapabilityV1[];
};

export type CloudflarePortalDeployResultV1 = {
  contractVersion: 1;
  operation: 'portal-deploy';
  checkedAt: string;
  worker: {
    state: CloudflareResourceStateV1;
    present?: boolean;
    modifiedAt?: string | null;
    compatibilityDate?: string | null;
  };
  pages: {
    state: CloudflareResourceStateV1;
    present?: boolean;
    productionBranch?: string | null;
    deploymentStatus?: string | null;
    deploymentCreatedAt?: string | null;
  };
  analytics: {
    state: CloudflareCapabilityStateV1;
    windowMinutes: 60;
    requests?: number;
    errors?: number;
    maxCpuTimeP50?: number;
    maxCpuTimeP99?: number;
  };
};

export type CloudflarePortalHyperdriveResultV1 = {
  contractVersion: 1;
  operation: 'portal-hyperdrive';
  checkedAt: string;
  hyperdrive: {
    state: CloudflareResourceStateV1;
    present?: boolean;
    cacheDisabled?: boolean;
    originConnections?: number;
  };
};

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const PORTAL_WORKER = 'student-portal-production';
const PORTAL_PAGES = 'student-portal-edge';
const PORTAL_HYPERDRIVE_ID = '46ac2fcb25ad4ad5b5662d536ccd968a';

const definitions = [
  { id: 'workers.scripts.read', label: 'Workers scripts' },
  { id: 'pages.projects.read', label: 'Pages projects' },
  { id: 'hyperdrive.configs.read', label: 'Hyperdrive configs' },
  { id: 'zones.read', label: 'Zones' },
  { id: 'analytics.workers.read', label: 'Workers analytics' },
] as const;

function stateForStatusV1(status: number): CloudflareCapabilityStateV1 {
  if (status === 401 || status === 403) return 'permission-required';
  if (status === 429 || status >= 500) return 'unavailable';
  return status >= 200 && status < 300 ? 'accessible' : 'unavailable';
}

function resourceStateForStatusV1(status: number): CloudflareResourceStateV1 {
  if (status === 404) return 'not-found';
  return stateForStatusV1(status);
}

function asObjectV1(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asStringV1(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 160 ? value : null;
}

function asNonNegativeNumberV1(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function readJsonV1(response: Response): Promise<JsonObject | null> {
  try {
    return asObjectV1((await response.json()) as unknown);
  } catch {
    return null;
  }
}

async function restProbeV1(
  url: string,
  token: string,
  fetcher: Fetcher,
): Promise<CloudflareCapabilityStateV1> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const state = stateForStatusV1(response.status);
    if (state !== 'accessible') {
      await response.body?.cancel();
      return state;
    }
    const body = await readJsonV1(response);
    if (body && body.success === false) return 'inconclusive';
    return 'accessible';
  } catch {
    return 'unavailable';
  }
}

async function readRestResourceV1(
  url: string,
  token: string,
  fetcher: Fetcher,
): Promise<{ state: CloudflareResourceStateV1; body: JsonObject | null }> {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const state = resourceStateForStatusV1(response.status);
    if (state !== 'accessible') {
      await response.body?.cancel();
      return { state, body: null };
    }
    const body = await readJsonV1(response);
    if (!body || body.success === false) return { state: 'inconclusive', body: null };
    return { state: 'accessible', body };
  } catch {
    return { state: 'unavailable', body: null };
  }
}

function capabilityAnalyticsBodyV1(accountId: string, now: Date) {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 5 * 60_000).toISOString();
  return {
    query:
      'query CapabilityProbe($accountTag: string, $datetimeStart: string, $datetimeEnd: string) {' +
      ' viewer { accounts(filter: { accountTag: $accountTag }) {' +
      ' workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {' +
      ' sum { requests } } } } }',
    variables: { accountTag: accountId, datetimeStart: start, datetimeEnd: end },
  };
}

function portalAnalyticsBodyV1(accountId: string, now: Date) {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 60 * 60_000).toISOString();
  return {
    query:
      'query PortalWorkerMetrics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {' +
      ' viewer { accounts(filter: { accountTag: $accountTag }) {' +
      ' workersInvocationsAdaptive(limit: 100, filter: { scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {' +
      ' sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } } } } }',
    variables: {
      accountTag: accountId,
      datetimeStart: start,
      datetimeEnd: end,
      scriptName: PORTAL_WORKER,
    },
  };
}

async function graphqlV1(
  accountId: string,
  token: string,
  fetcher: Fetcher,
  body: JsonObject,
): Promise<{ state: CloudflareCapabilityStateV1; body: JsonObject | null }> {
  if (!accountId || !token) return { state: 'credential-missing', body: null };
  try {
    const response = await fetcher(API_BASE + '/graphql', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const state = stateForStatusV1(response.status);
    if (state !== 'accessible') {
      await response.body?.cancel();
      return { state, body: null };
    }
    const parsed = await readJsonV1(response);
    if (!parsed) return { state: 'inconclusive', body: null };
    const errors = parsed.errors;
    if (Array.isArray(errors) && errors.length > 0)
      return { state: 'inconclusive', body: null };
    return { state: 'accessible', body: parsed };
  } catch {
    return { state: 'unavailable', body: null };
  }
}

async function analyticsProbeV1(
  accountId: string,
  token: string,
  fetcher: Fetcher,
  now: Date,
): Promise<CloudflareCapabilityStateV1> {
  const result = await graphqlV1(
    accountId,
    token,
    fetcher,
    capabilityAnalyticsBodyV1(accountId, now),
  );
  if (result.state !== 'accessible' || !result.body) return result.state;
  const data = asObjectV1(result.body.data);
  const viewer = asObjectV1(data?.viewer);
  const accounts = viewer?.accounts;
  return Array.isArray(accounts) ? 'accessible' : 'inconclusive';
}

function validateAccountV1(accountId: string) {
  if (!ACCOUNT_ID.test(accountId)) throw new Error('Invalid Cloudflare account selector');
}

export async function probeCloudflareCapabilitiesV1(input: {
  accountId: string;
  token: string;
  tokenKind: CloudflareTokenKindV1;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<CloudflareProbeResultV1> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  validateAccountV1(input.accountId);

  if (!input.token) {
    return {
      contractVersion: 1,
      tokenKind: input.tokenKind,
      checkedAt: now.toISOString(),
      capabilities: definitions.map((item) => ({ ...item, state: 'credential-missing' })),
    };
  }

  const account = encodeURIComponent(input.accountId);
  const rest = {
    'workers.scripts.read': API_BASE + '/accounts/' + account + '/workers/scripts',
    'pages.projects.read':
      API_BASE + '/accounts/' + account + '/pages/projects?page=1&per_page=1',
    'hyperdrive.configs.read':
      API_BASE + '/accounts/' + account + '/hyperdrive/configs?page=1&per_page=1',
    'zones.read': API_BASE + '/zones?account.id=' + account + '&page=1&per_page=1',
  } as const;

  const capabilities: CloudflareCapabilityV1[] = [];
  for (const item of definitions) {
    const state =
      item.id === 'analytics.workers.read'
        ? await analyticsProbeV1(input.accountId, input.token, fetcher, now)
        : await restProbeV1(rest[item.id], input.token, fetcher);
    capabilities.push({ ...item, state });
  }

  return {
    contractVersion: 1,
    tokenKind: input.tokenKind,
    checkedAt: now.toISOString(),
    capabilities,
  };
}

type RestReadV1 = Awaited<ReturnType<typeof readRestResourceV1>>;
type GraphqlReadV1 = Awaited<ReturnType<typeof graphqlV1>>;

/** The Portal Worker among the account's scripts, with its date and compatibility date. */
function portalWorkerV1(workerRead: RestReadV1): CloudflarePortalDeployResultV1['worker'] {
  if (workerRead.state !== 'accessible' || !workerRead.body) return { state: workerRead.state };
  const result = workerRead.body.result;
  if (!Array.isArray(result)) return { state: 'inconclusive' };
  const match = result.map(asObjectV1).find((item) => item?.id === PORTAL_WORKER);
  return match
    ? {
        state: 'accessible',
        present: true,
        modifiedAt: asStringV1(match.modified_on),
        compatibilityDate: asStringV1(match.compatibility_date),
      }
    : { state: 'accessible', present: false };
}

/** The Pages project and its canonical deployment. */
function portalPagesV1(pagesRead: RestReadV1): CloudflarePortalDeployResultV1['pages'] {
  if (pagesRead.state === 'not-found') return { state: 'not-found', present: false };
  if (pagesRead.state !== 'accessible' || !pagesRead.body) return { state: pagesRead.state };
  const project = asObjectV1(pagesRead.body.result);
  if (!project) return { state: 'inconclusive' };
  const deployment = asObjectV1(project.canonical_deployment);
  const latestStage = asObjectV1(deployment?.latest_stage);
  return {
    state: 'accessible',
    present: true,
    productionBranch: asStringV1(project.production_branch),
    deploymentStatus: asStringV1(latestStage?.status),
    deploymentCreatedAt: asStringV1(deployment?.created_on),
  };
}

/** Requests, errors and the highest CPU quantiles over the rows; null when a row has no counts. */
function invocationTotalsV1(rows: readonly unknown[]) {
  let requests = 0;
  let errors = 0;
  let maxCpuTimeP50: number | undefined;
  let maxCpuTimeP99: number | undefined;
  for (const row of rows) {
    const object = asObjectV1(row);
    const sum = asObjectV1(object?.sum);
    const rowRequests = asNonNegativeNumberV1(sum?.requests);
    const rowErrors = asNonNegativeNumberV1(sum?.errors);
    if (rowRequests === null || rowErrors === null) return null;
    requests += rowRequests;
    errors += rowErrors;
    const quantiles = asObjectV1(object?.quantiles);
    const cpuP50 = asNonNegativeNumberV1(quantiles?.cpuTimeP50);
    const cpuP99 = asNonNegativeNumberV1(quantiles?.cpuTimeP99);
    if (cpuP50 !== null)
      maxCpuTimeP50 = Math.max(maxCpuTimeP50 ?? 0, cpuP50);
    if (cpuP99 !== null)
      maxCpuTimeP99 = Math.max(maxCpuTimeP99 ?? 0, cpuP99);
  }
  return { requests, errors, maxCpuTimeP50, maxCpuTimeP99 };
}

/** The Portal Worker's last hour of invocations. */
function portalAnalyticsV1(analyticsRead: GraphqlReadV1): CloudflarePortalDeployResultV1['analytics'] {
  if (analyticsRead.state !== 'accessible' || !analyticsRead.body)
    return { state: analyticsRead.state, windowMinutes: 60 };
  const data = asObjectV1(analyticsRead.body.data);
  const viewer = asObjectV1(data?.viewer);
  const accounts = viewer?.accounts;
  if (!Array.isArray(accounts)) return { state: 'inconclusive', windowMinutes: 60 };
  const first = asObjectV1(accounts[0]);
  const rows = first?.workersInvocationsAdaptive;
  if (!Array.isArray(rows)) return { state: 'inconclusive', windowMinutes: 60 };
  const totals = invocationTotalsV1(rows);
  if (!totals) return { state: 'inconclusive', windowMinutes: 60 };
  const { requests, errors, maxCpuTimeP50, maxCpuTimeP99 } = totals;
  return {
    state: 'accessible',
    windowMinutes: 60,
    requests,
    errors,
    ...(maxCpuTimeP50 === undefined ? {} : { maxCpuTimeP50 }),
    ...(maxCpuTimeP99 === undefined ? {} : { maxCpuTimeP99 }),
  };
}

export async function diagnoseCloudflarePortalDeployV1(input: {
  accountId: string;
  token: string;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<CloudflarePortalDeployResultV1> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  validateAccountV1(input.accountId);

  if (!input.token) {
    return {
      contractVersion: 1,
      operation: 'portal-deploy',
      checkedAt: now.toISOString(),
      worker: { state: 'credential-missing' },
      pages: { state: 'credential-missing' },
      analytics: { state: 'credential-missing', windowMinutes: 60 },
    };
  }

  const account = encodeURIComponent(input.accountId);
  const workerRead = await readRestResourceV1(
    API_BASE + '/accounts/' + account + '/workers/scripts',
    input.token,
    fetcher,
  );
  const worker = portalWorkerV1(workerRead);

  const pagesRead = await readRestResourceV1(
    API_BASE + '/accounts/' + account + '/pages/projects/' + encodeURIComponent(PORTAL_PAGES),
    input.token,
    fetcher,
  );
  const pages = portalPagesV1(pagesRead);

  const analyticsRead = await graphqlV1(
    input.accountId,
    input.token,
    fetcher,
    portalAnalyticsBodyV1(input.accountId, now),
  );
  const analytics = portalAnalyticsV1(analyticsRead);

  return {
    contractVersion: 1,
    operation: 'portal-deploy',
    checkedAt: now.toISOString(),
    worker,
    pages,
    analytics,
  };
}

export async function diagnoseCloudflarePortalHyperdriveV1(input: {
  accountId: string;
  token: string;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<CloudflarePortalHyperdriveResultV1> {
  const now = input.now ?? new Date();
  const fetcher = input.fetcher ?? fetch;
  validateAccountV1(input.accountId);

  if (!input.token) {
    return {
      contractVersion: 1,
      operation: 'portal-hyperdrive',
      checkedAt: now.toISOString(),
      hyperdrive: { state: 'credential-missing' },
    };
  }

  const account = encodeURIComponent(input.accountId);
  const read = await readRestResourceV1(
    API_BASE + '/accounts/' + account + '/hyperdrive/configs/' + PORTAL_HYPERDRIVE_ID,
    input.token,
    fetcher,
  );
  if (read.state === 'not-found') {
    return {
      contractVersion: 1,
      operation: 'portal-hyperdrive',
      checkedAt: now.toISOString(),
      hyperdrive: { state: 'not-found', present: false },
    };
  }
  if (read.state !== 'accessible' || !read.body) {
    return {
      contractVersion: 1,
      operation: 'portal-hyperdrive',
      checkedAt: now.toISOString(),
      hyperdrive: { state: read.state },
    };
  }

  const config = asObjectV1(read.body.result);
  const caching = asObjectV1(config?.caching);
  const cacheDisabled = caching?.disabled;
  const originConnections = asNonNegativeNumberV1(config?.origin_connection_limit);
  if (!config || typeof cacheDisabled !== 'boolean' || originConnections === null) {
    return {
      contractVersion: 1,
      operation: 'portal-hyperdrive',
      checkedAt: now.toISOString(),
      hyperdrive: { state: 'inconclusive' },
    };
  }

  return {
    contractVersion: 1,
    operation: 'portal-hyperdrive',
    checkedAt: now.toISOString(),
    hyperdrive: {
      state: 'accessible',
      present: true,
      cacheDisabled,
      originConnections,
    },
  };
}

type CliOperationV1 = 'capabilities' | 'portal-deploy' | 'portal-hyperdrive';

function parseArgsV1(argv: readonly string[]) {
  const kindIndex = argv.indexOf('--token-kind');
  const outputIndex = argv.indexOf('--output');
  const operationIndex = argv.indexOf('--operation');
  const tokenKind = argv[kindIndex + 1];
  const output = argv[outputIndex + 1];
  const operation = (argv[operationIndex + 1] ?? 'capabilities') as CliOperationV1;
  if ((tokenKind !== 'deploy' && tokenKind !== 'hyperdrive') || !output)
    throw new Error('Expected --token-kind <deploy|hyperdrive> and --output <path>');
  if (!['capabilities', 'portal-deploy', 'portal-hyperdrive'].includes(operation))
    throw new Error('Unsupported Cloudflare operator operation');
  if (operation === 'portal-deploy' && tokenKind !== 'deploy')
    throw new Error('portal-deploy requires deploy token');
  if (operation === 'portal-hyperdrive' && tokenKind !== 'hyperdrive')
    throw new Error('portal-hyperdrive requires hyperdrive token');
  return { tokenKind, output, operation } as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { tokenKind, output, operation } = parseArgsV1(process.argv.slice(2));
  const common = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
  };

  if (operation === 'capabilities') {
    const result = await probeCloudflareCapabilitiesV1({ ...common, tokenKind });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        event: 'cloudflare-readonly-probe-v1',
        tokenKind,
        capabilities: result.capabilities.map(({ id, state }) => ({ id, state })),
      }),
    );
  } else if (operation === 'portal-deploy') {
    const result = await diagnoseCloudflarePortalDeployV1(common);
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        event: 'cloudflare-readonly-diagnostic-v1',
        operation,
        state: {
          worker: result.worker.state,
          pages: result.pages.state,
          analytics: result.analytics.state,
        },
      }),
    );
  } else {
    const result = await diagnoseCloudflarePortalHyperdriveV1(common);
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        event: 'cloudflare-readonly-diagnostic-v1',
        operation,
        state: { hyperdrive: result.hyperdrive.state },
      }),
    );
  }
}
