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
  'platform.groups.manage',
  'gradebook.persistence.admin',
  'area.desempenho',
  'area.importacao',
  'area.painel-do-aluno',
  'area.saude',
] as const;

export type PlatformRoute = (typeof PLATFORM_ROUTES)[number];
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/**
 * Areas of the Centro that an administrator may open to a person outside the admin group
 * (#1513). Configurações, the gradebook's year settings, the Coletor and the public demo stay with
 * ADMINISTRADOR only.
 */
export const ACCESS_AREAS = [
  { id: 'desempenho', label: 'Banco de notas', detail: 'Desempenho, Boletins e Conselho' },
  { id: 'importacao', label: 'Importação', detail: 'Importação, Auditoria e OneDrive' },
  { id: 'painel-do-aluno', label: 'Painel do Aluno', detail: 'Painel do Aluno e Conciliação' },
  { id: 'saude', label: 'Saúde', detail: 'Saúde do sistema' },
] as const;
export type AccessArea = (typeof ACCESS_AREAS)[number]['id'];
export const ACCESS_AREA_IDS: readonly AccessArea[] = ACCESS_AREAS.map((area) => area.id);
export const areaCapabilityV1 = (area: AccessArea): PlatformCapability => `area.${area}`;
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
  capabilities: ['area.painel-do-aluno'],
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
