import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPlatformDataV2, usePlatformCheckedAtV2 } from '../src/platform/platform-data-v2';
import { AreaErrorBoundaryV1 } from '../src/shared/ui/area-error-boundary-v1';
import { PageContent } from '../src/platform/pages';
import { allowLeavingToV1, useDraftNavigationGuardV1 } from '../src/shared/forms/draft-navigation-v1';
import { buildPlatformSnapshot } from '../server/platform/snapshot';
import type { PlatformSnapshotV2 } from '../shared/platform-snapshot-v2';

vi.mock('../src/platform/notes-page', () => ({
  NotesPage: () => {
    throw new Error('Banco sintético falhou');
  },
}));

let reads = 0;
const template = () =>
  buildPlatformSnapshot(
    {
      lists: [],
      moduleItems: [],
      configurationItems: [],
      auditItems: [],
      migrationItems: [],
      correlationId: `synthetic-${++reads}`,
      generatedAt: new Date(1_800_000_000_000 + reads * 1000).toISOString(),
    },
    ['platform.snapshot.read', 'platform.settings.read'],
  );
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('the footer time follows every reading, even one with the same content', async () => {
  let clock = 0;
  const states: unknown[] = [];
  const controller = createPlatformDataV2(
    (state) => states.push(state),
    vi.fn<typeof fetch>(async () => json(template())),
    () => clock,
  );
  const { result } = renderHook(() => usePlatformCheckedAtV2());
  try {
    await controller.start();
    await vi.waitFor(() => expect(result.current).not.toBe(''));
    const first = result.current;
    const published = states.length;
    clock = 120_000;
    await act(async () => {
      await controller.refresh();
    });
    // The screens get nothing new, but the footer moves on.
    expect(states).toHaveLength(published);
    expect(result.current).not.toBe(first);
    expect(Date.parse(result.current)).toBeGreaterThan(Date.parse(first));
  } finally {
    controller.dispose();
  }
});

it('the whole Centro has a limit too: no white screen, a way to reload', () => {
  const Broken = () => {
    throw new Error('Cabeçalho sintético falhou');
  };
  render(
    <AreaErrorBoundaryV1 label="Centro de Administração" whole>
      <Broken />
    </AreaErrorBoundaryV1>,
  );
  expect(screen.getByText('Centro de Administração indisponível')).toBeTruthy();
  expect(screen.getByText(/Recarregue a página para continuar/)).toBeTruthy();
  expect(screen.queryByText(/O restante do Centro continua disponível/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
});

it('a failure in the Banco de notas page stays in its area', () => {
  const snapshot = buildPlatformSnapshot(
    { lists: [], moduleItems: [], configurationItems: [], auditItems: [], migrationItems: [], correlationId: 'synthetic' },
    ['platform.snapshot.read'],
  ) as unknown as PlatformSnapshotV2;
  render(<PageContent route="banco-de-notas" snapshot={snapshot} auxiliary="ready" />);
  expect(screen.getByText('Banco de notas indisponível')).toBeTruthy();
});

it('a search result with an open edit asks once; refusing leaves address and history alone', () => {
  window.location.hash = '#/painel-do-aluno';
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  renderHook(() => useDraftNavigationGuardV1(true));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const push = vi.spyOn(window.history, 'pushState');
  expect(allowLeavingToV1('#/banco-de-notas')).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('#/painel-do-aluno');
  expect(push).not.toHaveBeenCalled();

  // Accepting asks no second time when the address arrives.
  confirm.mockClear();
  confirm.mockReturnValue(true);
  expect(allowLeavingToV1('#/banco-de-notas')).toBe(true);
  confirm.mockReturnValue(false);
  window.location.hash = '#/banco-de-notas';
  window.dispatchEvent(new HashChangeEvent('hashchange', { newURL: window.location.href }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('#/banco-de-notas');
});
