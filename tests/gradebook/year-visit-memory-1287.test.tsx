// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GradebookYearProvider } from '../../src/platform/gradebook-year-provider';
import { useGradebookYear, type GradebookYearContextValue } from '../../src/platform/gradebook-year-context';

const year = (value: number) => ({ year: value, minimumApprovalMilli: 60000, maxCouncilComponents: 2 });
const catalogue = (values = [2026, 2025]) => ({
  contractVersion: 2, state: 'ready', operation: 'bootstrap', years: values.map(year),
});
let scope: GradebookYearContextValue;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
function Probe() {
  const current = useGradebookYear();
  if (!current) throw new Error('Missing year provider');
  scope = current;
  return <output aria-label="Effective year">{current.year ?? 'none'}</output>;
}
const mount = () => render(<GradebookYearProvider><Probe /></GradebookYearProvider>);
const expectYear = async (value: number | 'none') => {
  await waitFor(() => expect(screen.getByLabelText('Effective year').textContent).toBe(String(value)));
};
beforeEach(() => {
  fetcher = vi.fn<typeof fetch>(async () => Response.json(catalogue()));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  act(() => scope?.clearAuthorization());
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('remembers a manual choice without writing browser storage', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  first.unmount();
  mount();
  await expectYear(2025);
  expect(storage).not.toHaveBeenCalled();
});

it('remembers the effective year selected by the real import follow-up method on remount', async () => {
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  await act(async () => { await scope.refreshYears(2026); });
  await expectYear(2026);
  first.unmount();
  mount();
  await expectYear(2026);
});

it('remembers the catalogue fallback instead of resurrecting a removed year when it returns', async () => {
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  fetcher.mockResolvedValueOnce(Response.json(catalogue([2026])));
  await act(async () => { await scope.refreshYears(); });
  await expectYear(2026);
  first.unmount();
  mount();
  await expectYear(2026);
});

it('clears visit memory for an authoritative empty catalogue', async () => {
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  fetcher.mockResolvedValueOnce(Response.json(catalogue([])));
  await act(async () => { await scope.refreshYears(); });
  await expectYear('none');
  first.unmount();
  mount();
  await expectYear(2026);
});

it('does not change the remembered year on an unavailable read', async () => {
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  fetcher.mockResolvedValueOnce(Response.json({ contractVersion: 2, state: 'unavailable' }, { status: 503 }));
  await act(async () => { await scope.refreshYears(2026); });
  await expectYear(2025);
  first.unmount();
  mount();
  await expectYear(2025);
});

it.each([401, 403])('forgets the old choice after an authoritative %i denial', async (status) => {
  const first = mount();
  await expectYear(2026);
  act(() => scope.selectYear(2025));
  fetcher.mockResolvedValueOnce(Response.json({}, { status }));
  await act(async () => { await scope.refreshYears(); });
  await expectYear('none');
  first.unmount();
  mount();
  await expectYear(2026);
});

it('does not let a delayed previous read overwrite state or visit memory', async () => {
  const first = mount();
  await expectYear(2026);
  let resolve!: (response: Response) => void;
  fetcher.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
  let pending!: Promise<void>;
  act(() => { pending = scope.refreshYears(2025); });
  await act(async () => { await scope.refreshYears(2026); });
  await act(async () => {
    resolve(Response.json(catalogue([2025])));
    await pending;
  });
  await expectYear(2026);
  first.unmount();
  mount();
  await expectYear(2026);
});

it.each(['ready', 'network-error'] as const)(
  'keeps a consumer authorization loss authoritative over a delayed %s catalogue',
  async (outcome) => {
    const first = mount();
    await expectYear(2026);
    act(() => scope.selectYear(2025));
    const staleSelection = scope.selectYear;
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>((accept, fail) => {
      resolve = accept;
      reject = fail;
    }));
    let pending!: Promise<void>;
    act(() => { pending = scope.refreshYears(2025); });
    expect(scope.loading).toBe(true);
    act(() => {
      scope.clearAuthorization();
      // An event already queued by the old selector must not restore its cached catalogue.
      staleSelection(2025);
    });
    await expectYear('none');
    expect(scope.years).toEqual([]);
    expect(scope.loading).toBe(false);
    expect(scope.failure).toContain('não possui autorização');
    await act(async () => {
      if (outcome === 'ready') resolve(Response.json(catalogue()));
      else reject(new Error('synthetic-late-network-error'));
      await pending;
    });
    await expectYear('none');
    expect(scope.years).toEqual([]);
    expect(scope.loading).toBe(false);
    expect(scope.failure).toContain('não possui autorização');
    // Only a fresh, successful request may restore the academic context.
    await act(async () => { await scope.refreshYears(); });
    await expectYear(2026);
    expect(scope.failure).toBeNull();
    first.unmount();
    mount();
    await expectYear(2026);
  },
);
