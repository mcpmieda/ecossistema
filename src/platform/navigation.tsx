import { Skeleton, Tabs } from '@heroui/react';
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
 * The sections of each service. Since 13/10/2026 (owner request) the side column lists the areas
 * of the Centro and the sections of the open one are tabs in the top bar.
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
/** Sections of the Banco de notas shown under the area Importação: the import itself and its
 * Auditoria (owner request of 13/10/2026). Their addresses did not change. */
const IMPORT_AREA_SECTIONS_V1: ReadonlySet<string> = new Set([defaultNotesSectionId, 'audit']);
export function importAreaSectionsV1(): ServiceSectionV2[] {
  return notesSections
    .filter((section) => IMPORT_AREA_SECTIONS_V1.has(section.id))
    .map((section) => ({
      id: section.id,
      label: section.label,
      href:
        section.id === defaultNotesSectionId ? '#/banco-de-notas?area=importacao' : section.href,
      icon: NOTES_SECTION_ICONS_V2[section.id] ?? Circle,
    }));
}
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
      .filter((section) => !IMPORT_AREA_SECTIONS_V1.has(section.id))
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
/** Areas about the Centro itself; the others are the work of the school. */
const SYSTEM_ROUTES_V1: ReadonlySet<PlatformRoute> = new Set(['operacao', 'configuracoes']);
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
          open: route === module.route && !IMPORT_AREA_SECTIONS_V1.has(section),
          sections: serviceSectionsV2(module.route),
        },
        {
          ...common,
          id: 'navigation.import',
          name: 'Importação',
          icon: Upload,
          href: '#/banco-de-notas?area=importacao',
          open: route === module.route && IMPORT_AREA_SECTIONS_V1.has(section),
          sections: importAreaSectionsV1(),
        },
      ];
    if (module.route === 'painel-do-aluno')
      return [
        {
          ...common,
          id: 'navigation.students',
          name: 'Conciliação',
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
 * Composition of 13/10/2026 (owner request): the side column lists only the areas of the Centro,
 * and the sections of the open area are tabs in the top bar.
 */
export function ShellSidebarV3({
  route,
  section,
  modules,
  loading,
  brand,
}: {
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
  loading: boolean;
  brand: ReactNode;
}) {
  const areas = mainNavigationAreasV1(modules, route, section);
  const groups = [
    { label: 'Menu principal', areas: areas.filter((area) => !SYSTEM_ROUTES_V1.has(area.route)) },
    { label: 'Sistema', areas: areas.filter((area) => SYSTEM_ROUTES_V1.has(area.route)) },
  ].filter((group) => group.areas.length > 0);
  return (
    <nav aria-label="Navegação principal" className="shell-side">
      <div className="shell-side__brand">{brand}</div>
      {loading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : (
        <div className="shell-side__groups">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="shell-side__group-label">{group.label}</p>
              <ul className="shell-side__areas">
                {group.areas.map((module) => {
                  const Icon = module.icon;
                  return (
                    <li key={module.id}>
                      <a
                        href={module.href}
                        aria-current={module.open ? 'page' : undefined}
                        data-open={module.open ? 'true' : undefined}
                        title={module.name}
                        className="shell-side__area no-underline"
                        onClick={guardDraft}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{module.name}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

/** The name of the open area, for the bar of the site. */
export function ShellAreaNameV1({
  route,
  section,
  modules,
}: {
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
}) {
  const area = mainNavigationAreasV1(modules, route, section).find((module) => module.open);
  return area ? <span className="shell-path__area">{area.name}</span> : null;
}

/** The open area's name and, when it has them, its sections as a row of tabs. */
export function ShellSectionTabsV1({
  route,
  section,
  modules,
}: {
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
}) {
  const area = mainNavigationAreasV1(modules, route, section).find((module) => module.open);
  const sections = area?.sections ?? [];
  if (!area || sections.length === 0) return null;
  return (
    <Tabs
      variant="secondary"
      className="shell-sections__tabs"
      selectedKey={section}
      onSelectionChange={(key) => {
        const next = sections.find((item) => item.id === key);
        // The address is the state: the tab only moves once the address has changed.
        if (next && next.id !== section && allowDraftNavigationV1())
          window.location.hash = next.href;
      }}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label={`Seções de ${area.name}`}>
          {sections.map((item) => (
            <Tabs.Tab key={item.id} id={item.id}>
              {item.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
