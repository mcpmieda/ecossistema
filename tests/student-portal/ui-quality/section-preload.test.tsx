import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalAdminPage } from '../../../src/features/student-portal-admin/student-portal-admin-page';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { opJsonV1, operationsMockV1 } from '../ui/overview/fixtures-v1';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function page() {
  const mock = operationsMockV1();
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/me')
      return opJsonV1({
        authenticated: true,
        identityKey: 'synthetic-preload-session',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        capabilities: ['platform.settings.read', 'area.painel-do-aluno'],
      });
    const input = JSON.parse(String(init.body));
    return opJsonV1(
      input.contractVersion === 2 ? await mock.reader.query(input) : await mock.client.query(input),
    );
  });
  return <StudentPortalAdminPage fetcher={fetcher} />;
}
function loadingStates() {
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    if (document.body.textContent?.includes('Carregando área do Painel')) seen.push('loading');
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}

it('opens an area whose bundle arrived while idle without any loading state', async () => {
  const idle = vi.fn((run: () => void) => {
    run();
    return 1;
  });
  vi.stubGlobal('requestIdleCallback', idle);
  vi.stubGlobal('cancelIdleCallback', vi.fn());
  window.history.replaceState(null, '', '/#/painel-do-aluno');
  render(page());
  await screen.findByRole('tab', { name: 'Sessões' });
  expect(idle).toHaveBeenCalledTimes(1);
  // The preload asked for the same modules the areas use; let them settle.
  await act(async () => {
    await import('../../../src/features/student-portal-admin/sessions/student-sessions-v1');
    await Promise.resolve();
  });
  const watch = loadingStates();
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Sessões' }));
  expect(await screen.findByRole('heading', { name: 'Sessões ativas' })).toBeTruthy();
  watch.stop();
  expect(watch.seen).toEqual([]);
});

it('still loads an area on demand where the browser offers no idle time', async () => {
  window.history.replaceState(null, '', '/#/painel-do-aluno');
  render(page());
  await userEvent.setup().click(await screen.findByRole('tab', { name: 'Sessões' }));
  expect(await screen.findByRole('heading', { name: 'Sessões ativas' })).toBeTruthy();
});
