import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ready = (views: Record<string, unknown>) =>
  Response.json({ contractVersion: 1, state: 'ready', views });

async function load() {
  vi.resetModules();
  return import('../../src/shared/ui/session-view-v1');
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('account views v1', () => {
  it('fills the tab with the account views and returns to the last area', async () => {
    const fetchMock = vi.fn(async () => ready({
      'gradebook-performance-view': { perspective: 'notes', year: 2026 },
      'platform-address': '#/banco-de-notas?area=performance',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const views = await load();
    await views.startAccountViewsV1('owner-a', true);
    expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
    expect(views.readSessionRecordV1('gradebook-performance-view')).toEqual({ perspective: 'notes', year: 2026 });
  });

  it('keeps an address that was opened on purpose and choices already made in this tab', async () => {
    window.history.replaceState(null, '', '/#/importacao');
    window.sessionStorage.setItem('ecossistema-view-owner-v1', 'owner-a');
    window.sessionStorage.setItem('ecossistema-view-v1:gradebook-council-view', JSON.stringify({ classId: 7 }));
    vi.stubGlobal('fetch', vi.fn(async () => ready({
      'gradebook-council-view': { classId: 3 },
      'platform-address': '#/banco-de-notas?area=council',
    })));
    const views = await load();
    await views.startAccountViewsV1('owner-a', false);
    expect(window.location.hash).toBe('#/importacao');
    expect(views.readSessionRecordV1('gradebook-council-view')).toEqual({ classId: 7 });
  });

  it('forgets the previous person when the tab changes hands', async () => {
    window.sessionStorage.setItem('ecossistema-view-owner-v1', 'owner-a');
    window.sessionStorage.setItem('ecossistema-view-v1:gradebook-council-view', JSON.stringify({ classId: 7 }));
    vi.stubGlobal('fetch', vi.fn(async () => ready({})));
    const views = await load();
    await views.startAccountViewsV1('owner-b', true);
    expect(views.readSessionRecordV1('gradebook-council-view')).toBeNull();
  });

  it('opens on the defaults when the account views cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ contractVersion: 1, state: 'unavailable' }, { status: 503 })));
    const views = await load();
    await views.startAccountViewsV1('owner-a', true);
    expect(window.location.hash).toBe('');
  });

  it('sends the latest choices to the account in one request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ready({}));
    vi.stubGlobal('fetch', fetchMock);
    const views = await load();
    await views.startAccountViewsV1('owner-a', false);
    vi.useFakeTimers();
    views.writeSessionViewV1('gradebook-performance-view', { perspective: 'overview' });
    views.writeSessionViewV1('gradebook-performance-view', { perspective: 'notes' });
    views.rememberAddressV1('#/banco-de-notas?area=performance');
    views.rememberAddressV1('#/<script>');
    await vi.advanceTimersByTimeAsync(1000);
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]?.[1]?.body))).toEqual({
      views: {
        'gradebook-performance-view': { perspective: 'notes' },
        'platform-address': '#/banco-de-notas?area=performance',
      },
    });
  });
});
