// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  diagnosticStudentFetchV1,
  enableStudentDiagnosticsV1,
  markStudentModuleFailureV1,
  reportStudentDiagnosticV1,
} from '../../src/student-portal/diagnostics-v1';
import { StudentDiagnosticBoundaryV1 } from '../../src/student-portal/diagnostic-boundary-v1';
let stop: (() => void) | undefined;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('does no startup traffic and sends at most one report per category without credentials, URL or error text', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  stop = enableStudentDiagnosticsV1(fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  for (let i = 0; i < 10; i++) {
    reportStudentDiagnosticV1('read');
    reportStudentDiagnosticV1('render');
    reportStudentDiagnosticV1('module-load');
  }
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [path, init] of fetcher.mock.calls) {
    expect(path).toBe('/api/observability/frontend-diagnostic');
    expect(init).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual([
      'area',
      'category',
      'correlationId',
      'release',
      'version',
    ]);
    expect(body.area).toBe('student-portal');
  }
});
it('does not retry a broken receiver or send while offline', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error('private');
  });
  stop = enableStudentDiagnosticsV1(fetcher);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  reportStudentDiagnosticV1('read');
  await flush();
  expect(fetcher).not.toHaveBeenCalled();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  reportStudentDiagnosticV1('read');
  await flush();
  reportStudentDiagnosticV1('read');
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('preserves transport responses and suppresses reports for cancellation', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  stop = enableStudentDiagnosticsV1(fetcher);
  const controller = new AbortController();
  controller.abort();
  const original = Error('synthetic cancellation');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw original;
    }),
  );
  await expect(
    diagnosticStudentFetchV1('/api/student/me', { signal: controller.signal }),
  ).rejects.toBe(original);
  expect(fetcher).not.toHaveBeenCalled();
  const response = new Response('SYNTHETIC PRIVATE', { status: 503 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  expect(await diagnosticStudentFetchV1('/api/student/me', {})).toBe(response);
  expect(response.bodyUsed).toBe(false);
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('renders a safe manual fallback and records only a category', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  stop = enableStudentDiagnosticsV1(fetcher);
  const broken = () => {
    throw Error('SYNTHETIC-PRIVATE');
  };
  const Broken = broken;
  render(
    <StudentDiagnosticBoundaryV1>
      <Broken />
    </StudentDiagnosticBoundaryV1>,
  );
  await flush();
  expect(screen.getByRole('button', { name: 'Recarregar página' })).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC-PRIVATE')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![1]!.body)).not.toContain('PRIVATE');
});
it('does not count a module failure again as a render failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  stop = enableStudentDiagnosticsV1(fetcher);
  const error = Error('SYNTHETIC');
  try {
    markStudentModuleFailureV1(error);
  } catch {
    /* expected */
  }
  const Broken = () => {
    throw error;
  };
  render(
    <StudentDiagnosticBoundaryV1>
      <Broken />
    </StudentDiagnosticBoundaryV1>,
  );
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).category).toBe('module-load');
});
