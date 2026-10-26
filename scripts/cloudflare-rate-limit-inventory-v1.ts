import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { CloudflareResourceStateV1 } from './cloudflare-operator-v1.ts';

const API = 'https://api.cloudflare.com/client/v4';
const PORTAL = 'student-portal-production';
const NAME = /^\w[\w-]{0,127}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const TARGETS = Array.from({ length: 11 }, (_, index) => String(3101249 + index));
const MAX_SCRIPTS = 100;
const MAX_BYTES = 2 * 1024 * 1024;

type ObjectV1 = Record<string, unknown>;
type BindingV1 = { name: string; namespaceId: string; limit: number; period: number };
type SnapshotV1 = { script: string; source: 'settings' | 'active-version'; bindings: BindingV1[] };
export type RateLimitInventoryV1 = {
  contractVersion: 1;
  operation: 'portal-rate-limits';
  checkedAt: string;
  state: CloudflareResourceStateV1;
  complete: boolean;
  scriptsInspected: number;
  activeVersionsInspected: number;
  portal: {
    present: boolean;
    settings: BindingV1[];
    activeVersions: Array<{ versionId: string; percentage: number; bindings: BindingV1[] }>;
  };
  namespaces: Array<{
    namespaceId: string;
    state: 'unused' | 'portal-only' | 'collision' | 'unverified';
    foreignWorkers: number;
    portalBindingNames: string[];
  }>;
};

function objectV1(value: unknown): ObjectV1 | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectV1)
    : null;
}

function stateForStatusV1(status: number): CloudflareResourceStateV1 {
  if (status === 401 || status === 403) return 'permission-required';
  if (status === 404) return 'not-found';
  return 'unavailable';
}

async function jsonBodyV1(response: Response): Promise<ObjectV1 | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return objectV1(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    // A received but malformed representation is not a transport outage.
    return null;
  }
}

// Never retain provider bodies, other binding values, error text or authorization headers.
async function getV1(url: string, token: string, fetcher: typeof fetch, signal: AbortSignal) {
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      // Cleanup failure must not erase a proven HTTP permission/not-found result.
      await response.body?.cancel().catch(() => undefined);
      return { state: stateForStatusV1(response.status), body: null };
    }
    const body = await jsonBodyV1(response);
    if (body?.success !== true) return { state: 'inconclusive' as const, body: null };
    return { state: 'accessible' as const, body };
  } catch {
    return { state: 'unavailable' as const, body: null };
  }
}

function bindingsV1(value: unknown): BindingV1[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null;
  const bindings: BindingV1[] = [];
  const names = new Set<string>();
  for (const item of value) {
    const binding = objectV1(item);
    if (!binding || typeof binding.type !== 'string') return null;
    if (binding.type !== 'ratelimit') continue;
    const simple = objectV1(binding.simple);
    if (
      typeof binding.name !== 'string' ||
      !NAME.test(binding.name) ||
      names.has(binding.name) ||
      typeof binding.namespace_id !== 'string' ||
      !/^[1-9]\d{0,19}$/u.test(binding.namespace_id) ||
      typeof simple?.limit !== 'number' ||
      !Number.isSafeInteger(simple.limit) ||
      simple.limit <= 0 ||
      (simple.period !== 10 && simple.period !== 60)
    )
      return null;
    names.add(binding.name);
    bindings.push({
      name: binding.name,
      namespaceId: binding.namespace_id,
      limit: simple.limit,
      period: simple.period,
    });
  }
  return bindings.sort((a, b) => a.name.localeCompare(b.name));
}

function singlePageV1(value: unknown, count: number): boolean {
  if (value === undefined || value === null) return true;
  const info = objectV1(value);
  if (!info) return false;
  const allowed = new Set(['count', 'total_count', 'page', 'per_page', 'total_pages']);
  if (Object.keys(info).some((key) => !allowed.has(key))) return false;
  if (info.count !== undefined && info.count !== count) return false;
  if (info.total_count !== undefined && info.total_count !== count) return false;
  if (info.page !== undefined && info.page !== 1) return false;
  if (info.total_pages !== undefined && info.total_pages !== 1) return false;
  if (
    info.per_page !== undefined &&
    (typeof info.per_page !== 'number' ||
      !Number.isSafeInteger(info.per_page) ||
      info.per_page < count)
  )
    return false;
  return true;
}

function failV1(
  result: RateLimitInventoryV1,
  state: CloudflareResourceStateV1,
): RateLimitInventoryV1 {
  result.state = state;
  // Partial observations must never attest absence of a collision.
  result.complete = false;
  return result;
}

type MetadataReaderV1 = (url: string) => ReturnType<typeof getV1>;
type ActiveVersionV1 = { versionId: string; percentage: number };
type BindingReadV1 = { state: CloudflareResourceStateV1; bindings: BindingV1[] | null };
type ScriptReadV1 = {
  state: CloudflareResourceStateV1;
  settings: BindingV1[];
  activeVersions: RateLimitInventoryV1['portal']['activeVersions'];
};

function listedScriptsV1(body: ObjectV1): string[] | null {
  const scripts = body.result;
  // scripts.list is SinglePage: never silently truncate or invent pagination.
  if (
    !Array.isArray(scripts) ||
    scripts.length === 0 ||
    scripts.length > MAX_SCRIPTS ||
    !singlePageV1(body.result_info, scripts.length) ||
    body.cursor !== undefined
  )
    return null;
  const names: string[] = [];
  for (const item of scripts) {
    const name = objectV1(item)?.id;
    if (typeof name !== 'string' || !NAME.test(name) || names.includes(name)) return null;
    names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function activeVersionsV1(body: ObjectV1): ActiveVersionV1[] | null {
  const items = objectV1(body.result)?.deployments;
  if (!Array.isArray(items) || items.length === 0) return null;
  // API and Wrangler define deployments[0] as the currently serving deployment.
  const active = objectV1(items[0])?.versions;
  if (!Array.isArray(active) || active.length < 1 || active.length > 2) return null;
  const versions: ActiveVersionV1[] = [];
  for (const item of active) {
    const version = objectV1(item);
    if (
      typeof version?.version_id !== 'string' ||
      !UUID.test(version.version_id) ||
      versions.some((entry) => entry.versionId === version.version_id) ||
      typeof version.percentage !== 'number' ||
      !Number.isFinite(version.percentage) ||
      version.percentage < 0 ||
      version.percentage > 100
    )
      return null;
    versions.push({ versionId: version.version_id, percentage: version.percentage });
  }
  const percentage = versions.reduce((sum, version) => sum + version.percentage, 0);
  return Math.abs(percentage - 100) <= 0.0001 ? versions : null;
}

async function readBindingsV1(
  url: string,
  read: MetadataReaderV1,
  versionId?: string,
): Promise<BindingReadV1> {
  const response = await read(url);
  if (response.state !== 'accessible' || !response.body)
    return { state: response.state, bindings: null };
  const resource = objectV1(response.body.result);
  if (versionId !== undefined && resource?.id !== versionId)
    return { state: 'inconclusive', bindings: null };
  const value =
    versionId === undefined ? resource?.bindings : objectV1(resource?.resources)?.bindings;
  const bindings = bindingsV1(value);
  return { state: bindings ? 'accessible' : 'inconclusive', bindings };
}

async function inspectScriptV1(root: string, read: MetadataReaderV1): Promise<ScriptReadV1> {
  const result: ScriptReadV1 = { state: 'inconclusive', settings: [], activeVersions: [] };
  const settings = await readBindingsV1(`${root}/settings`, read);
  if (!settings.bindings) return { ...result, state: settings.state };
  result.settings = settings.bindings;
  const deployments = await read(`${root}/deployments`);
  if (deployments.state !== 'accessible' || !deployments.body)
    return { ...result, state: deployments.state };
  const active = activeVersionsV1(deployments.body);
  if (!active) return result;
  for (const version of active) {
    // Include 0%: these versions remain callable by the version-override header.
    const response = await readBindingsV1(
      `${root}/versions/${version.versionId}`,
      read,
      version.versionId,
    );
    if (!response.bindings) return { ...result, state: response.state };
    result.activeVersions.push({ ...version, bindings: response.bindings });
  }
  result.state = 'accessible';
  return result;
}

function namespaceChecksV1(snapshots: SnapshotV1[]): RateLimitInventoryV1['namespaces'] {
  return TARGETS.map((namespaceId) => {
    const references = snapshots.flatMap((snapshot) =>
      snapshot.bindings
        .filter((binding) => binding.namespaceId === namespaceId)
        .map((binding) => ({ script: snapshot.script, binding })),
    );
    const foreignWorkers = new Set(
      references.filter((ref) => ref.script !== PORTAL).map((ref) => ref.script),
    ).size;
    const portalBindingNames = [
      ...new Set(references.filter((ref) => ref.script === PORTAL).map((ref) => ref.binding.name)),
    ];
    portalBindingNames.sort((a, b) => a.localeCompare(b));
    let state: RateLimitInventoryV1['namespaces'][number]['state'] = 'portal-only';
    if (foreignWorkers > 0 || portalBindingNames.length > 1) state = 'collision';
    else if (references.length === 0) state = 'unused';
    return { namespaceId, foreignWorkers, portalBindingNames, state };
  });
}

export async function inspectCloudflareRateLimitsV1(input: {
  accountId: string;
  token: string;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<RateLimitInventoryV1> {
  if (!/^[a-f0-9]{32}$/u.test(input.accountId))
    throw new Error('Invalid Cloudflare account selector');
  const result: RateLimitInventoryV1 = {
    contractVersion: 1,
    operation: 'portal-rate-limits',
    checkedAt: (input.now ?? new Date()).toISOString(),
    state: 'inconclusive',
    complete: false,
    scriptsInspected: 0,
    activeVersionsInspected: 0,
    portal: { present: false, settings: [], activeVersions: [] },
    namespaces: TARGETS.map((namespaceId) => ({
      namespaceId,
      state: 'unverified',
      foreignWorkers: 0,
      portalBindingNames: [],
    })),
  };
  if (!input.token) return failV1(result, 'credential-missing');
  const fetcher = input.fetcher ?? fetch;
  const signal = AbortSignal.timeout(120_000);
  const read: MetadataReaderV1 = (url) => getV1(url, input.token, fetcher, signal);
  const base = `${API}/accounts/${input.accountId}/workers/scripts`;
  const listing = await read(base);
  if (listing.state !== 'accessible' || !listing.body) return failV1(result, listing.state);
  const names = listedScriptsV1(listing.body);
  if (!names) return failV1(result, 'inconclusive');
  const snapshots: SnapshotV1[] = [];
  for (const script of names) {
    if (signal.aborted) return failV1(result, 'unavailable');
    const inspection = await inspectScriptV1(`${base}/${encodeURIComponent(script)}`, read);
    if (inspection.state !== 'accessible') return failV1(result, inspection.state);
    snapshots.push(
      { script, source: 'settings', bindings: inspection.settings },
      ...inspection.activeVersions.map((version) => ({
        script,
        source: 'active-version' as const,
        bindings: version.bindings,
      })),
    );
    result.scriptsInspected++;
    result.activeVersionsInspected += inspection.activeVersions.length;
    if (script === PORTAL)
      result.portal = {
        present: true,
        settings: inspection.settings,
        activeVersions: inspection.activeVersions,
      };
  }
  if (!result.portal.present) return failV1(result, 'not-found');
  result.namespaces = namespaceChecksV1(snapshots);
  result.complete = true;
  result.state = 'accessible';
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1])
    throw new Error('Expected --output <path>');
  const result = await inspectCloudflareRateLimitsV1({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '',
  });
  await writeFile(args[1], `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      event: 'cloudflare-rate-limit-inventory-v1',
      state: result.state,
      complete: result.complete,
    }),
  );
}
