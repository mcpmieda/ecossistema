import { z } from 'zod';
import type { PlatformCapability } from '../../shared/platform-contract';
import { PLATFORM_SOURCE_SECTIONS_V2, type PlatformSnapshotV2, type PlatformSourceSectionV2 } from '../../shared/platform-snapshot-v2';
import { requireCapability } from '../auth/capabilities';
import type { RuntimeEnv } from '../env';
import { TechnicalCredentialError } from '../auth/technical-identity';
import { getGraphToken, graphAllPages, GraphError, GraphTokenError } from '../graph/client';
import { resolveRegisteredModules } from '../modules/registry';
import { coreModules } from './manifest';
import { joinFlightV1 } from '../http/shared-flight-v1';

/** The registered modules are the only SharePoint platform list still read (#1473). */
export const EXPECTED_PLATFORM_LISTS = ['PLATAFORMA_MODULOS'] as const;
const listSchema = z.object({ id: z.string(), displayName: z.string() });
const graphItemSchema = z.object({ id: z.string(), fields: z.record(z.string(), z.unknown()).optional() });
type PlatformList = z.infer<typeof listSchema>;
type PlatformItem = { id: string; fields: Record<string, unknown> };
type SnapshotSource = { lists: PlatformList[]; moduleItems: PlatformItem[]; correlationId: string; generatedAt?: string };
function hasCapability(capabilities: readonly PlatformCapability[], capability: PlatformCapability): boolean { return capabilities.includes(capability); }
export interface PlatformSnapshotDependenciesV2 {
  token(env: RuntimeEnv): Promise<string>;
  pages(env: RuntimeEnv, path: string, token: string, signal?: AbortSignal): Promise<unknown[]>;
}
const sourceDependencies: PlatformSnapshotDependenciesV2 = {
  token: (env) => getGraphToken(env),
  pages: (env, path, token, signal) => graphAllPages<unknown>(env, path, token, { signal }),
};
async function readListItems(env: RuntimeEnv, listId: string | undefined, selectedFields: string, token: string,
  dependencies = sourceDependencies, signal?: AbortSignal): Promise<PlatformItem[]> {
  if (!listId) return [];
  const items = await dependencies.pages(env,
    `/sites/${env.SHAREPOINT_SITE_ID}/lists/${listId}/items?$expand=fields($select=${selectedFields})&$top=100`, token, signal);
  return items.map((item) => {
    const parsed = graphItemSchema.parse(item);
    return { id: parsed.id, fields: parsed.fields ?? {} };
  });
}
export function buildPlatformSnapshot(source: SnapshotSource, capabilities: readonly PlatformCapability[]) {
  const byName = new Map(source.lists.map((list) => [list.displayName, list.id]));
  const allRegisteredModules = resolveRegisteredModules(source.moduleItems, capabilities).filter((module) => module.contractVersion !== null);
  const missingPlatformLists = EXPECTED_PLATFORM_LISTS.filter((name) => !byName.has(name));
  const foundationStatus = missingPlatformLists.length === 0 ? 'ok' as const : 'degraded' as const;
  const healthContractsConfigured = allRegisteredModules.filter((module) => module.healthEndpoint.trim().length > 0).length;
  const healthContractsMissing = allRegisteredModules.length - healthContractsConfigured;
  const operationalStatus = foundationStatus === 'degraded' ? 'attention' as const : 'nominal' as const;
  return {
    version: '1.0.0', releaseState: 'production' as const, generatedAt: source.generatedAt ?? new Date().toISOString(), correlationId: source.correlationId,
    foundation: { status: foundationStatus, sharePointListCount: source.lists.length, expectedPlatformListsPresent: missingPlatformLists.length === 0, missingPlatformLists },
    operational: hasCapability(capabilities, 'platform.health.read') ? {
      status: operationalStatus, healthContractsConfigured, healthContractsMissing,
    } : null,
    coreModules: coreModules.filter((module) => module.capabilities.every((capability) => hasCapability(capabilities, capability))),
    registeredModules: hasCapability(capabilities, 'platform.modules.read') ? allRegisteredModules : [],
  };
}
async function readLists(env: RuntimeEnv, token: string, dependencies = sourceDependencies, signal?: AbortSignal): Promise<PlatformList[]> {
  const items = await dependencies.pages(env, `/sites/${env.SHAREPOINT_SITE_ID}/lists?$select=id,displayName&$top=50`, token, signal);
  return items.map((value) => listSchema.parse(value));
}
function retrySeconds(error: unknown): number {
  const value = error instanceof GraphError ? error.retryAfterSeconds : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? Math.max(30, value) : 30;
}
type PlatformSourceFailureStageV2 = 'token' | 'list-catalogue' | 'section';
function platformSourceFailureKindV2(error: unknown): 'graph-response' | 'credential-configuration' | 'token-assertion'
  | 'token-transport' | 'token-contract' | 'timeout' | 'aborted' | 'contract' | 'runtime' {
  if (error instanceof GraphError) return 'graph-response';
  if (error instanceof TechnicalCredentialError) return 'credential-configuration';
  if (error instanceof GraphTokenError) {
    if (error.stage === 'assertion') {
      return 'token-assertion';
    }
    if (error.stage === 'transport') {
      return 'token-transport';
    }
    return 'token-contract';
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof z.ZodError) return 'contract';
  return 'runtime';
}
/** Provider bodies and exception messages can contain tenant details. Log only a fixed
 * classification, numeric status and opaque correlations needed for operations.
 */
function logPlatformSourceFailureV2(input: {
  error: unknown; stage: PlatformSourceFailureStageV2; correlationId: string; section?: PlatformSourceSectionV2;
}) {
  const graph = input.error instanceof GraphError ? input.error : undefined;
  const credential = input.error instanceof TechnicalCredentialError ? input.error : undefined;
  const token = input.error instanceof GraphTokenError ? input.error : undefined;
  console.warn(JSON.stringify({
    message: 'platform_microsoft_source_unavailable',
    stage: input.stage,
    failureKind: platformSourceFailureKindV2(input.error),
    correlationId: input.correlationId,
    ...(input.section ? { section: input.section } : {}),
    ...(graph ? { providerStatus: graph.status, providerCorrelationId: graph.correlationId } : {}),
    ...(credential ? { credentialStage: credential.stage, credentialSlots: credential.slots } : {}),
    ...(token ? { tokenStage: token.stage, credentialSlot: token.slot } : {}),
  }));
}
/** V2 explicitly identifies unavailable sources. A failure of audit cannot hide healthy
 * configuration data or prevent a native, separately authenticated application from opening.
 */
export async function getPlatformSnapshotV2(env: RuntimeEnv, capabilities: readonly PlatformCapability[],
  dependencies = sourceDependencies, requestSignal?: AbortSignal): Promise<PlatformSnapshotV2> {
  requireCapability(capabilities, 'platform.snapshot.read');
  const correlationId = crypto.randomUUID();
  const source: SnapshotSource = { lists: [], moduleItems: [], correlationId };
  const unavailableSections: PlatformSourceSectionV2[] = [];
  let retryAfterSeconds = 0;
  const timeout = AbortSignal.timeout(30_000);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  let token: string;
  try {
    signal.throwIfAborted();
    token = await dependencies.token(env);
    signal.throwIfAborted();
  } catch (error) {
    requestSignal?.throwIfAborted();
    logPlatformSourceFailureV2({ error, stage: 'token', correlationId });
    return { ...buildPlatformSnapshot(source, capabilities), unavailableSections: [...PLATFORM_SOURCE_SECTIONS_V2], retryAfterSeconds: retrySeconds(error) };
  }
  try {
    source.lists = await readLists(env, token, dependencies, signal);
  } catch (error) {
    requestSignal?.throwIfAborted();
    logPlatformSourceFailureV2({ error, stage: 'list-catalogue', correlationId });
    return { ...buildPlatformSnapshot(source, capabilities), unavailableSections: [...PLATFORM_SOURCE_SECTIONS_V2], retryAfterSeconds: retrySeconds(error) };
  }
  const byName = new Map(source.lists.map((list) => [list.displayName, list.id]));
  const modules = hasCapability(capabilities, 'platform.modules.read') || hasCapability(capabilities, 'platform.health.read');
  // Only the registered modules: the settings, audit and migration lists were retired (#1473).
  const jobs = [
    { section: 'modules', key: 'moduleItems', enabled: modules, list: 'PLATAFORMA_MODULOS', fields: 'Chave,Nome,RotaBase,Versao,Status,Ordem,HealthEndpoint,AtualizadoEmUTC' },
  ] as const;
  await Promise.all(jobs.map(async (job) => {
    if (!job.enabled) return;
    try { source[job.key] = await readListItems(env, byName.get(job.list), job.fields, token, dependencies, signal); }
    catch (error) {
      unavailableSections.push(job.section);
      retryAfterSeconds = Math.max(retryAfterSeconds, retrySeconds(error));
      logPlatformSourceFailureV2({ error, stage: 'section', section: job.section, correlationId });
    }
  }));
  requestSignal?.throwIfAborted();
  const snapshot = buildPlatformSnapshot(source, capabilities);
  if (unavailableSections.length && snapshot.operational) snapshot.operational.status = 'attention';
  unavailableSections.sort((left, right) => left.localeCompare(right));
  return { ...snapshot, unavailableSections, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

/**
 * The SharePoint platform lists (modules, settings, audit, migrations) barely change, and the ADM
 * asked for them on every return of focus to the window: ~6 Microsoft calls each time (issue
 * #1426, 20). Per instance and per set of capabilities, a complete answer is reused for 5 min and
 * simultaneous requests share one read. An answer with an unavailable section is never kept. The
 * caller's own authorization is still checked on every request before this.
 */
export const PLATFORM_SNAPSHOT_CACHE_MS_V2 = 5 * 60_000;
type SnapshotCacheEntryV2 = {
  at: number; value?: PlatformSnapshotV2; pending?: Promise<PlatformSnapshotV2>; pendingSince?: number;
};
/** A read in flight is shared only a little longer than its own 30 s limit (issue #1450, 2). */
const SNAPSHOT_PENDING_SHARE_MS_V2 = 35_000;
const snapshotCacheV2 = new Map<string, SnapshotCacheEntryV2>();

export function forgetPlatformSnapshotsV2(): void {
  snapshotCacheV2.clear();
}

export async function getPlatformSnapshotCachedV2(env: RuntimeEnv, capabilities: readonly PlatformCapability[],
  dependencies = sourceDependencies, now: () => number = Date.now): Promise<PlatformSnapshotV2> {
  requireCapability(capabilities, 'platform.snapshot.read');
  const key = [...new Set(capabilities)].sort((a, b) => a.localeCompare(b)).join(',');
  const entry = snapshotCacheV2.get(key) ?? { at: Number.NEGATIVE_INFINITY };
  if (entry.value && now() - entry.at < PLATFORM_SNAPSHOT_CACHE_MS_V2) return entry.value;
  const read = () => getPlatformSnapshotV2(env, capabilities, dependencies);
  // A read started by another request is joined only for a while: its I/O belongs to that request,
  // and if that request is cancelled the answer never comes (issue #1450, 2).
  const since = entry.pendingSince ?? 0;
  if (entry.pending && now() - since < SNAPSHOT_PENDING_SHARE_MS_V2)
    return joinFlightV1(entry.pending, SNAPSHOT_PENDING_SHARE_MS_V2 - (now() - since), read);
  const pending = read()
    .then((value) => {
      if (value.unavailableSections?.length) entry.value = undefined;
      else { entry.value = value; entry.at = now(); }
      return value;
    })
    .finally(() => { if (entry.pending === pending) { entry.pending = undefined; entry.pendingSince = undefined; } });
  entry.pending = pending;
  entry.pendingSince = now();
  snapshotCacheV2.set(key, entry);
  return pending;
}
