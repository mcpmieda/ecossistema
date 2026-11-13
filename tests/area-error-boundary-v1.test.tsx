import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageContent } from '../src/platform/pages';
import { StudentPortalAdminPage } from '../src/features/student-portal-admin/student-portal-admin-page';
import { buildPlatformSnapshot } from '../server/platform/snapshot';
import type { PlatformSnapshotV2 } from '../shared/platform-snapshot-v2';
import { setupOperationsDomV1 } from './student-portal/ui/overview/dom-v1';
import { opJsonV1, operationsMockV1 } from './student-portal/ui/overview/fixtures-v1';

vi.mock('../src/platform/system-health-page-v1', () => ({
  SystemHealthPageV1: () => {
    throw new Error('Saúde sintética falhou');
  },
}));
vi.mock('../src/features/student-portal-admin/sessions/student-sessions-v1', () => ({
  StudentSessionsV1: () => {
    throw new Error('Sessões sintéticas falharam');
  },
}));

beforeEach(() => {
  setupOperationsDomV1();
  // The error React reports for the failed area is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const snapshot = () =>
  buildPlatformSnapshot(
    { lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [], correlationId: 'synthetic' },
    ['platform.snapshot.read', 'platform.settings.read'],
  ) as unknown as PlatformSnapshotV2;

it('a failure in Saúde stays in its area, with a way to reload (A14)', async () => {
  render(
    <>
      <nav>Menu do Centro</nav>
      <PageContent route="operacao" snapshot={snapshot()} />
    </>,
  );
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Saúde do Sistema indisponível');
  expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
  expect(screen.getByText('Menu do Centro')).toBeTruthy();
});

it('a failure in an area of the Painel keeps the Painel and its tabs (A14)', async () => {
  const mock = operationsMockV1();
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/me')
      return opJsonV1({
        authenticated: true,
        identityKey: 'synthetic-boundary-session',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        capabilities: ['platform.settings.read'],
      });
    const input = JSON.parse(String(init.body));
    return opJsonV1(
      input.contractVersion === 2 ? await mock.reader.query(input) : await mock.client.query(input),
    );
  });
  window.history.replaceState(null, '', '/#/painel-do-aluno');
  render(<StudentPortalAdminPage fetcher={fetcher} />);
  await userEvent.setup().click(await screen.findByRole('tab', { name: 'Sessões' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Área do Painel indisponível');
  expect(screen.getByRole('tab', { name: 'Sessões' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
});
