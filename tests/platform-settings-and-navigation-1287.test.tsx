// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const snapshot = () => buildPlatformSnapshot({
  lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [],
  correlationId: 'synthetic',
}, PLATFORM_CAPABILITIES);
const years = {
  contractVersion: 2, state: 'ready', operation: 'bootstrap',
  years: [2026, 2025].map((year) => ({ year, minimumApprovalMilli: 60000, maxCouncilComponents: 2 })),
};
const session = {
  version: 1, policy: 'absolute', defaultDurationHours: 8, allowedDurationsHours: [4, 8, 12],
  currentDurationHours: 8, configured: true, authenticatedAt: '2026-10-14T00:00:00Z', expiresAt: '2026-10-14T08:00:00Z',
};
const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  window.history.replaceState(null, '', '/#/configuracoes');
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function network(auxiliary: () => Promise<Response>) {
  const fetcher = vi.fn<typeof fetch>(async (path, init) => {
    if (path === '/api/me') return Response.json({ authenticated: true, capabilities: PLATFORM_CAPABILITIES });
    if (path === '/api/platform/bootstrap') return Response.json(snapshot());
    if (path === '/api/platform/snapshot-v2') return auxiliary();
    if (path === '/api/platform/settings/session') return Response.json(session);
    if (path === '/api/gradebook/operational-workspace') return Response.json(years);
    if (path === '/api/gradebook/performance') return Response.json({ transportVersion: 2, state: 'unavailable' }, { status: 503 });
    if (path === '/api/platform/live') return Response.json({ state: 'unavailable' }, { status: 503 });
    throw new Error(`Unexpected synthetic request: ${String(path)} ${String(init?.method ?? 'GET')}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const bootstrapCalls = (fetcher: ReturnType<typeof network>) => fetcher.mock.calls.filter(([path]) => path === '/api/gradebook/operational-workspace').length;
function settingsCard() {
  const heading = screen.getByRole('heading', { name: 'Ano letivo' });
  return heading.closest('[data-slot="card"]') ?? heading.closest('.card') ?? document.body;
}

it('keeps native settings mounted during a Microsoft failure and carries the selected year to the real Banco', async () => {
  const fetcher = network(async () => Response.json({}, { status: 503 }));
  render(<App />);
  await screen.findByRole('heading', { name: 'Ano letivo' });
  await screen.findByRole('button', { name: 'Ano letivo global' });
  const trigger = within(settingsCard()).getByRole('button', { name: 'Ano letivo global' });
  await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false));
  const user = userEvent.setup();
  await user.click(trigger);
  await user.click(await screen.findByRole('option', { name: '2025' }));
  expect(trigger.textContent).toContain('2025');
  const main = screen.getByRole('navigation', { name: 'Navegação principal' });
  await user.click(within(main).getByRole('link', { name: 'Banco de notas', exact: true }));
  await waitFor(() => expect(fetcher.mock.calls.some(([path, init]) => path === '/api/gradebook/performance' && String(init?.body).includes('"year":2025'))).toBe(true));
  expect(bootstrapCalls(fetcher)).toBe(2);
  await user.click(within(main).getByRole('link', { name: 'Configurações', exact: true }));
  const second = await screen.findByRole('button', { name: 'Ano letivo global' });
  await waitFor(() => expect(second.textContent).toContain('2025'));
  expect(bootstrapCalls(fetcher)).toBe(3);
  expect(screen.queryByText('Nenhuma configuração cadastrada')).toBeNull();
  expect(screen.queryByText('Nenhuma migração registrada')).toBeNull();
  expect(screen.queryByText('0 registro(s) encontrado(s).')).toBeNull();
});

it('keeps the selector usable while Microsoft is pending and does not remount it when Microsoft recovers', async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  network(() => pending);
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'Ano letivo global' });
  await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false));
  expect(screen.getAllByText('Consultando informações Microsoft…')).toHaveLength(2);
  await act(async () => { release(Response.json(snapshot())); });
  await screen.findByText('Nenhuma configuração cadastrada');
  expect(screen.getByRole('button', { name: 'Ano letivo global' })).toBe(trigger);
});

it.each([
  ['configurations', 'Nenhuma migração registrada', 'Nenhuma configuração cadastrada'],
  ['migrations', 'Nenhuma configuração cadastrada', 'Nenhuma migração registrada'],
])('isolates an unavailable %s card from the other Microsoft card and the year selector', async (section, present, absent) => {
  network(async () => Response.json({ ...snapshot(), unavailableSections: [section], retryAfterSeconds: 90 }));
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'Ano letivo global' });
  await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false));
  expect(await screen.findByText(present)).toBeTruthy();
  expect(screen.queryByText(absent)).toBeNull();
  expect(screen.getAllByText('Informações Microsoft temporariamente indisponíveis')).toHaveLength(1);
});

it('does not turn an unavailable list catalogue into empty external records', async () => {
  network(async () => Response.json({ ...snapshot(), unavailableSections: ['lists'], retryAfterSeconds: 90 }));
  render(<App />);
  await screen.findByRole('button', { name: 'Ano letivo global' });
  expect(await screen.findAllByText('Informações Microsoft temporariamente indisponíveis')).toHaveLength(2);
  expect(screen.queryByText('Nenhuma configuração cadastrada')).toBeNull();
  expect(screen.queryByText('Nenhuma migração registrada')).toBeNull();
  expect(screen.queryByText('0 registro(s) encontrado(s).')).toBeNull();
});

it.each([401, 403])('preserves the authoritative authorization boundary (%i)', async (status) => {
  network(async () => Response.json({}, { status }));
  render(<App />);
  expect(await screen.findByText(/Sua autorização precisa ser verificada novamente/u)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Ano letivo global' })).toBeNull();
});

it('does not bootstrap an academic catalogue merely to open a nonacademic area', async () => {
  window.history.replaceState(null, '', '/#/operacao');
  const fetcher = network(async () => Response.json({}, { status: 503 }));
  render(<App />);
  await screen.findByRole('heading', { name: 'Saúde do Sistema', exact: true });
  expect(bootstrapCalls(fetcher)).toBe(0);
});

it('uses semantic section links with current-route state and no dangling tab controls', async () => {
  window.history.replaceState(null, '', '/#/banco-de-notas?area=performance');
  network(async () => Response.json(snapshot()));
  render(<App />);
  const nav = await screen.findByRole('navigation', { name: 'Seções de Banco de notas' });
  const links = within(nav).getAllByRole('link');
  expect(links).toHaveLength(4);
  expect(within(nav).getByRole('link', { name: 'Desempenho' }).getAttribute('aria-current')).toBe('page');
  expect(nav.querySelector('[role="tab"],[role="tablist"],[aria-controls]')).toBeNull();
  // The shell arrives before the real, lazy-loaded workspace. Wait for that workspace,
  // not only for its navigation, so a cold import cannot race this integration assertion.
  const workspace = await screen.findByRole('region', { name: 'Banco de notas' });
  const user = userEvent.setup();
  const configuration = within(nav).getByRole('link', { name: 'Configurações' });
  await user.click(configuration);
  await waitFor(() => {
    expect(window.location.hash).toBe('#/banco-de-notas?area=settings');
    expect(configuration.getAttribute('aria-current')).toBe('page');
  });
  expect(screen.getByRole('region', { name: 'Banco de notas' })).toBe(workspace);
});

it('supports focus-only arrow keys and guarded native Enter activation', async () => {
  window.history.replaceState(null, '', '/#/banco-de-notas?area=performance');
  network(async () => Response.json(snapshot()));
  render(<App />);
  const nav = await screen.findByRole('navigation', { name: 'Seções de Banco de notas' });
  const first = within(nav).getByRole('link', { name: 'Desempenho' });
  const last = within(nav).getByRole('link', { name: 'Configurações' });
  const user = userEvent.setup();
  first.focus();
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(last);
  expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
  const block = (event: Event) => event.preventDefault();
  window.addEventListener('ecossistema-before-navigation', block);
  try {
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
    expect(first.getAttribute('aria-current')).toBe('page');
  } finally {
    window.removeEventListener('ecossistema-before-navigation', block);
  }
  await user.keyboard('{Home}{ArrowRight}');
  expect(document.activeElement).toBe(within(nav).getByRole('link', { name: 'Boletins' }));
  await user.keyboard('{End}{Enter}');
  await waitFor(() => {
    expect(window.location.hash).toBe('#/banco-de-notas?area=settings');
    expect(last.getAttribute('aria-current')).toBe('page');
  });
});
