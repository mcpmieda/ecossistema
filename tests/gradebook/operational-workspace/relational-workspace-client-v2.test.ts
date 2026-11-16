// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOperationalWorkspaceV2 } from '../../../src/features/gradebook/operational-workspace/operational-workspace-client-v2';
import {
  useGradebookYear,
  type GradebookYearContextValue,
} from '../../../src/platform/gradebook-year-context';
import { GradebookYearProvider } from '../../../src/platform/gradebook-year-provider';
import type {
  OperationalWorkspaceRequestV2,
  WorkspaceLinkV2,
} from '../../../shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2';

// This suite uses createElement, not JSX; .test.ts is the existing runner's discovery pattern.
const year = { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 };
const bootstrap = () => ({
  contractVersion: 2,
  state: 'ready',
  operation: 'bootstrap',
  years: [year, { year: 2025, minimumApprovalMilli: 60000, maxCouncilComponents: 2 }],
});
const entity: WorkspaceLinkV2 = { kind: 'student', id: 1, label: 'ALUNO SINTETICO' };
const search = (label = 'ALUNO SINTETICO', nextOffset: number | null = null) => ({
  contractVersion: 2,
  state: 'ready',
  operation: 'search',
  context: year,
  items: [{ entity: { ...entity, label }, description: 'A1 · Nº 1' }],
  nextOffset,
});
const detail = {
  contractVersion: 2,
  state: 'ready',
  operation: 'center',
  context: year,
  center: { entity, classInfo: null, bindings: [], offers: [], nextOffset: null },
};
const searchRequest: Extract<OperationalWorkspaceRequestV2, { operation: 'search' }> = {
  contractVersion: 2,
  operation: 'search',
  year: 2026,
  kind: 'student',
  query: '',
  offset: 0,
  limit: 100,
};
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let root: Root | null = null;
let host: HTMLDivElement;
let current: GradebookYearContextValue;
function Harness() {
  current = useGradebookYear()!;
  return createElement(
    'output',
    null,
    JSON.stringify({ year: current.year, years: current.years, failure: current.failure }),
  );
}
function reply(value: unknown, status = 200) {
  return Response.json(value, { status });
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no layout/media engine. These adapters do not claim visual validation.
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  fetchMock.mockResolvedValueOnce(reply(bootstrap()));
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(GradebookYearProvider, null, createElement(Harness)));
  });
}

describe('V2 transport rejects invalid, stale-context and false-success responses', () => {
  it('posts the explicit selected year with same-origin credentials, no-store and cancellation', async () => {
    fetchMock.mockResolvedValueOnce(reply(search()));
    const controller = new AbortController();
    expect(await requestOperationalWorkspaceV2(searchRequest, controller.signal)).toMatchObject({
      state: 'ready',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/gradebook/operational-workspace',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(searchRequest),
      }),
    );
  });
  it.each([401, 403])('handles opaque authentication responses with status %i', async (status) => {
    fetchMock.mockResolvedValueOnce(reply({ contractVersion: 1, state: 'not-authorized' }, status));
    expect(await requestOperationalWorkspaceV2(searchRequest)).toEqual({
      contractVersion: 2,
      state: 'not-authorized',
    });
  });
  it.each([
    { ...search(), context: { ...year, year: 2025 } },
    { ...search(), contractVersion: 1 },
    { ...search(), nextOffset: 1 },
    { ...search(), items: [{ entity: { ...entity, id: 'student:1' }, description: null }] },
    { ...search(), operation: 'context' },
  ])('rejects invalid or mismatched payloads', async (value) => {
    fetchMock.mockResolvedValueOnce(reply(value));
    expect(await requestOperationalWorkspaceV2(searchRequest)).toEqual({
      contractVersion: 2,
      state: 'unavailable',
    });
  });
  it('keeps center reads compatible without the retired UI', async () => {
    fetchMock.mockResolvedValueOnce(reply(detail));
    expect(
      await requestOperationalWorkspaceV2({
        contractVersion: 2,
        operation: 'center',
        year: 2026,
        kind: 'student',
        id: 1,
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({ state: 'ready', operation: 'center', center: { entity } });
  });
  it('keeps class catalog search available for the student administration panel', async () => {
    const classEntity = { kind: 'class-group', id: 10, label: 'TURMA SINTETICA' };
    fetchMock.mockResolvedValueOnce(
      reply({ ...search(), items: [{ entity: classEntity, description: null }] }),
    );
    expect(
      await requestOperationalWorkspaceV2({ ...searchRequest, kind: 'class-group' }),
    ).toMatchObject({ state: 'ready', operation: 'search', items: [{ entity: classEntity }] });
  });
  it('rejects a failing HTTP status even when the response claims success', async () => {
    fetchMock.mockResolvedValueOnce(reply(search(), 500));
    expect(await requestOperationalWorkspaceV2(searchRequest)).toEqual({
      contractVersion: 2,
      state: 'unavailable',
    });
  });
  it('accepts another materialized year and rejects malformed inputs before any invalid network operation', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...search(), context: { ...year, year: 2025 } }));
    expect(await requestOperationalWorkspaceV2({ ...searchRequest, year: 2025 })).toMatchObject({
      state: 'ready',
      context: { year: 2025 },
    });
    expect(await requestOperationalWorkspaceV2({ ...searchRequest, limit: 201 })).toEqual({
      contractVersion: 2,
      state: 'invalid-request',
    });
    expect(await requestOperationalWorkspaceV2({ ...searchRequest, year: 1999 })).toEqual({
      contractVersion: 2,
      state: 'invalid-request',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('global academic year lifecycle through the retained V2 bootstrap', () => {
  it('loads the newest materialized year using only the global catalogue request', async () => {
    await mount();
    expect(current.year).toBe(2026);
    expect(current.years.map((item) => item.year)).toEqual([2026, 2025]);
    expect(current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      contractVersion: 2,
      operation: 'bootstrap',
    });
  });
  it('changes only to a materialized year and invalidates academic consumers once', async () => {
    await mount();
    const epoch = current.epoch;
    await act(async () => {
      current.selectYear(2024);
    });
    expect(current.year).toBe(2026);
    expect(current.epoch).toBe(epoch);
    await act(async () => {
      current.selectYear(2025);
    });
    expect(current.year).toBe(2025);
    expect(current.epoch).toBe(epoch + 1);
    await act(async () => {
      current.selectYear(2025);
    });
    expect(current.epoch).toBe(epoch + 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('ignores an older catalogue response after a newer refresh selects a materialized year', async () => {
    await mount();
    const old = deferred();
    fetchMock.mockReturnValueOnce(old.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.refreshYears();
    });
    fetchMock.mockResolvedValueOnce(reply(bootstrap()));
    await act(async () => {
      await current.refreshYears(2025);
    });
    await act(async () => {
      old.resolve(reply({ ...bootstrap(), years: [year] }));
      await pending;
    });
    expect(current.year).toBe(2025);
    expect(current.years.map((item) => item.year)).toEqual([2026, 2025]);
    expect(current.failure).toBeNull();
  });
  it.each([401, 403])(
    'clears the global catalogue and selected year after lost authorization (%i)',
    async (status) => {
      await mount();
      fetchMock.mockResolvedValueOnce(reply({ state: 'not-authorized' }, status));
      await act(async () => {
        await current.refreshYears();
      });
      expect(current.year).toBeNull();
      expect(current.years).toEqual([]);
      expect(current.loading).toBe(false);
      expect(current.failure).toContain('não possui autorização');
    },
  );
  it('retains a retryable failure on network errors and recovers the selected year', async () => {
    await mount();
    await act(async () => {
      current.selectYear(2025);
    });
    fetchMock.mockRejectedValueOnce(new Error('synthetic-network-error'));
    await act(async () => {
      await current.refreshYears();
    });
    expect(current.year).toBe(2025);
    expect(current.failure).toContain('Não foi possível carregar');
    expect(current.loading).toBe(false);
    fetchMock.mockResolvedValueOnce(reply(bootstrap()));
    await act(async () => {
      await current.refreshYears();
    });
    expect(current.year).toBe(2025);
    expect(current.failure).toBeNull();
  });
});
