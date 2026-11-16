import type { PlatformRoute, PlatformSnapshotContract } from '../../shared/platform-contract';
import { notesModule, notesSections, withNotesModule } from './notes-module';
import { platformHref } from './routes';
import {
  studentPortalModule,
  studentPortalSections,
  studentPortalHref,
} from './student-portal-module';

export type SearchCategory = 'Área' | 'Seção' | 'Configuração';
export type SearchIconKind = 'route' | 'configuration';

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
          label: 'Conciliação',
          description: 'Conferir pendências e conciliar alunos.',
          category: 'Área',
          href: studentPortalHref('reconciliation'),
          iconKind: 'route',
          route: studentPortalModule.route,
          searchText: normalizeSearch(
            'Conciliação reconciliação pendências alunos Smecel relatório',
          ),
        },
      ]
    : [];
  return [...core, ...notes, ...students, ...portal];
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
