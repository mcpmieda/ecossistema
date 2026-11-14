// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewOneDriveSyncV1 } from '../../../src/adm-preview/onedrive-sync-preview-v1';
import { requestOneDriveSyncV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1';
import { OneDriveSyncPageV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-page-v1';

vi.mock('../../../src/platform/gradebook-year-context', () => ({ useGradebookYear: () => ({ year: 2026 }) }));
vi.mock('../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1');

const ready = previewOneDriveSyncV1(JSON.stringify({ action: 'status' }));
const down = { contractVersion: 1, state: 'unavailable' } as const;
const message = /não respondeu agora/u;
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('one failed automatic read (back from the background) shows nothing; three in a row do', async () => {
  vi.mocked(requestOneDriveSyncV1).mockResolvedValueOnce(ready).mockResolvedValue(down);
  render(<OneDriveSyncPageV1 />);
  await advance(10);
  expect(screen.getByText('Leitura automática do OneDrive')).toBeTruthy();
  await advance(10_000);
  await advance(10_000);
  expect(screen.queryByText(message)).toBeNull();
  await advance(10_000);
  expect(screen.getByText(message)).toBeTruthy();
});

it('does not read while the page is hidden, and reads again shortly after it comes back', async () => {
  vi.mocked(requestOneDriveSyncV1).mockResolvedValue(ready);
  render(<OneDriveSyncPageV1 />);
  await advance(10);
  const calls = vi.mocked(requestOneDriveSyncV1).mock.calls.length;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await advance(30_000);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls.length).toBe(calls);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await advance(1_100);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls.length).toBe(calls + 1);
});
