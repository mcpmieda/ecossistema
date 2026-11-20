import { Skeleton } from '@heroui/react';
import type { MouseEvent, ReactNode } from 'react';
import {
  ChartColumn,
  Circle,
  CloudCog,
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
import { defaultNotesSectionId, notesSectionCapabilityV1, notesSections } from './notes-module';
import { useSidebarHealthV1 } from './sidebar-health-v1';
import {
  reconciliationPendingLabelV1,
  useReconciliationPendingCountV1,
  useReconciliationPendingReaderV1,
} from './reconciliation-pending-v1';
import {
  auditPendingLabelV1,
  useAuditPendingCountV1,
  useAuditPendingReaderV1,
} from './audit-pending-v1';
import { RECONCILIATION_PENDING_CAP_V1 } from '../../shared/student-identity/reconciliation-v1';
import {
  portalSectionFromHash,
  studentPortalHref,
  studentPortalSections,
} from './student-portal-module';
import { platformHref, routeIcons } from './routes';
import { SectionLinksV1 } from './section-links-v1';

/*
 * The sections of each service. The side column lists the areas of the Centro and the sections of
 * the open one are tabs in the top bar.
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
  council: Gavel,
  settings: Settings2,
  onedrive: CloudCog,
  reconciliation: Users,
};
/** Sections of the Banco de notas shown under the area Importação, in the order of its tabs: the
 * OneDrive automatic read, the Auditoria, the manual import and the Conciliação. */
const IMPORT_AREA_ORDER_V1 = ['onedrive', 'audit', defaultNotesSectionId, 'reconciliation'];
const IMPORT_AREA_SECTIONS_V1: ReadonlySet<string> = new Set(IMPORT_AREA_ORDER_V1);
export function importAreaSectionsV1(): ServiceSectionV2[] {
  return IMPORT_AREA_ORDER_V1.flatMap((id) => {
    const section = notesSections.find((item) => item.id === id);
    if (!section) return [];
    return [
      {
        id: section.id,
        label: section.label,
        href: id === defaultNotesSectionId ? '#/banco-de-notas?area=importacao' : section.href,
        icon: NOTES_SECTION_ICONS_V2[section.id] ?? Circle,
      },
    ];
  });
}
/** The Importação's count in the side column: the Auditoria's and the Conciliação's together. */
export function importPendingLabelV1(
  audit: number | null,
  reconciliation: number | null,
): string | null {
  const capped = (audit ?? 0) > 999 || (reconciliation ?? 0) > RECONCILIATION_PENDING_CAP_V1;
  const total =
    Math.min(audit ?? 0, 999) + Math.min(reconciliation ?? 0, RECONCILIATION_PENDING_CAP_V1);
  if (total === 0) return null;
  return capped ? `${total}+` : String(total);
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
    return [{ id: 'health', label: 'Saúde', href: '#/operacao', icon: HeartPulse }];
  return [];
}
/** The section in the address; each service falls back to its own first section. */
export function serviceSectionFromHashV2(route: PlatformRoute, hash: string): string {
  // The platform's SharePoint Auditoria was retired: Saúde is the only section.
  if (route === 'operacao') return 'health';
  if (route === 'painel-do-aluno') {
    const section = portalSectionFromHash(hash);
    return section === 'credentials' ? 'accounts' : section;
  }
  const requested = new URLSearchParams(hash.split('?')[1] ?? '').get('area');
  return notesSections.some((section) => section.id === requested)
    ? (requested as string)
    : defaultNotesSectionId;
}
/** Services first, then the platform areas. */
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
  return topOrderV2(modules).flatMap((module) => {
    const common = { route: module.route, icon: routeIcons[module.route] };
    if (module.route === 'banco-de-notas') {
      const allowed = (item: { id: string }) =>
        module.capabilities.includes(notesSectionCapabilityV1(item.id));
      const importSections = importAreaSectionsV1().filter(allowed);
      return [
        {
          ...common,
          id: module.id,
          name: module.name,
          href: '#/banco-de-notas?area=performance',
          open: route === module.route && !IMPORT_AREA_SECTIONS_V1.has(section),
          sections: serviceSectionsV2(module.route).filter(allowed),
        },
        {
          ...common,
          id: 'navigation.import',
          name: 'Importação',
          icon: Upload,
          // The first of its tabs this person may open.
          href: importSections[0]?.href ?? '#/banco-de-notas?area=importacao',
          open: route === module.route && IMPORT_AREA_SECTIONS_V1.has(section),
          sections: importSections,
        },
      ].filter((area) => area.sections.length > 0);
    }
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
 * Composition: the side column lists only the areas of the Centro, and the sections of the open
 * area are tabs in the top bar.
 */
const HEALTH_LABELS_V1 = { normal: 'Normal', attention: 'Atenção', critical: 'Crítico' } as const;

export function ShellSidebarV3({
  route,
  section,
  modules,
  loading,
  brand,
}: Readonly<{
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
  loading: boolean;
  brand: ReactNode;
}>) {
  const areas = mainNavigationAreasV1(modules, route, section);
  const groups = [
    { label: 'Menu principal', areas: areas.filter((area) => !SYSTEM_ROUTES_V1.has(area.route)) },
    { label: 'Sistema', areas: areas.filter((area) => SYSTEM_ROUTES_V1.has(area.route)) },
  ].filter((group) => group.areas.length > 0);
  const health = useSidebarHealthV1(!loading && areas.some((area) => area.route === 'operacao'));
  const importTabs = areas.find((area) => area.id === 'navigation.import')?.sections ?? [];
  const readsAudit = !loading && importTabs.some((item) => item.id === 'audit');
  const readsReconciliation = !loading && importTabs.some((item) => item.id === 'reconciliation');
  const visit = `${route}:${section}`;
  useAuditPendingReaderV1(readsAudit, visit);
  useReconciliationPendingReaderV1(readsReconciliation, visit);
  const auditCount = useAuditPendingCountV1();
  const reconciliationCount = useReconciliationPendingCountV1();
  const pending = importPendingLabelV1(
    readsAudit ? auditCount : null,
    readsReconciliation ? reconciliationCount : null,
  );
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
                        {module.id === 'navigation.import' && pending && (
                          <span className="shell-side__count">
                            {pending}
                            <span className="sr-only"> pendências</span>
                          </span>
                        )}
                        {module.route === 'operacao' && health && health !== 'unknown' && (
                          <span className="shell-side__status" data-state={health}>
                            <span className="sr-only">{HEALTH_LABELS_V1[health]}</span>
                          </span>
                        )}
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
}: Readonly<{
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
}>) {
  const area = mainNavigationAreasV1(modules, route, section).find((module) => module.open);
  return area ? <span className="shell-path__area">{area.name}</span> : null;
}

/** Route navigation retains the tab appearance without dangling tab-panel relationships. */
export function ShellSectionTabsV1({
  route,
  section,
  modules,
}: Readonly<{
  route: PlatformRoute;
  section: string;
  modules: CoreModuleContract[];
}>) {
  const area = mainNavigationAreasV1(modules, route, section).find((module) => module.open);
  const auditCount = useAuditPendingCountV1();
  const reconciliationCount = useReconciliationPendingCountV1();
  const counts: Readonly<Record<string, string | null>> = {
    audit: auditPendingLabelV1(auditCount),
    reconciliation: reconciliationPendingLabelV1(reconciliationCount),
  };
  const sections = (area?.sections ?? []).map((item) =>
    area?.id === 'navigation.import' && item.id in counts
      ? { ...item, count: counts[item.id] }
      : item,
  );
  if (!area || sections.length === 0) return null;
  return <SectionLinksV1 label={`Seções de ${area.name}`} section={section} sections={sections} />;
}
