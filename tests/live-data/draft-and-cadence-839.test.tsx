// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
import {
  DraftUpdatesNoticeV1,
  allowDraftNavigationV1,
  useDraftNavigationGuardV1,
} from '../../src/shared/forms/draft-navigation-v1';
import { LiveRefreshScopeV1 } from '../../src/shared/live-data/live-refresh-scope-v1';
import { useLiveRefreshV1 } from '../../src/shared/live-data/use-live-refresh-v1';
import { notifyLiveChangeV1 } from '../../src/shared/live-data/live-refresh-v1';

beforeEach(() => {
  vi.useFakeTimers();
  mockSecureJitterV1(0);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
function Draft({ blocked, label = 'Ano sintético' }: { blocked: boolean; label?: string }) {
  const [value, setValue] = useState('2010');
  const [expectedVersion] = useState(17);
  useDraftNavigationGuardV1(blocked);
  return (
    <>
      <input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} />
      <output data-testid={label + '-version'}>{expectedVersion}</output>
    </>
  );
}
it('keeps a draft and its original version while showing only a broad update notice', async () => {
  const view = render(
    <>
      <Draft blocked />
      <DraftUpdatesNoticeV1 />
    </>,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '2012' } });
  await act(async () => notifyLiveChangeV1('portal', { broadcast: false }));
  expect(input.value).toBe('2012');
  expect(screen.getByTestId('Ano sintético-version').textContent).toBe('17');
  expect(screen.getByText(/Há atualizações a conferir/).textContent).not.toContain('Este cadastro');
  expect(allowDraftNavigationV1()).toBe(false);
  view.rerender(
    <>
      <Draft blocked={false} />
      <DraftUpdatesNoticeV1 />
    </>,
  );
  expect(screen.queryByText(/Há atualizações a conferir/)).toBeNull();
  expect(input.value).toBe('2012');
  expect(allowDraftNavigationV1()).toBe(true);
});
it('does not warn for a clean form', async () => {
  render(
    <>
      <Draft blocked={false} />
      <DraftUpdatesNoticeV1 />
    </>,
  );
  await act(async () => notifyLiveChangeV1('gradebook', { broadcast: false }));
  expect(screen.queryByText(/Há atualizações a conferir/)).toBeNull();
});
it('clearing one guard does not erase another pending draft warning', async () => {
  const content = (first: boolean, second: boolean) => (
    <>
      <Draft blocked={first} label="Primeiro" />
      <Draft blocked={second} label="Segundo" />
      <DraftUpdatesNoticeV1 />
    </>
  );
  const view = render(content(true, true));
  await act(async () => notifyLiveChangeV1('portal', { broadcast: false }));
  view.rerender(content(false, true));
  expect(screen.getByText(/Há atualizações a conferir/)).toBeTruthy();
  view.rerender(content(false, false));
  expect(screen.queryByText(/Há atualizações a conferir/)).toBeNull();
});
it('cleans anonymous pending metadata on identity-scope unmount', async () => {
  const view = render(
    <>
      <Draft blocked />
      <DraftUpdatesNoticeV1 />
    </>,
  );
  await act(async () => notifyLiveChangeV1('portal', { broadcast: false }));
  view.unmount();
  render(<DraftUpdatesNoticeV1 />);
  expect(screen.queryByText(/Há atualizações a conferir/)).toBeNull();
  expect(allowDraftNavigationV1()).toBe(true);
});
function Reader({ read, intervalMs }: { read: () => Promise<unknown>; intervalMs?: number }) {
  useLiveRefreshV1(read, { domains: ['gradebook'], intervalMs });
  return null;
}
it('allows an explicit critical-reader interval to override an inherited fallback', async () => {
  const inherited = vi.fn(async () => true),
    critical = vi.fn(async () => true);
  render(
    <LiveRefreshScopeV1 active intervalMs={120_000}>
      <Reader read={inherited} />
      <Reader read={critical} intervalMs={30_000} />
    </LiveRefreshScopeV1>,
  );
  await advance(30_000);
  expect(inherited).not.toHaveBeenCalled();
  expect(critical).toHaveBeenCalledTimes(1);
  await advance(90_000);
  expect(inherited).toHaveBeenCalledTimes(1);
  expect(critical).toHaveBeenCalledTimes(4);
});
it('reacts to changes before a slower fallback is due', async () => {
  const read = vi.fn(async () => true);
  render(
    <LiveRefreshScopeV1 active intervalMs={120_000}>
      <Reader read={read} />
    </LiveRefreshScopeV1>,
  );
  await act(async () => notifyLiveChangeV1('gradebook', { broadcast: false }));
  await advance(250);
  expect(read).toHaveBeenCalledTimes(1);
  await advance(30_000);
  expect(read).toHaveBeenCalledTimes(1);
});
it('preserves the original fallback when no override is selected', async () => {
  const read = vi.fn(async () => true);
  render(
    <LiveRefreshScopeV1 active>
      <Reader read={read} />
    </LiveRefreshScopeV1>,
  );
  await advance(30_000);
  expect(read).toHaveBeenCalledTimes(1);
});
