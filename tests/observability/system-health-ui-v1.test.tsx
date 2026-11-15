// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildPlatformSnapshot, EXPECTED_PLATFORM_LISTS } from '../../server/platform/snapshot';
import { PLATFORM_CAPABILITIES } from '../../shared/platform-contract';
import type { SystemHealthSnapshotV1 } from '../../shared/system-health-v1';
import { SystemHealthPageV1 } from '../../src/platform/system-health-page-v1';

const now = Date.parse('2026-09-21T18:00:00.000Z');
const at = new Date(now).toISOString();
const sample = (): SystemHealthSnapshotV1 => ({
  schemaVersion: 1, generatedAt: at, portalReadState: 'ok',
  publicEntry: { outcome: 'ok', status: 200, durationMs: 30, observedAt: at },
  portal: {
    schemaVersion: 1, observedAt: at, servingEnabled: true, credentialsConfigured: true,
    database: 'ok', readDurationMs: 20,
    maintenance: {
      status: 'normal', liveOutboxAvailable: true, expiredIp: 0, expiredAudit: 0,
      backlog: false, exhausted: false, publicationDue: 0, oldestPublicationDueMs: 0,
      liveBacklog: false, livePending: 0, liveRetrying: 0, oldestLiveDueMs: 0,
      waitingConnections: 0, oldestWaitingQueryMs: 0,
    },
  },
});
const platform = () => buildPlatformSnapshot({ lists: [], moduleItems: [], correlationId: 'synthetic-health-ui' }, PLATFORM_CAPABILITIES);
const identity = (key = 'synthetic-health-admin') => ({
  authenticated: true, identityKey: key, capabilities: ['platform.health.read', 'platform.settings.read'],
});
let readIdentity: ReturnType<typeof vi.fn<typeof fetch>>;
let readHealth: ReturnType<typeof vi.fn<typeof fetch>>;
const flush = () => act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const metric = (title: string) => {
  const card = screen.getByText(title, { selector: '[data-slot="card-description"]' }).closest('[data-slot="card"]');
  if (!(card instanceof HTMLElement)) throw new Error(`Missing metric: ${title}`);
  return within(card);
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  readIdentity = vi.fn<typeof fetch>(async () => Response.json(identity()));
  readHealth = vi.fn<typeof fetch>(async () => Response.json(sample()));
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((path, init) => {
    if (path === '/api/me') return readIdentity(path, init);
    if (path === '/api/platform/system-health') return readHealth(path, init);
    throw new Error('Unexpected synthetic request');
  }));
});
afterEach(async () => { cleanup(); await flush(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps absent data unknown while the first read is pending', async () => {
  readHealth.mockImplementation(() => new Promise<Response>(() => undefined));
  const view = render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('heading', { name: 'Não há confirmação suficiente' })).toBeTruthy();
  expect(screen.getByText('Nenhuma coleta disponível.')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(metric('Entrada pública').getByText('Sem confirmação')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Verificando…' }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  expect(readHealth.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});

it.each(['platform.health.read', 'platform.settings.read'])('does not read monitoring without %s', async (capability) => {
  readIdentity.mockResolvedValue(Response.json({ ...identity(), capabilities: identity().capabilities.filter((item) => item !== capability) }));
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('status').textContent).toBe('Acesso ao monitoramento não autorizado.');
  expect(readHealth).not.toHaveBeenCalled();
});

it('keeps a successful public sample visible when the private source is unavailable', async () => {
  readHealth.mockResolvedValue(Response.json({ ...sample(), portalReadState: 'unavailable', portal: null }));
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('heading', { name: 'Não há confirmação suficiente' })).toBeTruthy();
  expect(metric('Entrada pública').getByText('Respondeu')).toBeTruthy();
  expect(metric('Leitura técnica do banco').getAllByText('Sem dados')).toHaveLength(2);
  expect(metric('Publicações aguardando').getByText('—')).toBeTruthy();
});

it('distinguishes a missing live structure from a healthy zero and caps counts', async () => {
  const data = sample();
  data.portal!.maintenance!.liveOutboxAvailable = false;
  data.portal!.maintenance!.publicationDue = 1001;
  readHealth.mockResolvedValue(Response.json(data));
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(metric('Avisos de atualização').getByText('Sem dados')).toBeTruthy();
  expect(metric('Avisos de atualização').getByText('—')).toBeTruthy();
  expect(metric('Publicações aguardando').getByText('1.000+')).toBeTruthy();
  expect(screen.getByRole('rowheader', { name: /Publicações prontas para processamento/u })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Não há confirmação suficiente' })).toBeTruthy();
});

it.each(['envelope', 'private source', 'public source', 'future envelope'])('does not show normal metrics for an expired or incoherent %s', async (field) => {
  const data = sample();
  const stale = new Date(now - 120_001).toISOString();
  if (field === 'envelope') data.generatedAt = stale;
  if (field === 'private source') data.portal!.observedAt = stale;
  if (field === 'public source') data.publicEntry.observedAt = stale;
  if (field === 'future envelope') data.generatedAt = new Date(now + 60_000).toISOString();
  readHealth.mockResolvedValue(Response.json(data));
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('heading', { name: 'Não há confirmação suficiente' })).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(metric('Leitura técnica do banco').queryByText('20 ms')).toBeNull();
});

it('expires a previously normal sample without treating a repeated response as a new collection', async () => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('heading', { name: 'Verificações básicas normais' })).toBeTruthy();
  await advance(135_000);
  expect(readHealth).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('heading', { name: 'Não há confirmação suficiente' })).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(screen.getByText('Última coleta: 21/09/2026, 15:00:00 (Bahia)')).toBeTruthy();
});

it('retains the collection time after a transient failure without confirming normality', async () => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  readHealth.mockRejectedValueOnce(new Error('synthetic-provider-failure'));
  await advance(5_000); fireEvent.click(screen.getByRole('button', { name: 'Atualizar' })); await flush();
  expect(screen.getByRole('alert').textContent).toContain('Não foi possível atualizar.');
  expect(screen.getByText('Última coleta: 21/09/2026, 15:00:00 (Bahia)')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(screen.queryByText('synthetic-provider-failure')).toBeNull();
});

it('refreshes once after the manual cooldown and prevents concurrent reads', async () => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  expect(screen.getByRole('heading', { name: 'Verificações básicas normais' })).toBeTruthy();
  let finish!: (response: Response) => void;
  readHealth.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  await advance(4_999); expect(readHealth).toHaveBeenCalledTimes(1);
  await advance(1); expect(readHealth).toHaveBeenCalledTimes(2);
  const button = screen.getByRole('button', { name: 'Verificando…' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button); expect(readHealth).toHaveBeenCalledTimes(2);
  await act(async () => finish(Response.json(sample()))); await flush();
  expect(screen.getByRole('button', { name: 'Atualizar' })).toBeTruthy();
});

it('confirms a fresh manual response immediately between clock ticks', async () => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  await advance(10_000);
  const latest = sample();
  latest.generatedAt = latest.portal!.observedAt = latest.publicEntry.observedAt = new Date(Date.now()).toISOString();
  readHealth.mockResolvedValueOnce(Response.json(latest));
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' })); await flush();
  expect(screen.getByText('Última coleta: 21/09/2026, 15:00:10 (Bahia)')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Verificações básicas normais' })).toBeTruthy();
  expect(metric('Leitura técnica do banco').getByText('20 ms')).toBeTruthy();
  expect(readHealth).toHaveBeenCalledTimes(2);
});

it.each([401, 403])('clears the sample and stops refresh after monitoring returns %i', async (status) => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  readHealth.mockResolvedValue(new Response(null, { status }));
  await advance(5_000); fireEvent.click(screen.getByRole('button', { name: 'Atualizar' })); await flush();
  expect(screen.getByRole('alert').textContent).toContain('Acesso ao monitoramento não autorizado.');
  expect(screen.getByText('Nenhuma coleta disponível.')).toBeTruthy();
  expect(screen.queryByText('Normal')).toBeNull();
  expect((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled).toBe(true);
  await advance(300_000); expect(readHealth).toHaveBeenCalledTimes(2);
  expect(readIdentity).toHaveBeenCalledTimes(2);
});

it('discards the previous identity sample and rejects its late response', async () => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  await advance(5_000);
  let finishOld!: (response: Response) => void;
  readHealth.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' })); await flush();
  await advance(5_000);
  readIdentity.mockResolvedValueOnce(Response.json(identity('synthetic-other-admin')));
  readHealth.mockImplementationOnce(() => new Promise<Response>(() => undefined));
  await act(async () => window.dispatchEvent(new Event('focus'))); await flush();
  expect(readHealth.mock.calls[1]![1]?.signal?.aborted).toBe(true);
  expect(screen.getByText('Nenhuma coleta disponível.')).toBeTruthy();
  await act(async () => finishOld(Response.json(sample()))); await flush();
  expect(screen.queryByText('Normal')).toBeNull();
  expect(screen.getByText('Nenhuma coleta disponível.')).toBeTruthy();
  expect(readHealth).toHaveBeenCalledTimes(3);
});

it.each(['hidden', 'offline'])('pauses reads while %s and resumes once when available', async (condition) => {
  render(<SystemHealthPageV1 snapshot={platform()} />); await flush();
  if (condition === 'hidden') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  else Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await act(async () => condition === 'hidden' ? document.dispatchEvent(new Event('visibilitychange')) : window.dispatchEvent(new Event('offline')));
  expect(screen.getByRole('status').textContent).toBe('Atualização pausada.');
  expect(screen.queryByText('Normal')).toBeNull();
  expect((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled).toBe(true);
  await advance(180_000); expect(readHealth).toHaveBeenCalledTimes(1);
  const latest = sample(); latest.generatedAt = latest.portal!.observedAt = latest.publicEntry.observedAt = new Date(Date.now()).toISOString();
  readHealth.mockResolvedValueOnce(Response.json(latest));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); await flush();
  expect(readHealth).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Atualização pausada.')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Verificações básicas normais' })).toBeTruthy();
});

it('renders independent monitoring while the administrative evidence is unavailable', async () => {
  render(<SystemHealthPageV1 snapshot={{ ...platform(), operational: null, unavailableSections: ['lists', 'modules'] }} />); await flush();
  expect(screen.getByRole('heading', { name: 'Verificações básicas normais' })).toBeTruthy();
  const details = screen.getByText('Evidências do Centro ADM').closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  expect(screen.getByText('Evidências administrativas indisponíveis. O monitoramento do Portal usa uma consulta independente.')).toBeTruthy();
  expect(readHealth).toHaveBeenCalledTimes(1);
});

it('expands real administrative evidence with accessible signals and registered systems', async () => {
  const complete = buildPlatformSnapshot({
    lists: EXPECTED_PLATFORM_LISTS.map((displayName, index) => ({ id: `synthetic-list-${index}`, displayName })),
    moduleItems: [{ id: 'synthetic-health-module', fields: {
      Chave: 'plataforma-base', Nome: 'SYNTHETIC HEALTH MODULE', RotaBase: '/', Versao: '1.0.0',
      Status: 'instalado', Ordem: 0, HealthEndpoint: '/api/health', AtualizadoEmUTC: at,
    } }],
    correlationId: 'synthetic-complete-evidence', generatedAt: at,
  }, PLATFORM_CAPABILITIES);
  expect(complete.registeredModules).toHaveLength(1);
  render(<SystemHealthPageV1 snapshot={complete} />); await flush();
  const details = screen.getByText('Evidências do Centro ADM').closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await act(async () => {
    await import('../../src/platform/operations-page');
  });
  await flush();
  const evidence = within(details);
  expect(evidence.getByRole('heading', { name: 'Operação' })).toBeTruthy();
  const signals = within(evidence.getByRole('grid', { name: 'Sinais operacionais observados' }));
  expect.soft(signals.queryAllByRole('rowheader')).toHaveLength(2);
  expect.soft(signals.queryByRole('rowheader', { name: 'Estrutura da plataforma' })).toBeTruthy();
  const systems = within(evidence.getByRole('grid', { name: 'Cobertura operacional dos sistemas registrados' }));
  expect.soft(systems.queryByRole('rowheader', { name: 'SYNTHETIC HEALTH MODULE' })).toBeTruthy();
  expect(systems.getByText('Configurado')).toBeTruthy();
  expect(readHealth).toHaveBeenCalledTimes(1);
});
