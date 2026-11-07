import { z } from 'zod';
import type {
  ModuleIntegrationIssue,
  ModuleIntegrationState,
  ModuleRegistryStatus,
  PlatformCapability,
  RegisteredModule,
} from '../../shared/platform-contract';
import { moduleContractForKey, type ModuleContract } from './contracts';

const moduleFieldsSchema = z.object({
  Chave: z.string().optional(),
  Nome: z.string().optional(),
  RotaBase: z.string().optional(),
  Versao: z.string().optional(),
  Status: z.string().optional(),
  Ordem: z.union([z.number(), z.string()]).optional(),
  HealthEndpoint: z.string().optional(),
  AtualizadoEmUTC: z.string().optional(),
});

type ModuleRegistryItem = {
  id: string;
  fields: Record<string, unknown>;
};

function numberOrZero(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeModuleRegistryStatus(value: string | undefined): ModuleRegistryStatus {
  const normalized = (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');

  if (normalized === 'instalado' || normalized === 'installed') return 'installed';
  if (normalized === 'desabilitado' || normalized === 'disabled') return 'disabled';
  if (normalized === 'depreciado' || normalized === 'deprecated') return 'deprecated';
  return 'unknown';
}

function requiredCapabilitiesAvailable(
  granted: readonly PlatformCapability[],
  required: readonly PlatformCapability[],
): boolean {
  return required.every((capability) => granted.includes(capability));
}

function contractIssues(
  fields: z.infer<typeof moduleFieldsSchema>,
  status: ModuleRegistryStatus,
  contract: ModuleContract,
): ModuleIntegrationIssue[] {
  const issues: ModuleIntegrationIssue[] = [];
  if (status !== contract.status) issues.push('status');
  if ((fields.RotaBase ?? '') !== contract.baseRoute) issues.push('base-route');
  if ((fields.Versao ?? '') !== contract.version) issues.push('version');
  if ((fields.HealthEndpoint ?? '') !== contract.healthEndpoint) issues.push('health-endpoint');
  return issues;
}

function integrationState(
  status: ModuleRegistryStatus,
  contract: ModuleContract | undefined,
  issues: readonly ModuleIntegrationIssue[],
): ModuleIntegrationState {
  if (status === 'disabled') return 'disabled';
  if (status === 'deprecated') return 'deprecated';
  if (status === 'unknown') return 'invalid-registry';
  if (!contract) return 'registry-only';
  if (issues.length > 0) return 'contract-mismatch';
  return 'ready';
}

export function resolveRegisteredModules(
  items: readonly ModuleRegistryItem[],
  grantedCapabilities: readonly PlatformCapability[],
): RegisteredModule[] {
  return items
    .flatMap((item) => {
      const parsed = moduleFieldsSchema.safeParse(item.fields);
      if (!parsed.success) return [];
      const fields = parsed.data;
      const key = fields.Chave ?? item.id;
      const contract = moduleContractForKey(key);
      const status = normalizeModuleRegistryStatus(fields.Status);
      const integrationIssues = contract ? contractIssues(fields, status, contract) : [];
      const state = integrationState(status, contract, integrationIssues);
      const requiredCapabilities = contract?.requiredCapabilities ?? [];

      return [
        {
          id: item.id,
          key,
          name: fields.Nome ?? fields.Chave ?? 'Módulo sem nome',
          baseRoute: fields.RotaBase ?? '',
          version: fields.Versao ?? '',
          status,
          order: numberOrZero(fields.Ordem),
          healthEndpoint: fields.HealthEndpoint ?? '',
          updatedAt: fields.AtualizadoEmUTC ?? '',
          contractVersion: contract?.contractVersion ?? null,
          requiredCapabilities,
          integrationState: state,
          integrationIssues,
          available:
            state === 'ready' &&
            requiredCapabilitiesAvailable(grantedCapabilities, requiredCapabilities),
        },
      ];
    })
    .sort(
      (left, right) => left.order - right.order || left.name.localeCompare(right.name, 'pt-BR'),
    );
}
