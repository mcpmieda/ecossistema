// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesPage } from '../../src/platform/notes-page';

const fixture = vi.hoisted(() => ({
  error: new Error('synthetic render error'),
  allowNavigation: vi.fn(() => false),
}));
vi.mock('../../src/platform/gradebook-workspace-page', () => ({
  GradebookWorkspacePage: () => {
    throw fixture.error;
  },
}));
vi.mock('../../src/shared/forms/draft-navigation-v1', () => ({
  allowDraftNavigationV1: fixture.allowNavigation,
}));

beforeEach(() => {
  fixture.allowNavigation.mockClear();
  fixture.error = new Error('synthetic render error');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows a module-load recovery message without reloading or rendering the original URL', async () => {
  fixture.error = new TypeError(
    'Failed to fetch dynamically imported module: /assets/synthetic.js',
  );
  render(<NotesPage />);
  expect(await screen.findByText(/BN-CARGA/)).toBeTruthy();
  expect(screen.getByText(/versão atual do aplicativo/)).toBeTruthy();
  expect(screen.queryByText(/synthetic\.js/)).toBeNull();
  expect(fixture.allowNavigation).not.toHaveBeenCalled();
});

it('does not diagnose a database outage from a render error', async () => {
  render(<NotesPage />);
  expect(await screen.findByText(/BN-TELA/)).toBeTruthy();
  expect(screen.getByText(/não confirma uma falha no banco de dados/)).toBeTruthy();
});

it('keeps manual reload behind the existing draft-navigation guard', async () => {
  const user = userEvent.setup();
  render(<NotesPage />);
  await screen.findByText(/BN-TELA/);
  await user.click(screen.getByRole('button', { name: 'Recarregar' }));
  expect(fixture.allowNavigation).toHaveBeenCalledTimes(1);
});
