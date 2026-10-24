import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Avatar, Button, Chip, Description, Dropdown,
  Label, Separator, Spinner, Surface,
} from '@heroui/react';
import { Activity, Boxes, ChevronDown, LockKeyhole, LogOut, Menu, PanelLeft, ShieldCheck, X } from 'lucide-react';
import { normalizePlatformRoute, type PlatformRoute } from '../shared/platform-contract';
import { platformRouteNeedsMicrosoftV2, platformRouteUnavailableV2 } from '../shared/platform-snapshot-v2';
import { ShellAreaNameV1, ShellSectionTabsV1, ShellSidebarV3, serviceSectionFromHashV2 } from './platform/navigation';
import { LoadingWorkspace, PageContent } from './platform/pages';
import { BrandMark, formatDate, initials } from './platform/presentation';
import { SCHOOL_NAME_V1 } from './shared/brand/school-mark-v1';
import { PlatformSearch } from './platform/search';
import { useDrawerSwipeV1 } from './platform/drawer-swipe-v1';
import { withStudentPortalModule } from './platform/student-portal-module';
import { usePlatformDataV2 } from './platform/platform-data-v2';
import { usePlatformIdentityV1, type PlatformIdentityV1 as Identity } from './platform/platform-identity-v1';
import { AdministrativeLiveProviderV1 } from './shared/live-data/administrative-live-v1';
import { DraftUpdatesNoticeV1 } from './shared/forms/draft-navigation-v1';

type AuthFailure = { correlationId?: string };
function authFailureFromUrl(): AuthFailure | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('authError') !== '1') return null;
  const correlationId = params.get('correlationId')?.trim();
  return { correlationId: correlationId || undefined };
}
function routeFromHash(): PlatformRoute { return normalizePlatformRoute(window.location.hash.replace(/^#\/?/u, '')); }
function usePlatformRoute(): PlatformRoute {
  const [route, setRoute] = useState<PlatformRoute>(() => routeFromHash());
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    if (!window.location.hash) window.history.replaceState(null, '', '#/banco-de-notas');
    // Addresses saved before Auditoria moved into Saúde do Sistema.
    if (/^#\/?auditoria\b/u.test(window.location.hash)) window.location.replace('#/operacao?area=audit');
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}
function useLocationHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return hash;
}
/** The side column collapsed to its icons, remembered in this browser (owner request of 13/10/2026). */
const SIDE_COLLAPSED_KEY_V1 = 'centro.side-collapsed.v1';
function useSideCollapsedV1(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(SIDE_COLLAPSED_KEY_V1) === '1'; } catch { return false; }
  });
  const toggle = () => setCollapsed((current) => {
    // Storage can be unavailable (private window, blocked data): the choice then lasts for the visit.
    try { window.localStorage.setItem(SIDE_COLLAPSED_KEY_V1, current ? '0' : '1'); } catch { /* kept in memory */ }
    return !current;
  });
  return [collapsed, toggle];
}
function MicrosoftMark() {
  return <span className="grid size-4 grid-cols-2 gap-px" aria-hidden="true">
    <span className="bg-current" /><span className="bg-current" /><span className="bg-current" /><span className="bg-current" />
  </span>;
}
function SessionCheckExperience() {
  return <main className="platform-shell grid min-h-svh place-items-center p-6" aria-busy="true" aria-label="Carregando Centro de Administração">
    <div className="grid justify-items-center gap-4 text-muted"><BrandMark pulse /><Spinner size="sm" color="accent" /></div>
  </main>;
}
function LoginExperience({ loading }: Readonly<{ loading: boolean }>) {
  return (
    <main className="platform-shell grid min-h-svh place-items-center px-4 py-6 sm:px-6 lg:px-8">
      <Surface className="login-stage grid w-full max-w-5xl overflow-hidden rounded-3xl border border-border/70 lg:grid-cols-[1.08fr_.92fr]">
        <Surface variant="secondary" className="login-intro hidden min-h-[600px] flex-col justify-between rounded-none border-0 p-10 shadow-none lg:flex">
          <div>
            <BrandMark />
            <Chip className="mt-10" variant="soft" color="accent" size="sm">{SCHOOL_NAME_V1}</Chip>
            <h1 className="mt-6 max-w-xl text-4xl font-semibold tracking-[-0.05em]">Centro de Administração</h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted">
              Uma plataforma administrativa modular e protegida para operar os sistemas da escola em uma única experiência.
            </p>
          </div>
          <div className="grid max-w-xl gap-3 text-sm">
            {[[ShieldCheck, 'Acesso institucional protegido'], [Boxes, 'Módulos integrados à mesma experiência'],
              [Activity, 'Operação rastreável e evolutiva']].map(([Icon, label]) => {
              const FeatureIcon = Icon as typeof ShieldCheck;
              return <Surface key={label as string} variant="default" className="stagger-item flex items-center gap-3 rounded-2xl border border-border/70 px-4 py-3">
                <FeatureIcon className="size-4 text-muted" /><span>{label as string}</span>
              </Surface>;
            })}
          </div>
        </Surface>
        <Surface variant="default" className="flex min-h-[560px] items-center rounded-none border-0 px-6 py-12 shadow-none sm:px-12 lg:min-h-[600px]">
          <div className="mx-auto w-full max-w-sm">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <BrandMark compact />
              <div><p className="text-sm font-semibold">Centro de Administração</p><p className="text-xs text-muted">{SCHOOL_NAME_V1}</p></div>
            </div>
            <Chip color="accent" variant="soft" size="sm">Acesso institucional</Chip>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.045em]">{loading ? 'Preparando seu acesso' : 'Entre para continuar'}</h2>
            <p className="mt-3 text-sm leading-6 text-muted">Use sua conta institucional da escola para continuar.</p>
            {loading ? <Alert status="accent" className="mt-8">
              <Alert.Indicator><Spinner size="sm" color="accent" /></Alert.Indicator>
              <Alert.Content><Alert.Title>Verificando sua sessão</Alert.Title><Alert.Description>Estamos confirmando identidade e permissões administrativas.</Alert.Description></Alert.Content>
            </Alert> : <Button variant="primary" size="lg" fullWidth className="mt-8" onPress={() => window.location.assign('/auth/login')}>
              <MicrosoftMark />Entrar com conta institucional
            </Button>}
            <Surface variant="secondary" className="mt-8 flex items-start gap-3 rounded-2xl p-4 text-xs leading-5 text-muted">
              <LockKeyhole className="mt-0.5 size-4 shrink-0 text-foreground/70" /><p>O Centro não solicita nem armazena sua senha institucional.</p>
            </Surface>
          </div>
        </Surface>
      </Surface>
    </main>
  );
}
function AuthErrorExperience({ correlationId }: Readonly<AuthFailure>) {
  return <main className="platform-shell grid min-h-svh place-items-center p-4 sm:p-6">
    <Surface variant="default" className="platform-card-surface w-full max-w-xl rounded-3xl p-6 sm:p-8">
      <Chip color="danger" variant="soft" size="sm">Entrada não concluída</Chip>
      <Alert status="danger" className="mt-5"><Alert.Indicator /><Alert.Content>
        <Alert.Title>Não foi possível concluir sua entrada.</Alert.Title>
        <Alert.Description>A tentativa anterior foi encerrada com segurança. Inicie uma nova entrada para continuar.</Alert.Description>
      </Alert.Content></Alert>
      <Button variant="primary" size="lg" fullWidth className="mt-6" onPress={() => window.location.assign('/auth/login')}><MicrosoftMark />Entrar novamente</Button>
      {correlationId && <p className="mt-5 break-all text-xs leading-5 text-muted">Correlação: <span className="font-mono">{correlationId}</span></p>}
    </Surface>
  </main>;
}
function RestrictedExperience({ name }: Readonly<{ name?: string }>) {
  return <main className="platform-shell grid min-h-svh place-items-center p-4">
    <Surface variant="default" className="platform-card-surface w-full max-w-2xl rounded-3xl p-6 sm:p-8">
      <Chip color="warning" variant="soft" size="sm">Acesso restrito</Chip>
      <Alert status="warning" className="mt-5"><Alert.Indicator /><Alert.Content>
        <Alert.Title>Você não tem acesso a esta área</Alert.Title>
        <Alert.Description>{name ? `${name}, sua conta está autenticada.` : 'Sua conta está autenticada.'} Seu perfil não possui as permissões necessárias para acessar o Centro de Administração.</Alert.Description>
      </Alert.Content></Alert>
      <form method="post" action="/auth/logout" className="mt-6"><Button variant="outline" type="submit"><LogOut />Sair</Button></form>
    </Surface>
  </main>;
}
function AdminShell({ identity }: Readonly<{ identity: Identity }>) {
  const route = usePlatformRoute();
  const { loadState, reload } = usePlatformDataV2();
  const logoutFormRef = useRef<HTMLFormElement>(null);
  const snapshot = useMemo(() => loadState.status === 'ready' ? {
    ...loadState.snapshot,
    coreModules: withStudentPortalModule(loadState.snapshot.coreModules, identity.capabilities ?? []),
  } : null, [loadState, identity.capabilities]);
  const modules = snapshot?.coreModules ?? [];
  const hash = useLocationHash();
  // On phones the side column is a drawer; it closes when the address changes.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [hash]);
  const [sideCollapsed, toggleSide] = useSideCollapsedV1();
  const drawerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useDrawerSwipeV1(menuOpen, setMenuOpen, drawerRef);
  useEffect(() => {
    if (!menuOpen) return;
    const drawer = drawerRef.current;
    const main = mainRef.current;
    // Everything but the drawer is inert while it is open: the page and the two bars above it.
    const bar = document.querySelector<HTMLElement>('.shell-topbar');
    const areaBar = document.querySelector<HTMLElement>('.shell-areabar');
    main?.setAttribute('inert', '');
    bar?.setAttribute('inert', '');
    areaBar?.setAttribute('inert', '');
    (drawer?.querySelector<HTMLElement>(".shell-side__area[data-open='true']") ??
      drawer?.querySelector<HTMLElement>('.shell-side__area'))?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
      if (event.key !== 'Tab' || !drawer) return;
      // Tab and Shift+Tab stay inside the drawer.
      const stops = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
        // Only what can really take focus: nothing hidden by the styles and nothing inside an
        // inert branch.
        .filter((item) => item.tabIndex >= 0 && !item.closest('[inert]') &&
          (typeof item.checkVisibility !== 'function' || item.checkVisibility()));
      const first = stops[0], last = stops.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (!drawer.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    // The drawer only exists on phones; a window that grows past them closes it.
    const wide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 901px)') : null;
    const onWide = () => { if (wide?.matches) setMenuOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    wide?.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      wide?.removeEventListener('change', onWide);
      main?.removeAttribute('inert');
      bar?.removeAttribute('inert');
      areaBar?.removeAttribute('inert');
      menuButtonRef.current?.focus();
    };
  }, [menuOpen]);
  const section = serviceSectionFromHashV2(route, hash);
  const native = !platformRouteNeedsMicrosoftV2(route, section);
  // Settings mixes a native PostgreSQL year selector/session controls and external cards.
  // Keep the native controls mounted; each Microsoft card applies its own availability gate.
  const mixedSettings = route === 'configuracoes';
  const showPage = loadState.status === 'ready' && (native || mixedSettings || (
    (loadState.auxiliary === 'ready' || loadState.auxiliary === 'partial')
    && !platformRouteUnavailableV2(route, loadState.snapshot, section)
  ));
  const profileMenu = (
            <Dropdown>
              <Button variant="ghost" size="md" className="profile-menu-trigger shrink-0 gap-2 px-2.5" aria-label="Abrir menu do perfil">
                <Avatar size="sm" color="accent" variant="soft"><Avatar.Fallback className="text-xs font-medium">{initials(identity.name)}</Avatar.Fallback></Avatar>
                <span className="hidden min-w-0 text-left lg:block"><span className="block max-w-40 truncate text-sm font-medium">{identity.name || 'Administrador'}</span><span className="block max-w-40 truncate text-xs font-normal text-muted">Administrador</span></span>
                <ChevronDown className="hidden size-4 text-muted sm:block" />
              </Button>
              <Dropdown.Popover className="min-w-72"><Dropdown.Menu aria-label="Conta e sessão" onAction={(key) => { if (key === 'logout') logoutFormRef.current?.requestSubmit(); }}>
                <Dropdown.Item id="identity" textValue="Perfil atual" isDisabled className="profile-menu-identity">
                  <div className="profile-menu-item-content">
                    <Avatar size="sm" color="accent" variant="soft"><Avatar.Fallback>{initials(identity.name)}</Avatar.Fallback></Avatar>
                    <div className="profile-menu-copy"><Label className="max-w-52 truncate">{identity.name || 'Administrador'}</Label><Description className="max-w-52 truncate">Administrador · sessão institucional</Description></div>
                  </div>
                </Dropdown.Item>
                <Separator />
                <Dropdown.Item id="logout" textValue="Sair" variant="danger"><div className="profile-menu-item-content"><LogOut className="size-4 shrink-0" /><div className="profile-menu-copy"><Label>Sair</Label><Description>Encerrar a sessão institucional</Description></div></div></Dropdown.Item>
              </Dropdown.Menu></Dropdown.Popover>
            </Dropdown>
  );
  return (
    <div className="platform-shell platform-shell--v2 min-h-svh" data-side={sideCollapsed ? 'collapsed' : undefined}>
      <Surface variant="default" className="platform-topbar shell-topbar sticky top-0 z-30 rounded-none">
        <Button ref={menuButtonRef} variant="ghost" size="md" isIconOnly className="shell-menu-button" aria-controls="shell-drawer" aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'} aria-expanded={menuOpen} onPress={() => setMenuOpen((open) => !open)}>
          {menuOpen ? <X /> : <Menu />}
        </Button>
        <Button variant="ghost" size="md" isIconOnly className="shell-collapse-button" aria-controls="shell-drawer" aria-label={sideCollapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'} aria-pressed={sideCollapsed} onPress={toggleSide}>
          <PanelLeft />
        </Button>
        <div className="shell-path">
          <a href="#/banco-de-notas" className="shell-brand text-foreground no-underline" aria-label="Ir para o início do Centro de Administração">
            <BrandMark compact />
            <span className="shell-brand__name">
              <span>Centro de Administração</span>
              <small>Escola Mun. Prof.ª Iêda Alves de Oliveira · MCPM</small>
            </span>
          </a>
          <ShellAreaNameV1 route={route} section={section} modules={modules} />
        </div>
        <div className="shell-tools">
            <PlatformSearch snapshot={snapshot} />
            <form ref={logoutFormRef} method="post" action="/auth/logout" className="hidden" />
            {profileMenu}
        </div>
      </Surface>
      <div className="shell-areabar">
        <ShellSectionTabsV1 route={route} section={section} modules={modules} />
      </div>
      <div className="shell-body shell-body--service">
        {menuOpen && <button type="button" className="shell-drawer-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} />}
        <aside ref={drawerRef} id="shell-drawer" className="shell-aside" data-open={menuOpen ? 'true' : undefined} {...(menuOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Menu do Centro' } : {})}>
          <Button variant="ghost" size="sm" isIconOnly className="shell-drawer-close" aria-label="Fechar menu" onPress={() => setMenuOpen(false)}><X /></Button>
          <ShellSidebarV3
            route={route}
            section={section}
            modules={modules}
            loading={loadState.status === 'loading'}
            brand={
              <a href="#/banco-de-notas" className="shell-side__brand-link text-foreground no-underline" aria-label="Ir para o início do Centro de Administração">
                <BrandMark compact />
                <span className="shell-side__brand-name">
                  <span>Centro de Administração</span>
                  <small>{SCHOOL_NAME_V1}</small>
                </span>
              </a>
            }
          />
        </aside>
        <main ref={mainRef} className="shell-main shell-main--service">
          <DraftUpdatesNoticeV1 />
          {loadState.status === 'loading' && <LoadingWorkspace />}
          {loadState.status === 'error' && <Surface variant="default" className="platform-card-surface max-w-3xl rounded-3xl p-5 sm:p-7">
            <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>Não foi possível carregar o Centro</Alert.Title><Alert.Description>{loadState.message}</Alert.Description></Alert.Content></Alert>
            <div className="mt-5 flex flex-wrap items-center gap-3"><Button variant="outline" onPress={() => { void reload(); }}>Tentar novamente</Button>
              {loadState.correlationId && <Chip variant="soft" size="sm" className="font-mono">Correlação: {loadState.correlationId}</Chip>}
            </div>
          </Surface>}
          {loadState.status === 'ready' && !native && !mixedSettings && loadState.auxiliary === 'loading' && <LoadingWorkspace />}
          {loadState.status === 'ready' && !showPage && loadState.auxiliary !== 'loading' && <Alert status="warning">
            <Alert.Indicator /><Alert.Content><Alert.Title>Informações desta área temporariamente indisponíveis</Alert.Title>
              <Alert.Description>{loadState.auxiliaryMessage} A consulta será refeita automaticamente.</Alert.Description>
            </Alert.Content>
          </Alert>}
          {showPage && loadState.status === 'ready' && <div key={route} className="route-stage">
            <PageContent route={route} section={section} snapshot={snapshot ?? loadState.snapshot} auxiliary={loadState.auxiliary} />
            <Separator className="mt-8" />
            <footer className="grid gap-2 pt-5 text-xs text-muted sm:grid-cols-2 sm:items-center"><span>Centro de Administração · {SCHOOL_NAME_V1}</span><span className="sm:text-right">Atualizado em {formatDate(loadState.snapshot.generatedAt)}</span></footer>
          </div>}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { identity, accessError, retry, recheck } = usePlatformIdentityV1();
  const authFailure = authFailureFromUrl();
  if (accessError) return <main className="platform-shell grid min-h-svh place-items-center p-4 sm:p-6">
    <Surface className="platform-card-surface w-full max-w-xl rounded-3xl p-6 sm:p-8"><Alert status="warning"><Alert.Indicator /><Alert.Content>
      <Alert.Title>Não foi possível verificar seu acesso.</Alert.Title><Alert.Description>Confira sua conexão e tente novamente em instantes.</Alert.Description>
    </Alert.Content></Alert><Button variant="outline" className="mt-5" onPress={retry}>Tentar novamente</Button></Surface>
  </main>;
  if (identity === null) return <SessionCheckExperience />;
  if (authFailure && !identity.authenticated) return <AuthErrorExperience correlationId={authFailure.correlationId} />;
  if (!identity.authenticated) return <LoginExperience loading={false} />;
  if (!identity.capabilities?.includes('platform.snapshot.read')) return <RestrictedExperience name={identity.name} />;
  return <AdministrativeLiveProviderV1
    identityKey={identity.identityKey ? `${identity.identityKey}:${identity.expiresAt ?? ''}:${identity.capabilities.join(',')}` : undefined}
    enabled={identity.capabilities.includes('platform.settings.read')}
    onAuthorizationLost={recheck}>
    <AdminShell key={`${identity.identityKey ?? 'current-session'}:${identity.capabilities.join(',')}`} identity={identity} />
  </AdministrativeLiveProviderV1>;
}