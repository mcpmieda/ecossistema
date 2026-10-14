// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import type { PlatformSourceSectionV2 } from '../shared/platform-snapshot-v2';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

// Keep the real App, PageContent, settings, year provider and workspace panels.
// Only the network is synthetic: this catches gates hidden by mocking PageContent.
const snapshot = () => buildPlatformSnapshot({
  lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [],
  correlationId: 'synthetic-1287',
}, PLATFORM_CAPABILITIES);
const catalogue = {
  contractVersion: 2, state: 'ready', operation: 'bootstrap',
  years: [2026, 2025].map((year) => ({ year, minimumApprovalMilli: 60000, maxCouncilComponents: 2 })),
};
const session = {
  version: 1, policy: 'absolute', defaultDurationHours: 12, allowedDurationsHours: [8, 12],
  currentDurationHours: 12, configured: true,
  authenticatedAt: '2026-10-14T08:00:00Z', expiresAt: '2026-10-14T20:00:00Z',
};
let auxiliary: () => Promise<Response>;
let academic: () => Promise<Response>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
const scrolling = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const primary = () => within(screen.getByRole('navigation', { name: 'Navegação principal' }));
const yearControl = () => screen.getByRole('button', { name: /Ano letivo global/u });
const yearReads = () => fetcher.mock.calls.filter(([path]) => path === '/api/gradebook/operational-workspace');
async function readyYear() {
  await screen.findByRole('button', { name: /Ano letivo global/u });
  await waitFor(() => expect((yearControl() as HTMLButtonElement).disabled).toBe(false));
  return yearControl();
}
async function select2025(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await readyYear());
  await user.click(await screen.findByRole('option', { name: '2025' }));
  await waitFor(() => expect(yearControl().textContent).toContain('2025'));
}
beforeEach(() => {
  window.history.replaceState(null, '', '/#/configuracoes');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: false, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: () => true,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  auxiliary = async () => Response.json({}, { status: 503 });
  academic = async () => Response.json(catalogue);
  fetcher = vi.fn<typeof fetch>(async (path) => {
    if (path === '/api/me') return Response.json({ authenticated: true, capabilities: PLATFORM_CAPABILITIES });
    if (path === '/api/platform/bootstrap') return Response.json(snapshot());
    if (path === '/api/platform/snapshot-v2') return auxiliary();
    if (path === '/api/gradebook/operational-workspace') return academic();
    if (path === '/api/platform/settings/session') return Response.json(session);
    return Response.json({}, { status: 503 });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  if (scrolling) Object.defineProperty(Element.prototype, 'scrollIntoView', scrolling);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('selects a native year during Microsoft 503 and uses it in the actual Bank after navigation', async () => {
  render(<App />);
  const user = userEvent.setup();
  await select2025(user);
  expect(screen.getAllByText('Informações Microsoft temporariamente indisponíveis')).toHaveLength(2);
  expect(screen.queryByText('Nenhuma configuração cadastrada')).toBeNull();
  expect(screen.queryByText('Nenhuma migração registrada')).toBeNull();
  expect(screen.queryByText(/0 registro\(s\) encontrado/u)).toBeNull();
  expect(screen.getByText('Sessão atual: 12 horas')).toBeTruthy();
  await user.click(primary().getByRole('link', { name: 'Banco de notas' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([path, init]) =>
    path === '/api/gradebook/performance' && String(init?.body).includes('"year":2025'),
  )).toBe(true));
  await user.click(primary().getByRole('link', { name: 'Configurações' }));
  await readyYear();
  expect(yearControl().textContent).toContain('2025');
});

it('does not wait for Microsoft or remount the native selector when the external read completes', async () => {
  let resolve!: (response: Response) => void;
  const waiting = new Promise<Response>((done) => { resolve = done; });
  auxiliary = () => waiting;
  render(<App />);
  const user = userEvent.setup();
  await select2025(user);
  const control = yearControl();
  expect(screen.getAllByText('Consultando informações Microsoft…')).toHaveLength(2);
  expect(screen.queryByText('Nenhuma configuração cadastrada')).toBeNull();
  expect(screen.queryByText('Nenhuma migração registrada')).toBeNull();
  await act(async () => { resolve(Response.json(snapshot())); });
  await screen.findByText('Nenhuma configuração cadastrada');
  expect(screen.getByText('Nenhuma migração registrada')).toBeTruthy();
  expect(yearControl()).toBe(control);
  expect(yearControl().textContent).toContain('2025');
  expect(yearReads()).toHaveLength(1);
});

it.each<PlatformSourceSectionV2>(['lists', 'configurations', 'migrations', 'audit'])(
  'isolates an unavailable %s section without presenting unknown records as zero', async (section) => {
    auxiliary = async () => Response.json({ ...snapshot(), unavailableSections: [section] });
    render(<App />);
    await readyYear();
    await waitFor(() => expect(screen.queryAllByText('Consultando informações Microsoft…')).toHaveLength(0));
    expect(Boolean(screen.queryByText('Nenhuma configuração cadastrada'))).toBe(
      section !== 'lists' && section !== 'configurations',
    );
    expect(Boolean(screen.queryByText('Nenhuma migração registrada'))).toBe(
      section !== 'lists' && section !== 'migrations',
    );
    if (section === 'lists' || section === 'migrations')
      expect(screen.queryByText(/0 registro\(s\) encontrado/u)).toBeNull();
  },
);

it.each([401, 403])('still removes native controls after an authoritative administrative %i denial', async (status) => {
  let resolve!: (response: Response) => void;
  const waiting = new Promise<Response>((done) => { resolve = done; });
  auxiliary = () => waiting;
  render(<App />);
  await readyYear();
  await act(async () => { resolve(Response.json({}, { status })); });
  await screen.findByText(/Sua autorização precisa ser verificada novamente/u);
  expect(screen.queryByRole('button', { name: /Ano letivo global/u })).toBeNull();
});

it('does not invent a year catalogue when the academic endpoint is unavailable', async () => {
  academic = async () => Response.json({ contractVersion: 2, state: 'unavailable' }, { status: 503 });
  render(<App />);
  await screen.findByText('Não foi possível carregar os anos letivos disponíveis.');
  expect((yearControl() as HTMLButtonElement).disabled).toBe(true);
});

it('does not load the academic catalogue when opening a nonacademic area', async () => {
  window.history.replaceState(null, '', '/#/operacao');
  render(<App />);
  await screen.findByRole('navigation', { name: 'Navegação principal' });
  await screen.findByRole('navigation', { name: 'Seções de Saúde do Sistema' });
  expect(yearReads()).toHaveLength(0);
});

it('uses accessible route links, preserves the real workspace and respects keyboard draft blocking', async () => {
  window.history.replaceState(null, '', '/#/banco-de-notas?area=performance');
  render(<App />);
  const navigation = within(await screen.findByRole('navigation', { name: 'Seções de Banco de notas' }));
  const performance = navigation.getByRole('link', { name: 'Desempenho' });
  const bulletins = navigation.getByRole('link', { name: 'Boletins' });
  expect(performance.getAttribute('aria-current')).toBe('page');
  expect(navigation.queryByRole('tab')).toBeNull();
  for (const link of navigation.getAllByRole('link')) expect(link.hasAttribute('aria-controls')).toBe(false);
  await waitFor(() => expect(document.querySelector('.gradebook-workspace')).not.toBeNull());
  const workspace = document.querySelector('.gradebook-workspace');
  const user = userEvent.setup();
  performance.focus();
  await user.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(bulletins);
  expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
  const block = (event: Event) => event.preventDefault();
  window.addEventListener('ecossistema-before-navigation', block);
  try {
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
    expect(performance.getAttribute('aria-current')).toBe('page');
  } finally {
    window.removeEventListener('ecossistema-before-navigation', block);
  }
  await user.keyboard('{Enter}');
  await waitFor(() => expect(bulletins.getAttribute('aria-current')).toBe('page'));
  await waitFor(() => expect(document.querySelector<HTMLElement>('#gradebook-panel-bulletins')?.hidden).toBe(false));
  expect(document.querySelector('.gradebook-workspace')).toBe(workspace);
  expect(performance.hasAttribute('aria-current')).toBe(false);
});
