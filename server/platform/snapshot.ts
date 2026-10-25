import { z } from 'zod';
import type { PlatformCapability, PlatformConfiguration, PlatformSnapshotContract } from '../../shared/platform-contract';
import { PLATFORM_SOURCE_SECTIONS_V2, type PlatformSnapshotV2, type PlatformSourceSectionV2 } from '../../shared/platform-snapshot-v2';
import { requireCapability } from '../auth/capabilities';
import type { RuntimeEnv } from '../env';
import { TechnicalCredentialError } from '../auth/technical-identity';
import { getGraphToken, graphAllPages, GraphError, GraphTokenError } from '../graph/client';
import { resolveRegisteredModules } from '../modules/registry';
import { coreModules } from './manifest';
import { recoveryEvidence } from './recovery-evidence';

export const EXPECTED_PLATFORM_LISTS = ['PLATAFORMA_CONFIGURACOES', 'PLATAFORMA_MODULOS', 'PLATAFORMA_AUDITORIA', 'PLATAFORMA_MIGRACOES'] as const;
const listSchema = z.object({ id: z.string(), displayName: z.string() });
const graphItemSchema = z.object({ id: z.string(), fields: z.record(z.string(), z.unknown()).optional() });
const configurationFieldsSchema = z.object({ Chave: z.string().optional(), Escopo: z.string().optional(), Versao: z.string().optional(),
  Ativo: z.boolean().optional(), VigenciaInicioUTC: z.string().optional(), VigenciaFimUTC: z.string().optional(), AtualizadoEmUTC: z.string().optional() });
const auditFieldsSchema = z.object({ EventoId: z.string().optional(), DataHoraUTC: z.string().optional(), Modulo: z.string().optional(),
  Acao: z.string().optional(), EntidadeTipo: z.string().optional(), CorrelationId: z.string().optional(), Resultado: z.string().optional() });
const migrationFieldsSchema = z.object({ Versao: z.string().optional(), Modulo: z.string().optional(), AplicadaEmUTC: z.string().optional(), Resultado: z.string().optional() });
type PlatformList = z.infer<typeof listSchema>;
type PlatformItem = { id: string; fields: Record<string, unknown> };
type SnapshotSource = { lists: PlatformList[]; moduleItems: PlatformItem[]; configurationItems: PlatformItem[];
  auditItems: PlatformItem[]; migrationItems: PlatformItem[]; correlationId: string; generatedAt?: string };
export type PlatformSnapshot = PlatformSnapshotContract;
export function isFailureResult(value: string): boolean {
  const normalized = value.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
  return /^(erro|error|falha|falhou|failed|failure)(?:\b|[:_-])/u.test(normalized);
}
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
function platformConfigurationsFromItems(items: readonly PlatformItem[]): PlatformConfiguration[] {
  return items.flatMap((item) => {
    const parsed = configurationFieldsSchema.safeParse(item.fields); if (!parsed.success) return [];
    const fields = parsed.data;
    return [{ id: item.id, key: fields.Chave ?? item.id, scope: fields.Escopo ?? 'global', version: fields.Versao ?? '',
      active: fields.Ativo ?? false, effectiveFrom: fields.VigenciaInicioUTC ?? '', effectiveUntil: fields.VigenciaFimUTC ?? '', updatedAt: fields.AtualizadoEmUTC ?? '' }];
  }).sort((left, right) => left.key.localeCompare(right.key, 'pt-BR'));
}
export function buildPlatformSnapshot(source: SnapshotSource, capabilities: readonly PlatformCapability[]) {
  const byName = new Map(source.lists.map((list) => [list.displayName, list.id]));
  const allRegisteredModules = resolveRegisteredModules(source.moduleItems, capabilities).filter((module) => module.contractVersion !== null);
  const allConfigurations = platformConfigurationsFromItems(source.configurationItems);
  const allRecentAudit = source.auditItems.flatMap((item) => {
    const parsed = auditFieldsSchema.safeParse(item.fields); if (!parsed.success) return [];
    const fields = parsed.data;
    return [{ id: item.id, eventId: fields.EventoId ?? item.id, occurredAt: fields.DataHoraUTC ?? '', module: fields.Modulo ?? 'plataforma',
      action: fields.Acao ?? 'evento', entityType: fields.EntidadeTipo ?? '', correlationId: fields.CorrelationId ?? '', result: fields.Resultado ?? '' }];
  }).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 20);
  const allMigrations = source.migrationItems.flatMap((item) => {
    const parsed = migrationFieldsSchema.safeParse(item.fields); if (!parsed.success) return [];
    const fields = parsed.data;
    return [{ id: item.id, version: fields.Versao ?? '', module: fields.Modulo ?? 'plataforma', appliedAt: fields.AplicadaEmUTC ?? '', result: fields.Resultado ?? '' }];
  }).sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
  const missingPlatformLists = EXPECTED_PLATFORM_LISTS.filter((name) => !byName.has(name));
  const foundationStatus = missingPlatformLists.length === 0 ? 'ok' as const : 'degraded' as const;
  const recentAuditFailureCount = allRecentAudit.filter((entry) => isFailureResult(entry.result)).length;
  const healthContractsConfigured = allRegisteredModules.filter((module) => module.healthEndpoint.trim().length > 0).length;
  const healthContractsMissing = allRegisteredModules.length - healthContractsConfigured;
  const operationalStatus = foundationStatus === 'degraded' || recentAuditFailureCount > 0 ? 'attention' as const : 'nominal' as const;
  return {
    version: '1.0.0', releaseState: 'production' as const, generatedAt: source.generatedAt ?? new Date().toISOString(), correlationId: source.correlationId,
    foundation: { status: foundationStatus, sharePointListCount: source.lists.length, expectedPlatformListsPresent: missingPlatformLists.length === 0, missingPlatformLists },
    operational: hasCapability(capabilities, 'platform.health.read') ? {
      status: operationalStatus, recentAuditFailureCount, healthContractsConfigured, healthContractsMissing, lastAuditAt: allRecentAudit[0]?.occurredAt ?? '',
      recoveryStatus: recoveryEvidence.status, recoveryVerifiedAt: recoveryEvidence.verifiedAt, recoveryEvidenceRef: recoveryEvidence.evidenceRef, recoveryScope: recoveryEvidence.scope,
    } : null,
    coreModules: coreModules.filter((module) => module.capabilities.every((capability) => hasCapability(capabilities, capability))),
    registeredModules: hasCapability(capabilities, 'platform.modules.read') ? allRegisteredModules : [],
    configurations: hasCapability(capabilities, 'platform.settings.read') ? allConfigurations : [],
    recentAudit: hasCapability(capabilities, 'platform.audit.read') ? allRecentAudit : [],
    migrations: hasCapability(capabilities, 'platform.settings.read') ? allMigrations : [],
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
  const source: SnapshotSource = { lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [], correlationId };
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
  const audit = hasCapability(capabilities, 'platform.audit.read') || hasCapability(capabilities, 'platform.health.read');
  const settings = hasCapability(capabilities, 'platform.settings.read');
  const jobs = [
    { section: 'modules', key: 'moduleItems', enabled: modules, list: 'PLATAFORMA_MODULOS', fields: 'Chave,Nome,RotaBase,Versao,Status,Ordem,HealthEndpoint,AtualizadoEmUTC' },
    { section: 'configurations', key: 'configurationItems', enabled: settings, list: 'PLATAFORMA_CONFIGURACOES', fields: 'Chave,Escopo,Versao,Ativo,VigenciaInicioUTC,VigenciaFimUTC,AtualizadoEmUTC' },
    { section: 'audit', key: 'auditItems', enabled: audit, list: 'PLATAFORMA_AUDITORIA', fields: 'EventoId,DataHoraUTC,Modulo,Acao,EntidadeTipo,CorrelationId,Resultado' },
    { section: 'migrations', key: 'migrationItems', enabled: settings, list: 'PLATAFORMA_MIGRACOES', fields: 'Versao,Modulo,AplicadaEmUTC,Resultado' },
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
/** Old consumers must never interpret a partial V2 response as a complete snapshot. */
export async function getPlatformSnapshot(env: RuntimeEnv, capabilities: readonly PlatformCapability[]): Promise<PlatformSnapshot> {
  const snapshot = await getPlatformSnapshotV2(env, capabilities);
  if (snapshot.unavailableSections?.length) throw new GraphError(503, snapshot.correlationId, snapshot.retryAfterSeconds);
  return snapshot;
}
/** Minimal settings read does not depend on the audit or migration lists. */
export async function getPlatformConfigurations(env: RuntimeEnv, capabilities: readonly PlatformCapability[]): Promise<PlatformConfiguration[]> {
  requireCapability(capabilities, 'platform.settings.read');
  const token = await getGraphToken(env);
  const lists = await readLists(env, token);
  const byName = new Map(lists.map((list) => [list.displayName, list.id]));
  return platformConfigurationsFromItems(await readListItems(env, byName.get('PLATAFORMA_CONFIGURACOES'),
    'Chave,Escopo,Versao,Ativo,VigenciaInicioUTC,VigenciaFimUTC,AtualizadoEmUTC', token));
}
