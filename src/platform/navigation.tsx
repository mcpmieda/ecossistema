import { Skeleton } from '@heroui/react';
import type { MouseEvent, ReactNode } from 'react';
import {
  ChartColumn,
  Circle,
  FileText,
  Gavel,
  HeartPulse,
  LayoutDashboard,
  type LucideIcon,
  MonitorSmartphone,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Users,
} from 'lucide-react';
import type { CoreModuleContract, PlatformRoute } from '../../shared/platform-contract';
import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import { defaultNotesSectionId, notesSections, withNotesModule } from './notes-module';
import {
  portalSectionFromHash,
  studentPortalHref,
  studentPortalSections,
} from './student-portal-module';
import { platformHref, routeIcons } from './routes';

/*
 * Shell layout of 07/10/2026 (owner request): the areas of the Centro sit in one subtle row at
 * the top, and the side column lists the sections of the service that is open.
 */
type ServiceSectionV2 = { id: string; label: string; href: string; icon: LucideIcon };
const PORTAL_SECTION_ICONS_V2: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  accounts: Users,
  policies: SlidersHorizontal,
  sessions: MonitorSmartphone,
  audit: ShieldCheck,
  settings: Settings2,
};
const NOTES_SECTION_ICONS_V2: Record<string, LucideIcon> = {
  [defaultNotesSectionId]: Upload,
  audit: ShieldCheck,
  performance: ChartColumn,
  bulletins: FileText,
  council: Gavel,
  settings: Settings2,
};
export function serviceSectionsV2(route: PlatformRoute): ServiceSectionV2[] {
  if (route === 'painel-do-aluno')
    return studentPortalSections
      .filter((section) => section.id !== 'credentials')
      .map((section) => ({
        id: section.id,
        label: section.label,
        href: studentPortalHref(section.id),
        icon: PORTAL_SECTION_ICONS_V2[section.id] ?? Circle,
      }));
  if (route === 'banco-de-notas')
    return notesSections
      .filter((section) => section.id !== 'importacao')
      .map((section) => ({
        id: section.id,
        label: section.label,
        href: section.href,
        icon: NOTES_SECTION_ICONS_V2[section.id] ?? Circle,
      }));
  if (route === 'operacao')
    return [
      { id: 'health', label: 'Saúde do Sistema', href: '#/operacao', icon: HeartPulse },
      { id: 'audit', label: 'Auditoria', href: '#/operacao?area=audit', icon: ShieldCheck },
    ];
  return [];
}
/** The section in the address; each service falls back to its own first section. */
export function serviceSectionFromHashV2(route: PlatformRoute, hash: string): string {
  if (route === 'operacao')
    return new URLSearchParams(hash.split('?')[1] ?? '').get('area') === 'audit'
      ? 'audit'
      : 'health';
  if (route === 'painel-do-aluno') {
    const section = portalSectionFromHash(hash);
    return section === 'credentials' ? 'accounts' : section;
  }
  const requested = new URLSearchParams(hash.split('?')[1] ?? '').get('area');
  return notesSections.some((section) => section.id === requested)
    ? (requested as string)
    : defaultNotesSectionId;
}
/** Services first, then the platform areas (owner order of 07/10/2026). */
const TOP_ORDER_V2: readonly PlatformRoute[] = [
  'banco-de-notas',
  'painel-do-aluno',
  'operacao',
  'configuracoes',
];
const topOrderV2 = (modules: CoreModuleContract[]) =>
  [...modules].sort(
    (left, right) => TOP_ORDER_V2.indexOf(left.route) - TOP_ORDER_V2.indexOf(right.route),
  );
const guardDraft = (event: MouseEvent<HTMLAnchorElement>) => {
  if (!allowDraftNavigationV1()) event.preventDefault();
};

/** Navigation areas reuse the authorized services and their existing addresses. */
export function mainNavigationAreasV1(
  modules: CoreModuleContract[],
  route: PlatformRoute,
  section: string,
) {
  return topOrderV2(withNotesModule(modules)).flatMap((module) => {
    const common = { route: module.route, icon: routeIcons[module.route] };
    if (module.route === 'banco-de-notas')
      return [
        {
          ...common,
          id: module.id,
          name: module.name,
          href: '#/banco-de-notas?area=performance',
          open: route === module.route && section !== 'importacao',
          sections: serviceSectionsV2(module.route),
        },
        {
          ...common,
          id: 'navigation.import',
          name: 'Importação',
          icon: Upload,
          href: '#/banco-de-notas?area=importacao',
          open: route === module.route && section === 'importacao',
          sections: [],
        },
      ];
    if (module.route === 'painel-do-aluno')
      return [
        {
          ...common,
          id: 'navigation.students',
          name: 'Alunos',
          icon: Users,
          href: studentPortalHref('reconciliation'),
          open: route === module.route && section === 'reconciliation',
          sections: [],
        },
        {
          ...common,
          id: module.id,
          name: module.name,
          href: platformHref(module.route),
          open: route === module.route && section !== 'reconciliation',
          sections: serviceSectionsV2(module.route),
        },
      ];
    return [
      {
        ...common,
        id: module.id,
        name: module.name,
        href: platformHref(module.route),
        open: route === module.route,
        sections: serviceSectionsV2(module.route),
      },
    ];
  });
}

/*
 * Composition of 08/10/2026 (owner study): on a computer there is no menu on top. One side
 * column holds the brand, the search, the areas of the Centro with the sections of the open
 * one, and the profile.
 */
export function ShellSidebarV3({
  route,
  section,
  modules,
  loading,
  brand,
  search,
  profile,
}: {
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
  loading: boolean;
  brand: ReactNode;
  search: ReactNode;
  profile: ReactNode;
}) {
  return (
    <nav aria-label="Navegação principal" className="shell-side">
      <div className="shell-side__brand">{brand}</div>
      <div className="shell-side__search">{search}</div>
      {loading ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <ul className="shell-side__areas">
          {mainNavigationAreasV1(modules, route, section).map((module) => {
            const open = module.open;
            const Icon = module.icon;
            const sections = open ? module.sections : [];
            return (
              <li key={module.id}>
                <a
                  href={module.href}
                  aria-current={open && sections.length === 0 ? 'page' : undefined}
                  data-open={open ? 'true' : undefined}
                  className="shell-side__area no-underline"
                  onClick={guardDraft}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{module.name}</span>
                </a>
                {sections.length > 0 ? (
                  <ul className="shell-side__sections">
                    {sections.map((item) => {
                      const isSelected = item.id === section;
                      return (
                        <li key={item.id}>
                          <a
                            href={item.href}
                            aria-current={isSelected ? 'page' : undefined}
                            data-selected={isSelected ? 'true' : undefined}
                            className="shell-side__section no-underline"
                            onClick={guardDraft}
                          >
                            <span className="truncate">{item.label}</span>
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="shell-side__profile">{profile}</div>
    </nav>
  );
}
