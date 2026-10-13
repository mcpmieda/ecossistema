import type { PlatformRoute, PlatformSnapshotContract } from '../../shared/platform-contract';
import { notesModule, notesSections, withNotesModule } from './notes-module';
import { platformHref } from './routes';
import {
  studentPortalModule,
  studentPortalSections,
  studentPortalHref,
} from './student-portal-module';

export type SearchCategory = 'Área' | 'Seção' | 'Sistema' | 'Configuração';
export type SearchIconKind = 'route' | 'system' | 'configuration';

export type PlatformSearchItem = {
  id: string;
  label: string;
  description: string;
  category: SearchCategory;
  href: string;
  searchText: string;
  iconKind: SearchIconKind;
  route?: PlatformRoute;
};

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR');
}

export function buildSearchItems(snapshot: PlatformSnapshotContract): PlatformSearchItem[] {
  const core = withNotesModule(snapshot.coreModules).map((module) => ({
    id: `core:${module.id}`,
    label: module.name,
    description: module.description,
    category: 'Área' as const,
    href:
      module.route === 'banco-de-notas'
        ? '#/banco-de-notas?area=performance'
        : platformHref(module.route),
    searchText: normalizeSearch(
      `${module.name} ${module.description} ${module.route} ${module.capabilities.join(' ')}`,
    ),
    iconKind: 'route' as const,
    route: module.route,
  }));

  const notes = notesSections.map((section) => ({
    id: `notes:${section.id}`,
    label: section.label,
    description:
      section.id === 'importacao'
        ? section.description
        : `${notesModule.name} · ${section.description}`,
    category: section.id === 'importacao' ? ('Área' as const) : ('Seção' as const),
    href: section.href,
    searchText: normalizeSearch(
      `${notesModule.name} ${notesModule.description} ${section.label} ${section.description} ${section.searchTerms}`,
    ),
    iconKind: 'route' as const,
    route: notesModule.route,
  }));

  // Auditoria is a section of Saúde do Sistema.
  const health = snapshot.coreModules.some((module) => module.route === 'operacao')
    ? [
        {
          id: 'health:audit',
          label: 'Auditoria',
          description: 'Saúde do Sistema · Trilha administrativa',
          category: 'Seção' as const,
          href: '#/operacao?area=audit',
          searchText: normalizeSearch(
            'Saúde do Sistema Auditoria rastreabilidade trilha administrativa eventos',
          ),
          iconKind: 'route' as const,
          route: 'operacao' as const,
        },
      ]
    : [];

  const systems = snapshot.registeredModules.map((module) => ({
    id: `system:${module.id}`,
    label: module.name,
    description: `${module.integrationState === 'ready' ? 'Sistema integrado' : 'Sistema registrado'} · ${module.key}${module.version ? ` · v${module.version}` : ''}`,
    category: 'Sistema' as const,
    href: platformHref('operacao'),
    searchText: normalizeSearch(
      `${module.name} ${module.key} ${module.version} ${module.status} ${module.integrationState} ${module.requiredCapabilities.join(' ')}`,
    ),
    iconKind: 'system' as const,
    route: 'operacao' as const,
  }));

  const configurations = snapshot.configurations.map((configuration) => ({
    id: `config:${configuration.id}`,
    label: configuration.key,
    description: `Configuração ${configuration.scope}${configuration.version ? ` · v${configuration.version}` : ''}`,
    category: 'Configuração' as const,
    href: platformHref('configuracoes'),
    searchText: normalizeSearch(
      `${configuration.key} ${configuration.scope} ${configuration.version} ${configuration.active ? 'ativa' : 'inativa'}`,
    ),
    iconKind: 'configuration' as const,
    route: 'configuracoes' as const,
  }));

  const portal = snapshot.coreModules.some((module) => module.route === 'painel-do-aluno')
    ? studentPortalSections.map((section) => ({
        id: 'student-portal:' + section.id,
        label: section.label,
        description: studentPortalModule.name + ' · ' + section.description,
        category: 'Seção' as const,
        href: studentPortalHref(section.id),
        searchText: normalizeSearch(
          studentPortalModule.name +
            ' portal aluno 2026 ' +
            section.label +
            ' ' +
            section.description,
        ),
        iconKind: 'route' as const,
        route: studentPortalModule.route,
      }))
    : [];
  const students: PlatformSearchItem[] = portal.length
    ? [
        {
          id: 'students:reconciliation',
          label: 'Alunos',
          description: 'Conferir pendências e conciliar alunos.',
          category: 'Área',
          href: studentPortalHref('reconciliation'),
          iconKind: 'route',
          route: studentPortalModule.route,
          searchText: normalizeSearch(
            'Alunos cadastro reconciliação conciliação pendências Smecel relatório',
          ),
        },
      ]
    : [];
  return [...core, ...notes, ...students, ...portal, ...health, ...systems, ...configurations];
}

export function filterSearchItems(
  items: PlatformSearchItem[],
  query: string,
  limit = 7,
): PlatformSearchItem[] {
  const normalizedQuery = normalizeSearch(query.trim());
  const queryTerms = normalizedQuery.split(/\s+/u).filter(Boolean);
  const matches = queryTerms.length
    ? items.filter((item) => queryTerms.every((term) => item.searchText.includes(term)))
    : items;
  return matches.slice(0, Math.max(0, limit));
}
