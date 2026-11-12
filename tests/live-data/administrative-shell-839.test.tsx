// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
import { App, ADMIN_AUTOMATIC_READS_V1 } from '../../src/App';
import { PLATFORM_CAPABILITIES } from '../../shared/platform-contract';
import { buildPlatformSnapshot } from '../../server/platform/snapshot';
import { notifyLiveChangeV1 } from '../../src/shared/live-data/live-refresh-v1';

const { reads } = vi.hoisted(() => ({ reads: vi.fn(async () => true) }));
vi.mock('../../src/platform/pages', async () => {
  const React = await import('react');
  const { useLiveRefreshV1 } = await import('../../src/shared/live-data/use-live-refresh-v1');
  const { useDraftNavigationGuardV1 } = await import('../../src/shared/forms/draft-navigation-v1');
  return {
    LoadingWorkspace: () => <p>Carregando área sintética</p>,
    PageContent: function Workspace({ route }: { route: string }) {
      const [value, setValue] = React.useState('');
      useDraftNavigationGuardV1(value !== '');
      useLiveRefreshV1(reads, { domains: ['gradebook'], canRefresh: () => value === '' });
      return <input aria-label={`workspace-${route}`} value={value} onChange={(event) => setValue(event.target.value)} />;
    },
  };
});
class Socket extends EventTarget {
  static instances: Socket[] = [];
  closed = false;
  constructor(readonly url: string | URL) { super(); Socket.instances.push(this); }
  send() {}
  close() { this.closed = true; }
}
const snapshot = () => buildPlatformSnapshot({ lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [], correlationId: 'synthetic' }, PLATFORM_CAPABILITIES);
let key: string;
let status: number;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const flush = () => act(async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const windowReturns = () => act(async () => { window.dispatchEvent(new Event('focus')); });
beforeEach(() => {
  vi.useFakeTimers(); mockSecureJitterV1(0);
  reads.mockClear(); Socket.instances = []; key = 'synthetic-a'; status = 200;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  window.history.replaceState(null, '', '/#/banco-de-notas');
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  fetcher = vi.fn<typeof fetch>(async (path) => {
    if (path === '/api/me') return status === 200
      ? Response.json({ authenticated: true, identityKey: key, expiresAt, capabilities: PLATFORM_CAPABILITIES })
      : new Response(null, { status });
    if (path === '/api/platform/bootstrap' || path === '/api/platform/snapshot-v2') return Response.json(snapshot());
    if (path === '/api/gradebook/view-preferences') return Response.json({ contractVersion: 1, state: 'ready', views: {} });
    throw new Error('Unexpected synthetic request');
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { cleanup(); await flush(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('the real App opens no live channel and reads again only when the window returns, keeping a draft', async () => {
  expect(ADMIN_AUTOMATIC_READS_V1).toBe(false);
  render(<App />); await flush();
  const input = screen.getByLabelText('workspace-banco-de-notas') as HTMLInputElement;
  expect(Socket.instances).toHaveLength(0);
  // No clock and no change notice reads by itself, not even after five quiet minutes.
  await act(async () => notifyLiveChangeV1('gradebook', { broadcast: false }));
  await advance(5 * 60_000);
  expect(reads).not.toHaveBeenCalled();
  await windowReturns(); await advance(250);
  expect(reads).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: 'rascunho local' } });
  await advance(10_000);
  await windowReturns(); await advance(2_000);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('workspace-banco-de-notas')).toBe(input);
  expect(input.value).toBe('rascunho local');
  expect(screen.queryByText(/Há atualizações a conferir/)).toBeNull();
  expect(Socket.instances).toHaveLength(0);
  // Only reads: the side column's health dot and Conciliação badge are queried by POST; the
  // person's last area is kept by PUT on their own saved views, never on school data.
  const sideReads = ['/api/platform/system-health', '/api/student-reconciliation/v1', '/api/gradebook/view-preferences'];
  expect(fetcher.mock.calls.every(([path, init]) =>
    !init?.method || init.method === 'GET' || sideReads.includes(String(path)))).toBe(true);
});
it.each([401, 403])('confirmed identity denial %i on the window return removes the workspace', async (code) => {
  render(<App />); await flush();
  expect(screen.getByLabelText('workspace-banco-de-notas')).toBeTruthy();
  status = code;
  await advance(10_000);
  await windowReturns(); await flush();
  expect(screen.queryByLabelText('workspace-banco-de-notas')).toBeNull();
  expect(Socket.instances).toHaveLength(0);
});
it('a transient identity error retains the same draft; an actual identity change resets it', async () => {
  render(<App />); await flush();
  const input = screen.getByLabelText('workspace-banco-de-notas') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'edição não salva' } });
  status = 503;
  await advance(10_000);
  await windowReturns(); await flush();
  expect(screen.getByLabelText('workspace-banco-de-notas')).toBe(input);
  expect(input.value).toBe('edição não salva');
  status = 200; key = 'synthetic-b';
  await advance(10_000);
  await windowReturns(); await flush();
  const next = screen.getByLabelText('workspace-banco-de-notas') as HTMLInputElement;
  expect(next).not.toBe(input); expect(next.value).toBe('');
  expect(Socket.instances).toHaveLength(0);
});
