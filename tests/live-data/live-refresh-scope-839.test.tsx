// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockSecureJitterV1 } from './secure-jitter-fixture';
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

function Reader({
  refresh,
  canRefresh = () => true,
}: {
  refresh: () => Promise<unknown>;
  canRefresh?: () => boolean;
}) {
  useLiveRefreshV1(refresh, { domains: ['gradebook'], canRefresh });
  return <input aria-label="Rascunho sintético" defaultValue="inicial" />;
}

it('pauses every retained reader in an inactive workspace and resumes once without unmounting its draft', async () => {
  const refresh = vi.fn(async () => true);
  const content = (active: boolean) => (
    <LiveRefreshScopeV1 active={active}>
      <Reader refresh={refresh} />
    </LiveRefreshScopeV1>
  );
  const view = render(content(true));
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'rascunho preservado' } });
  await advance(30_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(content(false));
  await act(async () => {
    notifyLiveChangeV1('gradebook');
    notifyLiveChangeV1('gradebook');
  });
  await advance(120_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(content(true));
  await advance(250);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input.value).toBe('rascunho preservado');
});

it('an active inner panel cannot reactivate an inactive ancestor', async () => {
  const refresh = vi.fn(async () => true);
  render(
    <LiveRefreshScopeV1 active={false}>
      <LiveRefreshScopeV1 active>
        <Reader refresh={refresh} />
      </LiveRefreshScopeV1>
    </LiveRefreshScopeV1>,
  );
  await act(async () => {
    notifyLiveChangeV1('gradebook');
    window.dispatchEvent(new Event('focus'));
  });
  await advance(120_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('retains failure cooldown across hidden/visible transitions', async () => {
  const refresh = vi.fn(async () => false);
  const content = (active: boolean) => (
    <LiveRefreshScopeV1 active={active}>
      <Reader refresh={refresh} />
    </LiveRefreshScopeV1>
  );
  const view = render(content(true));
  await act(async () => {
    notifyLiveChangeV1('gradebook');
  });
  await advance(250);
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(content(false));
  await advance(1_000);
  view.rerender(content(true));
  await advance(1_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(28_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it('does not bypass the reader guard for a dirty form or an operation in progress', async () => {
  let allowed = false;
  const refresh = vi.fn(async () => true);
  const content = (active: boolean) => (
    <LiveRefreshScopeV1 active={active}>
      <Reader refresh={refresh} canRefresh={() => allowed} />
    </LiveRefreshScopeV1>
  );
  const view = render(content(false));
  view.rerender(content(true));
  await advance(2_000);
  expect(refresh).not.toHaveBeenCalled();
  allowed = true;
  await advance(1_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});
