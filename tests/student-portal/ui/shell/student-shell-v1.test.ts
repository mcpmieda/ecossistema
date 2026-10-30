import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudentPortalPageV1,
  StudentProfileV1,
  type StudentPagePropsV1,
} from '../../../../src/features/student-portal/shell/student-shell-v1';
import { SYNTHETIC_SELF_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { PortalClientErrorV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { selfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';

const ready = { state: 'ready', data: SYNTHETIC_SELF_V1 } as const;
const page = (props: Partial<StudentPagePropsV1> = {}) =>
  createElement(StudentPortalPageV1, { load: ready, ...props });
beforeEach(() => {
  setupOperationsDomV1();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('student shell and canonical profile', () => {
  it('renders the profile and simplified bulletin navigation from the same self object', () => {
    render(page({ load: { state: 'ready', data: { ...SYNTHETIC_SELF_V1, showFrequency: true } } }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portal do Aluno');
    const schoolMark = screen.getByRole('img', {
      name: 'Escola Mun. Prof.ª Iêda Alves de Oliveira MCPM',
    });
    expect(schoolMark.querySelector('.pa-school-logo-image')).toBeTruthy();
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Perfil do aluno', 'Minhas notas', 'Frequência do aluno']);
    cleanup();
    // Política Frequência off (or a server without the field): no attendance section at all.
    for (const data of [SYNTHETIC_SELF_V1, { ...SYNTHETIC_SELF_V1, showFrequency: false }]) {
      render(page({ load: { state: 'ready', data } }));
      expect(screen.queryByRole('heading', { name: /Frequência/u })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Atualizar frequência' })).toBeNull();
      cleanup();
    }
    render(page({ load: { state: 'ready', data: { ...SYNTHETIC_SELF_V1, showFrequency: true } } }));
    expect(screen.getByText('Estudante de exemplo')).toBeTruthy();
    expect(screen.getByText('Turma de exemplo')).toBeTruthy();
    // The year chip was removed (owner review 27/09/2026).
    expect(screen.queryByText('2026')).toBeNull();
    // "Em curso" is no longer shown in the hero (owner review 27/09/2026).
    expect(screen.queryByText('Em curso')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Boletim' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Resumo' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Evolução' })).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
    expect(document.querySelector('time')).toBeNull();
  });
  it('shows a menu item only for the pages the school turned on, each read once with the sign-in', async () => {
    const frequencyClient = {
      read: vi.fn(() => new Promise<never>(() => undefined)),
      readYear: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const scheduleClient = { read: vi.fn(() => new Promise<never>(() => undefined)) };
    const incidentsClient = {
      read: vi.fn(() => new Promise<never>(() => undefined)),
      acknowledge: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const menu = () =>
      screen.queryByRole('navigation', { name: 'Menu do Portal' }) &&
      within(screen.getByRole('navigation', { name: 'Menu do Portal' }))
        .getAllByRole('button')
        .map((item) => item.textContent);
    const show = (fields: { showFrequency?: boolean; showSchedule?: boolean; showIncidents?: boolean }) =>
      render(page({ load: { state: 'ready', data: { ...SYNTHETIC_SELF_V1, ...fields } }, frequencyClient, scheduleClient, incidentsClient }));
    // Every key off (or a server without them): the bottom bar with Notas only (owner decision 23/10/2026).
    show({ showFrequency: false, showSchedule: false, showIncidents: false });
    expect(menu()).toEqual(['Notas']);
    cleanup();
    expect(incidentsClient.read).not.toHaveBeenCalled();
    cleanup();
    show({ showSchedule: true });
    expect(menu()).toEqual(['Notas', 'Horário']);
    cleanup();
    // Ocorrências (owner decisions 29/10/2026): to the right of Horário, read once with the sign-in.
    show({ showIncidents: true });
    expect(menu()).toEqual(['Notas', 'Ocorrências']);
    await vi.waitFor(() => expect(incidentsClient.read).toHaveBeenCalledOnce());
    expect(incidentsClient.acknowledge).not.toHaveBeenCalled();
    cleanup();
    frequencyClient.readYear.mockClear();
    scheduleClient.read.mockClear();
    show({ showFrequency: true, showSchedule: true, showIncidents: true });
    expect(menu()).toEqual(['Notas', 'Frequência', 'Horário', 'Ocorrências']);
    // Each page is read once, with the sign-in like the grades (one request each), and opening it
    // asks nothing more.
    await vi.waitFor(() => expect(frequencyClient.readYear).toHaveBeenCalledOnce());
    expect(scheduleClient.read).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Horário' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduleClient.read).toHaveBeenCalledOnce();
    expect(frequencyClient.read).not.toHaveBeenCalled();
  });
  it("marks the Frequência calendar with a green check, or a red X while the page has a red warning (owner decision 23/10/2026)", async () => {
    const year = (tone: 'alert' | 'good' | null) => ({
      contractVersion: 2 as const, state: 'ready' as const, academicYear: 2026 as const, today: '2026-10-21',
      year: null, lastReadAt: null, months: [],
      comment: tone ? { kind: 'near-limit', tone, text: 'Frase' } : null,
    });
    const mark = () => document.querySelector('.pa3-nav-item[aria-controls="pa3-panel-frequency"] .pa3-nav-icon g')!;
    for (const [tone, expected, name] of [
      ['alert', 'pa3-frequency-mark--alert', 'Com aviso'],
      ['good', 'pa3-frequency-mark--good', 'Sem aviso'],
      [null, 'pa3-frequency-mark--good', 'Sem aviso'],
    ] as const) {
      const frequencyClient = { read: vi.fn(() => new Promise<never>(() => undefined)), readYear: vi.fn(async () => year(tone)) };
      render(page({ load: { state: 'ready', data: { ...SYNTHETIC_SELF_V1, showFrequency: true } }, frequencyClient }));
      // Unknown until the year is read: the plain icon.
      await vi.waitFor(() => expect(mark().getAttribute('class')).toBe(expected));
      expect(screen.getByRole('button', { name: 'Frequência', description: name })).toBeTruthy();
      cleanup();
    }
  });
  it('clears protected profile and grade content in loading, errors and expiration', () => {
    const view = render(page());
    view.rerender(page({ load: { state: 'loading' } }));
    expect(screen.getByRole('status', { name: 'Carregando perfil e notas' })).toBeTruthy();
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('main').getAttribute('aria-busy')).toBe('true');
    view.rerender(
      page({ load: { state: 'error', error: new PortalClientErrorV1('network-error') } }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar seus dados');
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
    view.rerender(
      page({ load: { state: 'error', error: new PortalClientErrorV1('unauthenticated') } }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Sessão expirada');
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('keeps no publication, maintenance and generic unavailability distinct', () => {
    const empty = selfResponseV1.parse({
      ...SYNTHETIC_SELF_V1,
      state: 'no-publication',
      subjects: [],
    });
    const view = render(page({ load: { state: 'ready', data: empty } }));
    expect(
      within(screen.getByRole('region', { name: 'Minhas notas' })).getByRole('status').textContent,
    ).toBe('Notas ainda não publicadas');
    expect(screen.getByText('Estudante de exemplo')).toBeTruthy();
    view.rerender(page({ load: { state: 'maintenance' } }));
    expect(screen.getByRole('alert').textContent).toContain('Portal em manutenção');
    view.rerender(
      page({ load: { state: 'error', error: new PortalClientErrorV1('unavailable') } }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Portal temporariamente indisponível');
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
  });
  it('shows a closed access state without retaining protected content or calling it missing grades', () => {
    const view = render(page());
    view.rerender(
      page({ load: { state: 'error', error: new PortalClientErrorV1('access-closed', 403) } }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Acesso ao Portal fechado');
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
    expect(screen.queryByText('Notas ainda não publicadas')).toBeNull();
  });
  it('shows no portrait placeholder without a photo, preserves long names and suppresses a global result for ASSISTIDO', () => {
    const profile = {
      ...SYNTHETIC_SELF_V1.profile,
      name: 'Élisa de Exemplo Sintético',
      academicState: 'assisted' as const,
      result: 'not-applicable' as const,
    };
    render(createElement(StudentProfileV1, { profile }));
    expect(screen.getByText(profile.name)).toBeTruthy();
    // No approved background-free photo: neither an image nor an initials stand-in.
    expect(screen.queryByText('ÉS')).toBeNull();
    expect(document.querySelector('.pa-hero-portrait')).toBeNull();
    expect(document.querySelector('.pa-student-hero--no-portrait')).not.toBeNull();
    expect(screen.getByText('ASSISTIDO')).toBeTruthy();
    expect(screen.queryByText('Não se aplica')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('time')).toBeNull();
  });
  it('shows the original photo in the arch and drops it entirely if it fails to load', () => {
    const profile = SYNTHETIC_SELF_V1.profile;
    render(createElement(StudentProfileV1, { profile, portraitSrc: '/api/student/photo?v=1' }));
    expect(document.querySelector('.pa-student-hero--arch')).not.toBeNull();
    const photo = document.querySelector('.pa-hero-frame-photo')!;
    expect(photo.getAttribute('src')).toBe('/api/student/photo?v=1');
    // A broken image never shows: no frame and no placeholder, the copy keeps the space.
    fireEvent.error(photo);
    expect(document.querySelector('.pa-hero-frame')).toBeNull();
    expect(document.querySelector('.pa-student-hero--no-portrait')).not.toBeNull();
  });
  it('supports skip link, keyboard logout and explicit retry/login callbacks', async () => {
    const user = userEvent.setup();
    const logout = vi.fn(),
      retry = vi.fn(),
      login = vi.fn();
    const view = render(page({ onLogout: logout }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Ir para o conteúdo' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sair' }));
    await user.keyboard('{Enter}');
    expect(logout).toHaveBeenCalledOnce();
    view.rerender(page({ onLogout: logout, loggingOut: true }));
    expect((screen.getByRole('button', { name: 'Sair' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      page({
        load: { state: 'error', error: new PortalClientErrorV1('network-error') },
        onRetry: retry,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(
      page({
        load: { state: 'error', error: new PortalClientErrorV1('unauthenticated') },
        onLogin: login,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(login).toHaveBeenCalledOnce();
  });
});
