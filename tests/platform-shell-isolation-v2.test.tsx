import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PLATFORM_CAPABILITIES } from '../shared/platform-contract';
import { buildPlatformSnapshot } from '../server/platform/snapshot';

const { mounts } = vi.hoisted(() => ({ mounts: vi.fn() }));
// Render the actual Center/authentication/navigation, replacing only the child workspace.
vi.mock('../src/platform/pages', async () => {
  const React = await import('react');
  return {
    LoadingWorkspace: () => <p>Carregando área</p>,
    PageContent: function PageContent({ route }: { route: string }) {
      const [value, setValue] = React.useState('');
      React.useEffect(() => {
        mounts(route);
      }, [route]);
      return (
        <input
          aria-label={`workspace-${route}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    },
  };
});
const snapshot = () =>
  buildPlatformSnapshot(
    {
      lists: [],
      moduleItems: [],
      configurationItems: [],
      auditItems: [],
      migrationItems: [],
      correlationId: 'synthetic',
    },
    PLATFORM_CAPABILITIES,
  );
beforeEach(() => {
  mounts.mockClear();
  window.history.replaceState(null, '', '/#/banco-de-notas');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

it('uses independent main links without remounting Importação and respects interrupted drafts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (path) =>
      path === '/api/me'
        ? Response.json({ authenticated: true, capabilities: PLATFORM_CAPABILITIES })
        : Response.json(snapshot()),
    ),
  );
  render(<App />);
  const input = await screen.findByRole('textbox', { name: 'workspace-banco-de-notas' });
  const user = userEvent.setup();
  await user.type(input, 'interrupted synthetic import');
  await user.click(screen.getByRole('link', { name: 'Banco de notas' }));
  expect(window.location.hash).toBe('#/banco-de-notas?area=performance');
  await user.click(screen.getByRole('link', { name: 'Importação' }));
  expect(window.location.hash).toBe('#/banco-de-notas?area=importacao');
  expect(screen.getByRole('link', { name: 'Importação' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(screen.getByRole('textbox', { name: 'workspace-banco-de-notas' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('interrupted synthetic import');
  const block = (event: Event) => event.preventDefault();
  window.addEventListener('ecossistema-before-navigation', block);
  try {
    await user.click(screen.getByRole('link', { name: 'Alunos' }));
    expect(window.location.hash).toBe('#/banco-de-notas?area=importacao');
  } finally {
    window.removeEventListener('ecossistema-before-navigation', block);
  }
  await user.click(screen.getByRole('link', { name: 'Alunos' }));
  await screen.findByRole('textbox', { name: 'workspace-painel-do-aluno' });
  expect(screen.getByRole('link', { name: 'Alunos' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('link', { name: 'Acessos e QR' })).toBeNull();
  await user.click(screen.getByRole('link', { name: 'Painel do Aluno' }));
  expect(await screen.findAllByRole('link', { name: 'Alunos' })).toHaveLength(2);
});

it.each([503, 401])(
  'handles external status %i without remounting work or substituting permissions',
  async (status) => {
    let resolve!: (response: Response) => void;
    const waiting = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn<typeof fetch>(async (path) => {
      if (path === '/api/me')
        return Response.json({
          authenticated: true,
          name: 'SYNTHETIC ADMIN',
          capabilities: PLATFORM_CAPABILITIES,
        });
      if (path === '/api/platform/bootstrap') return Response.json(snapshot());
      if (path === '/api/platform/snapshot-v2') return waiting;
      throw new Error('Unexpected synthetic request');
    });
    vi.stubGlobal('fetch', fetcher);
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'workspace-banco-de-notas' });
    await userEvent.type(input, 'unsaved local work');
    expect(mounts).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(Response.json({}, { status }));
      await flush();
    });
    if (status === 503) {
      expect(screen.getByRole('textbox', { name: 'workspace-banco-de-notas' })).toBe(input);
      expect((input as HTMLInputElement).value).toBe('unsaved local work');
      expect(mounts).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.queryByRole('textbox', { name: 'workspace-banco-de-notas' })).toBeNull();
      expect(screen.getByText(/Sua autorização precisa ser verificada novamente/u)).toBeTruthy();
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
it('limits a partial outage to pages that actually need the unavailable source', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (path) => {
      if (path === '/api/me')
        return Response.json({ authenticated: true, capabilities: PLATFORM_CAPABILITIES });
      return Response.json(
        path === '/api/platform/bootstrap'
          ? snapshot()
          : { ...snapshot(), unavailableSections: ['audit'], retryAfterSeconds: 90 },
      );
    }),
  );
  render(<App />);
  expect(await screen.findByRole('textbox', { name: 'workspace-banco-de-notas' })).toBeTruthy();
  await act(async () => {
    window.location.hash = '#/operacao?area=audit';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
  });
  expect(
    await screen.findByText('Informações desta área temporariamente indisponíveis'),
  ).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'workspace-operacao' })).toBeNull();
  await act(async () => {
    window.location.hash = '#/configuracoes';
    window.dispatchEvent(new Event('hashchange'));
    await flush();
  });
  expect(await screen.findByRole('textbox', { name: 'workspace-configuracoes' })).toBeTruthy();
});

it('keeps the keyboard inside the phone drawer, closes it on Escape and gives focus back', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (path) =>
      path === '/api/me'
        ? Response.json({
            authenticated: true,
            name: 'SYNTHETIC ADMIN',
            capabilities: PLATFORM_CAPABILITIES,
          })
        : Response.json(snapshot()),
    ),
  );
  render(<App />);
  await screen.findByRole('textbox', { name: 'workspace-banco-de-notas' });
  const user = userEvent.setup();
  const menu = screen.getByRole('button', { name: 'Abrir menu' });
  await user.click(menu);
  const drawer = screen.getByRole('dialog', { name: 'Menu do Centro' });
  // Focus starts on the open area, and the page and the top bar behind are inert.
  expect(drawer.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.getAttribute('data-open')).toBe('true');
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(true);
  expect(document.querySelector('.shell-topbar')?.hasAttribute('inert')).toBe(true);
  // The drawer holds one navigation only; no hidden copy of the old section row is a tab stop.
  expect(drawer.querySelector('.shell-sidenav')).toBeNull();
  expect(within(drawer).getAllByRole('navigation')).toHaveLength(1);
  const stops = [...drawer.querySelectorAll<HTMLElement>('a[href], button')].filter(
    (item) => !item.closest('.shell-side__search, .shell-side__profile'),
  );
  const first = stops[0]!,
    last = stops.at(-1)!;
  // The open area (Banco de notas) has sections, so the last stop is an area after them.
  expect(last.textContent).toBe('Configurações');
  // The two edges wrap inside the drawer.
  last.focus();
  await user.tab();
  expect(document.activeElement).toBe(first);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(last);
  // Both directions, more steps than there are stops: focus never leaves the drawer.
  for (let step = 0; step < 30; step++) {
    await user.tab({ shift: step % 2 === 0 });
    expect(drawer.contains(document.activeElement)).toBe(true);
  }
  for (let step = 0; step < 30; step++) {
    await user.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);
  }
  for (let step = 0; step < 30; step++) {
    await user.tab({ shift: true });
    expect(drawer.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Menu do Centro' })).toBeNull();
  expect(document.querySelector('main')?.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('.shell-topbar')?.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Abrir menu' }));
  // The drawer has its own visible way out.
  await user.click(screen.getByRole('button', { name: 'Abrir menu' }));
  await user.click(
    within(screen.getByRole('dialog', { name: 'Menu do Centro' })).getByRole('button', {
      name: 'Fechar menu',
    }),
  );
  expect(screen.queryByRole('dialog', { name: 'Menu do Centro' })).toBeNull();
});
