export const PLATFORM_ROUTES = [
  'operacao',
  'banco-de-notas',
  'painel-do-aluno',
  'configuracoes',
] as const;

export const PLATFORM_CAPABILITIES = [
  'platform.snapshot.read',
  'platform.health.read',
  'platform.audit.read',
  'platform.settings.read',
  'platform.settings.write',
  'gradebook.persistence.admin',
] as const;

export type PlatformRoute = (typeof PLATFORM_ROUTES)[number];
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];
export type ModuleState = 'ready' | 'planned';

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

export type PlatformSnapshotContract = {
  version: string;
  releaseState: 'production';
  generatedAt: string;
  correlationId: string;
  coreModules: CoreModuleContract[];
};

function isPlatformRoute(value: string): value is PlatformRoute {
  return (PLATFORM_ROUTES as readonly string[]).includes(value);
}

export function normalizePlatformRoute(value: string): PlatformRoute {
  const route = value.split(/[?#]/u)[0] ?? '';
  return isPlatformRoute(route) ? route : 'banco-de-notas';
}
