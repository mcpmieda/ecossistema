import {
  STUDENT_PORTAL_MODULE,
  type CoreModuleContract,
  type PlatformCapability,
} from '../../shared/platform-contract';

export const studentPortalModule = STUDENT_PORTAL_MODULE;
export const studentPortalSections = [
  { id: 'overview', label: 'Visão geral', description: 'Contas, acesso e saúde operacional.' },
  {
    id: 'accounts',
    label: 'Alunos',
    description: 'Pesquisar alunos, abrir fichas e gerenciar acesso.',
  },
  {
    id: 'credentials',
    label: 'QR code',
    description: 'Nascimento, QR de acesso e PDF por turma.',
  },
  {
    id: 'policies',
    label: 'Políticas',
    description: 'Acesso, períodos, divulgação e políticas personalizadas.',
  },
  {
    id: 'sessions',
    label: 'Sessões',
    description: 'Ver acessos ativos e histórico.',
  },
  { id: 'audit', label: 'Auditoria', description: 'Consultar eventos e detalhes autorizados.' },
  {
    id: 'settings',
    label: 'Configurações',
    description: 'Operações gerais da escola.',
  },
] as const;
export type StudentPortalSection =
  (typeof studentPortalSections)[number]['id'] | 'birth' | 'publication' | 'reconciliation';
export function portalSectionFromHash(hash: string): StudentPortalSection {
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const selected = params.get('area');
  if (selected === 'reconciliation') return 'reconciliation';
  if (selected === 'birth') return 'credentials';
  if (selected === 'publication') return 'audit';
  return studentPortalSections.find((section) => section.id === selected)?.id ?? 'overview';
}
export const studentPortalHref = (section: StudentPortalSection) =>
  '#/painel-do-aluno?area=' +
  (section === 'birth' ? 'credentials' : section === 'publication' ? 'audit' : section);
export function withStudentPortalModule(
  modules: CoreModuleContract[],
  capabilities: readonly PlatformCapability[],
) {
  const existing = modules.filter((module) => module.route !== 'painel-do-aluno');
  return capabilities.includes('platform.settings.read')
    ? [...existing, studentPortalModule]
    : existing;
}
