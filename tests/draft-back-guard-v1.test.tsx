import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DISCARD_DRAFT_PROMPT_V1,
  useDraftNavigationGuardV1,
} from '../src/shared/forms/draft-navigation-v1';

const tick = (ms = 0) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

function Guarded({ blocked }: { readonly blocked: boolean }) {
  useDraftNavigationGuardV1(blocked);
  return null;
}

let heard: string[] = [];
const listen = () => heard.push(window.location.hash);

beforeEach(async () => {
  window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
  window.location.hash = '#/painel-do-aluno?area=settings';
  await tick(20);
  heard = [];
  window.addEventListener('hashchange', listen);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('hashchange', listen);
  vi.restoreAllMocks();
});

it('asks before the phone back leaves an unsaved edit, and stays when refused (A1)', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<Guarded blocked />);
  window.history.back();
  await tick(600);
  expect(confirm).toHaveBeenCalledWith(DISCARD_DRAFT_PROMPT_V1);
  expect(confirm).toHaveBeenCalledTimes(1);
  // The address returns to the screen shown, and no screen hears of the refused change.
  expect(window.location.hash).toBe('#/painel-do-aluno?area=settings');
  expect(heard).toEqual([]);
});

it('lets the back through when the edit is discarded (A1)', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<Guarded blocked />);
  window.history.back();
  await tick(600);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(window.location.hash).toBe('#/painel-do-aluno?area=accounts');
  expect(heard).toEqual(['#/painel-do-aluno?area=accounts']);
});

it('asks nothing without an edit pending (A1)', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<Guarded blocked={false} />);
  window.history.back();
  await tick(600);
  expect(confirm).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('#/painel-do-aluno?area=accounts');
  expect(heard).toEqual(['#/painel-do-aluno?area=accounts']);
});
