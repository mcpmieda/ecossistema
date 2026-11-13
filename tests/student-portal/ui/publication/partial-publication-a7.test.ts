import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminCommandV1, AdminQueryV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { StudentPublicationV1 } from '../../../../src/features/student-portal-admin/publication/student-publication-v1';
import { SETTINGS_SCHOOL_V1 } from '../settings/fixtures-v1';
import { PUBLICATION_META_V1, publicationFixtureV1, publicationResponseV1 } from './fixtures-v1';

const json = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** School scope where the 1º trimestre (published, equal) and 2º (newer marks) reach 3 of 40 students. */
function setup(autoUpdate: boolean) {
  const fixture = publicationFixtureV1(SETTINGS_SCHOOL_V1);
  fixture.settings.value.autoUpdate = autoUpdate;
  for (const item of fixture.items) {
    if (item.period === 'T1') Object.assign(item, { state: 'published', availableRevision: 'synthetic:2026:revision:2',
      publishedRevision: 'synthetic:2026:revision:2', publishedCount: 3, targetCount: 40 });
    if (item.period === 'T2') Object.assign(item, { publishedCount: 3, targetCount: 40 });
    if (item.period === 'REC1') Object.assign(item, { publishedCount: 40, targetCount: 40 });
  }
  const writes: AdminCommandV1[] = [];
  const client = createPortalAdminClientV1({
    fetch: async (path, init) => {
      if (path.endsWith('/query')) {
        const input: AdminQueryV1 = JSON.parse(String(init.body));
        return json(input.operation === 'publication'
          ? publicationResponseV1(fixture)
          : { ...PUBLICATION_META_V1, state: 'settings', settings: fixture.settings });
      }
      writes.push(JSON.parse(String(init.body)));
      return json({ ...PUBLICATION_META_V1, state: 'committed', operationId: SYNTHETIC_ID_V1, version: 10 });
    },
  });
  return { writes, props: { client, scope: SETTINGS_SCHOOL_V1, canWrite: true, scopeLabel: 'Escola · 2026' } };
}
const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('.pa-publication-card') as HTMLElement;

it('A7: names a partial publication and offers to publish it for everyone', async () => {
  const user = userEvent.setup();
  const mock = setup(false);
  render(createElement(StudentPublicationV1, mock.props));
  await screen.findByRole('heading', { name: '1º trimestre' });
  const first = card('1º trimestre');
  expect(within(first).getByText('Publicada para 3 de 40 alunos')).toBeTruthy();
  expect(within(first).queryByText('Publicada')).toBeNull();
  await user.click(within(first).getByRole('button', { name: 'Publicar para todos de 1º trimestre' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar publicação' }));
  await screen.findByText('1º trimestre: solicitação aceita.');
  expect(mock.writes[0]).toMatchObject({ operation: 'publish', period: 'T1', targetDataVersion: 'synthetic:2026:revision:2' });
});

it('A7: a partial period with newer marks never offers the update the server refuses', async () => {
  render(createElement(StudentPublicationV1, setup(false).props));
  await screen.findByRole('heading', { name: '2º trimestre' });
  const second = card('2º trimestre');
  expect(within(second).getByRole('button', { name: 'Publicar para todos de 2º trimestre' })).toBeTruthy();
  expect(within(second).queryByRole('button', { name: 'Publicar as notas novas de 2º trimestre' })).toBeNull();
  // Everyone published: the usual label and no extra button.
  const recovery = card('Recuperação 1');
  expect(within(recovery).getByText('Publicada')).toBeTruthy();
  expect(within(recovery).queryByRole('button', { name: /Publicar/u })).toBeNull();
});
