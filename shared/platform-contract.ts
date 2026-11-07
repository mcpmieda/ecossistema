export const PLATFORM_ROUTES = [
  'operacao',
  'banco-de-notas',
  'painel-do-aluno',
  'configuracoes',
] as const;

export const PLATFORM_CAPABILITIES = [
  'platform.snapshot.read',
  'platform.health.read',
  'platform.modules.read',
  'platform.audit.read',
  'platform.settings.read',
  'platform.settings.write',
  'gradebook.persistence.admin',
] as const;

export const MODULE_REGISTRY_STATUSES = ['installed', 'disabled', 'deprecated', 'unknown'] as const;
export const MODULE_INTEGRATION_STATES = [
  'ready',
  'registry-only',
  'contract-mismatch',
  'disabled',
  'deprecated',
  'invalid-registry',
] as const;
export const MODULE_INTEGRATION_ISSUES = [
  'status',
  'base-route',
  'version',
  'health-endpoint',
] as const;

export type PlatformRoute = (typeof PLATFORM_ROUTES)[number];
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];
export type ModuleRegistryStatus = (typeof MODULE_REGISTRY_STATUSES)[number];
export type ModuleIntegrationState = (typeof MODULE_INTEGRATION_STATES)[number];
export type ModuleIntegrationIssue = (typeof MODULE_INTEGRATION_ISSUES)[number];
export type ModuleState = 'ready' | 'planned';
export type FoundationStatus = 'ok' | 'degraded';
type OperationalStatus = 'nominal' | 'attention';
type RecoveryStatus = 'not-verified' | 'verified';

export type CoreModuleContract = {
  id: string;
  name: string;
  description: string;
  route: PlatformRoute;
  state: ModuleState;
  requiredRole: 'ADMINISTRADOR';
  capabilities: PlatformCapability[];
};

export const STUDENT_PORTAL_MODULE: CoreModuleContract = {
  id: 'student-portal.admin',
  name: 'Painel do Aluno',
  description: 'Acesso, contas, notas publicadas e operação do Portal de 2026.',
  route: 'painel-do-aluno',
  state: 'ready',
  requiredRole: 'ADMINISTRADOR',
  capabilities: ['platform.settings.read'],
};

export type RegisteredModule = {
  id: string;
  key: string;
  name: string;
  baseRoute: string;
  version: string;
  status: ModuleRegistryStatus;
  order: number;
  healthEndpoint: string;
  updatedAt: string;
  contractVersion: number | null;
  requiredCapabilities: PlatformCapability[];
  integrationState: ModuleIntegrationState;
  integrationIssues: ModuleIntegrationIssue[];
  available: boolean;
};

export type PlatformConfiguration = {
  id: string;
  key: string;
  scope: string;
  version: string;
  active: boolean;
  effectiveFrom: string;
  effectiveUntil: string;
  updatedAt: string;
};

export type AuditEntry = {
  id: string;
  eventId: string;
  occurredAt: string;
  module: string;
  action: string;
  entityType: string;
  correlationId: string;
  result: string;
};

export type MigrationEntry = {
  id: string;
  version: string;
  module: string;
  appliedAt: string;
  result: string;
};

export type OperationalSummary = {
  status: OperationalStatus;
  recentAuditFailureCount: number;
  healthContractsConfigured: number;
  healthContractsMissing: number;
  lastAuditAt: string;
  recoveryStatus: RecoveryStatus;
  recoveryVerifiedAt: string;
  recoveryEvidenceRef: string;
  recoveryScope: string;
};

export type PlatformSnapshotContract = {
  version: string;
  releaseState: 'production';
  generatedAt: string;
  correlationId: string;
  foundation: {
    status: FoundationStatus;
    sharePointListCount: number;
    expectedPlatformListsPresent: boolean;
    missingPlatformLists: string[];
  };
  operational: OperationalSummary | null;
  coreModules: CoreModuleContract[];
  registeredModules: RegisteredModule[];
  configurations: PlatformConfiguration[];
  recentAudit: AuditEntry[];
  migrations: MigrationEntry[];
};

function isPlatformRoute(value: string): value is PlatformRoute {
  return (PLATFORM_ROUTES as readonly string[]).includes(value);
}

export function normalizePlatformRoute(value: string): PlatformRoute {
  const route = value.split(/[?#]/u)[0] ?? '';
  return isPlatformRoute(route) ? route : 'banco-de-notas';
}
