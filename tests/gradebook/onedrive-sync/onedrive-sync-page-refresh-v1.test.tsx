// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { previewOneDriveSyncV1 } from '../../../src/adm-preview/onedrive-sync-preview-v1';
import { requestOneDriveSyncV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1';
import { OneDriveSyncPageV1 } from '../../../src/features/gradebook/onedrive-sync/onedrive-sync-page-v1';

vi.mock('../../../src/platform/gradebook-year-context', () => ({ useGradebookYear: () => ({ year: 2026 }) }));
vi.mock('../../../src/features/gradebook/onedrive-sync/onedrive-sync-client-v1');

const ready = previewOneDriveSyncV1(JSON.stringify({ action: 'status' }));
/** A status with a file being read (issue #1450, 12b: only a read in progress asks every 10 s). */
const reading = (() => {
  if (ready.state !== 'status') throw new Error('preview status');
  return { ...ready, status: { ...ready.status, files: ready.status.files.map((file, index) => ({ ...file, state: index === 0 ? 'reading' as const : 'idle' as const })) } };
})();
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
  vi.mocked(requestOneDriveSyncV1).mockResolvedValueOnce(reading).mockResolvedValue(down);
  render(<OneDriveSyncPageV1 />);
  await advance(10);
  expect(screen.getByText('Leitura automática')).toBeTruthy();
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
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls).toHaveLength(calls);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await advance(1_100);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls).toHaveLength(calls + 1);
});

const still = (() => {
  if (ready.state !== 'status') throw new Error('preview status');
  return { ...ready, status: { ...ready.status, files: ready.status.files.map((file) => ({ ...file, state: 'idle' as const })) } };
})();

it('reads every 60 s when nothing moves, and every 10 s while a file is read (issue #1426, 11; #1450, 12b)', async () => {
  vi.mocked(requestOneDriveSyncV1).mockResolvedValue(still);
  render(<OneDriveSyncPageV1 />);
  await advance(10);
  const calls = () => vi.mocked(requestOneDriveSyncV1).mock.calls.length;
  const first = calls();
  await advance(30_000);
  expect(calls()).toBe(first);
  await advance(30_000);
  expect(calls()).toBe(first + 1);
  vi.mocked(requestOneDriveSyncV1).mockResolvedValue(reading);
  await advance(60_000);
  await advance(10_000);
  expect(calls()).toBe(first + 3);
});

it('a file only waiting for a later retry does not make the panel read every 10 s (issue #1450, 12b)', async () => {
  const waiting = (() => {
    if (still.state !== 'status') throw new Error('preview status');
    return { ...still, status: { ...still.status, files: still.status.files.map((file, index) => ({ ...file, state: index === 0 ? 'pending' as const : 'idle' as const })) } };
  })();
  vi.mocked(requestOneDriveSyncV1).mockResolvedValue(waiting);
  render(<OneDriveSyncPageV1 />);
  await advance(10);
  const first = vi.mocked(requestOneDriveSyncV1).mock.calls.length;
  await advance(30_000);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls).toHaveLength(first);
});

it('stops reading after 10 min untouched and reads at once on the next click', async () => {
  vi.mocked(requestOneDriveSyncV1).mockResolvedValue(still);
  render(<OneDriveSyncPageV1 />);
  await advance(11 * 60_000);
  const paused = vi.mocked(requestOneDriveSyncV1).mock.calls.length;
  await advance(5 * 60_000);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls).toHaveLength(paused);
  await act(async () => { window.dispatchEvent(new Event('pointerdown')); });
  await advance(10);
  expect(vi.mocked(requestOneDriveSyncV1).mock.calls).toHaveLength(paused + 1);
});
