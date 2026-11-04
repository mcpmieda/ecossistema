import { createElement, StrictMode } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type {
  AdminCommandV1,
  AdminQueryV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { StudentPublicationV1 } from '../../../../src/features/student-portal-admin/publication/student-publication-v1';
import { SETTINGS_CLASS_V1, SETTINGS_SCHOOL_V1 } from '../settings/fixtures-v1';
import { PUBLICATION_META_V1, publicationFixtureV1, publicationResponseV1 } from './fixtures-v1';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
beforeEach(() => {
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
function setup(
  options: { write?: (command: AdminCommandV1) => Promise<Response>; materialize?: boolean } = {},
) {
  const fixture = publicationFixtureV1(),
    writes: AdminCommandV1[] = [],
    bodies: string[] = [];
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (path.endsWith('/query')) {
        const input: AdminQueryV1 = JSON.parse(String(init.body));
        return json(
          input.operation === 'publication'
            ? publicationResponseV1(fixture)
            : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings },
        );
      }
      const command: AdminCommandV1 = JSON.parse(String(init.body));
      writes.push(command);
      bodies.push(String(init.body));
      if (options.write) return options.write(command);
      if ('period' in command) {
        const item = fixture.items.find((item) => item.period === command.period)!;
        if (command.operation === 'unpublish') {
          item.publishedRevision = null;
          item.state = 'available';
        } else if (options.materialize && 'targetDataVersion' in command) {
          item.publishedRevision = command.targetDataVersion;
          item.state = 'published';
        }
      }
      return json({
        ...PUBLICATION_META_V1,
        state: 'committed',
        operationId: SYNTHETIC_ID_V1,
        version: 10,
      });
    },
  });
  return {
    fixture,
    writes,
    bodies,
    props: {
      client,
      scope: SETTINGS_CLASS_V1,
      canWrite: true,
      scopeLabel: 'Turma sintética · 2026',
    },
  };
}
const ready = () => screen.findByRole('heading', { name: '1º trimestre' });
describe('publication interface', () => {
  it('renders six independent server states and read-only policy without actions for no-data', async () => {
    const mock = setup();
    mock.fixture.settings.value.autoUpdate = true;
    mock.fixture.settings.value.showPartials = true;
    render(createElement(StudentPublicationV1, mock.props));
    await ready();
    for (const period of ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'])
      expect(
        screen.getByRole('heading', {
          name: period.startsWith('REC')
            ? `Recuperação ${period.slice(3)}`
            : `${period.slice(1)}º trimestre`,
        }),
      ).toBeTruthy();
    expect(screen.getByText('Ligada')).toBeTruthy();
    expect(screen.getByText('Finais e parciais')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publicar T3' })).toBeNull();
    expect(screen.getAllByText('Não definida')).toHaveLength(1); // Dates without values are omitted from repeated cards.
    expect(mock.writes).toHaveLength(0);
  });
  it('hides manual refresh while auto-update is on and shows it only for a pending manual revision', async () => {
    const automatic = setup();
    automatic.fixture.settings.value.autoUpdate = true;
    render(createElement(StudentPublicationV1, automatic.props));
    await ready();
    expect(screen.getByRole('button', { name: 'Publicar as notas novas de 1º trimestre' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Publicar as notas novas de 2º trimestre' }),
    ).toBeNull();
    expect(screen.queryByText('Publicar para todos')).toBeNull();
    cleanup();

    const manual = setup();
    manual.fixture.settings.value.autoUpdate = false;
    render(createElement(StudentPublicationV1, manual.props));
    await ready();
    expect(
      screen.getByRole('button', { name: 'Publicar as notas novas de 2º trimestre' }),
    ).toBeTruthy();
    const published = screen
      .getByRole('heading', { name: 'Recuperação 1' })
      .closest('.pa-publication-card')!;
    expect(
      within(published as HTMLElement).queryByText('Publicar as notas novas'),
    ).toBeNull();
  });

  it('reviews only the chosen period and does not equate command acceptance with materialization', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StudentPublicationV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 1º trimestre' }));
    expect(mock.writes).toHaveLength(0);
    expect(within(screen.getByRole('dialog')).getByText('synthetic:2026:revision:2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmar publicação' }));
    await screen.findByText('1º trimestre: solicitação aceita.');
    await screen.findByRole('button', { name: 'Parar acompanhamento' });
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({
      operation: 'publish',
      scope: SETTINGS_CLASS_V1,
      period: 'T1',
      expectedVersion: 9,
      targetDataVersion: 'synthetic:2026:revision:2',
    });
    await ready();
    const card = screen
      .getByRole('heading', { name: '1º trimestre' })
      .closest('.pa-publication-card')!;
    expect(within(card as HTMLElement).getByText('Pronta para publicar')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Parar acompanhamento' }));
    await screen.findByText(
      'Acompanhamento parado. Isso não cancela a decisão aceita nem o processamento no servidor.',
    );
    expect(mock.writes).toHaveLength(1);
  });
  it('cancels a reviewed update without any command', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StudentPublicationV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 2º trimestre' }));
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it('keeps a revision changed between query and confirmation, then requires explicit reload after conflict', async () => {
    const user = userEvent.setup(),
      mock = setup({ write: async () => json({ ...PUBLICATION_META_V1, state: 'conflict' }, 409) });
    render(createElement(StudentPublicationV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 2º trimestre' }));
    mock.fixture.items.forEach((item) => {
      item.version = 11;
      if (item.availableRevision) item.availableRevision = 'synthetic:2026:revision:3';
    });
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas' }));
    await screen.findByText(
      'A fonte, o escopo ou a configuração mudou. Recarregue e revise uma nova decisão; a revisão não será substituída automaticamente.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.writes[0]).toMatchObject({
      operation: 'publish-update',
      period: 'T2',
      expectedVersion: 9,
      targetDataVersion: 'synthetic:2026:revision:2',
    });
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Recarregar' }));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 2º trimestre' }));
    expect(within(screen.getByRole('dialog')).getByText('synthetic:2026:revision:3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas' }));
    await vi.waitFor(() => expect(mock.writes).toHaveLength(2));
    expect(mock.writes[1]).toMatchObject({
      expectedVersion: 11,
      targetDataVersion: 'synthetic:2026:revision:3',
    });
    expect(mock.writes[0]!.idempotencyKey).not.toBe(mock.writes[1]!.idempotencyKey);
  });
  it('confirms withdrawal separately and preserves unrelated periods in the presentation', async () => {
    const user = userEvent.setup(),
      mock = setup();
    render(createElement(StudentPublicationV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Retirar publicação de 2º trimestre' }));
    expect(
      within(screen.getByRole('dialog')).getByText(
        /O histórico acadêmico e os demais períodos são preservados/u,
      ),
    ).toBeTruthy();
    expect(mock.writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirmar retirada' }));
    await screen.findByText('Publicação retirada para este grupo.');
    expect(mock.writes[0]).toMatchObject({
      operation: 'unpublish',
      period: 'T2',
      expectedVersion: 9,
      confirmed: true,
    });
    expect(mock.writes[0]).not.toHaveProperty('targetDataVersion');
    const remaining = (await screen.findByRole('heading', { name: 'Recuperação 1' })).closest(
      '.pa-publication-card',
    )!;
    expect(within(remaining as HTMLElement).getByText('Publicada')).toBeTruthy();
  });
  it('discards an open decision before painting a changed write capability', async () => {
    const user = userEvent.setup(),
      mock = setup();
    const view = render(createElement(StudentPublicationV1, mock.props));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 1º trimestre' }));
    view.rerender(createElement(StudentPublicationV1, { ...mock.props, canWrite: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await ready();
    expect(screen.queryByRole('button', { name: /Publicar|Atualizar|Retirar publicação/u })).toBeNull();
    expect(mock.writes).toHaveLength(0);
  });
  it('clears the previous scope and ignores a late response after a scope switch', async () => {
    let finish!: (response: Response) => void;
    const fixture = publicationFixtureV1(),
      school = publicationFixtureV1(SETTINGS_SCHOOL_V1);
    const client = createPortalAdminClientV1({
      fetch: async (_path, init) => {
        const input: AdminQueryV1 = JSON.parse(String(init.body));
        if (input.scope.kind === 'class' && input.operation === 'publication')
          return new Promise<Response>((done) => {
            finish = done;
          });
        const data = input.scope.kind === 'class' ? fixture : school;
        return json(
          input.operation === 'publication'
            ? publicationResponseV1(data)
            : { ...PUBLICATION_META_V1, state: 'settings', settings: data.settings },
        );
      },
    });
    const view = render(
      createElement(StudentPublicationV1, { client, scope: SETTINGS_CLASS_V1, canWrite: true }),
    );
    expect(screen.queryByRole('heading', { name: '1º trimestre' })).toBeNull();
    view.rerender(
      createElement(StudentPublicationV1, { client, scope: SETTINGS_SCHOOL_V1, canWrite: true }),
    );
    await ready();
    await act(async () => finish(json(publicationResponseV1(fixture))));
    expect(screen.getByText('Escola · 2026')).toBeTruthy();
    expect(screen.queryByText('Turma 900001 · 2026')).toBeNull();
  });
  it('retries the same uncertain decision outside the modal under StrictMode', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const mock = setup({
      write: async () => {
        if (++attempts <= 2) throw new TypeError('lost');
        return json({
          ...PUBLICATION_META_V1,
          state: 'committed',
          operationId: SYNTHETIC_ID_V1,
          version: 10,
        });
      },
    });
    render(createElement(StrictMode, null, createElement(StudentPublicationV1, mock.props)));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 1º trimestre' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar publicação' }));
    await screen.findByRole('button', { name: 'Tentar novamente' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await screen.findByText('1º trimestre: solicitação aceita.');
    expect(mock.bodies).toHaveLength(3);
    expect(new Set(mock.bodies).size).toBe(1);
  });
  it('enables the follow-up reload again after a rate-limited check keeps the old content', async () => {
    const user = userEvent.setup(),
      fixture = publicationFixtureV1();
    let limited = false;
    const client = createPortalAdminClientV1({
      fetch: async (path, init) => {
        if (!path.endsWith('/query')) {
          limited = true;
          return json({
            ...PUBLICATION_META_V1,
            state: 'committed',
            operationId: SYNTHETIC_ID_V1,
            version: 10,
          });
        }
        if (limited)
          return new Response(JSON.stringify({ ...PUBLICATION_META_V1, state: 'rate-limited' }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Retry-After': '1',
            },
          });
        const input: AdminQueryV1 = JSON.parse(String(init.body));
        return json(
          input.operation === 'publication'
            ? publicationResponseV1(fixture)
            : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings },
        );
      },
    });
    render(
      createElement(StudentPublicationV1, { client, scope: SETTINGS_CLASS_V1, canWrite: true }),
    );
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publicar as notas novas de 1º trimestre' }));
    expect(within(screen.getByRole('dialog')).getByText('1º trimestre')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirmar publicação' }));
    const check = (await screen.findByRole('button', {
      name: 'Consultar estado atual',
    })) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    await vi.waitFor(() => expect(check.disabled).toBe(false), { timeout: 3000 });
  });
  it('never manufactures six no-data cards from an unavailable response', async () => {
    const client = createPortalAdminClientV1({
      fetch: async () => json({ ...PUBLICATION_META_V1, state: 'unavailable' }, 503),
    });
    render(
      createElement(StudentPublicationV1, { client, scope: SETTINGS_CLASS_V1, canWrite: true }),
    );
    await screen.findByText('Consulta indisponível. Tente novamente.');
    expect(screen.queryByRole('heading', { name: '1º trimestre' })).toBeNull();
    expect(screen.queryByText('Sem notas no Banco')).toBeNull();
  });
});
